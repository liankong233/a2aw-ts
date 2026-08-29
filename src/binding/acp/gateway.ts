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
 * ACP 网关绑定：把统一能力模型装配为 ACP（Agent Client Protocol）服务端。
 *
 * 会话语义到能力模型的映射：
 *
 * - `initialize` → 能力声明的元信息（认证方式按是否配置 `verify` 暴露）；
 * - `authenticate` → HTTP 层门禁已校验凭据，此处直接确认；
 * - `session/new` / `session/load` → 内存会话登记（不持久化）；
 * - `session/prompt` → 以 sessionId 为任务 id 调用执行器，文本经
 *   {@link ImplEventEmitter} 发出的内容以 `agent_message_chunk` 回推，
 *   终态映射为 `stopReason`（failed / rejected → `refusal`）。
 *
 * 凭据门禁在 HTTP 层（{@link unauthorizedResponse} 语义）：配置了
 * `verify` 时，携带无效凭据的请求一律 401；未携带凭据的请求放行到协议
 * 层。校验通过的主体经 AsyncLocalStorage 透传给 `session/prompt` 处理
 * （同一请求的处理链路内有效）。
 *
 * @packageDocumentation
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';
import {
  agent,
  methods,
  PROTOCOL_VERSION,
  type AgentApp,
} from '@agentclientprotocol/sdk';
import {
  AcpServer,
  type AcpServerOptions,
  type HandleRequestOptions,
} from '@agentclientprotocol/sdk/experimental/server';
import { createNodeHttpHandler } from '@agentclientprotocol/sdk/experimental/node';
import type { AgentAuthHeaders } from '../../common/auth.ts';
import type { CapabilityDeclaration } from '../../model/capability.ts';
import { messageText, textMessage } from '../../model/message.ts';
import type {
  ImplEventEmitter,
  ImplExecutor,
  AgentCredentialVerifier,
} from '../../impl/adaptor.ts';
import { unauthorizedResponse } from './server.ts';

/** 校验通过的主体（请求处理链路内可见）。 */
interface RequestPrincipal {
  readonly userName?: string;
}

/** 主体存储：门禁校验后写入，session/prompt 处理器读取。 */
const principalStorage = new AsyncLocalStorage<RequestPrincipal>();

/** web Headers → 协议无关请求头视图。 */
function headersToRecord(headers: Headers): AgentAuthHeaders {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

/**
 * 创建 ACP 网关绑定：返回可直接挂载的 Express 中间件（内部为 Streamable
 * HTTP 的 node 处理器）。
 *
 * ```ts
 * app.use('/acp', createAcpGatewayBinding({ capabilities, implement, verify }));
 * ```
 */
export function createAcpGatewayBinding(options: {
  /** 统一能力声明（initialize 元信息来源）。 */
  readonly capabilities: CapabilityDeclaration;
  /** 统一执行器（session/prompt 的处理入口）。 */
  readonly implement: ImplExecutor;
  /** 凭据校验器（可选；配置后启用 HTTP 层门禁）。 */
  readonly verify?: AgentCredentialVerifier;
}): RequestHandler {
  const app = buildAgentApp(options.capabilities, options.implement);
  const server = new PrincipalAwareAcpServer({
    agent: app,
    ...(options.verify !== undefined ? { verify: options.verify } : {}),
  });
  // node 请求监听器与 Express 中间件同形（少一个 next 参数）
  return createNodeHttpHandler(server) as unknown as RequestHandler;
}

/** 带凭据门禁与主体透传的 ACP 服务端。 */
class PrincipalAwareAcpServer extends AcpServer {
  private readonly verify?: AgentCredentialVerifier;

  constructor(options: AcpServerOptions & { readonly verify?: AgentCredentialVerifier }) {
    super(options);
    this.verify = options.verify;
  }

  override async handleRequest(
    request: Request,
    handlerOptions?: HandleRequestOptions,
  ): Promise<Response> {
    if (this.verify === undefined) {
      return super.handleRequest(request, handlerOptions);
    }
    if (!request.headers.has('authorization')) {
      // 未携带凭据：放行到协议层（ACP 规范语义），主体未知
      return super.handleRequest(request, handlerOptions);
    }
    let principal: { userName: string } | undefined;
    try {
      const verified = await this.verify(headersToRecord(request.headers));
      if (verified === null || verified === undefined) {
        return unauthorizedResponse();
      }
      principal = verified;
    } catch {
      // 校验器自身抛错（凭据后端故障等）按无法确认身份处理：fail-closed；
      // 交由 ACP node 处理器透传会把错误明文回给客户端，这里自行拦截
      return unauthorizedResponse();
    }
    return principalStorage.run({ userName: principal.userName }, () =>
      super.handleRequest(request, handlerOptions),
    );
  }
}

/** 把能力模型装配为 ACP Agent 应用。 */
function buildAgentApp(capabilities: CapabilityDeclaration, implement: ImplExecutor): AgentApp {
  const authMethods =
    capabilities.auth !== undefined && capabilities.auth.length > 0
      ? [{ id: 'bearer', name: 'Bearer Token' }]
      : [];

  return agent({ name: capabilities.name })
    .onRequest(methods.agent.initialize, async () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
      authMethods,
    }))
    .onRequest(methods.agent.authenticate, async () => ({}))
    // 会话不持久化、不校验：session/new 仅分配 id，session/load 一律
    // 返回未加载（执行器本身无会话状态，prompt 每轮独立）
    .onRequest(methods.agent.session.new, async () => ({
      sessionId: crypto.randomUUID(),
    }))
    .onRequest(methods.agent.session.load, async () => undefined)
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      const sessionId = ctx.params.sessionId;
      const prompt = ctx.params.prompt
        .filter((block) => block.type === 'text')
        .map((block) => (block as { type: 'text'; text: string }).text)
        .join('\n');
      let stopReason: 'end_turn' | 'refusal' = 'end_turn';
      const principal = principalStorage.getStore();

      // 发射器的异步回推集中等待，保证 chunk 先于 prompt 响应到达
      const pending: Array<Promise<void>> = [];
      const pushChunk = (text: string) => {
        if (text === '') {
          return;
        }
        pending.push(
          ctx.client
            .notify(methods.client.session.update, {
              sessionId,
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
            })
            .catch(() => {}),
        );
      };
      const emit: ImplEventEmitter = {
        text: (text) => pushChunk(text),
        message: (message) => pushChunk(messageText(message) ?? ''),
        task: () => {},
        status: (_taskId, state, message) => {
          if ((state === 'failed' || state === 'rejected') && stopReason === 'end_turn') {
            stopReason = 'refusal';
          }
          if (message !== undefined) {
            pushChunk(messageText(message) ?? '');
          }
        },
        artifact: (_taskId, artifact) => {
          const text = (artifact.parts ?? [])
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join('\n');
          pushChunk(text);
        },
      };

      await implement(
        {
          taskId: sessionId,
          contextId: sessionId,
          message: textMessage(prompt),
          user: principal?.userName !== undefined ? { userName: principal.userName } : undefined,
          task: undefined,
        },
        emit,
      );
      await Promise.all(pending);
      return { stopReason };
    });
}