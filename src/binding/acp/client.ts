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
 * ACP 客户端授权封装。
 *
 * 两个职责：
 *
 * 1. **传输层凭据 + fetch 替换**：{@link createAcpClientStream} 把
 *    认证头（Bearer / API-Key）与自定义 fetch（如 `NetworkClient.fetch`）
 *    注入 SDK 的 HTTP 流，每次请求动态求值，token 刷新后即时生效。
 * 2. **认证挑战流程**：{@link AcpClientAuth} 提供 `authenticate` 调用封装
 *    与 {@link pickAcpAuthMethod} 选方法助手，配合 `auth_required`
 *    错误（code -32000）实现「初始化 → 认证 → 重试」的完整闭环。
 *
 * @packageDocumentation
 */

import { createHttpStream, type HttpStreamOptions } from '@agentclientprotocol/sdk/experimental/http-client';
import { methods, RequestError, type ClientContext, type Stream } from '@agentclientprotocol/sdk';
import type {
  AuthenticateResponse,
  AuthMethod,
  AuthMethodAgent,
  InitializeResponse,
} from '@agentclientprotocol/sdk';
import type { AcpCookieStore } from '@agentclientprotocol/sdk/experimental/http-client';
import { withAuthHeaders, defaultFetch, type FetchLike } from '../../common/fetch.ts';
import type { AuthHeaderProvider, AuthHeaders } from '../../common/auth.ts';

/** {@link createAcpClientStream} 的选项。 */
export type AcpClientStreamOptions = {
  /**
   * 自定义 fetch 替换（设计文档铁律 2：注入 `NetworkClient.fetch`）。
   * 默认 `globalThis.fetch`。
   */
  readonly fetch?: FetchLike;
  /** 认证头来源：每次请求附加（Bearer / API-Key 等）。 */
  readonly auth?: AuthHeaderProvider | AuthHeaders;
  /** 附加的固定请求头（会与 `auth` 合并，`auth` 优先）。 */
  readonly headers?: Record<string, string>;
  /** Cookie 策略（透传 SDK）。 */
  readonly cookies?: HttpStreamOptions['cookies'];
  /** 复用的联系 cookie 存储（透传 SDK，重连保留亲和性）。 */
  readonly cookieStore?: AcpCookieStore;
};

/**
 * 创建 ACP 客户端 HTTP 流。
 *
 * 认证头经 {@link withAuthHeaders} 注入自定义 fetch 链，因此无论
 * `fetch` 是否被替换，凭据都在交给底层实现前附加。
 */
export function createAcpClientStream(
  serverUrl: string,
  options: AcpClientStreamOptions = {},
): Stream {
  const fetchImpl = options.fetch ?? defaultFetch;
  const fetch_ = options.auth ? withAuthHeaders(fetchImpl, options.auth) : fetchImpl;
  const headers: Record<string, string> = { ...options.headers };
  return createHttpStream(serverUrl, {
    ...(options.cookies !== undefined ? { cookies: options.cookies } : {}),
    ...(options.cookieStore !== undefined ? { cookieStore: options.cookieStore } : {}),
    ...(fetch_ !== defaultFetch ? { fetch: fetch_ } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });
}

/**
 * 从 `initialize` 响应选择可用的认证方法（跳过 `terminal` 型——该型由
 * 客户端在交互终端里重跑 agent，不能通过 `authenticate` 调用）。
 *
 * 可选 `preferredId` 优先；缺省取第一个非 terminal 方法。
 */
export function pickAcpAuthMethod(
  response: InitializeResponse,
  preferredId?: string,
): AuthMethodAgent | undefined {
  const methods = response.authMethods ?? [];
  // AuthMethod 联合里只有 terminal 型带 `type` 判别字段；
  // `AuthMethodAgent` 没有该字段，用 `'type' in` 收窄出可经
  // `authenticate` 调用的方法。
  const agentMethods = methods.filter(
    (method): method is AuthMethodAgent => !('type' in method),
  );
  if (agentMethods.length === 0) {
    return undefined;
  }
  return (
    (preferredId !== undefined
      ? agentMethods.find((method) => method.id === preferredId)
      : undefined) ?? agentMethods[0]
  );
}

/**
 * ACP 客户端认证助手：持有凭据与自定义 fetch，提供挑战流程的封装。
 *
 * 典型用法：
 *
 * ```ts
 * const auth = new AcpClientAuth({ auth: bearerTokenProvider(readToken) });
 * const stream = auth.stream('https://agent.example');
 * await app.connectWith(stream, async (ctx) => {
 *   await auth.authenticate(ctx);           // 若服务端要求认证
 *   const session = await ctx.buildSession('/work').start();
 *   // ...
 * });
 * ```
 */
export class AcpClientAuth {
  /** 自定义 fetch 替换。 */
  readonly fetch?: FetchLike;
  /** 认证头来源。 */
  readonly auth?: AuthHeaderProvider | AuthHeaders;

  constructor(options: AcpClientStreamOptions = {}) {
    this.fetch = options.fetch;
    this.auth = options.auth;
  }

  /** 按本助手的 `fetch`/`auth` 配置创建客户端 HTTP 流。 */
  stream(serverUrl: string, options: Omit<AcpClientStreamOptions, 'fetch' | 'auth'> = {}): Stream {
    return createAcpClientStream(serverUrl, { fetch: this.fetch, auth: this.auth, ...options });
  }

  /**
   * 对当前连接发起 `authenticate` 挑战。
   *
   * `methodId` 必填：取自 `initialize` 响应中的 `authMethods`
   * （可用 {@link pickAcpAuthMethod} 挑选，跳过 terminal 型）。
   * 服务端要求认证时，典型调用点是捕获到 `auth_required`（code -32000）
   * 错误之后。
   */
  async authenticate(context: ClientContext, methodId: string): Promise<AuthenticateResponse> {
    return context.request(methods.agent.authenticate, { methodId });
  }
}

/** 判断错误是否为 ACP 的 `auth_required`（code -32000）。 */
export function isAcpAuthRequiredError(error: unknown): boolean {
  return error instanceof RequestError && error.code === -32000;
}