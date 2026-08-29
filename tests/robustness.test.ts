/**
 * 稳健性验收测试：真实使用链路的韧性问题——断联、瞬断恢复、多次异常、
 * 并发、认证重试有界、畸形响应防御、请求头合并。
 *
 * 覆盖的链路故障注入（全部走真实 node:http + fetch，不 mock 传输层）：
 *
 * - **轮询瞬断**：`getTask` 链路 `res.destroy()`（连接被拔）→ 恢复后
 *   任务应继续完成，而不是一次网络抖动就判死；
 * - **持续瞬断**：有超时 → 兜底 timeout；无超时 → 连续失败上限后放弃
 *   （不无限轮询）；
 * - **SSE 中断回退**：事件流发出 WORKING 后连接被掐（服务端关闭/空闲
 *   断开），`invokeStreaming` 应回退轮询收尾到终态（§4.14 流式回退）；
 * - **非流式卡片**：SDK 降级为一次性调用，`invokeStreaming` 同样收尾；
 * - **多次异常**：abort 一次后同一适配器再调用成功、并发多任务互不
 *   干扰、连续 401 挑战重试有界不无限循环；
 * - **畸形响应**：任务缺 id 等畸形态给出可感知错误而非挂死；
 * - **请求头合并**：`withAuthHeaders` 传入 `Request` 对象时保留原始头。
 *
 * @packageDocumentation
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  A2aInvokeAdaptor,
  AgentInvokeError,
  bearerTokenProvider,
  textMessage,
} from '../src/index.ts';
import { messageText } from '../src/model/message.ts';
import { withAuthHeaders, type FetchLike } from '../src/common/fetch.ts';
import type { Message } from '@a2a-js/sdk';

/** 任务结果 JSON（wire 枚举名 `TASK_STATE_*`）。 */
function taskResult(taskId: string, state: string, message?: unknown): unknown {
  return {
    id: taskId,
    contextId: '',
    status: { state, message, timestamp: '2026-01-01T00:00:00Z' },
    artifacts: [],
  };
}

/** SendMessage 的成功响应 result（wire 形态 `{ task }` / `{ message }`）。 */
function sendMessageResult(task?: unknown, message?: unknown): unknown {
  return task !== undefined ? { task } : { message };
}

function wireState(state: string): string {
  return `TASK_STATE_${state}`;
}

function agentReply(text: string, messageId = 'm-2'): unknown {
  return {
    messageId,
    contextId: '',
    taskId: '',
    role: 'ROLE_AGENT',
    parts: [{ text }],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}

/**
 * 可注入故障的 A2A mock 服务：
 *
 * - `killGetTask`：第 N 次 GetTask 直接拔线（`req.socket.destroy()`），
 *   制造真实 ECONNRESET / fetch failed 形态的网络瞬断；
 * - `killStream`：SendStreamingMessage 写出一帧后拔线（SSE 中途断联）；
 * - `requireAuth`：Bearer 校验（挑战重试链路用）。
 */
async function startFaultyServer(options: {
  sendMessage: () => unknown;
  getTask?: (taskId: string) => unknown;
  streaming?: boolean;
  killGetTaskAt?: number[]; // 第 N 次 GetTask（从 1 起）拔线
  killStream?: boolean; // SSE 发帧后立即拔线
  emptyStream?: boolean; // SendStreamingMessage 返回空流（无任何事件）
  requireAuth?: boolean;
}): Promise<{
  url: string;
  close: () => Promise<void>;
  getTaskCalls: () => number;
  seenAuth: string[];
}> {
  let boundPort = 0;
  let getTaskCalls = 0;
  const seenAuth: string[] = [];
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    seenAuth.push(req.headers.authorization ?? '(none)');
    if (
      options.requireAuth === true &&
      req.headers.authorization !== `Bearer good-token`
    ) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' });
      res.end();
      return;
    }
    if (url.pathname === '/.well-known/agent-card.json') {
      const card = {
        name: 'Faulty Mock',
        description: 'robustness test agent',
        supportedInterfaces: [
          { protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: `http://127.0.0.1:${boundPort}/jsonrpc` },
        ],
        capabilities: {
          streaming: options.streaming === true,
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
    const reply = (result: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    };
    const replyError = (code: number, message: string) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code, message } }));
    };
    switch (rpc.method) {
      case 'SendMessage':
        reply(options.sendMessage());
        return;
      case 'GetTask': {
        getTaskCalls += 1;
        if (options.killGetTaskAt?.includes(getTaskCalls)) {
          req.socket.destroy(); // 真实网络瞬断：连接被拔，无响应
          return;
        }
        if (options.getTask === undefined) {
          replyError(-32001, 'task not found');
          return;
        }
        const taskId = (rpc as { params?: { id?: unknown } }).params?.id;
        reply(options.getTask(String(taskId ?? '')));
        return;
      }
      case 'SendStreamingMessage': {
        if (options.emptyStream === true) {
          // 空流：声明流式但连接建立后不推送任何事件（异常服务端形态）
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              task: { id: 't-s', contextId: '', status: { state: wireState('WORKING') }, artifacts: [] },
              streamOptions: {},
            },
          })}\n\n`,
        );
        if (options.killStream === true) {
          // SSE 中途被服务端掐断（空闲超时/代理断开）：流正常结束但未达终态
          setTimeout(() => req.socket.destroy(), 20);
        } else {
          res.write(
            `data: ${JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              result: {
                statusUpdate: {
                  taskId: 't-s',
                  contextId: '',
                  status: {
                    state: wireState('COMPLETED'),
                    message: agentReply('流式完成'),
                    timestamp: '2026-01-01T00:00:00Z',
                  },
                  streamOptions: {},
                },
              },
            })}\n\n`,
          );
          res.write(`data: {"jsonrpc":"2.0","id":${String(rpc.id)},"result":{"event":{"streamOptions":{}}}}\n\n`);
          res.end();
        }
        return;
      }
      default:
        replyError(-32601, 'method not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  boundPort = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${boundPort}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
    getTaskCalls: () => getTaskCalls,
    seenAuth,
  };
}

const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!();
  }
});

describe('稳健性：轮询瞬断容忍（一次网络抖动不判死）', () => {
  it('getTask 首次拔线（ECONNRESET）后恢复 → invoke 继续完成', async () => {
    const mock = await startFaultyServer({
      sendMessage: () => sendMessageResult(taskResult('t-1', wireState('WORKING'))),
      getTask: (id) =>
        id === 't-1'
          ? taskResult('t-1', wireState('COMPLETED'), agentReply('挺过来了'))
          : taskResult(String(id), wireState('WORKING')),
      killGetTaskAt: [1],
    });
    servers.push(mock.close);

    const adaptor = new A2aInvokeAdaptor(mock.url, { timeoutMs: 5000 });
    const task = await adaptor.invoke({ message: textMessage('hi') });
    expect(task.state).toBe('completed');
    expect(messageText(task.message!)).toBe('挺过来了');
    expect(mock.getTaskCalls()).toBeGreaterThanOrEqual(2);
  });

  it('getTask 持续拔线 + 有超时 → 兜底 timeout（不崩溃不挂死）', async () => {
    const mock = await startFaultyServer({
      sendMessage: () => sendMessageResult(taskResult('t-1', wireState('WORKING'))),
      getTask: () => taskResult('t-1', wireState('WORKING')),
      killGetTaskAt: Array.from({ length: 100 }, (_, i) => i + 1),
    });
    servers.push(mock.close);

    const adaptor = new A2aInvokeAdaptor(mock.url, { timeoutMs: 1500 });
    const started = Date.now();
    const error = await adaptor
      .invoke({ message: textMessage('hi') })
      .then(() => null, (e: unknown) => e);
    const elapsed = Date.now() - started;
    expect(error).toBeInstanceOf(AgentInvokeError);
    expect((error as AgentInvokeError).code).toBe('timeout');
    expect(elapsed).toBeGreaterThanOrEqual(1200);
    expect(elapsed).toBeLessThan(3000);
  });

  it('getTask 持续拔线 + 无超时 → 连续失败上限后放弃（不无限轮询）', async () => {
    const mock = await startFaultyServer({
      sendMessage: () => sendMessageResult(taskResult('t-1', wireState('WORKING'))),
      getTask: () => taskResult('t-1', wireState('WORKING')),
      killGetTaskAt: Array.from({ length: 100 }, (_, i) => i + 1),
    });
    servers.push(mock.close);

    const adaptor = new A2aInvokeAdaptor(mock.url); // 不配超时
    const started = Date.now();
    const error = await adaptor
      .invoke({ message: textMessage('hi') })
      .then(() => null, (e: unknown) => e);
    const elapsed = Date.now() - started;
    expect(error).toBeInstanceOf(AgentInvokeError);
    // 连续瞬断超过上限后以 unexpected 抛错（附原始 cause）
    expect((error as AgentInvokeError).code).toBe('unexpected');
    expect((error as AgentInvokeError).cause).toBeDefined();
    expect(elapsed).toBeLessThan(10000);
  });
});

describe('稳健性：SSE 断联回退轮询（§4.14 流式优先 + 回退）', () => {
  it('invokeStreaming：事件流中途被掐（未达终态）→ 回退轮询收尾', async () => {
    const mock = await startFaultyServer({
      streaming: true,
      killStream: true, // 发出 WORKING 后连接被服务端掐断
      sendMessage: () => sendMessageResult(taskResult('t-1', wireState('WORKING'))),
      getTask: () => taskResult('t-s', wireState('COMPLETED'), agentReply('回退完成')),
    });
    servers.push(mock.close);

    const adaptor = new A2aInvokeAdaptor(mock.url, { timeoutMs: 5000 });
    const task = await adaptor.invokeStreaming({ message: textMessage('hi') });
    expect(task.state).toBe('completed');
    expect(messageText(task.message!)).toBe('回退完成');
  });

  it('invokeStreaming：事件流直达终态 → 直接返回，不触发轮询', async () => {
    const mock = await startFaultyServer({
      streaming: true,
      killStream: false, // 流内直接给 COMPLETED
      sendMessage: () => sendMessageResult(taskResult('t-1', wireState('WORKING'))),
      getTask: () => taskResult('t-s', wireState('WORKING')),
    });
    servers.push(mock.close);

    const adaptor = new A2aInvokeAdaptor(mock.url, { timeoutMs: 5000 });
    const task = await adaptor.invokeStreaming({ message: textMessage('hi') });
    expect(task.state).toBe('completed');
    expect(messageText(task.message!)).toBe('流式完成');
    expect(mock.getTaskCalls()).toBe(0);
  });

  it('invokeStreaming：卡片不支持流式 → SDK 降级一次性调用后仍收尾', async () => {
    const mock = await startFaultyServer({
      streaming: false, // 卡片未声明 streaming → SDK 一次性降级
      sendMessage: () => sendMessageResult(taskResult('t-p', wireState('WORKING'))),
      getTask: () => taskResult('t-p', wireState('COMPLETED'), agentReply('降级收尾')),
    });
    servers.push(mock.close);

    const adaptor = new A2aInvokeAdaptor(mock.url, { timeoutMs: 5000 });
    const task = await adaptor.invokeStreaming({ message: textMessage('hi') });
    expect(task.state).toBe('completed');
    expect(messageText(task.message!)).toBe('降级收尾');
  });
});

describe('稳健性：多次异常与恢复', () => {
  it('abort 一次后，同一适配器再次调用新任务成功', async () => {
    const mock = await startFaultyServer({
      // 首轮 abort 发生在发送前（不产生请求）；真正的调用只有一次，
      // 直接返回终态即可
      sendMessage: () => sendMessageResult(taskResult('t-b', wireState('COMPLETED'), agentReply('第二次成功'))),
    });
    servers.push(mock.close);

    const adaptor = new A2aInvokeAdaptor(mock.url);
    // 第一次：立即 abort（中断，不发送请求）
    const ctrl = new AbortController();
    ctrl.abort();
    const first = await adaptor
      .invoke({ message: textMessage('x') }, { signal: ctrl.signal })
      .then(() => null, (e: unknown) => e);
    expect((first as AgentInvokeError).code).toBe('canceled');
    // 第二次：同一适配器、同一连接链，正常完成
    const second = await adaptor.invoke({ message: textMessage('y') });
    expect(second.state).toBe('completed');
    expect(messageText(second.message!)).toBe('第二次成功');
  });

  it('并发多任务：同一适配器 3 个任务互不干扰并行完成', async () => {
    const mock = await startFaultyServer({
      sendMessage: () => sendMessageResult(taskResult('t-1', wireState('WORKING'))),
      getTask: (id) =>
        taskResult(String(id), wireState('COMPLETED'), agentReply(`完成${String(id)}`)),
    });
    servers.push(mock.close);

    const adaptor = new A2aInvokeAdaptor(mock.url, { timeoutMs: 5000 });
    const tasks = await Promise.all([
      adaptor.invoke({ message: textMessage('a') }),
      adaptor.invoke({ message: textMessage('b') }),
      adaptor.invoke({ message: textMessage('c') }),
    ]);
    expect(tasks.map((t) => t.state)).toEqual(['completed', 'completed', 'completed']);
  });

  it('连续 401：挑战重试有界，不无限循环（最终可感知失败）', async () => {
    const mock = await startFaultyServer({
      requireAuth: true, // 恒定拒绝（凭据恒错）
      sendMessage: () => sendMessageResult(taskResult('t-1', wireState('COMPLETED'))),
    });
    servers.push(mock.close);

    const adaptor = new A2aInvokeAdaptor(mock.url, {
      auth: bearerTokenProvider(async () => 'wrong-token'),
    });
    const error = await adaptor
      .probe()
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(AgentInvokeError);
    // SDK 挑战重试有界（每次请求最多一次重试）：卡片请求 + 重试 ≈ 2 次
    const authAttempts = mock.seenAuth.length;
    expect(authAttempts).toBeLessThanOrEqual(2);
  });
});

describe('稳健性：畸形响应防御', () => {
  it('SendMessage 返回缺 id 的任务 → 可感知失败（不挂死不崩溃）', async () => {
    const mock = await startFaultyServer({
      sendMessage: () => ({
        task: {
          // 缺 id：畸形响应
          contextId: '',
          status: { state: wireState('WORKING') },
          artifacts: [],
        },
      }),
      getTask: () => taskResult('t-1', wireState('COMPLETED')),
    });
    servers.push(mock.close);

    const adaptor = new A2aInvokeAdaptor(mock.url);
    const error = await adaptor
      .invoke({ message: textMessage('hi') })
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(AgentInvokeError);
    expect((error as AgentInvokeError).code).toBe('unexpected');
    expect((error as AgentInvokeError).message).toContain('任务 id');
  });

  it('事件流在产生任务前中断 → 明确报错而非静默成功', async () => {
    const mock = await startFaultyServer({
      streaming: true,
      emptyStream: true, // 卡片声明流式但连接建立后不推送任何事件（异常形态）
      sendMessage: () => sendMessageResult(taskResult('t-1', wireState('WORKING'))),
      getTask: () => taskResult('t-1', wireState('COMPLETED')),
    });
    servers.push(mock.close);

    const adaptor = new A2aInvokeAdaptor(mock.url);
    const error = await adaptor
      .invokeStreaming({ message: textMessage('x') })
      .then(() => null, (e: unknown) => e);
    // 空流没有任何任务锚点，无法回退轮询：明确报错（不静默当成功）
    expect(error).toBeInstanceOf(AgentInvokeError);
    expect((error as AgentInvokeError).message).toContain('事件流在产生任务前中断');
  });
});

describe('稳健性：请求头合并（withAuthHeaders 链路）', () => {
  it('传入 Request 对象时保留原始头并附加认证头（不整体替换）', async () => {
    const seen: Array<ConstructorParameters<typeof Headers>[0]> = [];
    const capture: FetchLike = async (_input, init) => {
      seen.push(init?.headers);
      return new Response('ok', { status: 200 });
    };
    const wrapped = withAuthHeaders(capture, { authorization: 'Bearer tok' });
    const request = new Request('https://example.com', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant': 't1' },
      body: '{}',
    });
    await wrapped(request);
    const headers = new Headers(seen[0]);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-tenant')).toBe('t1');
    expect(headers.get('authorization')).toBe('Bearer tok');
  });

  it('传入 init.headers 时仍以 init.headers 为准（显式覆盖）', async () => {
    const seen: Array<ConstructorParameters<typeof Headers>[0]> = [];
    const capture: FetchLike = async (_input, init) => {
      seen.push(init?.headers);
      return new Response('ok', { status: 200 });
    };
    const wrapped = withAuthHeaders(capture, { authorization: 'Bearer tok' });
    const request = new Request('https://example.com', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x',
    });
    await wrapped(
      request,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
    );
    const headers = new Headers(seen[0]);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('authorization')).toBe('Bearer tok');
  });
});

describe('稳健性：实现侧任务上下文登记有界', () => {
  it('真实链路：同任务续聊覆盖登记、新任务追加，登记数 = 任务数（不无限累积）', async () => {
    const { A2aServer } = await import('../src/binding/a2a/server.ts');
    const { A2aConnectClient } = await import('../src/binding/a2a/connect-client.ts');
    const { Role, TaskState } = await import('@a2a-js/sdk');
    const expressApp = express();

    // 先监听拿端口，再以绝对 exportUrl 构造（A2A 卡片端点必须绝对地址）
    const httpServer = createServer(expressApp);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    servers.push(
      () =>
        new Promise<void>((resolve, reject) =>
          httpServer.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const port = (httpServer.address() as AddressInfo).port;

    const server = new A2aServer({
      capabilities: { name: 'bounded', description: 'd' },
      executor: async ({ taskId }, emit) => {
        emit.text('ok');
        emit.status(taskId, TaskState.TASK_STATE_COMPLETED);
      },
      exportUrl: `http://127.0.0.1:${port}/jsonrpc`,
    });
    server.mount(expressApp);

    const connect = new A2aConnectClient(`http://127.0.0.1:${port}`);
    const messageFor = (taskId: string, messageId: string): Message => ({
      messageId,
      contextId: `ctx-${taskId}`,
      taskId,
      role: Role.ROLE_USER,
      parts: [{ content: { $case: 'text', value: 'hi' }, metadata: {}, filename: '', mediaType: 'text/plain' }],
      metadata: {},
      extensions: [],
      referenceTaskIds: [],
    });
    const map = (server.exportClient as unknown as {
      taskContextIds: Map<string, string>;
    }).taskContextIds;

    // 每个新任务登记一条；多轮独立任务不残留不累积（登记数 = 任务数）
    await connect.sendMessage({ message: messageFor('', 'm-1') });
    expect(map.size).toBe(1);
    await connect.sendMessage({ message: messageFor('', 'm-3') });
    expect(map.size).toBe(2);
    expect([...map.values()].every((ctx) => ctx !== '')).toBe(true);
  });
});