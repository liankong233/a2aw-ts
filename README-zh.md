# @codepre/a2aw-ts

**Agent-to-Agent wrapper library for TypeScript（TypeScript 的 Agent 间协作封装库）**

协议无关的 Agent 能力适配库：通过 **`A2aImplAdaptor`（实现侧）**、**`A2aInvokeAdaptor`（调用侧）** 与 **`A2aGateway`（多协议对外网关）** 完成全部的能力探测、调用与实现。使用者不接触任何 Agent 协议（A2A / ACP / MCP）的细节，公共面也不出现任何协议 SDK 的类型；新增协议时只需在内部 binding 层加一个同形模块，公共接口不变。

**[English](./README.md)**

## 三个适配器

| 适配器 | 方向 | 职责 |
| --- | --- | --- |
| `A2aImplAdaptor` | 外部 → 内部 | 把内部执行能力导出为可被发现与调用的服务端：能力声明 → 对外卡片、执行器 → 任务事件流、认证校验 → 请求主体；`mount()` 挂载 HTTP 服务、`probe()` 本地能力视图 |
| `A2aInvokeAdaptor` | 内部 → 外部 | 连接外部 Agent：`probe()` 探测能力（→ 统一能力视图）、`invoke()` 调起任务并等到终态、`invokeStream()` 订阅事件流、`getTask()` / `cancel()` 管理任务 |
| `A2aGateway` | 外部 → 内部 | **统一对外网关**：同一份能力实现经可配置的多协议传输同时暴露——A2A（卡片发现 + 任务调用）/ ACP（会话式提示驱动）/ MCP（技能 → 工具），共享执行器与凭据校验器 |

## 快速开始

### 实现侧：导出内部能力

```ts
import express from 'express';
import { A2aImplAdaptor, extractBearerToken } from '@codepre/a2aw-ts';

const impl = new A2aImplAdaptor({
  capabilities: {
    name: 'codepre',
    description: 'Codepre 导出的远程 Agent',
    version: '1.0.0',
    skills: [{ name: 'run-task', description: '执行 Codepre 任务' }],
    capabilities: { streaming: true },
    auth: [{ key: 'bearer', kind: 'http', name: 'bearer' }],
  },
  implement: async ({ taskId, message, user }, emit) => {
    emit.text(`已收到：${message.parts[0]?.text ?? ''}（${user?.userName ?? '匿名'}）`);
    emit.status(taskId, 'completed');
  },
  auth: { verify: (headers) =>
    extractBearerToken(headers) ? { userName: 'codepre' } : null },
});

const app = express();
impl.mount(app); // /.well-known/agent-card.json + /jsonrpc + /api/rest
```

### 统一对外网关：一份实现，多协议暴露

```ts
import express from 'express';
import { A2aGateway, extractBearerToken } from '@codepre/a2aw-ts';

const gateway = new A2aGateway({
  capabilities: {
    name: 'codepre',
    description: 'Codepre 导出的远程 Agent',
    skills: [{ name: 'run-task', description: '执行 Codepre 任务' }],
  },
  implement: async ({ taskId, message }, emit) => {
    emit.text(`已收到：${message.parts[0]?.text ?? ''}`);
    emit.status(taskId, 'completed');
  },
  auth: { verify: (headers) =>
    extractBearerToken(headers) ? { userName: 'codepre' } : null },
  // transports 缺省三协议全开；显式给出时只启用列出的传输（白名单）
  transports: {
    a2a: true,                       // /.well-known/agent-card.json + /jsonrpc + /api/rest
    acp: { path: '/acp' },           // 会话式：session/prompt 驱动执行器，chunk 流式回推
    mcp: { path: '/mcp' },           // 工具式：技能 → tools/list + tools/call
  },
});
gateway.mount(app);
```

各协议的门禁语义略有差异：A2A 未携带凭据的请求放行到协议层（主体未知）；ACP 同样放行未携带凭据的请求，但携带无效凭据一律 401；MCP 配置了 `verify` 后所有请求都要求有效凭据。注意：各绑定自行读取原始请求体，宿主不要在其之前全局挂 `express.json()`。

### 调用侧：探测并调用外部 Agent

```ts
import {
  A2aInvokeAdaptor,
  bearerTokenProvider,
  textMessage,
  messageText,
} from '@codepre/a2aw-ts';

const invoke = new A2aInvokeAdaptor('https://agent.example', {
  fetch: networkClient.fetch,                    // 自定义 fetch 替换（可选）
  auth: bearerTokenProvider(readSecretRefToken), // 凭据来源（可选）
});
const view = await invoke.probe();               // 统一能力视图：技能/开关/认证要求/传输绑定
const task = await invoke.invoke({ message: textMessage('你好') }); // 等到终态
console.log(task.state, messageText(task.message));
```

## 统一数据模型（全部协议无关）

- `CapabilityDeclaration`：本地能力声明（名称/描述/技能/能力开关/认证方案），`A2aImplAdaptor` 的输入；
- `CapabilityView`：远端探测视图（含 `auth.required` / `auth.schemes` 与传输绑定），`probe()` 的产出；
- `AgentMessage`：消息（`role: 'user' | 'agent'` + parts；当前支持文本 part，扩展点见 `AgentMessagePart`）；`textMessage()` / `messageText()` 便捷助手；
- `AgentTask` / `AgentTaskState`：任务快照与状态机（终态 = completed / failed / canceled / rejected）；
- `AgentTaskEvent`：任务事件流（task / status / message / artifact）。

## 错误模型

| 错误 | 场景 | code |
| --- | --- | --- |
| `AuthError` | 授权路径（凭据缺失/无效/不可得/需要挑战） | `unauthorized` / `forbidden` / `credentials-unavailable` / `challenge` |
| `AgentInvokeError` | 调用路径 | `timeout` / `task-failed` / `task-not-found` / `invalid-request` / `unexpected` |

`invoke()` 在任务终态为 failed / rejected 时抛 `AgentInvokeError('task-failed')` 并携带最终任务快照（`error.task`）；等待终态超时抛 `timeout`。

## 目录

```
src/
  model/     协议无关数据模型（message / task / capability / types）
  impl/      A2aImplAdaptor（实现侧适配器）
  invoke/    A2aInvokeAdaptor + AgentInvokeError（调用侧适配器）
  gateway/   A2aGateway（多协议对外网关）
  common/    认证头提供器（auth.ts）、fetch 注入（fetch.ts）、授权错误（errors.ts）
  binding/   协议绑定层（不导出）
    a2a/       A2A 传输、AgentCard、任务状态机、模型↔SDK 转换（model.ts）
    acp/       ACP 授权门禁 + 网关绑定（gateway.ts：能力模型 → AgentApp）
    mcp/       网关绑定（server.ts：官方 @modelcontextprotocol/sdk 的无状态 Streamable HTTP）
tests/     vitest 测试（真实 node:http / Express 链路；公共面测试不 import 任何协议 SDK）
```

分层铁律：`model/` 与三个适配器不依赖任何协议 SDK；只有 `binding/` 依赖 `@a2a-js/sdk` / `@agentclientprotocol/sdk` / `@modelcontextprotocol/sdk`（Express 为可选 peer）。**新增协议 = 新增一个 binding 模块 + 网关传输配置扩展一项**，公共接口不变。

## 门禁

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```
