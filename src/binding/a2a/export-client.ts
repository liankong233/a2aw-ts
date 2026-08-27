/**
 * {@link A2aExportClient}：把内部执行能力导出为 A2A 服务端（外部 → 内部）。
 *
 * 结构：
 *
 * - **能力声明** {@link A2aCapabilityDeclaration}：统一的 AgentCard 来源，
 *   外部客户端据此发现；
 * - **执行器** {@link A2aAgentExecutor}：内部模块实现的统一任务入口
 *   （每轮用户消息调一次，经 {@link A2aTaskEmitter} 发布事件）；
 * - **认证** {@link A2aCredentialVerifier}：请求头 → `User`（可选）。
 *
 * `A2aExportClient` 内部把执行器适配为 SDK 的 `AgentExecutor`
 * （`DefaultRequestHandler` 的事件总线契约：首发事件必须是 task 或
 * message；终态/中断态由 SDK 根据最后 task 状态自动结算），对外暴露
 * SDK 的 {@link A2ARequestHandler} 与 AgentCard，由 {@link A2aServer}
 * 装配成 HTTP 服务。
 *
 * @packageDocumentation
 */

import { AgentEvent } from '@a2a-js/sdk/server';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type A2ARequestHandler,
  type ExecutionEventBus,
  type RequestContext,
  type TaskStore,
} from '@a2a-js/sdk/server';
import { TaskState, type Message, type SendMessageRequest, type Task, type TaskArtifactUpdateEvent, type TaskStatus, type TaskStatusUpdateEvent } from '@a2a-js/sdk';
import { buildAgentTextMessage } from './messages.ts';
import { fromAgentCard, toAgentCard, type A2aCapabilityDeclaration } from './capabilities.ts';
import { createA2aUserBuilder, type A2aCredentialVerifier, type MaybePromise } from './auth.ts';

/** {@link A2aExportClient} 的选项。 */
export type A2aExportOptions = {
  /** 统一能力声明：导出 AgentCard 的来源（含 skills / 认证方案）。 */
  readonly capabilities: A2aCapabilityDeclaration;
  /** 内部执行器：处理每一轮用户消息，产出任务事件。 */
  readonly executor: A2aAgentExecutor;
  /** 认证校验（可选）；缺省等价于 `UserBuilder.noAuthentication`。 */
  readonly auth?: A2aCredentialVerifier;
  /** 任务取消回调（可选）：SDK 要求取消时发布 canceled 终态，适配层代发。 */
  readonly onCancel?: (taskId: string) => MaybePromise<void>;
  /** 任务存储（可选）：按认证主体隔离；缺省内存实现。 */
  readonly taskStore?: TaskStore;
  /** 启用 v0.3 兼容层（透传 SDK），缺省关闭。 */
  readonly legacyCompat?: boolean;
};

/** 内部执行器的任务输入（由 `RequestContext` 提炼）。 */
export interface A2aAgentTaskInput {
  readonly taskId: string;
  readonly contextId: string;
  /** 用户本轮消息。 */
  readonly message: Message;
  /** 完整 A2A 请求（含 configuration / metadata / tenant）。 */
  readonly request: SendMessageRequest;
  /** 认证主体；未认证为 `UnauthenticatedUser`（`isAuthenticated === false`）。 */
  readonly user: import('@a2a-js/sdk/server').User | undefined;
  /** 续轮时的既有任务（多轮会话；首轮为 undefined）。 */
  readonly task: Task | undefined;
}

/**
 * 任务事件发射器：执行器向 A2A 事件总线发布事件。
 *
 * 语义遵循 A2A 服务端契约：首发事件必须是 task 或 message；随后可发
 * 状态更新 / 工件更新。终态（COMPLETED / FAILED / CANCELED / REJECTED）
 * 由 SDK 自动结算，执行器不需要额外处理。
 */
export interface A2aTaskEmitter {
  /** 发布 agent 文本消息（message 事件，首事件可用）。 */
  text(text: string): void;
  /** 发布完整消息（message 事件）。 */
  message(message: Message): void;
  /** 发布任务（task 事件，首选首事件）。 */
  task(task: Task): void;
  /** 更新任务状态（statusUpdate 事件；message 可省略或附 agent 回复）。 */
  status(taskId: string, state: TaskState, options?: { message?: Message }): void;
  /** 发布工件更新（artifactUpdate 事件）。 */
  artifact(event: TaskArtifactUpdateEvent): void;
}

/**
 * 内部执行器：处理一轮用户消息。
 *
 * 通过 `emit` 发布事件，返回后由 SDK 结算（终态自动收束事件流）。
 * 抛错时 SDK 自动合成 FAILED 任务，无需自行转发。
 */
export type A2aAgentExecutor = (
  input: A2aAgentTaskInput,
  emit: A2aTaskEmitter,
) => Promise<void>;

/** 把事件总线包装成执行器友好的发射器。 */
class A2aEventAdapter implements A2aTaskEmitter {
  constructor(
    private readonly eventBus: ExecutionEventBus,
    private readonly taskId: string,
    private readonly contextId: string,
  ) {}

  text(text: string): void {
    this.message(buildAgentTextMessage(this.taskId, text, this.contextId));
  }

  message(message: Message): void {
    this.eventBus.publish(AgentEvent.message(message));
  }

  task(task: Task): void {
    this.eventBus.publish(AgentEvent.task(task));
  }

  status(taskId: string, state: TaskState, options?: { message?: Message }): void {
    const status: TaskStatus = {
      state,
      message: options?.message,
      timestamp: new Date().toISOString(),
    };
    const event: TaskStatusUpdateEvent = {
      taskId,
      contextId: this.contextId,
      status,
      metadata: {},
    };
    this.eventBus.publish(AgentEvent.statusUpdate(event));
  }

  artifact(event: TaskArtifactUpdateEvent): void {
    this.eventBus.publish(AgentEvent.artifactUpdate(event));
  }
}

/**
 * A2A 导出客户端：能力的服务端出口（外部 A2A 客户端 → 内部执行器）。
 *
 * ```ts
 * const exportClient = new A2aExportClient({
 *   capabilities: { name: 'codepre', description: '...', skills: [...] },
 *   executor: async ({ taskId }, emit) => {
 *     emit.text('你好，我是 Codepre 的远程 Agent');
 *     emit.status(taskId, TaskState.COMPLETED);
 *   },
 *   auth: { verify: (headers) => ... },
 * });
 * ```
 */
export class A2aExportClient {
  /** 统一能力声明（AgentCard 的来源）。 */
  readonly capabilities: A2aCapabilityDeclaration;
  private readonly exportOptions: A2aExportOptions;
  private readonly requestHandler: A2ARequestHandler;
  private readonly taskContextIds = new Map<string, string>();

  constructor(options: A2aExportOptions) {
    this.exportOptions = options;
    this.capabilities = options.capabilities;
    this.requestHandler = this.buildRequestHandler(options);
  }

  private buildRequestHandler(options: A2aExportOptions): A2ARequestHandler {
    const agentCard = toAgentCard(options.capabilities);
    const taskStore = options.taskStore ?? new InMemoryTaskStore();
    const executor: AgentExecutor = {
      execute: async (requestContext: RequestContext, eventBus: ExecutionEventBus) => {
        this.taskContextIds.set(requestContext.taskId, requestContext.contextId);
        const input: A2aAgentTaskInput = {
          taskId: requestContext.taskId,
          contextId: requestContext.contextId,
          message: requestContext.userMessage,
          request: requestContext.request,
          user: requestContext.context.user,
          task: requestContext.task,
        };
        await options.executor(
          input,
          new A2aEventAdapter(eventBus, requestContext.taskId, requestContext.contextId),
        );
      },
      cancelTask: async (taskId: string, eventBus: ExecutionEventBus) => {
        await options.onCancel?.(taskId);
        const contextId = this.taskContextIds.get(taskId) ?? '';
        const adapter = new A2aEventAdapter(eventBus, taskId, contextId);
        adapter.status(taskId, TaskState.TASK_STATE_CANCELED);
        adapter.task({
          id: taskId,
          contextId,
          status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: undefined },
          artifacts: [],
          history: [],
          metadata: {},
        });
      },
    };
    return new DefaultRequestHandler(agentCard, taskStore, executor);
  }

  /** 导出的 AgentCard（能力声明 → 卡片）。 */
  get agentCard() {
    return toAgentCard(this.capabilities);
  }

  /** 获取 AgentCard（SDK 请求处理器视角）。 */
  getAgentCard(): Promise<import('@a2a-js/sdk').AgentCard> {
    return this.requestHandler.getAgentCard();
  }

  /** 探测视角的能力视图（本地导出的内容）。 */
  probe(url: string) {
    return fromAgentCard(this.agentCard, url);
  }

  /** SDK A2A 请求处理器（供门面装配 Express 中间件）。 */
  get handler(): A2ARequestHandler {
    return this.requestHandler;
  }

  /** 认证校验器（转成 SDK `UserBuilder` 供门面装配）。 */
  get userBuilder() {
    return createA2aUserBuilder(
      this.exportOptions.auth === undefined ? {} : { verify: this.exportOptions.auth },
    );
  }
}