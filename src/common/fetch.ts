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
 * 自定义 fetch 替换（设计文档铁律 2 的落地点）。
 *
 * Codepre 要求所有出网请求统一注入 `NetworkClient.fetch`（代理解析 +
 * 流量统计 + 审计）。本模块提供两个协议的 fetch 替换入口类型，以及
 * 「给每个请求附加认证头」的包装器。
 *
 * @packageDocumentation
 */

import { resolveAuthHeaders, type AuthHeaderProvider, type AuthHeaders } from './auth.ts';

/** 可注入的 fetch 实现（与标准 `fetch` 同签名）。 */
export type FetchLike = typeof globalThis.fetch;

/** 默认 fetch 实现，未显式注入时使用。 */
export const defaultFetch: FetchLike = globalThis.fetch;

/**
 * 包装 fetch：为每个请求附加认证头，然后委托给底层实现。
 *
 * @param fetchImpl - 底层 fetch（可以继续被其他中间件包装，形成注入链）。
 * @param auth - 认证头来源；每次请求动态求值，保证 token 刷新后立即生效。
 */
export function withAuthHeaders(
  fetchImpl: FetchLike,
  auth: AuthHeaderProvider | AuthHeaders,
): FetchLike {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(await resolveAuthHeaders(auth))) {
      headers.set(name, value);
    }
    return fetchImpl(input, { ...init, headers });
  };
}

/**
 * 判断一次 fetch 调用是否需要触发认证挑战（401/403）。
 *
 * 供实现「挑战 → 刷新凭据 → 重试」的客户端逻辑复用。
 */
export function isChallengeResponse(status: number): boolean {
  return status === 401 || status === 403;
}