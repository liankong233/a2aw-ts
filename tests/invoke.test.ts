/**
 * {@link A2aInvokeAdaptor} 的端到端测试：mock HTTP 服务（卡片 + JSON-RPC）
 * 覆盖探测、调用（直答/任务轮询/超时/失败）、流式订阅、认证挑战重试与
 * 自定义 fetch 注入。全程只使用协议无关的模型类型——测试文件不 import
 * 任何 a2a-js 数据类型。
 * @packageDocumentation
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  A2aInvokeAdaptor,
  AgentInvokeError,
  bearerTokenProvider,
  textMessage,
} from '../src/index.ts';
import { messageText } from '../src/model/message.ts';
import type { FetchLike } from '../src/common/fetch.ts';

const GOOD = 'good-token';

/** 一条 agent 文本消息（mock 服务端返回用；role 用 wire 枚举名）。 */
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

/** 任务结果 JSON（mock 返回用；state 必须用 SDK wire 枚举名 `TASK_STATE_*`）。 */
function taskResult(taskId: string, state: string, message?: unknown): unknown {
  return {
    id: taskId,
    contextId: '',
    status: {
      state,
      message,
      timestamp: '2026-01-01T00:00:00Z',
    },
    artifacts: [],
  };
}

/** SendMessage 的成功响应 result（wire 形态：`{ task }` 或 `{ message }`）。 */
function sendMessageResult(task?: unknown, message?: unknown): unknown {
  return task !== undefined ? { task } : { message };
}

/** wire 枚举名助手：`completed` → `TASK_STATE_COMPLETED`。 */
function wireState(state: 'SUBMITTED' | 'WORKING' | 'COMPLETED' | 'FAILED' | 'CANCELED' | 'REJECTED' | 'INPUT_REQUIRED'): string {
  return `TASK_STATE_${state}`;
}

/** 启动一个 A2A mock 服务。 */
async function startMockServer(options: {
  /** 认证门禁：设置了则校验 Bearer 头（GOOD 通过）。 */
  requireAuth?: boolean;
  /** 卡片是否声明流式能力（声明 false 时 SDK 客户端会降级为一次性调用）。 */
  streaming?: boolean;
  /** SendMessage 的响应 result（可返回 task / message）。 */
  sendMessage: () => unknown;
  /** GetTask 的响应 result；缺省返回 `-32001 task not found` 错误。 */
  getTask?: (taskId: string) => unknown;
  /** SendStreamingMessage 的事件列表（每个元素是 StreamResponse result）。 */
  streamEvents?: () => unknown[];
}): Promise<{ url: string; close: () => Promise<void>; seenAuth: string[] }> {
  let boundPort = 0;
  const seenAuth: string[] = [];
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    seenAuth.push(req.headers.authorization ?? '(none)');
    const unauthorized = () => {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' });
      res.end();
    };
    if (options.requireAuth && req.headers.authorization !== `Bearer ${GOOD}`) {
      unauthorized();
      return;
    }
    if (url.pathname === '/.well-known/agent-card.json') {
      const card = {
        name: 'Mock Agent',
        description: 'A2A mock agent',
        supportedInterfaces: [
          { protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: `http://127.0.0.1:${boundPort}/jsonrpc` },
        ],
        capabilities: { streaming: options.streaming === true, pushNotifications: false, stateTransitionHistory: false },
        skills: [{ id: 'echo', name: 'echo', description: '复读机' }],
        securitySchemes: options.requireAuth ? { bearer: { scheme: { $case: 'httpAuthSecurityScheme', value: { description: '', scheme: 'bearer', bearerFormat: '' } } } } : {},
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
        if (options.getTask === undefined) {
          replyError(-32001, 'task not found');
          return;
        }
        const taskId = (rpc as { params?: { id?: unknown } }).params?.id;
        reply(options.getTask(String(taskId ?? '')));
        return;
      }
      case 'SendStreamingMessage': {
        const events = options.streamEvents?.() ?? [];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of events) {
          res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: event })}\n\n`);
        }
        res.end();
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
    seenAuth,
  };
}

const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!();
  }
});

/** 记录每次调用次数的 fetch 包装。 */
function countingFetch(counter: { calls: number }): FetchLike {
  return async (input, init) => {
    counter.calls += 1;
    return globalThis.fetch(input, init);
  };
}

describe('A2aInvokeAdaptor.probe（能力探测）', () => {
  it('拉取卡片并产出协议无关的能力视图', async () => {
    const mock = await startMockServer({
      sendMessage: () => sendMessageResult(taskResult('t-1', wireState('COMPLETED'), agentReply('done'))),
    });
    servers.push(mock.close);

    const adaptor = new A2aInvokeAdaptor(mock.url);
    const view = await adaptor.probe();
    expect(view.name).toBe('Mock Agent');
    expect(view.description).toBe('A2A mock agent');
    expect(view.skills).toContainEqual(expect.objectContaining({ name: 'echo' }));
    expect(view.bindings[0]).toEqual(
      expect.objectContaining({ protocol: 'JSONRPC', url: expect.stringContaining('/jsonrpc') }),
    );
    expect(view.auth.required).toBe(false);
    expect(adaptor.transport).toBe('a2a');
  });
});

describe('A2aInvokeAdaptor.invoke（发送 → 终态）', () => {
  it('服务端直接返回 COMPLETED 任务：返回终态任务与回复文本', async () => {
    const mock = await startMockServer({
      sendMessage: () => sendMessageResult(taskResult('t-1', wireState('COMPLETED'), agentReply('已收到：早上好'))),
    });
    servers.push(mock.close);

    const adaptor = new A2aInvokeAdaptor(mock.url);
    const task = await adaptor.invoke({ message: textMessage('早上好') });
    expect(task.taskId).toBe('t-1');
    expect(task.state).toBe('completed');
    expect(messageText(task.message!)).toBe('已收到：早上好');
  });

  it('服务端直答消息（无任务状态机）：归并为 completed 任务', async () => {
    const mock = await startMockServer({
      sendMessage: () => sendMessageResult(undefined, agentReply('直接回答')),
    });
    servers.push(mock.close);

    const adaptor = new A2aInvokeAdaptor(mock.url);
    const task = await adaptor.invoke({ message: textMessage('hi') });
    expect(task.state).toBe('completed');
    expect(messageText(task.message!)).toBe('直接回答');
  });

  it('WORKING → 轮询 GetTask → COMPLETED', async () => {
    let polls = 0;
    const mock = await startMockServer({
      sendMessage: () => sendMessageResult(taskResult('t-1', wireState('WORKING'))),
      getTask: () => {
        polls += 1;
        return polls >= 2
          ? taskResult('t-1', wireState('COMPLETED'), agentReply('轮询完成'))
          : taskResult('t-1', wireState('WORKING'));
      },
    });
    servers.push(mock.close);

    const adaptor = new A2aInvokeAdaptor(mock.url);
    const task = await adaptor.invoke({ message: textMessage('hi') });
    expect(task.state).toBe('completed');
    expect(messageText(task.message!)).toBe('轮询完成');
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it('始终不终态：超时抛 timeout', async () => {
    const mock = await startMockServer({
      sendMessage: () => sendMessageResult(taskResult('t-1', wireState('WORKING'))),
      getTask: () => taskResult('t-1', wireState('WORKING')),
    });
    servers.push(mock.close);

    const adaptor = new A2aInvokeAdaptor(mock.url, { timeoutMs: 600 });
    const error = await adaptor
      .invoke({ message: textMessage('hi') })
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(AgentInvokeError);
    expect((error as AgentInvokeError).code).toBe('timeout');
  });

  it('终态 failed：抛 task-failed 并携带任务快照', async () => {
    const mock = await startMockServer({
      sendMessage: () => sendMessageResult(taskResult('t-1', wireState('FAILED'), agentReply('出错了'))),
    });
    servers.push(mock.close);

    const adaptor = new A2aInvokeAdaptor(mock.url);
    const error = await adaptor
      .invoke({ message: textMessage('hi') })
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(AgentInvokeError);
    expect((error as AgentInvokeError).code).toBe('task-failed');
    expect(((error as AgentInvokeError).task?.message) !== undefined).toBe(true);
  });

  it('input-required：立即返回非终态快照供续聊，不进入轮询', async () => {
    let polls = 0;
    const mock = await startMockServer({
      sendMessage: () =>
        sendMessageResult(taskResult('t-1', wireState('INPUT_REQUIRED'), agentReply('请补充目标文件名'))),
      // 若实现错误地继续轮询，这里会拿到 GET 命中
      getTask: () => {
        polls += 1;
        return taskResult('t-1', wireState('COMPLETED'), agentReply('不应到达'));
      },
    });
    servers.push(mock.close);

    const adaptor = new A2aInvokeAdaptor(mock.url, { timeoutMs: 1000 });
    const task = await adaptor.invoke({ message: textMessage('整理文件') });
    expect(task.state).toBe('input-required');
    expect(messageText(task.message!)).toBe('请补充目标文件名');
    expect(polls).toBe(0);
  });
});

describe('A2aInvokeAdaptor 任务管理', () => {
  it('getTask：未知任务映射为 task-not-found', async () => {
    const mock = await startMockServer({
      sendMessage: () => sendMessageResult(taskResult('t-1', wireState('COMPLETED'), agentReply('done'))),
    });
    servers.push(mock.close);

    const adaptor = new A2aInvokeAdaptor(mock.url);
    const error = await adaptor
      .getTask('missing')
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(AgentInvokeError);
    expect((error as AgentInvokeError).code).toBe('task-not-found');
  });
});

describe('A2aInvokeAdaptor.invokeStream（事件流订阅）', () => {
  it('SSE 事件流 → 模型事件序列（task → status 终态）', async () => {
    const mock = await startMockServer({
      streaming: true,
      sendMessage: () => sendMessageResult(taskResult('t-1', wireState('COMPLETED'), agentReply('done'))),
      streamEvents: () => [
        { task: taskResult('t-1', wireState('WORKING')) },
        {
          statusUpdate: {
            taskId: 't-1',
            contextId: '',
            status: { state: wireState('COMPLETED'), message: agentReply('流式完成'), timestamp: '2026-01-01T00:00:00Z' },
          },
        },
      ],
    });
    servers.push(mock.close);

    const adaptor = new A2aInvokeAdaptor(mock.url);
    const events: string[] = [];
    for await (const event of adaptor.invokeStream({ message: textMessage('hi') })) {
      events.push(event.type);
      if (event.type === 'task') {
        expect(event.task.state).toBe('working');
      }
      if (event.type === 'status') {
        expect(event.state).toBe('completed');
        expect(messageText(event.message!)).toBe('流式完成');
      }
    }
    expect(events).toEqual(['task', 'status']);
  });
});

describe('A2aInvokeAdaptor 传输注入', () => {
  it('自定义 fetch 注入：卡片与调用都走注入的 fetch，且全程携带认证头', async () => {
    const mock = await startMockServer({
      requireAuth: true,
      sendMessage: () => sendMessageResult(taskResult('t-1', wireState('COMPLETED'), agentReply('ok'))),
    });
    servers.push(mock.close);

    const counter = { calls: 0 };
    const adaptor = new A2aInvokeAdaptor(mock.url, {
      fetch: countingFetch(counter),
      auth: bearerTokenProvider(async () => GOOD),
    });
    await adaptor.probe();
    await adaptor.invoke({ message: textMessage('hi') });
    expect(counter.calls).toBeGreaterThanOrEqual(2);
    expect(mock.seenAuth.length).toBeGreaterThan(0);
    expect(mock.seenAuth.every((auth) => auth === `Bearer ${GOOD}`)).toBe(true);
  });

  it('401 挑战 → 换凭据重试成功（首次无凭据）', async () => {
    const mock = await startMockServer({
      requireAuth: true,
      sendMessage: () => sendMessageResult(taskResult('t-1', wireState('COMPLETED'), agentReply('ok'))),
    });
    servers.push(mock.close);

    let evaluation = 0;
    const provider = async (): Promise<Record<string, string>> => {
      evaluation += 1;
      return evaluation > 1 ? { authorization: `Bearer ${GOOD}` } : {};
    };
    const counter = { calls: 0 };
    const adaptor = new A2aInvokeAdaptor(mock.url, {
      fetch: countingFetch(counter),
      auth: provider,
    });
    const view = await adaptor.probe();
    expect(view.name).toBe('Mock Agent');
    expect(counter.calls).toBeGreaterThanOrEqual(2);
    expect(mock.seenAuth.at(-1)).toBe(`Bearer ${GOOD}`);
  });

  it('始终无凭据则调用失败（401）', async () => {
    const mock = await startMockServer({
      requireAuth: true,
      sendMessage: () => sendMessageResult(taskResult('t-1', wireState('COMPLETED'), agentReply('ok'))),
    });
    servers.push(mock.close);

    const adaptor = new A2aInvokeAdaptor(mock.url, { auth: async () => ({}) });
    const error = await adaptor
      .probe()
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(AgentInvokeError);
  });
});