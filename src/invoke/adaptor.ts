/**
 * Copyright 2026 codepre
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * {@link A2aInvokeAdaptor}：能力调用适配器（内部 → 外部）。
 *
 * 连接外部 Agent，完成「探测 → 调用 → 取结果」的完整闭环，全程使用
 * 协议无关的模型类型（{@link CapabilityView} / {@link AgentMessage} /
 * {@link AgentTask}），使用者不接触任何协议细节：
 *
 * - **探测** {@link A2aInvokeAdaptor.probe}：拉取并解析远端能力声明，
 *   产出统一能力视图（技能 / 能力开关 / 认证要求 / 传输绑定）；
 * - **调用** {@link A2aInvokeAdaptor.invoke}：发送用户消息，内部
 *   「发送 → 轮询」直至终态，返回终态任务快照（直答消息同样归并为
 *   任务）；也可用 {@link A2aInvokeAdaptor.invokeStream} 订阅原始事件流；
 * - **管理** getTask / cancel：查询与取消既有任务。
 *
 * 内部由 binding 层（A2A）完成 AgentCard 获取、传输与认证；未来接入
 * 更多协议时新增同形 binding，经 `transport` 选择即可。
 *
 * @packageDocumentation
 */

import type { AuthHeaderProvider, AuthHeaders } from '../common/auth.ts';
import type { FetchLike } from '../common/fetch.ts';
import type { AgentMessage } from '../model/message.ts';
import type { AgentCardKeyRetriever, CapabilityView } from '../model/capability.ts';
import { isTerminalState, type AgentTask, type AgentTaskEvent } from '../model/task.ts';
import {
  fromCardView,
  fromSdkMessage,
  fromSdkStreamResponse,
  fromSdkTask,
  toSdkMessage,
} from '../binding/a2a/model.ts';
import { classifyA2aError } from '../binding/a2a/errors.ts';
import {
  A2aConnectClient,
  type A2aSendMessageInput,
} from '../binding/a2a/connect-client.ts';
import { AgentInvokeError, isAgentInvokeError } from './errors.ts';

/** 轮询终态的时间间隔。 */
const POLL_INTERVAL_MS = 300;

/**
 * 无超时配置下轮询的连续瞬断容忍上限（超过即放弃，防对死远端无限
 * 轮询）；配置了 `timeoutMs` 时由超时兜底、瞬断不设上限。
 */
const MAX_TRANSIENT_POLL_FAILURES = 10;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

/** 中止时抛 AbortError（随后映射为 code=canceled）。 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

/** {@link A2aInvokeAdaptor} 的选项。 */
export interface InvokeOptions {
  /**
   * 自定义 fetch 替换（AgentCard 获取 + 传输统一注入）。
   * 默认 `globalThis.fetch`。
   */
  readonly fetch?: FetchLike;
  /** 认证来源：每次请求动态求值（Bearer / API-Key 等）。 */
  readonly auth?: AuthHeaderProvider | AuthHeaders;
  /** AgentCard 路径；缺省 `/.well-known/agent-card.json`。 */
  readonly cardPath?: string;
  /** 协议绑定（当前仅 'a2a'；后续新增协议在此扩展）。 */
  readonly transport?: 'a2a';
  /** 启用 v0.3 兼容层（透传 binding），缺省关闭。 */
  readonly legacyCompat?: boolean;
  /** {@link A2aInvokeAdaptor.invoke invoke} 等待终态的默认超时（毫秒）。 */
  readonly timeoutMs?: number;
  /** 全部调用共享的默认取消信号。 */
  readonly signal?: AbortSignal;
  /**
   * AgentCard 签名（JWS）公钥获取器（§4.14：存在签名时强制校验，
   * 失败拒绝连接并提示）。配置后 `probe` 对带签名卡片逐一校验。
   */
  readonly verifyCardSignature?: AgentCardKeyRetriever;
}

/** 一次调用的输入（模型语义，缺省字段在内部补齐）。 */
export interface InvokeInput {
  /** 用户消息。 */
  readonly message: AgentMessage;
  /** 续聊：既有任务 id；首轮可省略（由服务端分配）。 */
  readonly taskId?: string;
  /** 多轮会话上下文 id；首轮可省略。 */
  readonly contextId?: string;
  /** 附加元数据。 */
  readonly metadata?: Record<string, unknown>;
}

/** {@link A2aInvokeAdaptor.invoke invoke} 的按次选项。 */
export interface InvokeRequestOptions {
  /** 等待终态的超时（毫秒）；缺省取构造选项的 `timeoutMs`。 */
  readonly timeoutMs?: number;
  /** 本次调用的取消信号（缺省取构造选项的 `signal`）。 */
  readonly signal?: AbortSignal;
}

/** 终态任务：failed / rejected 抛 {@link AgentInvokeError}（code=`task-failed`）。 */
function terminalResult(task: AgentTask): AgentTask {
  if (task.state === 'failed' || task.state === 'rejected') {
    throw new AgentInvokeError(
      'task-failed',
      `任务最终状态为 ${task.state}`,
      { task },
    );
  }
  return task;
}

/**
 * 能力调用适配器：连接外部 Agent，探测并调用其能力。
 *
 * ```ts
 * const invoke = new A2aInvokeAdaptor('https://agent.example', {
 *   fetch: networkClient.fetch,
 *   auth: bearerTokenProvider(readSecretRefToken),
 * });
 * const view = await invoke.probe();                 // 统一能力视图
 * const task = await invoke.invoke({ message: textMessage('你好') });
 * console.log(messageText(task.message));            // 终态回复
 * ```
 */
export class A2aInvokeAdaptor {
  /** 远端地址。 */
  readonly url: string;
  /** 协议绑定名。 */
  readonly transport: 'a2a';
  private readonly options: InvokeOptions;
  private connect?: A2aConnectClient;

  constructor(url: string, options: InvokeOptions = {}) {
    this.url = url;
    this.options = options;
    this.transport = options.transport ?? 'a2a';
  }

  /**
   * 探测远端：拉取能力声明并解析为统一能力视图。
   *
   * 走注入的 fetch（含认证头），首次拉取后缓存；失败抛错由调用方处理
   * （如登记流程里标记「不可连接」）。
   */
  async probe(): Promise<CapabilityView> {
    try {
      return fromCardView(await this.client().probe());
    } catch (error) {
      throw this.mapError(error);
    }
  }

  /**
   * 调起一轮任务并等待终态或交互停泊点。
   *
   * 内部「发送 → 轮询」直至终态（completed / failed / canceled /
   * rejected）；服务端直答消息（无任务状态机）归并为 completed 任务。
   * 任务进入 `input-required`（Agent 请求追加输入）或 `auth-required`
   * （Agent 要求先补凭据）时返回当前快照，由调用方凭 `taskId` /
   * `contextId` 续聊（持续聊时经 `/凭据补录` 后重试）。中途调用方可经
   * `signal` 终止（抛 code=`canceled`）。超时抛 {@link AgentInvokeError}
   * （code=`timeout`）。
   *
   * 轮询期间的**瞬时网络故障**（fetch failed / ECONNRESET / socket hang up
   * / terminated 等）会被容忍并继续下一轮——链路抖动不中断任务；仅在
   * 没有超时配置且连续失败超过 {@link MAX_TRANSIENT_POLL_FAILURES} 次时
   * 才放弃（防无超时下对死远端无限轮询）。服务端明确拒绝（任务不存在 /
   * 请求畸形 / 响应畸形）则立即失败。
   *
   * 需要「流式优先、断连回退轮询」的韧性路径时用
   * {@link A2aInvokeAdaptor.invokeStreaming invokeStreaming}。
   */
  async invoke(input: InvokeInput, options: InvokeRequestOptions = {}): Promise<AgentTask> {
    const signal = options.signal ?? this.options.signal;
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    try {
      throwIfAborted(signal);
      const initial = await this.client().sendMessage(this.buildRequest(input), signal);
      // 直答：无任务状态机（SDK SendMessage 可能直接返回 Message）
      if ('messageId' in initial) {
        return terminalResult({
          taskId: input.taskId ?? '',
          ...(initial.contextId !== undefined && initial.contextId !== ''
            ? { contextId: initial.contextId }
            : {}),
          state: 'completed',
          message: fromSdkMessage(initial),
        });
      }
      return await this.pollToTerminal(fromSdkTask(initial), signal, deadline);
    } catch (error) {
      throw this.mapError(error);
    }
  }

  /**
   * 流式优先的韧性调用：先走事件流（SSE），流中断/结束仍未达终态时
   * **回退轮询** `getTask` 直至终态（§4.14：流式优先、流不可用回退轮询）。
   *
   * 适合长任务与不稳定链路：事件流能给出实时增量；SSE 被服务端掐断
   * （空闲断开/代理超时）时不会把任务当成「未完成即成功」，而是继续
   * 以既有任务 id 轮询收尾。卡片不支持流式时由 SDK 降级为一次性调用，
   * 同样走回退轮询。停泊态（input-required / auth-required）与
   * `signal` / `timeoutMs` 语义同 {@link A2aInvokeAdaptor.invoke invoke}。
   */
  async invokeStreaming(input: InvokeInput, options: InvokeRequestOptions = {}): Promise<AgentTask> {
    const signal = options.signal ?? this.options.signal;
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    let current: AgentTask | undefined;
    try {
      throwIfAborted(signal);
      for await (const response of this.client().sendMessageStream(
        this.buildRequest(input),
        signal,
      )) {
        const event = fromSdkStreamResponse(response);
        if (event === undefined) {
          continue;
        }
        current = mergeEvent(current, event);
        if (current === undefined) {
          continue;
        }
        // 停泊态与终态在事件流中即返回（不进入回退轮询）
        if (current.state === 'input-required' || current.state === 'auth-required') {
          return current;
        }
        if (isTerminalState(current.state)) {
          return terminalResult(current);
        }
      }
    } catch (error) {
      // 流起点就失败（网络/协议错误）：非瞬断直接失败；瞬断同样回退轮询
      if (!isTransientTransportError(error)) {
        throw this.mapError(error);
      }
    }
    // 流正常结束或瞬断中断且未达终态：以既有任务 id 回退轮询收尾
    if (current !== undefined && current.taskId !== '' && current.taskId !== undefined) {
      return await this.pollToTerminal(current, signal, deadline);
    }
    throw new AgentInvokeError(
      'unexpected',
      '事件流在产生任务前中断，无法继续等待终态',
      {},
    );
  }

  /**
   * 订阅一轮任务的事件流（task / status / message / artifact）。
   *
   * 低层接口：不负责等到终态，由调用方自行消费；适合需要实时增量
   * 或长任务的场景。`signal` 中止时流随之终止。注意：SSE 被服务端
   * 掐断时本方法**正常结束**（没有异常），调用方应自行检查最后事件
   * 是否终态；需要自动收尾用 {@link A2aInvokeAdaptor.invokeStreaming
   * invokeStreaming}。
   */
  async *invokeStream(
    input: InvokeInput,
    options: InvokeRequestOptions = {},
  ): AsyncGenerator<AgentTaskEvent, void, undefined> {
    const signal = options.signal ?? this.options.signal;
    try {
      for await (const response of this.client().sendMessageStream(
        this.buildRequest(input),
        signal,
      )) {
        const event = fromSdkStreamResponse(response);
        if (event !== undefined) {
          yield event;
        }
      }
    } catch (error) {
      throw this.mapError(error);
    }
  }

  /** 查询既有任务（幂等）；`signal` 可终止请求。 */
  async getTask(taskId: string, signal?: AbortSignal): Promise<AgentTask> {
    try {
      return fromSdkTask(await this.client().getTask(taskId, signal ?? this.options.signal));
    } catch (error) {
      throw this.mapError(error);
    }
  }

  /** 取消任务（幂等）；`signal` 可终止请求。 */
  async cancel(taskId: string, signal?: AbortSignal): Promise<AgentTask> {
    try {
      return fromSdkTask(await this.client().cancelTask(taskId, signal ?? this.options.signal));
    } catch (error) {
      throw this.mapError(error);
    }
  }

  /**
   * 轮询收尾：以 `current` 为起点轮询 `getTask` 直至终态/停泊/超时。
   *
   * 轮询期间的瞬断网络故障被容忍并继续下一轮（不影响互不干扰的任务
   * 状态）；无超时配置时连续失败超过 {@link MAX_TRANSIENT_POLL_FAILURES}
   * 次即放弃，避免对死远端无限轮询。服务端明确拒绝（task-not-found /
   * invalid-request / malformed-response）立即上抛。
   */
  private async pollToTerminal(
    current: AgentTask,
    signal: AbortSignal | undefined,
    deadline: number | undefined,
  ): Promise<AgentTask> {
    if (current.taskId === '' || current.taskId === undefined) {
      throw new AgentInvokeError('unexpected', '服务端返回了无任务 id 的任务', {});
    }
    // 有超时配置时交给 deadline 兜底；无超时时以连续失败次数兜底
    const maxTransient = deadline !== undefined ? Number.MAX_SAFE_INTEGER : MAX_TRANSIENT_POLL_FAILURES;
    let transientFailures = 0;
    for (;;) {
      if (current.state === 'input-required' || current.state === 'auth-required') {
        return current;
      }
      if (isTerminalState(current.state)) {
        return terminalResult(current);
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new AgentInvokeError('timeout', '等待任务终态超时', { task: current });
      }
      throwIfAborted(signal);
      await sleep(POLL_INTERVAL_MS, signal);
      try {
        current = fromSdkTask(await this.client().getTask(current.taskId, signal));
        transientFailures = 0;
      } catch (error) {
        if (!isTransientTransportError(error)) {
          throw error;
        }
        transientFailures += 1;
        if (transientFailures > maxTransient) {
          throw error;
        }
        // 瞬断：静默继续下一轮轮询（sleep 已节流）
      }
    }
  }

  /** 便捷入参 → binding 发送入参（模型消息转协议消息）。 */
  private buildRequest(input: InvokeInput): A2aSendMessageInput {
    return {
      message: toSdkMessage(input.message, input.taskId ?? '', input.contextId ?? ''),
      configuration: undefined,
      metadata: input.metadata,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
    };
  }

  /** binding 客户端（惰性创建并缓存；probe 与调用共用一条 fetch/auth 链）。 */
  private client(): A2aConnectClient {
    if (this.connect === undefined) {
      this.connect = new A2aConnectClient(this.url, {
        fetch: this.options.fetch,
        auth: this.options.auth,
        cardPath: this.options.cardPath,
        legacyCompat: this.options.legacyCompat,
        verifyCardSignature: this.options.verifyCardSignature,
      });
    }
    return this.connect;
  }

  /** binding 协议错误 → 统一调用错误（已归一的错误原样透传）。 */
  private mapError(error: unknown): unknown {
    if (isAgentInvokeError(error)) {
      return error;
    }
    if (isAbortError(error)) {
      return new AgentInvokeError('canceled', '调用已被取消', { cause: error });
    }
    switch (classifyA2aError(error)) {
      case 'task-not-found':
        return new AgentInvokeError('task-not-found', '任务不存在', { cause: error });
      case 'invalid-request':
        return new AgentInvokeError('invalid-request', '请求参数畸形', { cause: error });
      case 'malformed-response':
        return new AgentInvokeError('unexpected', '服务端返回了畸形响应', { cause: error });
      default:
        return new AgentInvokeError('unexpected', '调用失败', { cause: error });
    }
  }
}

/** 中止错误判定（DOMException AbortError；含 AbortSignal.reason 自造形态）。 */
function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    error.name === 'AbortError'
  );
}

/**
 * 事件流增量合并：按流事件逐步演进「最新任务快照」。
 *
 * - task 事件：整体替换快照（自带 taskId / contextId / 状态）；
 * - status 事件：更新状态与消息，保留既有 contextId / artifacts；
 * - message / artifact 事件：增量附着，不改状态。
 */
function mergeEvent(current: AgentTask | undefined, event: AgentTaskEvent): AgentTask | undefined {
  switch (event.type) {
    case 'task':
      return event.task;
    case 'status':
      return {
        ...(current ?? { taskId: event.taskId, state: event.state }),
        taskId: event.taskId,
        state: event.state,
        ...(event.message !== undefined ? { message: event.message } : {}),
      };
    case 'message':
      return current === undefined
        ? { taskId: '', state: 'working', message: event.message }
        : { ...current, message: event.message };
    case 'artifact':
      return current === undefined
        ? undefined
        : {
            ...current,
            artifacts: [...(current.artifacts ?? []), event.artifact],
          };
  }
}

/**
 * 瞬时传输故障判定：网络抖动类错误不按「任务失败」处理，轮询/回退
 * 链路对其容忍重试。沿 `cause` 链匹配常见瞬断形态（undici `fetch
 * failed` 包裹、连接重置、空闲超时、管道中断）；协议错误（任务不存在
 * / 请求畸形）不在此列。
 */
function isTransientTransportError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const message =
      typeof current === 'object' && current !== null && 'message' in current
        ? String((current as { message?: unknown }).message ?? '')
        : String(current);
    if (
      /fetch failed|ECONNRESET|socket hang up|terminated|ETIMEDOUT|EPIPE|ECONNREFUSED|UND_ERR_|network error/i.test(
        message,
      )
    ) {
      return true;
    }
    current =
      typeof current === 'object' && current !== null && 'cause' in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}