/**
 * ACP 适配的端到端测试：真实 node:http 服务（AcpAuthServer）+ 真实
 * 客户端流，覆盖 HTTP 层 401 门禁、协议层 auth_required、自定义 fetch
 * 注入与认证头附加。
 * @packageDocumentation
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { agent, client, methods, PROTOCOL_VERSION, type AgentApp } from '@agentclientprotocol/sdk';
import { createNodeHttpHandler } from '@agentclientprotocol/sdk/experimental/node';
import type { NewSessionResponse } from '@agentclientprotocol/sdk';
import { AcpAuthServer, acpAuthRequired, parseBearerToken } from '../src/binding/acp/server.ts';
import {
  AcpClientAuth,
  createAcpClientStream,
  pickAcpAuthMethod,
} from '../src/binding/acp/client.ts';
import { bearerTokenProvider } from '../src/common/auth.ts';
import type { FetchLike } from '../src/common/fetch.ts';

const GOOD_TOKEN = 'good-token';
const BAD_TOKEN = 'bad-token';

/** 记录每次 outbound 请求头的 fetch 包装（用于断言自定义 fetch 生效）。 */
type HeadersArg = ConstructorParameters<typeof Headers>[0];
function recordingFetch(seen: Array<HeadersArg | undefined>): FetchLike {
  return async (input, init) => {
    seen.push(init?.headers);
    return globalThis.fetch(input, init);
  };
}

/** 启动一个 AcpAuthServer 测试服务，返回 baseUrl 与关闭函数。 */
async function startAcpServer(options: {
  verify?: (headers: Headers) => unknown | null | Promise<unknown | null>;
  onAuthenticated?: (principal: unknown, request: Request) => void;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const app: AgentApp = agent({ name: 'test-agent' })
    .onRequest(methods.agent.initialize, async () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      authMethods: [{ id: 'bearer', name: 'Bearer Token' }],
    }))
    .onRequest(methods.agent.authenticate, async () => ({}))
    .onRequest(methods.agent.session.new, async () => {
      if (!authenticated) {
        throw acpAuthRequired('需要先认证');
      }
      const response: NewSessionResponse = { sessionId: 's-1' };
      return response;
    });
  // 服务端会话级认证态：principal 由 HTTP 层校验成功后写入
  let authenticated: unknown = null;
  const authServer = new AcpAuthServer({
    agent: app,
    verify: options.verify,
    onAuthenticated: (principal, request) => {
      authenticated = principal;
      options.onAuthenticated?.(principal, request);
    },
  });
  const httpHandler = createNodeHttpHandler(authServer);
  const server: Server = createServer(httpHandler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('无法取得测试服务端口');
  }
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!();
  }
});

describe('AcpAuthServer（HTTP 层门禁）', () => {
  it('无效凭据直接 401，不进入协议层', async () => {
    const { url, close } = await startAcpServer({
      verify: (headers) => (parseBearerToken({ headers } as unknown as Request) === GOOD_TOKEN ? { token: GOOD_TOKEN } : null),
    });
    servers.push(close);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${BAD_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
  });

  it('有效凭据通过门禁并记录主体', async () => {
    const principals: unknown[] = [];
    const { url, close } = await startAcpServer({
      verify: (headers) =>
        parseBearerToken({ headers } as unknown as Request) === GOOD_TOKEN
          ? { token: GOOD_TOKEN }
          : null,
      onAuthenticated: (principal) => principals.push(principal),
    });
    servers.push(close);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${GOOD_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(response.status).toBe(200);
    expect(principals).toContainEqual({ token: GOOD_TOKEN });
  });
});

describe('ACP 客户端（自定义 fetch + 认证头 + 挑战流程）', () => {
  it('注入自定义 fetch 并附加 Bearer 头，完成会话创建', async () => {
    const { url, close } = await startAcpServer({
      verify: (headers) =>
        parseBearerToken({ headers } as unknown as Request) === GOOD_TOKEN
          ? { token: GOOD_TOKEN }
          : null,
    });
    servers.push(close);

    const seenHeaders: Array<HeadersArg | undefined> = [];
    const stream = createAcpClientStream(url, {
      fetch: recordingFetch(seenHeaders),
      auth: bearerTokenProvider(async () => GOOD_TOKEN),
    });

    const app = client({ name: 'test-client' });
    const sessionId = await app.connectWith(stream, async (ctx) => {
      await ctx.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await ctx.buildSession('/work').start();
      return session.sessionId;
    });

    expect(sessionId).toBe('s-1');
    // 自定义 fetch 确实被调用
    expect(seenHeaders.length).toBeGreaterThan(0);
    // 认证头出现在每次 outbound 请求上
    for (const headers of seenHeaders) {
      expect(new Headers(headers).get('authorization')).toBe(`Bearer ${GOOD_TOKEN}`);
    }
  });

  it('AcpClientAuth 助手：先走 authenticate 挑战再建会话', async () => {
    // 服务端要求认证；客户端凭 provider 拿到令牌后先 authenticate 再建会话
    const { url, close } = await startAcpServer({
      verify: (headers) =>
        parseBearerToken({ headers } as unknown as Request) === GOOD_TOKEN
          ? { token: GOOD_TOKEN }
          : null,
    });
    servers.push(close);

    const auth = new AcpClientAuth({ auth: bearerTokenProvider(async () => GOOD_TOKEN) });
    const app = client({ name: 'test-client' });
    const result = await app.connectWith(auth.stream(url), async (ctx) => {
      await ctx.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await auth.authenticate(ctx, 'bearer');
      const session = await ctx.buildSession('/work').start();
      return session.sessionId;
    });
    expect(result).toBe('s-1');
  });
});

describe('pickAcpAuthMethod', () => {
  it('跳过 terminal 型方法，取第一个 agent 型方法', () => {
    const method = pickAcpAuthMethod({
      protocolVersion: 1,
      authMethods: [
        { id: 'tui', name: 'TUI', type: 'terminal' },
        { id: 'bearer', name: 'Bearer Token' },
      ],
    });
    expect(method?.id).toBe('bearer');
  });

  it('无可用方法返回 undefined', () => {
    expect(pickAcpAuthMethod({ protocolVersion: 1 })).toBeUndefined();
  });
});