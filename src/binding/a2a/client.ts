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
 * A2A 客户端授权封装。
 *
 * 职责：
 *
 * 1. **自定义 fetch 替换**：`ClientFactory` 的 AgentCard 获取（
 *    `DefaultAgentCardResolver`）与 JSON-RPC / REST 传输（
 *    `JsonRpcTransportFactory` / `RestTransportFactory`）统一注入
 *    调用方 fetch（设计文档铁律 2：`NetworkClient.fetch`）。
 * 2. **认证挑战**：把统一的 {@link AuthHeaderProvider} 转成 SDK 的
 *    {@link AuthenticationHandler}，经 `createAuthenticatingFetchWithRetry`
 *    挂到 fetch 链上——401/403（`WWW-Authenticate`）时自动重试，
 *    支持 OAuth 等「挑战 → 换新凭据 → 重试 → 持久化」流程。
 *
 * @packageDocumentation
 */

import {
  ClientFactory,
  createAuthenticatingFetchWithRetry,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  type AuthenticationHandler,
  type Client,
  type HttpHeaders,
} from '@a2a-js/sdk/client';
import { isChallengeResponse, withAuthHeaders, defaultFetch, type FetchLike } from '../../common/fetch.ts';
import { resolveAuthHeaders, type AuthHeaderProvider, type AuthHeaders } from '../../common/auth.ts';

/** {@link createA2aClientFactory} 的选项。 */
export type A2aClientOptions = {
  /**
   * 自定义 fetch 替换（AgentCard 获取 + JSON-RPC/REST 传输统一注入）。
   * 默认 `globalThis.fetch`。
   */
  readonly fetch?: FetchLike;
  /**
   * 认证来源：统一 {@link AuthHeaderProvider}（自动适配为 SDK 的
   * `AuthenticationHandler`，含 401/403 挑战重试），或直接给 SDK 原生
   * `AuthenticationHandler`（需要完全自定义挑战逻辑时）。
   */
  readonly auth?: AuthHeaderProvider | AuthHeaders | AuthenticationHandler;
  /**
   * 启用 v0.3 兼容层（老协议 AgentCard/方法名自动适配）。
   * 透传 SDK `legacyCompat` 选项。
   */
  readonly legacyCompat?: boolean;
};

/** 判断值是否为 SDK 的 `AuthenticationHandler`（对象形态，区别函数形态的 provider）。 */
function isAuthenticationHandler(value: unknown): value is AuthenticationHandler {
  return typeof value === 'object' && value !== null && 'headers' in value;
}

/**
 * 把统一 {@link AuthHeaderProvider} 适配为 SDK 的 `AuthenticationHandler`：
 *
 * - `headers()` 每次请求前求值，token 刷新即时生效；
 * - `shouldRetryWithHeaders()` 在 401/403 时返回当前凭据头，触发一次重试；
 * - `onSuccessfulRetry()` 空实现（凭据由 provider 自管，无需持久化）。
 */
export function createA2aAuthenticationHandler(
  auth: AuthHeaderProvider | AuthHeaders,
): AuthenticationHandler {
  const supply = async (): Promise<HttpHeaders> => ({ ...(await resolveAuthHeaders(auth)) });
  return {
    headers: supply,
    shouldRetryWithHeaders: async (_request, response) => {
      return isChallengeResponse(response.status) ? supply() : undefined;
    },
    onSuccessfulRetry: async () => {},
  };
}

/**
 * 把自定义 fetch 与认证来源绑成带挑战重试的 fetch 链。
 *
 * 等价于 SDK 的 `createAuthenticatingFetchWithRetry(fetchImpl, handler)`；
 * `auth` 为统一 provider 时自动转换。
 */
export function attachA2aAuth(
  fetchImpl: FetchLike,
  auth: AuthHeaderProvider | AuthHeaders | AuthenticationHandler,
): FetchLike {
  if (isAuthenticationHandler(auth)) {
    return createAuthenticatingFetchWithRetry(fetchImpl, auth);
  }
  return createAuthenticatingFetchWithRetry(fetchImpl, createA2aAuthenticationHandler(auth));
}

/** 构建底层链路：自定义 fetch（或默认） + 可选认证包装。 */
function buildFetch(options: A2aClientOptions): FetchLike {
  const base = options.fetch ?? defaultFetch;
  return options.auth !== undefined ? attachA2aAuth(base, options.auth) : base;
}

/**
 * 创建 A2A 客户端工厂：注入自定义 fetch 与认证链。
 *
 * 默认同时注册 JSON-RPC 与 REST 两个传输工厂，SDK 根据 AgentCard 声明的
 * `ProtocolBinding` 自动选择；AgentCard 解析也走同一个 fetch 链。
 */
export function createA2aClientFactory(options: A2aClientOptions = {}): ClientFactory {
  const fetchImpl = buildFetch(options);
  const legacyCompat = options.legacyCompat === true ? { enabled: true } : undefined;
  return new ClientFactory({
    transports: [
      new JsonRpcTransportFactory({
        fetchImpl,
        ...(legacyCompat !== undefined ? { legacyCompat } : {}),
      }),
      new RestTransportFactory({
        fetchImpl,
        ...(legacyCompat !== undefined ? { legacyCompat } : {}),
      }),
    ],
    cardResolver: new DefaultAgentCardResolver({
      fetchImpl,
      ...(legacyCompat !== undefined ? { legacyCompat } : {}),
    }),
  });
}

/** {@link createA2aClient} 的选项（在 {@link A2aClientOptions} 之上加卡片路径）。 */
export type CreateA2aClientOptions = A2aClientOptions & {
  /** AgentCard 路径；缺省 `/.well-known/agent-card.json`。 */
  readonly cardPath?: string;
};

/**
 * 从 AgentCard URL 创建 A2A 客户端（自定义 fetch + 认证一体）。
 *
 * ```ts
 * const client = await createA2aClient('https://agent.example', {
 *   fetch: networkClient.fetch,
 *   auth: bearerTokenProvider(readSecretRefToken),
 * });
 * await client.sendMessage({ taskId, message: { role: 'user', parts: [...] } });
 * ```
 */
export async function createA2aClient(
  url: string,
  options: CreateA2aClientOptions = {},
): Promise<Client> {
  const factory = createA2aClientFactory(options);
  return options.cardPath === undefined
    ? factory.createFromUrl(url)
    : factory.createFromUrl(url, options.cardPath);
}

/** 以 `withAuthHeaders` + 自定义 fetch 构建静态头链路（无挑战重试的轻量场景）。 */
export function buildA2aFetch(
  fetchImpl: FetchLike,
  auth: AuthHeaderProvider | AuthHeaders,
): FetchLike {
  return withAuthHeaders(fetchImpl, auth);
}

export type { AuthenticationHandler, HttpHeaders } from '@a2a-js/sdk/client';