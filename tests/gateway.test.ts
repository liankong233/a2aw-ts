/**
 * {@link A2aGateway} 的端到端测试：同一份能力实现经 A2A / ACP / MCP 三种
 * 传输同时向外暴露——真实 Express 宿主 + 各协议真实客户端链路。覆盖默认
 * 全开、按配置裁剪、自定义路径与凭据门禁。
 * @packageDocumentation
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { client, methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import {
  A2aGateway,
  A2aInvokeAdaptor,
  GATEWAY_DEFAULT_PATHS,
  extractBearerToken,
  textMessage,
  type GatewayOptions,
  type ImplTaskInput,
} from '../src/index.ts';
import { messageText } from '../src/model/message.ts';
import { createAcpClientStream } from '../src/binding/acp/client.ts';

const GOOD = 'good-token';

/** 构造共享的网关选项（能力声明 + 执行器 + 认证）。 */
function gatewayOptions(overrides: Partial<GatewayOptions> = {}): GatewayOptions {
  return {
    capabilities: {
      name: 'codepre',
      description: 'Codepre 统一网关导出的 Agent',
      version: '2.0.0',
      skills: [{ name: 'echo', description: '复读机技能', tags: ['demo'] }],
      capabilities: { streaming: true },
    },
    implement: async ({ taskId, message }: ImplTaskInput, emit) => {
      emit.text(`已收到：${messageText(message) ?? ''}`);
      emit.status(taskId, 'completed');
    },
    ...overrides,
  };
}

/** 启动挂载了网关的 Express 宿主（先取端口，再按绝对地址构造网关）。 */
async function startHost(
  make: (baseUrl: string) => A2aGateway,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  const httpServer: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => httpServer.once('listening', resolve));
  const port = (httpServer.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  make(baseUrl).mount(app);
  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

/** JSON-RPC 响应（测试用宽松形态，便于断言任意字段）。 */
interface RpcResponse {
  // 测试文件允许显式 any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result?: any;
  error?: { code: number; message: string };
}

/** 向指定端点 POST 一条 JSON-RPC 消息；返回状态码与解析后的响应（401 等空体响应 json 为空对象）。 */
async function postRpc(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: RpcResponse }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as RpcResponse) };
}

const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!();
  }
});

describe('A2aGateway 默认全开（三协议）', () => {
  it('transports 缺省为 a2a/acp/mcp 全启用', () => {
    const gateway = new A2aGateway(gatewayOptions());
    expect([...gateway.transports]).toEqual(['a2a', 'acp', 'mcp']);
    expect(gateway.probe('http://x')).toMatchObject({ name: 'codepre', version: '2.0.0' });
  });

  it('A2A 传输：探测 + 调用直达共享执行器', async () => {
    const host = await startHost((baseUrl) =>
      new A2aGateway(gatewayOptions({ exportUrl: `${baseUrl}/jsonrpc` })),
    );
    servers.push(host.close);

    const invoke = new A2aInvokeAdaptor(host.baseUrl);
    const view = await invoke.probe();
    expect(view.name).toBe('codepre');
    const task = await invoke.invoke({ message: textMessage('走 A2A') });
    expect(task.state).toBe('completed');
    expect(messageText(task.message!)).toBe('已收到：走 A2A');
  });

  it('MCP 传输：initialize / tools/list / tools/call 全链路', async () => {
    const host = await startHost(() => new A2aGateway(gatewayOptions()));
    servers.push(host.close);
    const url = `${host.baseUrl}${GATEWAY_DEFAULT_PATHS.mcp}`;

    const initialized = await postRpc(url, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    expect(initialized.json.result.serverInfo).toEqual({ name: 'codepre', version: '2.0.0' });
    expect(initialized.json.result.protocolVersion).toBe('2025-06-18');
    expect(initialized.json.result.capabilities.tools).toEqual({});

    const listed = await postRpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(listed.json.result.tools).toHaveLength(1);
    expect(listed.json.result.tools[0]).toMatchObject({ name: 'echo', description: '复读机技能' });

    const called = await postRpc(url, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'echo', arguments: { input: '走 MCP' } },
    });
    expect(called.json.result.isError).toBe(false);
    expect(called.json.result.content).toEqual([{ type: 'text', text: '已收到：走 MCP' }]);

    const unknownTool = await postRpc(url, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    });
    expect(unknownTool.json.error?.code).toBe(-32602);

    const pinged = await postRpc(url, { jsonrpc: '2.0', id: 5, method: 'ping' });
    expect(pinged.json.result).toEqual({});
  });

  it('MCP 通知请求返回 202 且无响应体', async () => {
    const host = await startHost(() => new A2aGateway(gatewayOptions()));
    servers.push(host.close);

    const response = await fetch(`${host.baseUrl}${GATEWAY_DEFAULT_PATHS.mcp}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });

  it('MCP：官方客户端 SDK 直连网关（listTools / callTool）', async () => {
    const host = await startHost(() => new A2aGateway(gatewayOptions()));
    servers.push(host.close);

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const mcp = new Client({ name: 'official-client', version: '0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${host.baseUrl}${GATEWAY_DEFAULT_PATHS.mcp}`)));
    try {
      const tools = await mcp.listTools();
      expect(tools.tools).toHaveLength(1);
      expect(tools.tools[0]).toMatchObject({ name: 'echo', description: '复读机技能' });

      const result = await mcp.callTool({ name: 'echo', arguments: { input: '官方 SDK' } });
      expect(result.content).toEqual([{ type: 'text', text: '已收到：官方 SDK' }]);

      // 官方客户端把协议级错误（-32602）转译为抛出的 McpError
      await expect(mcp.callTool({ name: 'nope', arguments: {} })).rejects.toThrow(/未知工具/);
    } finally {
      await mcp.close();
    }
  });

  it('MCP：GET 请求缺 SSE 声明时按规范返回 406', async () => {
    const host = await startHost(() => new A2aGateway(gatewayOptions()));
    servers.push(host.close);
    const response = await fetch(`${host.baseUrl}${GATEWAY_DEFAULT_PATHS.mcp}`);
    expect(response.status).toBe(406);
  });

  it('ACP 传输：initialize → 建会话 → prompt 收到流式回复', async () => {
    const host = await startHost(() => new A2aGateway(gatewayOptions()));
    servers.push(host.close);

    const app = client({ name: 'test-client' });
    const reply = await app.connectWith(
      createAcpClientStream(`${host.baseUrl}${GATEWAY_DEFAULT_PATHS.acp}`),
      async (ctx) => {
        await ctx.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        return ctx.buildSession('/work').withSession(async (session) => {
          await session.prompt('走 ACP');
          return await session.readText();
        });
      },
    );
    expect(reply).toBe('已收到：走 ACP');
  });
});

describe('A2aGateway 按配置裁剪与路径覆盖', () => {
  it('只启用 mcp：其余传输 404，MCP 可用且路径可自定义', async () => {
    const gateway = new A2aGateway(gatewayOptions({
      transports: { mcp: { path: '/api/mcp' } },
    }));
    expect([...gateway.transports]).toEqual(['mcp']);
    const host = await startHost(() => gateway);
    servers.push(host.close);

    expect((await fetch(`${host.baseUrl}/.well-known/agent-card.json`)).status).toBe(404);
    expect((await fetch(`${host.baseUrl}${GATEWAY_DEFAULT_PATHS.acp}`, { method: 'POST' })).status).toBe(404);

    const called = await postRpc(`${host.baseUrl}/api/mcp`, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'echo', arguments: { input: 'hi' } },
    });
    expect(called.json.result.content[0].text).toBe('已收到：hi');
  });
});

describe('A2aGateway 凭据门禁', () => {
  function secureOptions(): GatewayOptions {
    return gatewayOptions({
      auth: {
        verify: async (headers) =>
          extractBearerToken(headers) === GOOD ? { userName: 'alice' } : null,
      },
    });
  }

  it('MCP：无凭据/错凭据 401，正确凭据通过且执行器看到主体', async () => {
    const seenUsers: Array<string | undefined> = [];
    const host = await startHost(() => new A2aGateway(gatewayOptions({
      ...secureOptions(),
      implement: async (input, emit) => {
        seenUsers.push(input.user?.userName);
        emit.text('ok');
        emit.status(input.taskId, 'completed');
      },
    })));
    servers.push(host.close);
    const url = `${host.baseUrl}${GATEWAY_DEFAULT_PATHS.mcp}`;
    const callBody = {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'echo', arguments: { input: 'hi' } },
    };

    const noAuth = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(callBody),
    });
    expect(noAuth.status).toBe(401);

    const badAuth = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: JSON.stringify(callBody),
    });
    expect(badAuth.status).toBe(401);

    const ok = await postRpc(url, { ...callBody }, { authorization: `Bearer ${GOOD}` });
    expect(ok.json.result.content[0].text).toBe('ok');
    expect(seenUsers).toEqual(['alice']);
  });

  it('ACP：无效凭据在 HTTP 层被 401 拒绝', async () => {
    const host = await startHost(() => new A2aGateway(secureOptions()));
    servers.push(host.close);

    const response = await fetch(`${host.baseUrl}${GATEWAY_DEFAULT_PATHS.acp}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {} },
      }),
    });
    expect(response.status).toBe(401);
  });

  it('A2A：正确凭据下执行器看到主体（复用实现侧链路）', async () => {
    const seenUsers: Array<string | undefined> = [];
    const host = await startHost((baseUrl) => new A2aGateway(gatewayOptions({
      ...secureOptions(),
      implement: async (input, emit) => {
        seenUsers.push(input.user?.userName);
        emit.text('ok');
        emit.status(input.taskId, 'completed');
      },
      exportUrl: `${baseUrl}/jsonrpc`,
    })));
    servers.push(host.close);

    const invoke = new A2aInvokeAdaptor(host.baseUrl, {
      auth: { authorization: `Bearer ${GOOD}` },
    });
    await invoke.invoke({ message: textMessage('hi') });
    expect(seenUsers).toEqual(['alice']);
  });
});