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
 * {@link A2aConnectClient}：连接外部 A2A Agent 的客户端（内部 → 外部）。
 *
 * 能力：
 *
 * - **探测** {@link A2aConnectClient.probe}：拉取并解析远端 AgentCard，
 *   产出统一能力视图 {@link A2aProbeResult}（skills / capabilities /
 *   认证要求 / 传输绑定），对应设计文档 §4.14 的 `/api/a2a/probe`；
 * - **任务调用**：`sendMessage` / `sendMessageStream` / `getTask` /
 *   `cancelTask` 等，底层复用 {@link createA2aClient} 的工厂链路——
 *   AgentCard 获取、JSON-RPC/REST 传输统一注入自定义 fetch，认证经
 *   `attachA2aAuth` 获得 401/403 挑战重试；
 * - **能力缓存**：AgentCard 首次拉取后缓存，`probe()` 与建连共用。
 *
 * @packageDocumentation
 */

import { DefaultAgentCardResolver, type Client as A2aSDKClient } from '@a2a-js/sdk/client';
import type {
  AgentCard,
  Message,
  SendMessageConfiguration,
  SendMessageRequest,
  Task,
  TaskState,
  TaskStatus,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  SendMessageResult,
  StreamResponse,
} from '@a2a-js/sdk';
import { fromAgentCard, type A2aProbeResult } from './capabilities.ts';
import { createA2aClient, type A2aClientOptions } from './client.ts';

/** 发送消息的便捷入参（缺省字段在内部补齐，保持调用方简洁）。 */
export type A2aSendMessageInput = {
  /** 用户消息。 */
  readonly message: Message;
  /** 续聊：既有任务 id；首轮可省略（由服务端分配）。 */
  readonly taskId?: string;
  /** 多轮会话上下文 id；首轮可省略。 */
  readonly contextId?: string;
  /** 发送配置（transmission / pushNotificationConfig 等），可选。 */
  readonly configuration?: SendMessageConfiguration;
  /** 附加元数据。 */
  readonly metadata?: Record<string, unknown>;
};

/** {@link A2aConnectClient} 的选项：复用 {@link A2aClientOptions} + 卡片路径。 */
export type A2aConnectClientOptions = A2aClientOptions & {
  /** AgentCard 路径；缺省 `/.well-known/agent-card.json`。 */
  readonly cardPath?: string;
};

/** 把便捷入参组装为 SDK 的完整请求对象。 */
function buildSendMessageRequest(input: A2aSendMessageInput): SendMessageRequest {
  return {
    tenant: '',
    configuration: input.configuration,
    metadata: input.metadata,
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
    message: input.message,
  };
}

/**
 * A2A 连接客户端：内部模块探测并调用外部 A2A Agent。
 *
 * ```ts
 * const connect = new A2aConnectClient('https://agent.example', {
 *   fetch: networkClient.fetch,
 *   auth: bearerTokenProvider(readToken),
 * });
 * const probe = await connect.probe();          // 统一能力视图
 * const task = await connect.sendMessage({ message, taskId: probe... });
 * ```
 */
export class A2aConnectClient {
  readonly url: string;
  private readonly options: A2aConnectClientOptions;
  private sdkClient?: A2aSDKClient;
  private cachedCard?: AgentCard;

  constructor(url: string, options: A2aConnectClientOptions = {}) {
    this.url = url;
    this.options = options;
  }

  /**
   * 探测远端：拉取 AgentCard 并解析为统一能力视图。
   *
   * 走注入的 fetch（含认证头），首次拉取后缓存；失败抛错由调用方处理
   * （如登记流程里标记「不可连接」）。
   */
  async probe(): Promise<A2aProbeResult> {
    const card = await this.getAgentCard();
    return fromAgentCard(card, this.url);
  }

  /** 获取远端 AgentCard（缓存；走注入的 fetch 与认证）。 */
  async getAgentCard(): Promise<AgentCard> {
    if (this.cachedCard !== undefined) {
      return this.cachedCard;
    }
    const card = await (await this.client()).getAgentCard();
    this.cachedCard = card;
    return card;
  }

  /** 底层 SDK 客户端（惰性创建并缓存；同 probe 共用一条 fetch/auth 链）。 */
  private async client(): Promise<A2aSDKClient> {
    if (this.sdkClient === undefined) {
      this.sdkClient = await createA2aClient(this.url, {
        ...this.options,
        cardPath: undefined,
      });
    }
    return this.sdkClient;
  }

  /** 发送消息（阻塞至终态或中间态）。 */
  async sendMessage(input: A2aSendMessageInput): Promise<SendMessageResult> {
    return (await this.client()).sendMessage(buildSendMessageRequest(input));
  }

  /** 流式发送：产出一串 StreamResponse（task / statusUpdate / artifactUpdate）。 */
  async *sendMessageStream(
    input: A2aSendMessageInput,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    yield* (await this.client()).sendMessageStream(buildSendMessageRequest(input));
  }

  /** 查询任务。 */
  async getTask(taskId: string): Promise<Task> {
    return (await this.client()).getTask({ id: taskId, tenant: '' });
  }

  /** 取消任务（幂等）。 */
  async cancelTask(taskId: string): Promise<Task> {
    return (await this.client()).cancelTask({ id: taskId, tenant: '', metadata: undefined });
  }

  /** 订阅既有任务的事件流。 */
  async *resubscribeTask(taskId: string): AsyncGenerator<StreamResponse, void, undefined> {
    yield* (await this.client()).resubscribeTask({ id: taskId, tenant: '' });
  }

  /** 底层 SDK 客户端（需要完整方法集时透明访问）。 */
  async sdk(): Promise<A2aSDKClient> {
    return this.client();
  }
}

export type {
  AgentCard as A2aAgentCard,
  Message as A2aMessage,
  SendMessageConfiguration,
  SendMessageRequest,
  StreamResponse,
  Task as A2aTask,
  TaskArtifactUpdateEvent,
  TaskState,
  TaskStatus,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
export type { Client as A2aSDKClient } from '@a2a-js/sdk/client';