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
import type { CapabilityView } from '../model/capability.ts';
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
   * 调起一轮任务并等待终态。
   *
   * 内部「发送 → 轮询」直至终态（completed / failed / canceled /
   * rejected）；服务端直答消息（无任务状态机）归并为 completed 任务。
   * 超时抛 {@link AgentInvokeError}（code=`timeout`）。
   */
  async invoke(input: InvokeInput, options: InvokeRequestOptions = {}): Promise<AgentTask> {
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    try {
      const initial = await this.client().sendMessage(this.buildRequest(input));
      // 直答：无任务状态机（SDK SendMessage 可能直接返回 Message）
      if ('messageId' in initial) {
        return terminalResult({
          taskId: input.taskId ?? '',
          state: 'completed',
          message: fromSdkMessage(initial),
        });
      }
      let current = fromSdkTask(initial);
      for (;;) {
        if (isTerminalState(current.state)) {
          return terminalResult(current);
        }
        if (deadline !== undefined && Date.now() >= deadline) {
          throw new AgentInvokeError(
            'timeout',
            `等待任务终态超时（超过 ${timeoutMs}ms）`,
            { task: current },
          );
        }
        await sleep(POLL_INTERVAL_MS);
        current = fromSdkTask(await this.client().getTask(current.taskId));
      }
    } catch (error) {
      throw this.mapError(error);
    }
  }

  /**
   * 订阅一轮任务的事件流（task / status / message / artifact）。
   *
   * 低层接口：不负责等到终态，由调用方自行消费；适合需要实时增量
   * 或长任务的场景。
   */
  async *invokeStream(input: InvokeInput): AsyncGenerator<AgentTaskEvent, void, undefined> {
    try {
      for await (const response of this.client().sendMessageStream(this.buildRequest(input))) {
        const event = fromSdkStreamResponse(response);
        if (event !== undefined) {
          yield event;
        }
      }
    } catch (error) {
      throw this.mapError(error);
    }
  }

  /** 查询既有任务（幂等）。 */
  async getTask(taskId: string): Promise<AgentTask> {
    try {
      return fromSdkTask(await this.client().getTask(taskId));
    } catch (error) {
      throw this.mapError(error);
    }
  }

  /** 取消任务（幂等）。 */
  async cancel(taskId: string): Promise<AgentTask> {
    try {
      return fromSdkTask(await this.client().cancelTask(taskId));
    } catch (error) {
      throw this.mapError(error);
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
      });
    }
    return this.connect;
  }

  /** binding 协议错误 → 统一调用错误（已归一的错误原样透传）。 */
  private mapError(error: unknown): unknown {
    if (isAgentInvokeError(error)) {
      return error;
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