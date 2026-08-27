/**
 * Copyright 2026 codepre
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * 协议无关的消息模型。
 *
 * 这是整库对「消息」的统一抽象：调用侧（{@link A2aInvokeAdaptor}）发送它、
 * 实现侧（{@link A2aImplAdaptor}）接收它。具体协议（A2A / ACP / 未来其他）
 * 的消息结构由 binding 层负责在模型与协议之间互转，公共面不出现任何协议
 * SDK 类型。
 *
 * 当前只支持文本 part；后续新增 part 类型（文件 / 函数调用 / 图片…）只需
 * 扩展 {@link AgentMessagePart} 联合，并在各 binding 的转换函数中补齐映射，
 * 公共接口无需变化。
 *
 * @packageDocumentation
 */

/** 消息发送方角色。 */
export type AgentMessageRole = 'user' | 'agent';

/** 消息内容 part（当前仅文本；联合类型，后续扩展）。 */
export type AgentMessagePart = {
  readonly type: 'text';
  readonly text: string;
};

/** 协议无关的消息。 */
export interface AgentMessage {
  /** 消息 id（缺省时由发送/转换方生成）。 */
  readonly messageId?: string;
  /** 发送方角色。 */
  readonly role: AgentMessageRole;
  /** 内容 part（协议无关的部分集合）。 */
  readonly parts: readonly AgentMessagePart[];
}

/** 构造一条纯文本消息（最常用的便捷构造）。 */
export function textMessage(
  text: string,
  role: AgentMessageRole = 'user',
  messageId?: string,
): AgentMessage {
  return { messageId, role, parts: [{ type: 'text', text }] };
}

/** 取消息首个文本 part 的内容；无文本 part 时返回 undefined。 */
export function messageText(message: AgentMessage): string | undefined {
  return message.parts.find((part) => part.type === 'text')?.text;
}