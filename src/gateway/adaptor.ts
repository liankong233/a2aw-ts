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
 * {@link A2aGateway}：统一对外网关——把同一份能力实现（能力声明 + 执行器
 * + 认证校验）经可配置的多协议传输同时向外暴露。
 *
 * 传输配置（{@link GatewayTransports}）：
 *
 * - **A2A**：AgentCard 发现 + JSON-RPC/REST 任务调用（复用实现侧适配器）；
 * - **ACP**：会话式编码代理协议，`session/prompt` 驱动执行器、
 *   `agent_message_chunk` 流式回推；
 * - **MCP**：技能 → 工具，`tools/call` 驱动执行器（无状态 JSON-RPC）。
 *
 * 三种传输共享同一执行器与凭据校验器；挂载路径见
 * {@link GATEWAY_DEFAULT_PATHS}，可按传输覆盖。`transports` 缺省为全开；
 * 显式给出时只启用列出的传输。
 *
 * @packageDocumentation
 */

import type { Express } from 'express';
import { toCapabilityView, type CapabilityDeclaration, type CapabilityView } from '../model/capability.ts';
import {
  A2aImplAdaptor,
  type AgentCredentialVerifier,
  type ImplExecutor,
} from '../impl/adaptor.ts';
import { createAcpGatewayBinding } from '../binding/acp/gateway.ts';
import { createMcpGatewayBinding } from '../binding/mcp/server.ts';

/** 网关缺省挂载路径。 */
export const GATEWAY_DEFAULT_PATHS = {
  /** ACP（Streamable HTTP）。 */
  acp: '/acp',
  /** MCP（Streamable HTTP JSON-RPC）。 */
  mcp: '/mcp',
} as const;

/** 单个传输的挂载配置。 */
export interface GatewayTransportOptions {
  /** 挂载路径（缺省见 {@link GATEWAY_DEFAULT_PATHS}）。 */
  readonly path?: string;
}

/**
 * 传输配置：键为协议名，白名单语义——`transports` 缺省（整体不传）时
 * 三协议全开；显式给出时只启用列出的传输（未列出的关闭），值可为
 * `true` 或对象形态指定挂载路径。
 */
export interface GatewayTransports {
  /** A2A 协议（卡片发现 + JSON-RPC/REST 任务调用；端点固定三件套）。 */
  readonly a2a?: boolean;
  /** ACP 协议（会话式提示驱动）。 */
  readonly acp?: boolean | GatewayTransportOptions;
  /** MCP 协议（技能 → 工具）。 */
  readonly mcp?: boolean | GatewayTransportOptions;
}

/** {@link A2aGateway} 的构造选项。 */
export interface GatewayOptions {
  /** 统一能力声明：所有传输共享的导出内容来源。 */
  readonly capabilities: CapabilityDeclaration;
  /** 统一执行器：所有传输共享的处理入口。 */
  readonly implement: ImplExecutor;
  /** 认证校验器（可选）：所有传输共享；各协议的门禁语义见对应 binding。 */
  readonly auth?: { readonly verify?: AgentCredentialVerifier };
  /**
   * 传输配置；缺省 `{ a2a: true, acp: true, mcp: true }` 全开，
   * 显式给出时只启用列出的传输。
   */
  readonly transports?: GatewayTransports;
  /** 能力声明里的 A2A 导出端点（透传给 A2A 绑定）。 */
  readonly exportUrl?: string;
}

/** 已启用的传输名。 */
export type GatewayTransportName = 'a2a' | 'acp' | 'mcp';

/** 解析单个传输的启用状态与路径（value 为 undefined 表示该传输未启用）。 */
function resolveTransport(
  value: boolean | GatewayTransportOptions | undefined,
  defaultPath: string,
): { enabled: boolean; path?: string } {
  if (value === undefined || value === false) {
    return { enabled: false };
  }
  if (value === true) {
    return { enabled: true, path: defaultPath };
  }
  return { enabled: true, path: value.path ?? defaultPath };
}

/**
 * 统一对外网关：一份实现，多协议暴露。
 *
 * ```ts
 * const gateway = new A2aGateway({
 *   capabilities: { name: 'codepre', description: '...', skills: [...] },
 *   implement: async ({ taskId, message }, emit) => {
 *     emit.text(`已收到：${messageText(message)}`);
 *     emit.status(taskId, 'completed');
 *   },
 *   auth: { verify: (headers) => extractBearerToken(headers) ? { userName: 'codepre' } : null },
 *   transports: { a2a: true, acp: { path: '/agent' }, mcp: true },
 * });
 * gateway.mount(app);
 * ```
 */
export class A2aGateway {
  /** 已启用的传输（构造时确定）。 */
  readonly transports: readonly GatewayTransportName[];
  private readonly impl?: A2aImplAdaptor;
  private readonly bindings: {
    capabilities: CapabilityDeclaration;
    implement: ImplExecutor;
    verify?: AgentCredentialVerifier;
  };
  private readonly paths: { acp: string; mcp: string };

  constructor(options: GatewayOptions) {
    this.bindings = {
      capabilities: options.capabilities,
      implement: options.implement,
      ...(options.auth?.verify !== undefined ? { verify: options.auth.verify } : {}),
    };
    // 白名单语义：未提供 transports 时全开；显式给出时只启用列出的传输
    const requested = options.transports;
    const enabledByDefault = requested === undefined;
    const a2a = enabledByDefault || requested.a2a === true;
    const acp = resolveTransport(enabledByDefault ? true : requested.acp, GATEWAY_DEFAULT_PATHS.acp);
    const mcp = resolveTransport(enabledByDefault ? true : requested.mcp, GATEWAY_DEFAULT_PATHS.mcp);

    this.transports = [
      ...(a2a ? (['a2a'] as const) : []),
      ...(acp.enabled ? (['acp'] as const) : []),
      ...(mcp.enabled ? (['mcp'] as const) : []),
    ];
    this.paths = { acp: acp.path ?? GATEWAY_DEFAULT_PATHS.acp, mcp: mcp.path ?? GATEWAY_DEFAULT_PATHS.mcp };
    if (a2a) {
      this.impl = new A2aImplAdaptor({
        capabilities: options.capabilities,
        implement: options.implement,
        ...(options.auth !== undefined ? { auth: options.auth } : {}),
        ...(options.exportUrl !== undefined ? { exportUrl: options.exportUrl } : {}),
      });
    }
  }

  /** 本地能力视图（能力声明 → 探测结果形态，与协议无关）。 */
  probe(url: string): CapabilityView {
    return toCapabilityView(url, this.bindings.capabilities);
  }

  /**
   * 挂载到 Express 应用：按启用情况依次挂载各传输的中间件
   * （A2A 三件套 + ACP / MCP 端点）。
   *
   * 注意：各绑定自行读取原始请求体，宿主不要在其之前全局挂 `express.json()`。
   */
  mount(app: Express): this {
    this.impl?.mount(app);
    if (this.transports.includes('acp')) {
      app.use(this.paths.acp, createAcpGatewayBinding(this.bindings));
    }
    if (this.transports.includes('mcp')) {
      app.use(this.paths.mcp, createMcpGatewayBinding(this.bindings));
    }
    return this;
  }
}
