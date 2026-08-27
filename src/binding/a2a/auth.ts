/**
 * A2A 服务端授权助手：请求头 → 认证主体（User）。
 *
 * 授权统一落在 SDK 的 `UserBuilder` 上：每个请求先解析出 `User`
 * （`isAuthenticated` + `userName`），供 `ServerCallContext` 与请求
 * 处理器使用。校验失败/抛错一律降级为 `UnauthenticatedUser`（不拒绝
 * 请求——是否拒绝由各方法处理器决定，与 A2A 消息级认证语义一致）。
 *
 * @packageDocumentation
 */

import { UnauthenticatedUser } from '@a2a-js/sdk/server';
import { UserBuilder } from '@a2a-js/sdk/server/express';
import type { User, RequestHeaders } from '@a2a-js/sdk/server';

/** 可能直接返回值的异步函数。 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * A2A 凭据校验器：检查请求头并返回主体。
 *
 * 返回 `null`/undefined 表示未认证（映射为 `UnauthenticatedUser`）；
 * `userName` 作为 `User.userName` 暴露给请求处理器。
 */
export type A2aCredentialVerifier = (
  headers: RequestHeaders,
) => MaybePromise<{ userName: string } | null | undefined>;

export { extractBearerToken } from '../../common/auth.ts';

/** {@link createA2aUserBuilder} 的选项。 */
export type CreateA2aUserBuilderOptions = {
  /**
   * 凭据校验器。省略时一律返回 `UnauthenticatedUser`
   * （等价于 SDK 的 `UserBuilder.noAuthentication`）。
   */
  readonly verify?: A2aCredentialVerifier;
};

/**
 * 创建 A2A 服务端的 `UserBuilder`。
 *
 * 每个请求调用 `verify` 解析主体；校验失败/未认证返回
 * `UnauthenticatedUser`；校验器抛错视为未认证，不向外冒泡。
 */
export function createA2aUserBuilder(options: CreateA2aUserBuilderOptions = {}): UserBuilder {
  return async (req) => {
    if (options.verify === undefined) {
      return new UnauthenticatedUser();
    }
    try {
      const principal = await options.verify(req.headers as unknown as RequestHeaders);
      if (principal === null || principal === undefined) {
        return new UnauthenticatedUser();
      }
      return { isAuthenticated: true, userName: principal.userName } satisfies User;
    } catch {
      return new UnauthenticatedUser();
    }
  };
}

export { UserBuilder } from '@a2a-js/sdk/server/express';
export type { A2ARequestHandler } from '@a2a-js/sdk/server';
export { UnauthenticatedUser } from '@a2a-js/sdk/server';
export type { RequestHeaders, User } from '@a2a-js/sdk/server';