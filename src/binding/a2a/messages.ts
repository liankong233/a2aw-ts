/**
 * A2A 消息构造辅助：给内部执行器用的轻量 Message 构建器。
 *
 * SDK 的 protobuf 消息类型要求若干必填标量字段（messageId / taskId /
 * contextId / role / parts / metadata 等），这里用空默认值补齐，
 * 让执行器只需要关注业务字段。
 *
 * @packageDocumentation
 */

import { Role, type Message } from '@a2a-js/sdk';

/** 生成一条 agent 文本消息（含随机 messageId）。 */
export function buildAgentTextMessage(
  taskId: string,
  text: string,
  contextId: string = '',
  messageId: string = crypto.randomUUID(),
): Message {
  return {
    messageId,
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: [
      {
        content: { $case: 'text', value: text },
        metadata: {},
        filename: '',
        mediaType: 'text/plain',
      },
    ],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}