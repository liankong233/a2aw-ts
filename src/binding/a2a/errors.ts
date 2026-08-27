/**
 * A2A binding 的错误归类：把 SDK 抛出的错误归为协议无关的错误类别。
 *
 * 调用侧适配器据此构造统一的 {@link AgentInvokeError}，公共面不出现
 * 协议错误类型。判定同时使用 `instanceof` 与错误名——vitest / 打包环境
 * 下同一 SDK 可能被加载两份（CJS/ESM 互操作），仅靠 instanceof 会失效。
 *
 * @packageDocumentation
 */

import {
  InvalidAgentResponseError,
  RequestMalformedError,
  TaskNotFoundError,
} from '@a2a-js/sdk/errors';

/** A2A 错误类别（协议无关）。 */
export type A2aErrorKind =
  /** 任务不存在。 */
  | 'task-not-found'
  /** 请求参数被判为畸形。 */
  | 'invalid-request'
  /** 服务端返回了无法解析的响应。 */
  | 'malformed-response'
  /** 其他未分类错误。 */
  | 'unexpected';

/** 把任意错误归为 {@link A2aErrorKind}。 */
export function classifyA2aError(error: unknown): A2aErrorKind {
  if (matches(error, TaskNotFoundError, 'TaskNotFoundError')) {
    return 'task-not-found';
  }
  if (matches(error, RequestMalformedError, 'RequestMalformedError')) {
    return 'invalid-request';
  }
  if (matches(error, InvalidAgentResponseError, 'InvalidAgentResponseError')) {
    return 'malformed-response';
  }
  return 'unexpected';
}

/** instanceof 判定 + 错误名兜底（跨模块实例时 instanceof 失效）。 */
function matches(error: unknown, ctor: abstract new () => Error, name: string): boolean {
  if (error instanceof ctor) {
    return true;
  }
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === name
  );
}