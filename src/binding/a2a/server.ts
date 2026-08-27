/**
 * A2A 服务端门面。
 *
 * - {@link A2aServer}：{@link A2aExportClient} 的 HTTP 门面（facade）——
 *   把导出的能力（AgentCard + 请求处理器 + 授权）装配成三块 Express
 *   中间件（AgentCard 服务 / JSON-RPC / REST），宿主服务挂载即用；
 * - {@link createA2aExpressHandlers}：底层装配函数（`A2aServer` 内部
 *   也用它），需要手动控制挂载路径/请求处理器时可直接使用。
 *
 * 授权助手（`createA2aUserBuilder` / `extractBearerToken`）见 {@link auth}。
 *
 * @packageDocumentation
 */

import type { Express, RequestHandler } from 'express';
import {
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
  type AgentCardProvider,
  type JsonRpcHandlerOptions,
  type RestHandlerOptions,
} from '@a2a-js/sdk/server/express';
import { A2aExportClient, type A2aExportOptions } from './export-client.ts';
import { createA2aUserBuilder, type A2aCredentialVerifier, type MaybePromise } from './auth.ts';

/** {@link A2aServer} 的选项：{@link A2aExportOptions} + 门面级配置。 */
export type A2aServerOptions = A2aExportOptions & {
  /** 卡片声明的 JSON-RPC 端点（覆盖能力声明里的 `url` 缺省值）。 */
  readonly exportUrl?: string;
  /** 启用 v0.3 兼容层（AgentCard 与旧方法名自动适配），缺省关闭。 */
  readonly legacyCompat?: boolean;
};

/** 装配完成的 A2A Express 中间件三元组。 */
export type A2aExpressHandlers = {
  /** AgentCard 服务中间件（挂 `/.well-known/agent-card.json`）。 */
  readonly agentCard: RequestHandler;
  /** JSON-RPC 中间件（挂 `/jsonrpc`）。 */
  readonly jsonRpc: RequestHandler;
  /** REST 中间件（挂 `/api/rest`）。 */
  readonly rest: RequestHandler;
};

/** {@link createA2aExpressHandlers} 的选项。 */
export type A2aExpressServerOptions = {
  /**
   * A2A 请求处理器（消息级方法），同时充当 AgentCard 提供器
   * （SDK 的 `DefaultRequestHandler` 同时实现两者）。
   */
  readonly requestHandler: import('@a2a-js/sdk/server').A2ARequestHandler;
  /** 授权配置；缺省等价于 `UserBuilder.noAuthentication`。 */
  readonly auth?: { verify?: A2aCredentialVerifier };
  /** 启用 v0.3 兼容层（透传 SDK）。 */
  readonly legacyCompat?: boolean;
};

/**
 * 一键装配 A2A 服务端的三块 Express 中间件，并统一注入授权。
 *
 * ```ts
 * const { agentCard, jsonRpc, rest } = createA2aExpressHandlers({
 *   requestHandler: a2aRequestHandler,
 *   auth: { verify: (headers) => ({ userName: extractBearerToken(headers) ?? '' }) },
 * });
 * app.use('/.well-known/agent-card.json', agentCard);
 * app.use('/jsonrpc', jsonRpc);
 * app.use('/api/rest', rest);
 * ```
 */
export function createA2aExpressHandlers(
  options: A2aExpressServerOptions,
): A2aExpressHandlers {
  const userBuilder = createA2aUserBuilder(options.auth);
  const legacyCompat = options.legacyCompat === true ? { enabled: true } : undefined;
  const jsonRpc: JsonRpcHandlerOptions = {
    requestHandler: options.requestHandler,
    userBuilder,
    ...(legacyCompat !== undefined ? { legacyCompat } : {}),
  };
  const rest: RestHandlerOptions = {
    requestHandler: options.requestHandler,
    userBuilder,
    ...(legacyCompat !== undefined ? { legacyCompat } : {}),
  };
  const agentCardProvider: AgentCardProvider = options.requestHandler;
  return {
    agentCard: agentCardHandler({
      agentCardProvider,
      ...(legacyCompat !== undefined ? { legacyCompat } : {}),
    }),
    jsonRpc: jsonRpcHandler(jsonRpc),
    rest: restHandler(rest),
  };
}

/** 默认挂载路径。 */
export const A2A_DEFAULT_PATHS = {
  agentCard: '/.well-known/agent-card.json',
  jsonRpc: '/jsonrpc',
  rest: '/api/rest',
} as const;

/**
 * A2A 服务端门面：{@link A2aExportClient} → 可挂载的 Express 服务。
 *
 * ```ts
 * const server = new A2aServer({
 *   capabilities: { name: 'codepre', description: '...', skills: [...] },
 *   executor: async ({ taskId }, emit) => { emit.text('ok'); emit.status(taskId, TaskState.COMPLETED); },
 * });
 * await server.mount(app).listen(port);   // Express 宿主
 * ```
 */
export class A2aServer {
  /** 底层导出客户端（能力声明 / 执行器 / 授权）。 */
  readonly exportClient: A2aExportClient;
  private readonly legacyCompat: boolean;
  private readonly exportOptions: A2aExportOptions;

  constructor(options: A2aServerOptions) {
    const { exportUrl, legacyCompat, ...exportOptions } = options;
    this.legacyCompat = legacyCompat ?? false;
    if (exportUrl !== undefined) {
      exportOptions.capabilities = {
        ...exportOptions.capabilities,
        url: exportUrl,
      };
    }
    this.exportOptions = exportOptions;
    this.exportClient = new A2aExportClient(exportOptions);
  }

  /** 装配参数：请求处理器 + 导出配置里的授权（缺一不可，否则校验器不生效）。 */
  private assemble(): A2aExpressServerOptions {
    const { auth } = this.exportOptions;
    return {
      requestHandler: this.exportClient.handler,
      ...(auth !== undefined ? { auth: { verify: auth } } : {}),
      ...(this.legacyCompat ? { legacyCompat: true } : {}),
    };
  }

  /** AgentCard 服务中间件。 */
  get agentCardHandler(): RequestHandler {
    return createA2aExpressHandlers(this.assemble()).agentCard;
  }

  /** JSON-RPC 中间件。 */
  get jsonRpcHandler(): RequestHandler {
    return createA2aExpressHandlers(this.assemble()).jsonRpc;
  }

  /** REST 中间件。 */
  get restHandler(): RequestHandler {
    return createA2aExpressHandlers(this.assemble()).rest;
  }

  /** 全部三块中间件（一次取齐）。 */
  get handlers(): A2aExpressHandlers {
    return createA2aExpressHandlers(this.assemble());
  }

  /**
   * 挂载到 Express 应用（缺省路径见 {@link A2A_DEFAULT_PATHS}）。
   *
   * 授权来自构造选项的 `auth`（经 `createA2aExpressHandlers` 注入
   * UserBuilder）：每个请求先解析主体，供执行器读取。
   */
  mount(
    app: Express,
    paths: Partial<typeof A2A_DEFAULT_PATHS> = {},
  ): this {
    const { agentCard, jsonRpc, rest } = this.handlers;
    app.use(paths.agentCard ?? A2A_DEFAULT_PATHS.agentCard, agentCard);
    app.use(paths.jsonRpc ?? A2A_DEFAULT_PATHS.jsonRpc, jsonRpc);
    app.use(paths.rest ?? A2A_DEFAULT_PATHS.rest, rest);
    return this;
  }
}

export {
  createA2aUserBuilder,
  extractBearerToken,
  UnauthenticatedUser,
  UserBuilder,
  type A2aCredentialVerifier,
  type CreateA2aUserBuilderOptions,
  type MaybePromise,
  type RequestHeaders,
  type User,
} from './auth.ts';
export type { A2ARequestHandler } from '@a2a-js/sdk/server';