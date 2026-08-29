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
 * {@link A2aImplAdaptor}：能力实现适配器（外部 → 内部）。
 *
 * 把内部执行能力导出为可被外部 Agent 发现与调用的服务端。使用者只需
 * 描述三样东西：
 *
 * - **能力声明** {@link CapabilityDeclaration}：名称 / 描述 / 技能 /
 *   能力开关 / 认证方案（协议无关）；
 * - **执行器** {@link ImplExecutor}：处理每一轮用户消息，经
 *   {@link ImplEventEmitter} 发布任务事件（模型语义，无协议概念）；
 * - **认证校验** {@link ImplAuth}（可选）：请求头 → 主体。
 *
 * 内部由 binding 层（A2A）把这些模型结构翻译为协议实现（AgentCard /
 * 任务事件流 / HTTP 传输），对外暴露的只有模型类型的
 * {@link A2aImplAdaptor.mount mount}（挂载 HTTP 服务）与
 * {@link A2aImplAdaptor.probe probe}（本地能力视图）。
 *
 * 未来接入更多协议（如 ACP）时：为新增协议实现同形的 binding 模块，
 * 并在构造选项中通过 `transport` 选择即可，公共接口不变。
 *
 * @packageDocumentation
 */

import type { Express, RequestHandler } from 'express';
import type { AgentAuthHeaders } from '../common/auth.ts';
import type {
  CapabilityDeclaration,
  CapabilityView,
} from '../model/capability.ts';
import type { AgentMessage } from '../model/message.ts';
import { toCapabilityView } from '../model/capability.ts';
import type { MaybePromise } from '../model/types.ts';
import type {
  AgentArtifact,
  AgentTask,
  AgentTaskState,
} from '../model/task.ts';
import {
  A2A_DEFAULT_PATHS,
  A2aServer,
} from '../binding/a2a/server.ts';
import type { A2aCredentialVerifier } from '../binding/a2a/auth.ts';
import type { A2aAgentExecutor, A2aAgentTaskInput, A2aTaskEmitter } from '../binding/a2a/export-client.ts';
import {
  fromSdkMessage,
  fromSdkTask,
  toSdkArtifactUpdate,
  toSdkCapabilityDeclaration,
  toSdkMessage,
  toSdkTask,
  toSdkTaskState,
} from '../binding/a2a/model.ts';

/** 实现侧凭据校验器：检查请求头并返回主体。 */
export type AgentCredentialVerifier = (
  headers: AgentAuthHeaders,
) => MaybePromise<{ userName: string } | null | undefined>;

/** 执行器输入（由 binding 层从协议请求提炼，模型语义）。 */
export interface ImplTaskInput {
  /** 任务 id。 */
  readonly taskId: string;
  /** 会话上下文 id（首轮可能为空串）。 */
  readonly contextId?: string;
  /** 用户本轮消息。 */
  readonly message: AgentMessage;
  /** 认证主体（未认证为 undefined）。 */
  readonly user?: { readonly userName: string };
  /** 续轮时的既有任务（多轮会话；首轮为 undefined）。 */
  readonly task?: AgentTask;
}

/**
 * 任务事件发射器：执行器向当前任务的事件流发布事件。
 *
 * 语义与协议流式契约对齐：首个事件通常是 task 或 message；随后可发
 * status / artifact / message 增量；发布终态（completed / failed /
 * canceled / rejected）后事件流自动收束。
 */
export interface ImplEventEmitter {
  /** 发布 agent 文本回复（可作为首事件）。 */
  text(text: string): void;
  /** 发布完整消息（message 事件）。 */
  message(message: AgentMessage): void;
  /** 发布任务快照（task 事件，首选首事件）。 */
  task(task: AgentTask): void;
  /** 更新任务状态（status 事件；message 可省略或附带 agent 回复）。 */
  status(taskId: string, state: AgentTaskState, message?: AgentMessage): void;
  /** 发布工件更新（artifact 事件）。 */
  artifact(taskId: string, artifact: AgentArtifact): void;
}

/**
 * 内部执行器：处理一轮用户消息。
 *
 * 通过 `emit` 发布事件，返回后由 binding 层结算（终态自动收束事件流）；
 * 抛错时自动合成 failed 终态，无需自行转发。
 */
export type ImplExecutor = (
  input: ImplTaskInput,
  emit: ImplEventEmitter,
) => Promise<void>;

/** {@link A2aImplAdaptor} 的构造选项。 */
export interface ImplOptions {
  /** 统一能力声明：导出给外部发现的内容来源。 */
  readonly capabilities: CapabilityDeclaration;
  /** 内部执行器：处理每一轮用户消息。 */
  readonly implement: ImplExecutor;
  /** 认证校验（可选）；缺省不要求认证。 */
  readonly auth?: { readonly verify?: AgentCredentialVerifier };
  /** 任务取消回调（可选）：外部取消任务时调用，适配层代发 canceled 终态。 */
  readonly onCancel?: (taskId: string) => MaybePromise<void>;
  /** 能力声明里的导出端点（覆盖 `capabilities.url` 缺省值）。 */
  readonly exportUrl?: string;
  /** 启用 v0.3 兼容层（透传 binding），缺省关闭。 */
  readonly legacyCompat?: boolean;
  /** 协议绑定（当前仅 'a2a'；后续新增协议在此扩展）。 */
  readonly transport?: 'a2a';
}

/** 装配完成的 HTTP 服务中间件三元组（Express 宿主挂载用）。 */
export interface ImplServerHandlers {
  /** AgentCard 服务中间件（挂 `/.well-known/agent-card.json`）。 */
  readonly agentCard: RequestHandler;
  /** JSON-RPC 中间件（挂 `/jsonrpc`）。 */
  readonly jsonRpc: RequestHandler;
  /** REST 中间件（挂 `/api/rest`）。 */
  readonly rest: RequestHandler;
}

/**
 * 能力实现适配器：内部执行能力 → 可挂载的 Agent 服务端。
 *
 * ```ts
 * const impl = new A2aImplAdaptor({
 *   capabilities: {
 *     name: 'codepre',
 *     description: 'Codepre 导出的远程 Agent',
 *     skills: [{ name: 'run-task', description: '执行 Codepre 任务' }],
 *     capabilities: { streaming: true },
 *     auth: [{ key: 'bearer', kind: 'http', name: 'bearer' }],
 *   },
 *   implement: async ({ taskId, message }, emit) => {
 *     emit.text(`已收到：${messageText(message) ?? ''}`);
 *     emit.status(taskId, 'completed');
 *   },
 *   auth: { verify: (headers) =>
 *     extractBearerToken(headers) ? { userName: 'codepre' } : null },
 * });
 * impl.mount(app);   // Express 宿主
 * ```
 */
export class A2aImplAdaptor {
  /** 协议绑定名。 */
  readonly transport: 'a2a';
  /** 统一能力声明（导出内容的来源）。 */
  readonly capabilities: CapabilityDeclaration;
  private readonly server: A2aServer;

  constructor(options: ImplOptions) {
    this.transport = options.transport ?? 'a2a';
    this.capabilities = options.capabilities;
    const verify = options.auth?.verify;
    this.server = new A2aServer({
      capabilities: toSdkCapabilityDeclaration(options.capabilities),
      executor: A2aImplAdaptor.adaptExecutor(options.implement),
      ...(verify !== undefined
        ? { auth: A2aImplAdaptor.adaptAuth(verify) }
        : {}),
      ...(options.onCancel !== undefined ? { onCancel: options.onCancel } : {}),
      ...(options.exportUrl !== undefined ? { exportUrl: options.exportUrl } : {}),
      ...(options.legacyCompat !== undefined
        ? { legacyCompat: options.legacyCompat }
        : {}),
    });
  }

  /** 本地能力视图（能力声明 → 探测结果形态）。 */
  probe(url: string): CapabilityView {
    return toCapabilityView(url, this.capabilities);
  }

  /** 全部三块 Express 中间件（需要手动控制挂载路径/宿主时使用）。 */
  get handlers(): ImplServerHandlers {
    return this.server.handlers;
  }

  /**
   * 挂载到 Express 应用（缺省路径：`/.well-known/agent-card.json` +
   * `/jsonrpc` + `/api/rest`，可经 `paths` 覆盖）。
   */
  mount(
    app: Express,
    paths: Partial<typeof A2A_DEFAULT_PATHS> = {},
  ): this {
    this.server.mount(app, paths);
    return this;
  }

  /** 模型执行器 → binding 执行器（输入与发射器双向翻译）。 */
  private static adaptExecutor(implement: ImplExecutor): A2aAgentExecutor {
    return async (input: A2aAgentTaskInput, emit: A2aTaskEmitter) => {
      await implement(
        {
          taskId: input.taskId,
          contextId: input.contextId,
          message: fromSdkMessage(input.message),
          // 仅认证通过的主体才投影给执行器：a2a-js 对无凭据请求给出的是
          // isAuthenticated=false 的占位用户（userName 恒为空串），若原样
          // 透传会让 `if (!input.user)` 形式的门禁在 A2A 上失效
          user:
            input.user !== undefined && input.user.isAuthenticated === true
              ? { userName: input.user.userName ?? '' }
              : undefined,
          task: input.task !== undefined ? fromSdkTask(input.task) : undefined,
        },
        A2aImplAdaptor.adaptEmitter(input, emit),
      );
    };
  }

  /** 模型发射器 → binding 发射器（任务/会话字段由上下文注入）。 */
  private static adaptEmitter(
    input: A2aAgentTaskInput,
    emit: A2aTaskEmitter,
  ): ImplEventEmitter {
    const { taskId, contextId } = input;
    return {
      text: (text) => emit.text(text),
      message: (message) => emit.message(toSdkMessage(message, taskId, contextId)),
      task: (task) => emit.task(toSdkTask(task, contextId)),
      status: (id, state, message) =>
        emit.status(
          id,
          toSdkTaskState(state),
          message !== undefined
            ? { message: toSdkMessage(message, id, contextId) }
            : undefined,
        ),
      artifact: (id, artifact) => emit.artifact(toSdkArtifactUpdate(id, contextId, artifact)),
    };
  }

  /** 模型凭据校验器 → binding 凭据校验器（请求头形态对齐）。 */
  private static adaptAuth(verify: AgentCredentialVerifier): A2aCredentialVerifier {
    return (headers) => verify(headers as AgentAuthHeaders);
  }
}