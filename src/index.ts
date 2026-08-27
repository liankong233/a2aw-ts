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
 * @codepre/a2aw-ts —— 协议无关的 Agent 能力适配库。
 *
 * 定位：把「能力探测、调用、实现」三条链路收拢为一对适配器，使用者不
 * 再接触任何 Agent 协议（A2A / ACP / 未来其他）的细节，公共面也不出现
 * 任何协议 SDK（`@a2a-js/sdk` / `@agentclientprotocol/sdk`）的类型。
 *
 * **两个适配器**
 *
 * - {@link A2aImplAdaptor}（实现侧，外部 → 内部）：把内部执行能力导出
 *   为可被外部 Agent 发现与调用的服务端。输入只有三样协议无关的东西：
 *   能力声明 {@link CapabilityDeclaration}、执行器 {@link ImplExecutor}、
 *   认证校验（可选）；挂载可用 {@link A2aImplAdaptor.mount mount}，
 *   本地视图用 {@link A2aImplAdaptor.probe probe}；
 * - {@link A2aInvokeAdaptor}（调用侧，内部 → 外部）：连接外部 Agent。
 *   {@link A2aInvokeAdaptor.probe probe} 探测能力（→ {@link CapabilityView}）、
 *   {@link A2aInvokeAdaptor.invoke invoke} 调起任务并等到终态
 *   （→ {@link AgentTask}，直答消息同样归并为任务）、
 *   {@link A2aInvokeAdaptor.invokeStream invokeStream} 订阅事件流、
 *   getTask / cancel 管理任务；
 * - {@link A2aGateway}（统一对外网关）：同一份能力实现经可配置的
 *   多协议传输（A2A / ACP / MCP）同时向外暴露。
 *
 * **统一数据模型**（全部协议无关，`model/`）：{@link AgentMessage} /
 * {@link AgentTask} / {@link AgentTaskEvent} / {@link CapabilityDeclaration} /
 * {@link CapabilityView}。当前消息只支持文本 part，扩展点见
 * {@link AgentMessagePart}。
 *
 * **公共抽象**（`common/`）：{@link AuthHeaderProvider}（认证头来源）、
 * {@link FetchLike}（自定义 fetch 替换，对接 Codepre `NetworkClient.fetch`）、
 * {@link AuthError} / {@link AgentInvokeError}（统一错误分类）。
 *
 * **协议绑定层**（`binding/`，不导出）：`binding/a2a`（A2A 传输、AgentCard、
 * 任务状态机）与 `binding/acp`（ACP 授权门禁）是内部实现；新增协议时实现
 * 同形的 binding 模块，适配器经 `transport` 选项选择即可，公共接口不变。
 *
 * 依赖方向：模型与适配器不依赖任何协议 SDK；仅 binding 层依赖
 * `@a2a-js/sdk` / `@agentclientprotocol/sdk`（Express 为可选 peer）。
 *
 * @packageDocumentation
 */

// --- 统一数据模型（协议无关） ---
export {
  textMessage,
  messageText,
  type AgentMessage,
  type AgentMessagePart,
  type AgentMessageRole,
} from './model/message.ts';
export {
  isTerminalState,
  type AgentArtifact,
  type AgentTask,
  type AgentTaskEvent,
  type AgentTaskState,
} from './model/task.ts';
export {
  toCapabilityView,
  type AgentAuthScheme,
  type AgentAuthSchemeKind,
  type AgentCapabilityFlags,
  type AgentSkill,
  type CapabilityBinding,
  type CapabilityDeclaration,
  type CapabilityView,
} from './model/capability.ts';
export type { MaybePromise } from './model/types.ts';

// --- 适配器：实现侧（外部 → 内部） ---
export {
  A2aImplAdaptor,
  type AgentCredentialVerifier,
  type ImplEventEmitter,
  type ImplExecutor,
  type ImplOptions,
  type ImplServerHandlers,
  type ImplTaskInput,
} from './impl/adaptor.ts';

// --- 适配器：统一对外网关（多协议暴露） ---
export {
  A2aGateway,
  GATEWAY_DEFAULT_PATHS,
  type GatewayOptions,
  type GatewayTransportName,
  type GatewayTransportOptions,
  type GatewayTransports,
} from './gateway/adaptor.ts';

// --- 适配器：调用侧（内部 → 外部） ---
export {
  A2aInvokeAdaptor,
  type InvokeInput,
  type InvokeOptions,
  type InvokeRequestOptions,
} from './invoke/adaptor.ts';
export {
  AgentInvokeError,
  isAgentInvokeError,
  type AgentInvokeErrorCode,
  type AgentInvokeErrorOptions,
} from './invoke/errors.ts';

// --- 公共抽象：认证与凭据（协议无关） ---
export {
  AUTHORIZATION_HEADER,
  WWW_AUTHENTICATE_HEADER,
  bearerTokenProvider,
  extractBearerToken,
  resolveAuthHeaders,
  type AgentAuthHeaders,
  type AuthHeaderProvider,
  type AuthHeaders,
} from './common/auth.ts';

// --- 公共抽象：fetch 注入（自定义 fetch 替换） ---
export { defaultFetch, isChallengeResponse, withAuthHeaders, type FetchLike } from './common/fetch.ts';

// --- 公共抽象：统一错误 ---
export {
  AuthError,
  isAuthError,
  type AuthErrorCode,
  type AuthErrorOptions,
} from './common/errors.ts';