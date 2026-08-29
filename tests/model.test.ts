/**
 * 模型层与 binding 转换层的单元测试：协议无关模型的行为，以及模型 ↔
 * a2a-js SDK 结构互转的正确性（转换是全库唯一接触 SDK 数据类型的边界）。
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';
import { Role, TaskState } from '@a2a-js/sdk';
import { textMessage, messageText } from '../src/model/message.ts';
import { toCapabilityView } from '../src/model/capability.ts';
import { fromSdkMessage, fromSdkTask, fromSdkStreamResponse, toSdkCapabilityDeclaration, toSdkMessage, toSdkSecuritySchemes, fromSdkSecuritySchemes, toSdkTaskState, fromSdkTaskState } from '../src/binding/a2a/model.ts';

describe('message 模型', () => {
  it('textMessage 便捷构造', () => {
    const message = textMessage('你好');
    expect(message.role).toBe('user');
    expect(message.parts).toEqual([{ type: 'text', text: '你好' }]);
    const agent = textMessage('回', 'agent', 'm-1');
    expect(agent.role).toBe('agent');
    expect(agent.messageId).toBe('m-1');
  });

  it('messageText 取首个文本 part；无文本返回 undefined', () => {
    expect(messageText(textMessage('hi'))).toBe('hi');
    expect(messageText({ role: 'user', parts: [] })).toBeUndefined();
  });
});

describe('消息转换（模型 ↔ SDK）', () => {
  it('模型 → SDK → 模型：角色/文本/消息 id 无损往返', () => {
    const sdk = toSdkMessage(textMessage('你好，Agent', 'user'), 't-1', 'c-1');
    expect(sdk.messageId).toBeTruthy();
    expect(sdk.taskId).toBe('t-1');
    expect(sdk.contextId).toBe('c-1');
    expect(sdk.role).toBe(Role.ROLE_USER);
    expect(sdk.parts[0]?.content).toEqual({ $case: 'text', value: '你好，Agent' });

    const back = fromSdkMessage(sdk);
    expect(back.role).toBe('user');
    expect(back.parts).toEqual([{ type: 'text', text: '你好，Agent' }]);
    expect(back.messageId).toBe(sdk.messageId);
  });

  it('agent 角色与空 parts 的缺省补齐', () => {
    const sdk = toSdkMessage({ role: 'agent', parts: [] }, 't-2', '');
    expect(sdk.role).toBe(Role.ROLE_AGENT);
    expect(sdk.parts).toHaveLength(1);
    const back = fromSdkMessage({ messageId: 'x', contextId: '', taskId: '', role: Role.ROLE_AGENT, parts: [], metadata: {}, extensions: [], referenceTaskIds: [] });
    expect(back.messageId).toBe('x');
    expect(back.role).toBe('agent');
  });

  it('SDK 非文本 part 在模型中被忽略', () => {
    const back = fromSdkMessage({
      messageId: 'x',
      contextId: '',
      taskId: '',
      role: Role.ROLE_AGENT,
      parts: [
        { content: { $case: 'text', value: 'keep' }, metadata: {}, filename: '', mediaType: 'text/plain' },
        { content: { $case: 'file', value: { fileName: 'a.png' } } as never, metadata: {}, filename: '', mediaType: 'image/png' },
      ],
      metadata: {},
      extensions: [],
      referenceTaskIds: [],
    });
    expect(back.parts).toEqual([{ type: 'text', text: 'keep' }]);
  });
});

describe('任务状态转换', () => {
  it('模型状态 ↔ SDK TaskState 往返（含 auth-required 独立映射）', () => {
    for (const state of [
      'submitted',
      'working',
      'input-required',
      'auth-required',
      'completed',
      'failed',
      'canceled',
      'rejected',
      'unknown',
    ] as const) {
      expect(fromSdkTaskState(toSdkTaskState(state))).toBe(state);
    }
  });

  it('AUTH_REQUIRED 独立映射为 auth-required；未识别归 unknown', () => {
    expect(fromSdkTaskState(TaskState.TASK_STATE_AUTH_REQUIRED)).toBe('auth-required');
    expect(fromSdkTaskState(TaskState.TASK_STATE_INPUT_REQUIRED)).toBe('input-required');
    expect(fromSdkTaskState(TaskState.UNRECOGNIZED)).toBe('unknown');
    expect(toSdkTaskState('unknown')).toBe(TaskState.TASK_STATE_UNSPECIFIED);
  });
});

describe('认证方案转换', () => {
  it('apiKey / http 投影为 SDK SecurityScheme（含缺省值）', () => {
    const schemes = toSdkSecuritySchemes([
      { key: 'apiKey', kind: 'apiKey', name: 'X-API-Key' },
      { key: 'bearer', kind: 'http' },
    ]);
    expect(schemes.apiKey?.scheme).toEqual({
      $case: 'apiKeySecurityScheme',
      value: { description: '', location: 'header', name: 'X-API-Key' },
    });
    expect(schemes.bearer?.scheme).toEqual({
      $case: 'httpAuthSecurityScheme',
      value: { description: '', scheme: 'bearer', bearerFormat: '' },
    });
    // 反向投影还原为模型形态
    expect(fromSdkSecuritySchemes(schemes)).toEqual([
      { key: 'apiKey', kind: 'apiKey', name: 'X-API-Key', location: 'header' },
      { key: 'bearer', kind: 'http', name: 'bearer' },
    ]);
  });

  it('unknown 方案在导出时抛错提示', () => {
    expect(() => toSdkSecuritySchemes([{ key: 'x', kind: 'unknown' }])).toThrow(/不支持的认证方案类型/);
  });
});

describe('任务与流事件转换（SDK → 模型）', () => {
  it('SDK Task（含终态消息）→ 模型任务快照', () => {
    const task = {
      id: 't-1',
      contextId: 'c-1',
      status: {
        state: TaskState.TASK_STATE_COMPLETED,
        message: {
          messageId: 'm-9',
          role: 'agent',
          parts: [{ content: { $case: 'text', value: '搞定' }, metadata: {}, filename: '', mediaType: 'text/plain' }],
        },
        timestamp: '2026-01-01T00:00:00Z',
      },
      artifacts: [
        {
          artifactId: 'a-1',
          name: '报告',
          description: '',
          parts: [{ content: { $case: 'text', value: '内容' }, metadata: {}, filename: '', mediaType: 'text/plain' }],
        },
      ],
    };
    const model = fromSdkTask(task as never);
    expect(model.taskId).toBe('t-1');
    expect(model.state).toBe('completed');
    expect(messageText(model.message!)).toBe('搞定');
    expect(model.artifacts).toEqual([{ name: '报告', parts: [{ type: 'text', text: '内容' }] }]);
  });

  it('StreamResponse 的 task / status / artifact / 空载荷映射', () => {
    const asTask = fromSdkStreamResponse({ payload: { $case: 'task', value: { id: 't-1', status: { state: TaskState.TASK_STATE_WORKING } } } } as never);
    expect(asTask).toEqual({ type: 'task', task: { taskId: 't-1', state: 'working' } });

    const asStatus = fromSdkStreamResponse({
      payload: {
        $case: 'statusUpdate',
        value: { taskId: 't-1', contextId: '', status: { state: TaskState.TASK_STATE_COMPLETED, message: { messageId: 'm', role: 'agent', parts: [] } } },
      },
    } as never);
    expect(asStatus?.type).toBe('status');
    expect(asStatus).toMatchObject({ taskId: 't-1', state: 'completed' });

    const empty = fromSdkStreamResponse({ payload: undefined } as never);
    expect(empty).toBeUndefined();
  });
});

describe('能力声明 ↔ 视图', () => {
  it('toCapabilityView：本地声明 → 探测视图（JSONRPC 绑定 + 认证要求）', () => {
    const view = toCapabilityView('http://x/jsonrpc', {
      name: 'codepre',
      description: 'desc',
      version: '1.0.0',
      skills: [{ name: 'chart' }],
      capabilities: { streaming: true },
      auth: [{ key: 'bearer', kind: 'http' }],
    });
    expect(view.name).toBe('codepre');
    expect(view.capabilities.streaming).toBe(true);
    expect(view.auth.required).toBe(true);
    expect(view.bindings).toEqual([
      { protocol: 'JSONRPC', version: '1.0', url: 'http://x/jsonrpc', tenant: '' },
    ]);
  });

  it('toSdkCapabilityDeclaration：认证方案一并转换', () => {
    const decl = toSdkCapabilityDeclaration({
      name: 'a',
      description: 'd',
      skills: [{ name: 's' }],
      auth: [{ key: 'k', kind: 'apiKey', name: 'X-Key' }],
      url: 'http://x/jsonrpc',
    });
    expect(decl.name).toBe('a');
    expect(decl.skills).toEqual([{ name: 's' }]);
    expect(decl.securitySchemes?.k?.scheme?.$case).toBe('apiKeySecurityScheme');
    expect(decl.url).toBe('http://x/jsonrpc');
  });
});