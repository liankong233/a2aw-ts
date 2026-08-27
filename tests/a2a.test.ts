/**
 * A2A 适配测试：服务端 UserBuilder/令牌解析的纯单元测试 + 客户端
 * 「自定义 fetch + 401 挑战重试」端到端测试。
 * @packageDocumentation
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Role, type SendMessageResult } from '@a2a-js/sdk';
import {
  attachA2aAuth,
  createA2aAuthenticationHandler,
  createA2aClient,
} from '../src/binding/a2a/client.ts';
import { createA2aUserBuilder } from '../src/binding/a2a/server.ts';
import {
  bearerTokenProvider,
  extractBearerToken,
  AUTHORIZATION_HEADER,
} from '../src/common/auth.ts';
import type { FetchLike } from '../src/common/fetch.ts';

const GOOD = 'good-token';

describe('extractBearerToken', () => {
  it('字符串头', () => {
    expect(extractBearerToken({ authorization: `Bearer ${GOOD}` })).toBe(GOOD);
    expect(extractBearerToken({ authorization: 'Basic abc' })).toBeNull();
  });

  it('数组头取第一个', () => {
    expect(extractBearerToken({ authorization: [`Bearer ${GOOD}`, 'Bearer other'] })).toBe(GOOD);
  });

  it('缺失返回 null', () => {
    expect(extractBearerToken({})).toBeNull();
    expect(extractBearerToken({ authorization: undefined })).toBeNull();
  });
});

describe('createA2aUserBuilder', () => {
  it('校验通过返回已认证 User', async () => {
    const builder = createA2aUserBuilder({
      verify: (headers) => {
        const token = extractBearerToken(headers);
        return token === GOOD ? { userName: 'alice' } : null;
      },
    });
    const user = await builder({ headers: { authorization: `Bearer ${GOOD}` } } as never);
    expect(user.isAuthenticated).toBe(true);
    expect(user.userName).toBe('alice');
  });

  it('校验失败返回 UnauthenticatedUser（不拒绝请求）', async () => {
    const builder = createA2aUserBuilder({
      verify: async () => null,
    });
    const user = await builder({ headers: {} } as never);
    expect(user.isAuthenticated).toBe(false);
  });

  it('无 verify 时等价于 noAuthentication', async () => {
    const builder = createA2aUserBuilder();
    const user = await builder({ headers: {} } as never);
    expect(user.isAuthenticated).toBe(false);
  });

  it('校验器抛错视为未认证，不冒泡', async () => {
    const builder = createA2aUserBuilder({
      verify: () => {
        throw new Error('secret store down');
      },
    });
    const user = await builder({ headers: {} } as never);
    expect(user.isAuthenticated).toBe(false);
  });
});

/** 启动一个 A2A mock 服务：卡片与 JSON-RPC 都要求 Bearer 凭据。 */
async function startA2aServer(): Promise<{
  url: string;
  close: () => Promise<void>;
  seenAuth: string[];
  jsonRpcCalls: number;
  fetchCalls: number;
}> {
  const seenAuth: string[] = [];
  let jsonRpcCalls = 0;
  let boundPort = 0;
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authorization = req.headers.authorization;
    seenAuth.push(authorization ?? '(none)');
    const unauthorized = () => {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' });
      res.end();
    };
    if (authorization !== `Bearer ${GOOD}`) {
      unauthorized();
      return;
    }
    if (url.pathname === '/.well-known/agent-card.json') {
      // AgentInterface.url 必须是绝对地址：按实际监听端口动态生成
      const card = {
        name: 'Test Agent',
        description: 'A2A test agent',
        supportedInterfaces: [
          { protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: `http://127.0.0.1:${boundPort}/` },
        ],
        capabilities: {
          streaming: false,
          pushNotifications: false,
          stateTransitionHistory: false,
        },
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(card));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body) as { id: unknown; method: string };
    res.writeHead(200, { 'content-type': 'application/json' });
    if (rpc.method === 'SendMessage') {
      jsonRpcCalls += 1;
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            task: {
              id: 'task-1',
              status: {
                state: 'COMPLETED',
                message: { messageId: 'm-2', role: 'agent', parts: [{ text: 'done' }] },
              },
              artifacts: [],
            },
          },
        }),
      );
      return;
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {} }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('无法取得测试服务端口');
  }
  boundPort = address.port;
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
    seenAuth,
    get jsonRpcCalls() {
      return jsonRpcCalls;
    },
    fetchCalls: 0,
  };
}

/** 记录每次调用次数的 fetch 包装。 */
function countingFetch(counter: { calls: number }): FetchLike {
  return async (input, init) => {
    counter.calls += 1;
    return globalThis.fetch(input, init);
  };
}

const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!();
  }
});

describe('attachA2aAuth（401 挑战 → 重试）', () => {
  it('首次无凭据 401，换凭据重试成功后带上认证头', async () => {
    const mock = await startA2aServer();
    servers.push(mock.close);

    // 第一次求值无令牌 → 401 挑战 → 第二次才给出 GOOD
    let evaluation = 0;
    const provider = async (): Promise<Record<string, string>> => {
      evaluation += 1;
      const headers: Record<string, string> = {};
      if (evaluation > 1) {
        headers[AUTHORIZATION_HEADER] = `Bearer ${GOOD}`;
      }
      return headers;
    };
    const counter = { calls: 0 };
    const wrapped = attachA2aAuth(countingFetch(counter), provider);

    const response = await wrapped(`${mock.url}/`, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: {} }),
    });
    expect(response.status).toBe(200);
    expect(counter.calls).toBe(2);
    // 第二次请求带上了认证头（服务端记录了最终成功的那次）
    expect(mock.seenAuth.at(-1)).toBe(`Bearer ${GOOD}`);
  });

  it('始终无凭据则最终失败', async () => {
    const mock = await startA2aServer();
    servers.push(mock.close);

    const provider = async () => ({});
    const wrapped = attachA2aAuth(globalThis.fetch, provider);
    const response = await wrapped(`${mock.url}/`, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: {} }),
    });
    expect(response.status).toBe(401);
  });

  it('自定义 handler 直接透传 SDK 语义', async () => {
    const handler = createA2aAuthenticationHandler(bearerTokenProvider(async () => GOOD));
    await expect(handler.headers()).resolves.toEqual({ authorization: `Bearer ${GOOD}` });
    const retry = await handler.shouldRetryWithHeaders({} as RequestInit, new Response(null, { status: 401 }));
    expect(retry).toEqual({ authorization: `Bearer ${GOOD}` });
    const noRetry = await handler.shouldRetryWithHeaders({} as RequestInit, new Response(null, { status: 200 }));
    expect(noRetry).toBeUndefined();
  });
});

describe('createA2aClient（AgentCard 获取 + 消息发送全链路）', () => {
  it('自定义 fetch 注入且全程携带认证头，完成一次消息发送', async () => {
    const mock = await startA2aServer();
    servers.push(mock.close);

    const counter = { calls: 0 };
    const client = await createA2aClient(mock.url, {
      fetch: countingFetch(counter),
      auth: bearerTokenProvider(async () => GOOD),
    });

    const result = await client.sendMessage({
      tenant: '',
      configuration: undefined,
      metadata: undefined,
      message: {
        messageId: 'm-1',
        contextId: '',
        taskId: '',
        role: Role.ROLE_USER,
        parts: [
          {
            content: { $case: 'text', value: 'hi' },
            metadata: undefined,
            filename: '',
            mediaType: 'text/plain',
          },
        ],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      },
    });
    // SendMessageResult = Message | Task：按判别字段取任务 id
    const taskId = 'id' in result ? result.id : undefined;
    expect(taskId).toBe('task-1');
    // 卡片获取 + message/send 都走了注入的 fetch（至少 2 次调用）
    expect(counter.calls).toBeGreaterThanOrEqual(2);
    // 所有到达服务端的请求都带上了 Bearer 头
    expect(mock.seenAuth.length).toBeGreaterThan(0);
    expect(mock.seenAuth.every((auth) => auth === `Bearer ${GOOD}`)).toBe(true);
    expect(mock.jsonRpcCalls).toBe(1);
  });
});