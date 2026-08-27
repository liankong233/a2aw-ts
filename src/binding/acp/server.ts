/**
 * ACP 服务端授权封装。
 *
 * ACP 的授权分两层，本模块两层都覆盖：
 *
 * 1. **HTTP 层**：`AcpAuthServer` 在把请求交给 SDK 的 `AcpServer` 路由前，
 *    校验 `Authorization` 头——携带了凭据但校验失败直接回 401
 *    （附 `WWW-Authenticate` 挑战头）；未携带凭据的请求放行到协议层，
 *    由 agent 在 `session/new` / `session/load` 里按需返回 `auth_required`。
 * 2. **协议层**：`registerAcpAuthenticate` 注册 `authenticate` 处理器、
 *   `acpAuthRequired` 构造 `auth_required` 错误，供会话处理器做「未认证
 *    即拒绝」的门控。
 *
 * @packageDocumentation
 */

import { methods, RequestError } from '@agentclientprotocol/sdk';
import type { AgentApp, AgentRequestContext } from '@agentclientprotocol/sdk';
import type { AuthenticateRequest, AuthenticateResponse } from '@agentclientprotocol/sdk';
import {
  AcpServer,
  type AcpServerOptions,
  type HandleRequestOptions,
} from '@agentclientprotocol/sdk/experimental/server';

/** 可能直接返回值的异步函数。 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * ACP 凭据校验器：检查请求头并返回主体信息。
 *
 * 返回 `null` 表示凭据缺失或无效。返回的任意非空值作为主体（principal）
 * 传给 {@link AcpAuthServerOptions.onAuthenticated}，供上层记录「哪个连接
 * 是谁」的会话态。
 */
export type AcpCredentialVerifier = (headers: Headers) => MaybePromise<unknown | null>;

/** {@link AcpAuthServer} 的构造选项：SDK 的 `AcpServerOptions` + 授权配置。 */
export type AcpAuthServerOptions = AcpServerOptions & {
  /**
   * 凭据校验器。提供后，凡携带 `Authorization` 头但校验返回 `null` 的请求
   * 一律 401；不提供则完全透传（纯协议层认证）。
   */
  readonly verify?: AcpCredentialVerifier;
  /** 校验通过时的回调（携带主体 + 原始请求），用于记录会话/审计。 */
  readonly onAuthenticated?: (principal: unknown, request: Request) => void;
};

/** 构造 401 响应，附 `WWW-Authenticate` 挑战头（默认 `Bearer`）。 */
export function unauthorizedResponse(challenge: string = 'Bearer'): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': challenge },
  });
}

/** 从 `Authorization` 头解析 Bearer 令牌；不存在或非 Bearer 返回 null。 */
export function parseBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * ACP 服务端传输：带 HTTP 层授权门禁的 {@link AcpServer}。
 *
 * 仅拦截「携带了无效凭据」的请求；未携带凭据的请求照常进入协议层，
 * 由 agent 的 `authenticate` / `auth_required` 流程处理（ACP 规范语义）。
 */
export class AcpAuthServer extends AcpServer {
  private readonly verify?: AcpCredentialVerifier;
  private readonly onAuthenticated?: (principal: unknown, request: Request) => void;

  constructor(options: AcpAuthServerOptions) {
    super(options);
    this.verify = options.verify;
    this.onAuthenticated = options.onAuthenticated;
  }

  /** 处理一个 Streamable HTTP ACP 请求；先过授权门禁再路由。 */
  override async handleRequest(
    request: Request,
    options?: HandleRequestOptions,
  ): Promise<Response> {
    if (this.verify !== undefined && request.headers.has('authorization')) {
      const principal = await this.verify(request.headers);
      if (principal === null) {
        return unauthorizedResponse();
      }
      this.onAuthenticated?.(principal, request);
    }
    return super.handleRequest(request, options);
  }
}

/**
 * `authenticate` 处理器类型：验证/完成一次客户端认证，成功返回空响应。
 *
 * 通常与 HTTP 层校验配合：校验通过即记录连接对应主体，此处返回
 * `{}` 表示认证完成；失败抛 {@link RequestError}（如 `acpAuthRequired`）。
 */
export type AcpAuthenticateHandler = (
  context: AgentRequestContext<AuthenticateRequest>,
) => MaybePromise<AuthenticateResponse | void>;

/** 在 agent 应用上注册协议层 `authenticate` 处理器。 */
export function registerAcpAuthenticate(
  app: AgentApp,
  handler: AcpAuthenticateHandler,
): AgentApp {
  return app.onRequest(methods.agent.authenticate, handler);
}

/**
 * 构造 ACP 的 `auth_required` 错误（JSON-RPC code -32000）。
 *
 * 在 `session/new` / `session/load` 处理器中返回该错误，客户端据此走
 * 认证挑战（先 `authenticate` 再重试）。
 */
export function acpAuthRequired(additionalMessage?: string): RequestError {
  return RequestError.authRequired(undefined, additionalMessage);
}

/** 判断是否为 ACP 的 `auth_required` 错误（code -32000）。 */
export function isAcpAuthRequiredError(error: unknown): boolean {
  return error instanceof RequestError && error.code === -32000;
}