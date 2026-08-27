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
 * 调用侧（{@link A2aInvokeAdaptor}）的统一错误。
 *
 * binding 层抛出的协议 SDK 错误（任务不存在、请求畸形、传输失败等）在
 * 适配器边界被翻译为 {@link AgentInvokeError}，调用方只需按 `code` 分支，
 * 不需要感知具体协议的错误体系。
 *
 * @packageDocumentation
 */

import type { AgentTask } from '../model/task.ts';

/** 调用错误码。 */
export type AgentInvokeErrorCode =
  /** 等待任务终态超时。 */
  | 'timeout'
  /** 任务最终状态为 failed / rejected。 */
  | 'task-failed'
  /** 任务不存在（协议 404 / task not found 语义）。 */
  | 'task-not-found'
  /** 请求参数被服务端判为畸形。 */
  | 'invalid-request'
  /** 其他未分类错误（原始错误在 cause 上）。 */
  | 'unexpected';

/** 调用错误的构造参数。 */
export interface AgentInvokeErrorOptions {
  /** 关联的任务快照（如 timeout / task-failed 时的最终状态）。 */
  readonly task?: AgentTask;
  /** 原始错误（binding 协议错误或传输错误）。 */
  readonly cause?: unknown;
}

/** 调用失败时抛出的统一错误，按 {@link AgentInvokeErrorCode} 分支处理。 */
export class AgentInvokeError extends Error {
  /** 调用错误码。 */
  readonly code: AgentInvokeErrorCode;
  /** 关联的任务快照（可能携带终态消息）。 */
  readonly task?: AgentTask;

  constructor(code: AgentInvokeErrorCode, message: string, options: AgentInvokeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AgentInvokeError';
    this.code = code;
    this.task = options.task;
  }
}

/** 判断未知错误是否为 {@link AgentInvokeError}。 */
export function isAgentInvokeError(error: unknown): error is AgentInvokeError {
  return error instanceof AgentInvokeError;
}