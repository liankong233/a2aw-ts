/**
 * A2A 三核心类（A2aExportClient / A2aServer / A2aConnectClient）的
 * 对称端到端测试：真实 Express + JSON-RPC 链路，覆盖：

 * - 能力声明 → AgentCard → 探测视图；
 * - A2aServer 导出 → A2aConnectClient 探测 + 发送消息（执行器回复）；
 * - 统一认证要求（securitySchemes → probe.authentication）。
 * @packageDocumentation
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { Role, TaskState, type Message } from '@a2a-js/sdk';
import { A2aExportClient } from '../src/binding/a2a/export-client.ts';
import { A2aServer } from '../src/binding/a2a/server.ts';
import { A2aConnectClient } from '../src/binding/a2a/connect-client.ts';
import { fromAgentCard } from '../src/binding/a2a/capabilities.ts';
import type { AgentCard } from '@a2a-js/sdk';

/** 构造一条用户消息（SDK protobuf 结构）。 */
function userMessage(text: string, messageId: string): Message {
  return {
    messageId,
    contextId: '',
    taskId: '',
    role: Role.ROLE_USER,
    parts: [
      { content: { $case: 'text', value: text }, metadata: {}, filename: '', mediaType: 'text/plain' },
    ],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}

const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!();
  }
});

describe('A2aExportClient（能力声明 → 探测视图）', () => {
  it('统一能力声明同步到 AgentCard 与探测结果（含认证要求）', () => {
    const exportClient = new A2aExportClient({
      capabilities: {
        name: 'codepre-agent',
        description: 'Codepre 导出的远程 Agent',
        version: '1.2.0',
        skills: [{ name: 'chart', description: '绘图', tags: ['viz'] }],
        capabilities: { streaming: true, pushNotifications: false },
        securitySchemes: {
          apiKey: {
            scheme: {
              $case: 'apiKeySecurityScheme',
              value: { description: '', location: 'header', name: 'X-API-Key' },
            },
          },
        },
      },
      executor: async () => {},
    });

    const probe = exportClient.probe('http://127.0.0.1:9/jsonrpc');
    expect(probe.name).toBe('codepre-agent');
    expect(probe.version).toBe('1.2.0');
    expect(probe.skills).toContainEqual(
      expect.objectContaining({ name: 'chart', tags: ['viz'] }),
    );
    expect(probe.capabilities.streaming).toBe(true);
    // 认证方案被提炼为统一摘要
    expect(probe.authentication.required).toBe(true);
    expect(probe.authentication.requirements).toContainEqual({
      key: 'apiKey',
      kind: 'apiKey',
    });
  });

  it('fromAgentCard 提炼远端卡片的传输绑定与能力', () => {
    const card: AgentCard = {
      name: 'remote',
      description: 'remote agent',
      version: '0.1.0',
      supportedInterfaces: [
        { url: 'http://remote/jsonrpc', protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' },
      ],
      provider: undefined,
      capabilities: { streaming: false, pushNotifications: true, extensions: [] },
      securitySchemes: {},
      securityRequirements: [],
      defaultInputModes: [],
      defaultOutputModes: [],
      skills: [],
      signatures: [],
    };
    const probe = fromAgentCard(card, 'http://remote');
    expect(probe.interfaces[0]).toEqual({
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
      url: 'http://remote/jsonrpc',
      tenant: '',
    });
    expect(probe.capabilities.pushNotifications).toBe(true);
    expect(probe.authentication.required).toBe(false);
  });
});

describe('A2aServer ↔ A2aConnectClient（对称端到端）', () => {
  it('完整链路：导出 Agent → 探测能力 → 发送消息获得执行器回复', async () => {
    const executor = async (
      input: import('../src/binding/a2a/export-client.ts').A2aAgentTaskInput,
      emit: import('../src/binding/a2a/export-client.ts').A2aTaskEmitter,
    ) => {
      emit.text(`已收到：${input.message.parts[0]?.content?.value ?? ''}`);
      emit.status(input.taskId, TaskState.TASK_STATE_COMPLETED);
    };

    // 先监听拿到端口，再用绝对端点构建导出面（AgentInterface.url 需要绝对地址）
    const app = express();
    const httpServer: Server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => httpServer.once('listening', resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const server = new A2aServer({
      capabilities: {
        name: 'codepre',
        description: 'Codepre 远程 Agent',
        version: '1.0.0',
        skills: [{ name: 'hello', description: '打招呼' }],
      },
      executor,
      exportUrl: `http://127.0.0.1:${port}/jsonrpc`,
    });
    server.mount(app);
    servers.push(async () => {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    });

    const connect = new A2aConnectClient(`http://127.0.0.1:${port}`);
    const probe = await connect.probe();
    expect(probe.name).toBe('codepre');
    expect(probe.version).toBe('1.0.0');
    expect(probe.interfaces[0].url).toBe(`http://127.0.0.1:${port}/jsonrpc`);

    const result = await connect.sendMessage({ message: userMessage('早上好', 'm-1') });
    expect('messageId' in result).toBe(true);
    const text = (result as Message).parts.find(
      (part) => part.content?.$case === 'text',
    )?.content?.value;
    expect(text).toBe('已收到：早上好');

    // 任务查询/取消的错误传播（未知任务）
    await expect(connect.getTask('missing-task')).rejects.toThrow();
    await expect(connect.cancelTask('missing-task')).rejects.toThrow();
  });
});