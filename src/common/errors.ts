/**
 * 统一的授权错误类型。
 *
 * ACP 与 A2A 两个协议的错误体系不同（ACP 走 JSON-RPC `RequestError`，
 * A2A 走 HTTP 状态码 + `ErrorDetail`），本包以 {@link AuthError} 收拢
 * 授权相关的可区分错误，供上层按 `code` 分支处理。
 *
 * @packageDocumentation
 */

/** 授权错误码。 */
export type AuthErrorCode =
  /** 请求缺少凭据或凭据无效（HTTP 401 / JSON-RPC auth_required 语义）。 */
  | 'unauthorized'
  /** 凭据有效但主体无权限（HTTP 403）。 */
  | 'forbidden'
  /** 凭据无法获取（密钥缺失、提供器返回 null 等）。 */
  | 'credentials-unavailable'
  /** 服务端要求先走认证挑战（authenticate / challenge-response）。 */
  | 'challenge';

/** 授权错误的构造参数。 */
export interface AuthErrorOptions {
  /** 触发方（便于定位）：如 'acp' / 'a2a'。 */
  readonly source?: string;
  /** 关联的原始错误。 */
  readonly cause?: unknown;
}

/** 授权失败时抛出的统一错误，按 {@link AuthErrorCode} 分支处理。 */
export class AuthError extends Error {
  /** 授权错误码。 */
  readonly code: AuthErrorCode;
  /** 触发方：'acp' / 'a2a'，便于日志定位。 */
  readonly source?: string;

  constructor(code: AuthErrorCode, message: string, options: AuthErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AuthError';
    this.code = code;
    this.source = options.source;
  }
}

/** 判断未知错误是否为 {@link AuthError}。 */
export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError;
}