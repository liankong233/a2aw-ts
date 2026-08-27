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
 * 认证头（credential）的提供与解析。
 *
 * 所有协议最终都以「往请求头里塞认证头」为落点（ACP 的 `Authorization`、
 * A2A 的 `Authorization` / `X-API-Key` 等）。这里提供统一的最小抽象：
 * {@link AuthHeaderProvider} 每次请求动态返回认证头，便于对接密钥库
 * （`secretRef` 解析、OAuth 换取 token 等）。
 *
 * {@link AgentAuthHeaders} 与 {@link extractBearerToken} 是协议无关的
 * 请求头视图（实现侧 `auth.verify` 的入参类型），具体协议的头结构由
 * binding 层在转换时对齐。
 *
 * @packageDocumentation
 */

/** Authorization 请求头名。 */
export const AUTHORIZATION_HEADER = 'authorization';

/** WWW-Authenticate 响应头名（401 挑战提示）。 */
export const WWW_AUTHENTICATE_HEADER = 'www-authenticate';

/**
 * 协议无关的请求头视图（实现侧凭据校验的入参）。
 *
 * 与主流协议的头结构同形（值可为字符串或字符串数组），`readonly` 只读。
 */
export type AgentAuthHeaders = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

/**
 * 从请求头解析 Bearer 令牌；缺失或非 Bearer 返回 null。
 *
 * 头值可能是数组，按规范取第一个。
 */
export function extractBearerToken(headers: AgentAuthHeaders): string | null {
  const authorization = headers[AUTHORIZATION_HEADER];
  if (Array.isArray(authorization)) {
    return /^Bearer\s+(.+)$/i.exec(authorization[0] ?? '')?.[1] ?? null;
  }
  if (typeof authorization !== 'string') {
    return null;
  }
  return /^Bearer\s+(.+)$/i.exec(authorization.trim())?.[1] ?? null;
}

/** 可能直接返回值的异步函数。 */
type MaybePromise<T> = T | Promise<T>;

/**
 * 认证头提供器：每次请求时被调用，返回要附加的请求头。
 *
 * 可以返回静态对象，也可以每次动态解析（如从密钥库读取、刷新 token）；
 * 返回 `null`/`undefined` 表示当前没有可用凭据（视为不附加认证头）。
 */
export type AuthHeaderProvider = () => MaybePromise<Record<string, string> | null | undefined>;

/** 认证头的静态来源。 */
export type AuthHeaders = Readonly<Record<string, string>>;

/** 恒等验证器：静默丢弃 provider 抛出的解析错误。 */
export async function resolveAuthHeaders(
  provider: AuthHeaderProvider | AuthHeaders,
): Promise<Record<string, string>> {
  const value =
    typeof provider === 'function' ? await (provider as AuthHeaderProvider)() : provider;
  if (value === null || value === undefined) {
    return {};
  }
  return value as Record<string, string>;
}

/**
 * Bearer 令牌解析器：给定解析函数，产出 `Authorization: Bearer <token>` 头。
 *
 * 解析函数返回 null/undefined 表示当前无可用令牌（视为无认证头），
 * 抛出异常表示凭据源故障（由调用方决定是否放行为未认证）。
 */
export function bearerTokenProvider(
  resolveToken: () => Promise<string | null | undefined> | string | null | undefined,
): AuthHeaderProvider {
  return async (): Promise<Record<string, string>> => {
    const token = await resolveToken();
    if (token === null || token === undefined || token === '') {
      return {};
    }
    return { authorization: `Bearer ${token}` };
  };
}