# @codepre/a2aw-ts

**Agent-to-Agent wrapper library for TypeScript**

Protocol-agnostic Agent capability adaptation library: **`A2aImplAdaptor` (implementation side)**, **`A2aInvokeAdaptor` (invocation side)** and **`A2aGateway` (multi-protocol outbound gateway)** together cover all capability discovery, invocation and exposure. Consumers never touch the details of any Agent protocol (A2A / ACP / MCP), and no protocol SDK types ever appear on the public surface; adding a new protocol only requires a same-shaped module in the internal binding layer — the public API stays unchanged.

**[中文文档 (Chinese docs)](./README-zh.md)**

## Install

```bash
npm install @codepre/a2aw-ts
# server-side adaptors additionally require Express (see note below)
npm install express
```

**Requirements**: Node.js ≥ 20 and an ESM project (`"type": "module"`); TypeScript types ship in the package (`dist/index.d.ts`), no separate `@types` package.

**Express note**: the implementation-side adaptors (`A2aImplAdaptor`, `A2aGateway`) mount HTTP handlers on an Express application, so Express is required to serve them. The package currently exposes a single entry point that loads the server-side bindings, so plain client-side usage (`A2aInvokeAdaptor`, `A2aInvokeAdaptor.invoke`, …) also needs Express installed at runtime — install it alongside unless you mount the handlers on another host via `@fastify/express` yourself.

Quick start:

```ts
import { A2aInvokeAdaptor, textMessage, messageText } from '@codepre/a2aw-ts';

const invoke = new A2aInvokeAdaptor('https://agent.example');
const view = await invoke.probe();                       // unified capability view
const task = await invoke.invoke({ message: textMessage('hello') });
console.log(task.state, messageText(task.message));
```

## The three adaptors

| Adaptor | Direction | Responsibility |
| --- | --- | --- |
| `A2aImplAdaptor` | external → internal | Exposes internal execution capabilities as a discoverable, callable server: capability declaration → outbound card, executor → task event stream, credential verification → request principal; `mount()` attaches HTTP handlers, `probe()` returns the local capability view |
| `A2aInvokeAdaptor` | internal → external | Connects to remote Agents: `probe()` discovers capabilities (→ unified capability view), `invoke()` starts a task and waits for a terminal state (or an `input-required` pause, resume via `taskId`), `invokeStream()` subscribes to event streams, `getTask()` / `cancel()` manage tasks |
| `A2aGateway` | external → internal | **Unified outbound gateway**: one capability implementation exposed simultaneously over configurable multi-protocol transports — A2A (card discovery + task invocation) / ACP (session-style prompt-driven) / MCP (skills → tools) — sharing the executor and credential verifier |

## Quick start

### Implementation side: expose internal capabilities

```ts
import express from 'express';
import { A2aImplAdaptor, extractBearerToken } from '@codepre/a2aw-ts';

const impl = new A2aImplAdaptor({
  capabilities: {
    name: 'codepre',
    description: 'Remote Agent exported by Codepre',
    version: '1.0.0',
    skills: [{ name: 'run-task', description: 'Run Codepre tasks' }],
    capabilities: { streaming: true },
    auth: [{ key: 'bearer', kind: 'http', name: 'bearer' }],
  },
  implement: async ({ taskId, message, user }, emit) => {
    emit.text(`Received: ${message.parts[0]?.text ?? ''} (${user?.userName ?? 'anonymous'})`);
    emit.status(taskId, 'completed');
  },
  auth: { verify: (headers) =>
    extractBearerToken(headers) ? { userName: 'codepre' } : null },
});

const app = express();
impl.mount(app); // /.well-known/agent-card.json + /jsonrpc + /api/rest
```

### Unified gateway: one implementation, multiple protocols

```ts
import express from 'express';
import { A2aGateway, extractBearerToken } from '@codepre/a2aw-ts';

const gateway = new A2aGateway({
  capabilities: {
    name: 'codepre',
    description: 'Remote Agent exported by Codepre',
    skills: [{ name: 'run-task', description: 'Run Codepre tasks' }],
  },
  implement: async ({ taskId, message }, emit) => {
    emit.text(`Received: ${message.parts[0]?.text ?? ''}`);
    emit.status(taskId, 'completed');
  },
  auth: { verify: (headers) =>
    extractBearerToken(headers) ? { userName: 'codepre' } : null },
  // Omitting transports enables all three protocols; when given explicitly,
  // only the listed transports are enabled (whitelist semantics)
  transports: {
    a2a: true,                       // /.well-known/agent-card.json + /jsonrpc + /api/rest
    acp: { path: '/acp' },           // session style: session/prompt drives the executor, chunks stream back
    mcp: { path: '/mcp' },           // tool style: skills → tools/list + tools/call
  },
});
gateway.mount(app);
```

Gate semantics differ slightly per protocol: A2A lets requests without credentials through to the protocol layer (principal unknown); ACP also admits requests without credentials, but any invalid credentials are rejected with 401; MCP requires valid credentials on every request once `verify` is configured. Note: each binding reads the raw request body itself, so the host must not attach a global `express.json()` middleware before them.

### Invocation side: probe and call remote Agents

```ts
import {
  A2aInvokeAdaptor,
  bearerTokenProvider,
  textMessage,
  messageText,
} from '@codepre/a2aw-ts';

const invoke = new A2aInvokeAdaptor('https://agent.example', {
  fetch: networkClient.fetch,                    // custom fetch replacement (optional)
  auth: bearerTokenProvider(readSecretRefToken), // credential source (optional)
});
const view = await invoke.probe();               // unified capability view: skills / switches / auth requirements / transport bindings
const task = await invoke.invoke({ message: textMessage('hello') }); // waits for a terminal state or an input-required pause
console.log(task.state, messageText(task.message));
```

## Unified data model (all protocol-agnostic)

- `CapabilityDeclaration`: local capability declaration (name/description/skills/capability switches/auth schemes), the input of `A2aImplAdaptor`;
- `CapabilityView`: remote discovery view (with `auth.required` / `auth.schemes` and transport bindings), the output of `probe()`;
- `AgentMessage`: message (`role: 'user' | 'agent'` + parts; text parts are currently supported, see `AgentMessagePart` for extension points); `textMessage()` / `messageText()` conveniences;
- `AgentTask` / `AgentTaskState`: task snapshot and state machine (terminal states = completed / failed / canceled / rejected);
- `AgentTaskEvent`: task event stream (task / status / message / artifact).

## Error model

| Error | Scenario | codes |
| --- | --- | --- |
| `AuthError` | auth error classification helper (HTTP gate failures surface as 401 and do not throw this type; use it to normalize auth semantics in your own call chains) | `unauthorized` / `forbidden` / `credentials-unavailable` / `challenge` |
| `AgentInvokeError` | invocation path | `timeout` / `canceled` / `task-failed` / `task-not-found` / `invalid-request` / `unexpected` |

`invoke()` throws `AgentInvokeError('task-failed')` with the final task snapshot attached (`error.task`) when the terminal state is failed / rejected; a timeout while waiting for a terminal state throws `timeout`; aborting via `AbortSignal` throws `canceled`; when the task enters `input-required` (the Agent asks for more input) or `auth-required` (the Agent demands credentials first), it returns the non-terminal snapshot and the caller resumes via `taskId` / `contextId` (the snapshot carries the server-assigned `contextId` for multi-turn mapping). Pass `verifyCardSignature` on the invoke adaptor to enforce AgentCard JWS signature verification during `probe()`.

### Link resilience

- `invoke()` tolerates transient network faults during polling (fetch failures, connection resets, socket hangs) — a jitter mid-task does not kill the call; without a `timeoutMs` it gives up after a bounded number of consecutive failures so a dead remote does not hang forever.
- `invokeStreaming()` is the stream-first resilient path (per §4.14): it consumes the SSE event stream and, if the stream ends or drops before a terminal state (server shut the stream / proxy timeout), **falls back to polling `getTask`** to finish the task; non-streaming cards degrade gracefully through the SDK and are finished the same way. Use it for long tasks over unstable links.
- `invokeStream()` stays a low-level subscriber: when the server closes the stream it ends normally without an exception — check the last event yourself, or use `invokeStreaming` for automatic wrap-up.

## Layout

```
src/
  model/     protocol-agnostic data model (message / task / capability / types)
  impl/      A2aImplAdaptor (implementation-side adaptor)
  invoke/    A2aInvokeAdaptor + AgentInvokeError (invocation-side adaptor)
  gateway/   A2aGateway (multi-protocol outbound gateway)
  common/    auth header providers (auth.ts), fetch injection (fetch.ts), auth errors (errors.ts)
  binding/   protocol binding layer (not exported)
    a2a/       A2A transport, AgentCard, task state machine, model↔SDK conversion (model.ts)
    acp/       ACP authorization gate + gateway binding (gateway.ts: capability model → AgentApp)
    mcp/       gateway binding (server.ts: stateless Streamable HTTP on the official @modelcontextprotocol/sdk)
tests/     vitest tests (real node:http / Express pipelines; public-surface tests import no protocol SDKs)
```

Layering rule: `model/` and the three adaptors depend on no protocol SDK; only `binding/` depends on `@a2a-js/sdk` / `@agentclientprotocol/sdk` / `@modelcontextprotocol/sdk` (Express is an optional peer). **Adding a protocol = adding one binding module + one entry in the gateway transport config**, public API unchanged.

## Gates

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

## License

[Apache-2.0](./LICENSE)
