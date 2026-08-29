/**
 * 接线验收测试：模拟 a2a-agent 适配壳（Phase 3 §4.14）用公共面 API 完成
 * 「探测 → 委派 → 澄清/凭据停泊 → 续聊 → 取消」闭环的真实调用形态。
 *
 * 覆盖五个设计文档明确要求、此前未能落地的接线缺口：
 *
 * 1. `AUTH_REQUIRED` 是独立停泊态（§4.14 状态映射表：挂起等待凭据），
 *    不得与 `input-required`（澄清）混淆；
 * 2. 任务快照回流 `contextId`（§4.14：contextId ↔ conversationId 持久化
 *    映射、同一会话续聊复用），续聊按快照锚点可还原全部上下文；
 * 3. 调用全程可经 AbortSignal 终止（§4.14：SSE 长连接受取消链透传，
 *    编排层可强制终止失控任务）；
 * 4. AgentCard 存在 JWS 签名时探测即校验（§4.14：存在时强制校验，
 *    失败拒绝连接并提示）；
 * 5. 服务端侧可挂载到 Fastify 宿主（Codepre server 为 Fastify，
 *    经 @fastify/express 桥接，A2A 传输全链路可用）。
 *
 * 与其它测试的约定一致：调用面的断言只用协议无关的模型类型；
 * 签名构造/桥接宿主属测试脚手架，可引入协议 SDK 与宿主依赖。
 * @packageDocumentation
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import express from 'express';
import type { webcrypto } from 'node:crypto';
import Fastify from 'fastify';
import fastifyExpress from '@fastify/express';
import type { AddressInfo } from 'node:net';
import { generateAgentCardSignature } from '@a2a-js/sdk';
import {
  A2aGateway,
  A2aInvokeAdaptor,
  AgentInvokeError,
  textMessage,
  messageText,
} from '../src/index.ts';
import type { AgentTask } from '../src/model/task.ts';

/** 任务结果 JSON（wire 枚举名 `TASK_STATE_*`）。 */
function taskResult(taskId: string, state: string, contextId?: string, message?: unknown): unknown {
  return {
    id: taskId,
    contextId: contextId ?? '',
    status: { state, message, timestamp: '2026-01-01T00:00:00Z' },
    artifacts: [],
  };
}

/** SendMessage 的成功响应 result（wire 形态 `{ task }`）。 */
function sendMessageResult(task?: unknown, message?: unknown): unknown {
  return task !== undefined ? { task } : { message };
}

/** wire 枚举名助手。 */
function wireState(state: string): string {
  return `TASK_STATE_${state}`;
}

/** 一条 agent 文本消息（wire 形态）。 */
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

/** 启动一个可编程的 A2A mock 服务（卡片 + JSON-RPC）。 */
async function startMockServer(options: {
  /** 卡片 JSON（覆盖缺省；可用于签名卡片）。 */
  card?: unknown;
  /** SendMessage 的响应 result。 */
  sendMessage: () => unknown;
  /** GetTask 的响应 result；缺省返回 `-32001 task not found`。 */
  getTask?: (taskId: string) => unknown;
  /** 每次 SendMessage 的原始请求体（用于断言续聊参数）。 */
  onSendBody?: (body: unknown) => void;
}): Promise<{ url: string; close: () => Promise<void> }> {
  let boundPort = 0;
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/.well-known/agent-card.json') {
      const body =
        options.card ??
        JSON.stringify({
          name: 'Mock Agent',
          description: 'A2A mock agent',
          supportedInterfaces: [
            { protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: `http://127.0.0.1:${boundPort}/jsonrpc` },
          ],
          capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
          skills: [],
        });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const rpc = JSON.parse(raw) as { id: unknown; method: string };
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
        options.onSendBody?.(JSON.parse(raw));
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
  };
}

const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!();
  }
});

describe('接线验收：AUTH_REQUIRED 是独立停泊态（§4.14 状态映射）', () => {
  it('远端要求凭据时返回 auth-required，不轮询、不与 input-required 混淆', async () => {
    let polls = 0;
    const mock = await startMockServer({
      sendMessage: () =>
        sendMessageResult(
          taskResult('t-1', wireState('AUTH_REQUIRED'), '', agentReply('需要有效凭据')),
        ),
      // 若实现错误地把 auth-required 当非停泊态轮询，这里会暴露
      getTask: () => {
        polls += 1;
        return taskResult('t-1', wireState('COMPLETED'), '', agentReply('不应到达'));
      },
    });
    servers.push(mock.close);

    const adaptor = new A2aInvokeAdaptor(mock.url, { timeoutMs: 1000 });
    const task = await adaptor.invoke({ message: textMessage('hi') });
    expect(task.state).toBe('auth-required');
    expect(messageText(task.message!)).toBe('需要有效凭据');
    expect(polls).toBe(0);

    // 与澄清停泊态可区分：接线层据此走凭据补录而不是生成澄清卡
    expect(task.state).not.toBe('input-required');
  });
});

describe('接线验收：contextId 回流与续聊（§4.14 多轮会话映射）', () => {
  it('任务快照携带远端分配 contextId；凭快照锚点续聊参数原样还原', async () => {
    // A2A v1.0 wire 形态：taskId / contextId 挂在 message 上
    // （params.message.taskId / params.message.contextId）
    const sentMessages: Array<{ taskId?: string; contextId?: string }> = [];
    let sends = 0;
    const mock = await startMockServer({
      // 首轮：立即返回 WORKING（含远端分配的 contextId），续聊轮返回 COMPLETED
      sendMessage: () => {
        sends += 1;
        return sends === 1
          ? sendMessageResult(taskResult('t-ctx', wireState('WORKING'), 'ctx-42'))
          : sendMessageResult(taskResult('t-ctx', wireState('COMPLETED'), 'ctx-42', agentReply('完成')));
      },
      onSendBody: (body) => {
        const message = (body as { params?: { message?: { taskId?: string; contextId?: string } } })
          .params?.message;
        if (message !== undefined) {
          sentMessages.push(message);
        }
      },
      getTask: () =>
        taskResult('t-ctx', wireState('INPUT_REQUIRED'), 'ctx-42', agentReply('请补充目标目录')),
    });
    servers.push(mock.close);

    const adaptor = new A2aInvokeAdaptor(mock.url, { timeoutMs: 2000 });
    const task = await adaptor.invoke({ message: textMessage('整理文件') });
    // 续聊锚点：任务快照必须带回远端分配的 contextId，接线层才能持久化
    // contextId ↔ conversationId 映射（§4.14 configJson.a2aContextId）
    expect(task.state).toBe('input-required');
    expect((task as AgentTask).contextId).toBe('ctx-42');

    // 续聊：同 taskId + contextId 原样回传，会话延续
    const resumed = await adaptor.invoke({
      message: textMessage('补充分组'),
      taskId: task.taskId,
      contextId: (task as AgentTask).contextId,
    });
    expect(resumed.state).toBe('completed');
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[1]?.taskId).toBe('t-ctx');
    expect(sentMessages[1]?.contextId).toBe('ctx-42');
  });
});

describe('接线验收：AbortSignal 终止（§4.14 取消链透传）', () => {
  it('已中止的 signal：invoke 立即拒绝，不发送请求', async () => {
    const mock = await startMockServer({
      sendMessage: () => sendMessageResult(taskResult('t-1', wireState('WORKING'))),
    });
    servers.push(mock.close);

    const controller = new AbortController();
    controller.abort();
    const adaptor = new A2aInvokeAdaptor(mock.url);
    const error = await adaptor
      .invoke({ message: textMessage('hi') }, { signal: controller.signal })
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(AgentInvokeError);
    expect((error as AgentInvokeError).code).toBe('canceled');
  });

  it('轮询等待中 abort：快速拒绝（code=canceled），不挂死编排层', async () => {
    const mock = await startMockServer({
      sendMessage: () => sendMessageResult(taskResult('t-1', wireState('WORKING'))),
      getTask: () => taskResult('t-1', wireState('WORKING')),
    });
    servers.push(mock.close);

    const controller = new AbortController();
    // 定时器只负责触发 abort；invoke 应在下一次轮询内自行拒绝
    const timer = setTimeout(() => controller.abort(), 250);
    const adaptor = new A2aInvokeAdaptor(mock.url); // 无 timeoutMs：若取消失效会无限轮询
    const started = Date.now();
    const error = await adaptor
      .invoke({ message: textMessage('hi') }, { signal: controller.signal })
      .then(() => null, (e: unknown) => e)
      .finally(() => clearTimeout(timer));
    const elapsed = Date.now() - started;
    expect(error).toBeInstanceOf(AgentInvokeError);
    expect((error as AgentInvokeError).code).toBe('canceled');
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('接线验收：AgentCard JWS 签名校验（§4.14 发现安全）', () => {
  /** 构造一张真实签名卡片（WebCrypto ES256 + SDK signer）。 */
  async function signedCard(): Promise<{ signed: unknown; publicKey: webcrypto.CryptoKey }> {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const { privateKey } = keyPair;
    const publicKey = keyPair.publicKey;
    const card = {
      name: 'Signed Agent',
      description: '带 JWS 签名的 Agent',
      version: '1.0.0',
      supportedInterfaces: [
        { protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: 'http://127.0.0.1:0/jsonrpc' },
      ],
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      skills: [],
    };
    const signer = generateAgentCardSignature(privateKey, {
      alg: 'ES256',
      kid: 'key-1',
      typ: 'JOSE',
    });
    const signed = await (signer as (card: unknown) => Promise<unknown>)(card);
    return { signed, publicKey };
  }

  it('probe 暴露签名存在性；配置密钥获取钩子时校验通过', async () => {
    const { signed, publicKey } = await signedCard();
    const mock = await startMockServer({ card: signed, sendMessage: () => ({}) });
    servers.push(mock.close);

    // 无钩子：登记流程可感知「卡片已签名，需处理」
    const plain = new A2aInvokeAdaptor(mock.url);
    const view = await plain.probe();
    expect(view.signature.present).toBe(true);

    // 配置钩子：按 kid 取回公钥，签名有效 → 探测成功
    const verified = new A2aInvokeAdaptor(mock.url, {
      verifyCardSignature: (kid) => (kid === 'key-1' ? publicKey : null),
    });
    const view2 = await verified.probe();
    expect(view2.name).toBe('Signed Agent');
  });

  it('签名校验失败拒绝连接（钩子取不到公钥 / 校验抛错）', async () => {
    const { signed } = await signedCard();
    const mock = await startMockServer({ card: signed, sendMessage: () => ({}) });
    servers.push(mock.close);

    const missing = new A2aInvokeAdaptor(mock.url, {
      verifyCardSignature: () => null,
    });
    await expect(missing.probe()).rejects.toBeInstanceOf(AgentInvokeError);
  });
});

describe('接线验收：Fastify 宿主桥接（Codepre server 侧）', () => {
  it('A2aGateway 经 @fastify/express 挂到 Fastify：探测 + 调用全链路', async () => {
    const server = Fastify({ logger: false });
    await server.register(fastifyExpress);
    // 先监听拿到端口——A2A 卡片必须宣告绝对端点（exportUrl），相对路径
    // 客户端无法解析（A2A 规范 AgentInterface.url 要求绝对地址）
    await server.listen({ port: 0, host: '127.0.0.1' });
    servers.push(async () => server.close());
    const port = (server.server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const gateway = new A2aGateway({
      capabilities: {
        name: 'codepre-fastify',
        description: 'Fastify 宿主导出的 Agent',
        version: '1.0.0',
        skills: [{ name: 'echo', description: '复读机技能' }],
      },
      implement: async ({ taskId, message }, emit) => {
        emit.text(`已收到：${messageText(message) ?? ''}`);
        emit.status(taskId, 'completed');
      },
      exportUrl: `${baseUrl}/jsonrpc`,
    });
    // 桥接姿势：网关先挂到独立 express app，再整体经 fastify.use() 登记
    // ——@fastify/express 只转发经 use() 登记的中间件（直接挂 fastify.express
    // 不会生效），这正是接线侧要遵守的挂载链路
    const gatewayApp = express();
    gateway.mount(gatewayApp);
    await server.use(gatewayApp);

    const invoke = new A2aInvokeAdaptor(baseUrl);
    const view = await invoke.probe();
    expect(view.name).toBe('codepre-fastify');
    const task = await invoke.invoke({ message: textMessage('走 Fastify') });
    expect(task.state).toBe('completed');
    expect(messageText(task.message!)).toBe('已收到：走 Fastify');
  });
});