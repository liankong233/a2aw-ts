/**
 * 协议无关的任务模型：状态机、任务快照与事件流。
 *
 * 调用侧（{@link A2aInvokeAdaptor} 的 `invoke` / `invokeStream`）产出
 * {@link AgentTaskEvent}；实现侧（{@link A2aImplAdaptor} 的执行器）经
 * {@link ImplEventEmitter} 发布同形事件。双方共用同一套
 * {@link AgentTaskState} 终态语义（completed / failed / canceled /
 * rejected），具体协议的状态枚举由 binding 层映射。
 *
 * @packageDocumentation
 */

import type { AgentMessagePart } from './message.ts';
import type { AgentMessage } from './message.ts';

/** 任务状态（协议无关的子集）。 */
export type AgentTaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'
  | 'unknown';

/** 终态集合：到达后不再有后续事件。 */
export function isTerminalState(state: AgentTaskState): boolean {
  return (
    state === 'completed' ||
    state === 'failed' ||
    state === 'canceled' ||
    state === 'rejected'
  );
}

/** 任务工件（含可选的文本 part 内容）。 */
export interface AgentArtifact {
  readonly name: string;
  readonly description?: string;
  readonly parts?: readonly AgentMessagePart[];
}

/** 协议无关的任务快照。 */
export interface AgentTask {
  readonly taskId: string;
  readonly state: AgentTaskState;
  /** 终态回复（协议里 status.message 的投影）。 */
  readonly message?: AgentMessage;
  readonly artifacts?: readonly AgentArtifact[];
}

/**
 * 任务事件流：`invokeStream` 的产出、实现侧发射器的输入。
 *
 * 与 A2A 流式契约对齐：首个事件通常是 task 或 message，随后是
 * status / artifact / message 增量；终态事件后流结束。
 */
export type AgentTaskEvent =
  | { readonly type: 'task'; readonly task: AgentTask }
  | {
      readonly type: 'status';
      readonly taskId: string;
      readonly state: AgentTaskState;
      readonly message?: AgentMessage;
    }
  | { readonly type: 'message'; readonly message: AgentMessage }
  | { readonly type: 'artifact'; readonly taskId: string; readonly artifact: AgentArtifact };