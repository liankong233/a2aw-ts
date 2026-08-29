/**
 * {@link A2aImplAdaptor} 的测试：能力声明 → 本地探测视图，以及与
 * {@link A2aInvokeAdaptor} 的对称端到端（真实 Express + JSON-RPC 链路，
 * 执行器与断言全部使用协议无关的模型类型——不 import 任何 a2a-js 类型）。
 * @packageDocumentation
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  A2aImplAdaptor,
  A2aInvokeAdaptor,
  bearerTokenProvider,
  textMessage,
  type CapabilityDeclaration,
  type ImplTaskInput,
} from '../src/index.ts';
import { messageText } from '../src/model/message.ts';

const GOOD = 'good-token';

/** 启动测试宿主：Express + 已监听端口。 */
async function startHost(): Promise<{
  app: ReturnType<typeof express>;
  port: number;
  close: () => Promise<void>;
}> {
  const app = express();
  const httpServer: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => httpServer.once('listening', resolve));
  const port = (httpServer.address() as AddressInfo).port;
  return {
    app,
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!();
  }
});

describe('A2aImplAdaptor 本地视图', () => {
  it('probe 由能力声明生成协议无关的探测视图', () => {
    const impl = new A2aImplAdaptor({
      capabilities: {
        name: 'codepre',
        description: 'Codepre 导出的远程 Agent',
        version: '1.2.0',
        skills: [{ name: 'chart', description: '绘图', tags: ['viz'] }],
        capabilities: { streaming: true },
        auth: [{ key: 'apiKey', kind: 'apiKey', name: 'X-API-Key' }],
      },
      implement: async () => {},
    });
    const view = impl.probe('http://127.0.0.1:9/jsonrpc');
    expect(view.name).toBe('codepre');
    expect(view.version).toBe('1.2.0');
    expect(view.skills).toContainEqual(expect.objectContaining({ name: 'chart', tags: ['viz'] }));
    expect(view.capabilities.streaming).toBe(true);
    expect(view.auth.required).toBe(true);
    expect(view.auth.schemes).toContainEqual({ key: 'apiKey', kind: 'apiKey', name: 'X-API-Key' });
    expect(impl.transport).toBe('a2a');
  });
});

describe('A2aImplAdaptor ↔ A2aInvokeAdaptor（对称端到端）', () => {
  it('导出 → 探测 → 调用：执行器以模型语义回复（文本 + 终态状态）', async () => {
    const received: ImplTaskInput[] = [];
    const host = await startHost();
    servers.push(host.close);

    const impl = new A2aImplAdaptor({
      capabilities: {
        name: 'codepre',
        description: 'Codepre 远程 Agent',
        version: '1.0.0',
        skills: [{ name: 'hello', description: '打招呼' }],
        capabilities: { streaming: true, pushNotifications: false },
      },
      implement: async (input, emit) => {
        received.push(input);
        emit.text(`已收到：${messageText(input.message) ?? ''}`);
        emit.status(input.taskId, 'completed');
      },
      exportUrl: `http://127.0.0.1:${host.port}/jsonrpc`,
    });
    impl.mount(host.app);

    const connect = new A2aInvokeAdaptor(`http://127.0.0.1:${host.port}`);
    const probe = await connect.probe();
    expect(probe.name).toBe('codepre');
    expect(probe.version).toBe('1.0.0');
    expect(probe.skills).toContainEqual(expect.objectContaining({ name: 'hello' }));

    const task = await connect.invoke({ message: textMessage('早上好') });
    expect(task.state).toBe('completed');
    expect(messageText(task.message!)).toBe('已收到：早上好');

    // 执行器收到的输入是模型形态（角色/文本/任务 id）
    expect(received).toHaveLength(1);
    expect(received[0]?.message.role).toBe('user');
    expect(messageText(received[0]!.message)).toBe('早上好');
    expect(received[0]?.taskId).toBeTruthy();
  });

  it('认证链路：客户端 Bearer → 服务端校验 → 执行器看到主体', async () => {
    const seenUsers: Array<{ userName?: string } | undefined> = [];
    const host = await startHost();
    servers.push(host.close);

    const impl = new A2aImplAdaptor({
      capabilities: { name: 'secure', description: '需认证的 Agent' },
      implement: async (input, emit) => {
        seenUsers.push(input.user);
        emit.text('ok');
        emit.status(input.taskId, 'completed');
      },
      auth: {
        verify: (headers) =>
          headers.authorization === `Bearer ${GOOD}` ? { userName: 'alice' } : null,
      },
      exportUrl: `http://127.0.0.1:${host.port}/jsonrpc`,
    });
    impl.mount(host.app);

    const connect = new A2aInvokeAdaptor(`http://127.0.0.1:${host.port}`, {
      auth: bearerTokenProvider(async () => GOOD),
    });
    await connect.invoke({ message: textMessage('hi') });
    expect(seenUsers).toEqual([{ userName: 'alice' }]);
  });

  it('未携带凭据的 A2A 请求：执行器看到 user 为 undefined（而非占位用户）', async () => {
    const seenUsers: Array<{ userName?: string } | undefined> = [];
    const host = await startHost();
    servers.push(host.close);

    const impl = new A2aImplAdaptor({
      capabilities: { name: 'secure', description: '需认证的 Agent' },
      implement: async (input, emit) => {
        seenUsers.push(input.user);
        emit.text('ok');
        emit.status(input.taskId, 'completed');
      },
      // A2A 门禁语义：无凭据放行到协议层，但主体必须是 undefined
      auth: { verify: () => null },
      exportUrl: `http://127.0.0.1:${host.port}/jsonrpc`,
    });
    impl.mount(host.app);

    const connect = new A2aInvokeAdaptor(`http://127.0.0.1:${host.port}`);
    await connect.invoke({ message: textMessage('hi') });
    expect(seenUsers).toEqual([undefined]);
  });

  it('执行器抛错：调用侧得到 task-failed', async () => {
    const host = await startHost();
    servers.push(host.close);

    const impl = new A2aImplAdaptor({
      capabilities: { name: 'crashy', description: '会失败的 Agent' },
      implement: async () => {
        throw new Error('内部错误');
      },
      exportUrl: `http://127.0.0.1:${host.port}/jsonrpc`,
    });
    impl.mount(host.app);

    const connect = new A2aInvokeAdaptor(`http://127.0.0.1:${host.port}`);
    const error = await connect
      .invoke({ message: textMessage('hi') })
      .then(() => null, (e: unknown) => e);
    expect((error as { code?: string }).code).toBe('task-failed');
  });
});

describe('A2aImplAdaptor 配置校验', () => {
  it('能力声明里的 unknown 认证方案在构造时抛错（不泄露到外部）', () => {
    const declaration: CapabilityDeclaration = {
      name: 'x',
      description: 'd',
      auth: [{ key: 'oops', kind: 'unknown' }],
    };
    expect(() => new A2aImplAdaptor({ capabilities: declaration, implement: async () => {} })).toThrow(
      /不支持的认证方案类型/,
    );
  });
});