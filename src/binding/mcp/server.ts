/**
 * MCP 网关绑定：基于官方 {@link https://github.com/modelcontextprotocol/typescript-sdk | @modelcontextprotocol/sdk}
 * 把统一能力模型装配为 MCP（Model Context Protocol）服务端。
 *
 * 映射关系：
 *
 * - 技能（`CapabilityDeclaration.skills`）→ MCP 工具（`tools/list`）；
 * - `tools/call` → 以工具名定位技能、参数文本化为用户消息调用执行器，
 *   执行器发出的文本 / 工件聚合为工具结果 content；终态 failed /
 *   rejected 或执行器抛错 → `isError: true`；未知工具 →
 *   JSON-RPC `-32602` 错误。
 *
 * 传输采用官方 `StreamableHTTPServerTransport` 的**无状态 + JSON 响应**
 * 模式：每个请求独立的 Server/Transport 实例，不维护会话与 SSE 流。
 * 凭据门禁在 HTTP 层：配置了 `verify` 时每个请求都必须携带有效凭据，
 * 否则 401；校验通过的主体按请求透传给执行器。
 *
 * @packageDocumentation
 */

import type { RequestHandler } from 'express';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { AgentAuthHeaders } from '../../common/auth.ts';
import type { CapabilityDeclaration, AgentSkill } from '../../model/capability.ts';
import { messageText, textMessage } from '../../model/message.ts';
import type {
  ImplEventEmitter,
  ImplExecutor,
  AgentCredentialVerifier,
} from '../../impl/adaptor.ts';

/** 工具参数到用户消息文本的候选键（按序取首个字符串值）。 */
const ARG_TEXT_KEYS = ['input', 'prompt', 'query', 'message', 'text'] as const;

/** node 请求头（IncomingHttpHeaders）→ 协议无关请求头视图。 */
function incomingHeadersToRecord(headers: Record<string, string | string[] | undefined>): AgentAuthHeaders {
  const record: Record<string, string | readonly string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      record[key] = value;
    } else if (Array.isArray(value)) {
      record[key] = value;
    }
  }
  return record;
}

/**
 * 创建 MCP 网关绑定：返回可直接挂载的 Express 中间件。
 *
 * ```ts
 * app.use('/mcp', createMcpGatewayBinding({ capabilities, implement, verify }));
 * ```
 *
 * 请求体解析在绑定内部完成（路由级 `express.json()`，宿主已全局挂载时
 * 不会重复解析）；响应固定为 application/json（`enableJsonResponse`），
 * 并对缺失 Accept 的客户端补齐规范要求的双类型声明以避免 406。
 */
export function createMcpGatewayBinding(options: {
  /** 统一能力声明（serverInfo 与 tools/list 来源）。 */
  readonly capabilities: CapabilityDeclaration;
  /** 统一执行器（tools/call 的处理入口）。 */
  readonly implement: ImplExecutor;
  /** 凭据校验器（可选；配置后所有请求都要求有效凭据）。 */
  readonly verify?: AgentCredentialVerifier;
}): RequestHandler {
  const jsonParser = express.json();

  return async (req, res, next) => {
    let principal: { userName: string } | undefined;
    if (options.verify !== undefined) {
      const verified = await options.verify(incomingHeadersToRecord(req.headers));
      if (verified === null || verified === undefined) {
        res.writeHead(401, { 'www-authenticate': 'Bearer' });
        res.end();
        return;
      }
      principal = verified;
    }

    jsonParser(req, res, async (parseError) => {
      if (parseError !== undefined) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: '请求体不是合法的 JSON' }));
        return;
      }
      try {
        // 无状态模式：每请求独立实例；JSON 响应模式：不启用 SSE 回包
        const server = buildMcpServer(options.capabilities, options.implement, principal);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        // 规范强制 POST 的 Accept 同时列出两种类型；网关只回 JSON，
        // 缺省补齐避免 406（GET/DELETE 保持原样，由传输按规范答复）
        if (req.method === 'POST') {
          const accept = req.headers.accept;
          if (typeof accept !== 'string' || !accept.includes('text/event-stream')) {
            req.headers.accept = 'application/json, text/event-stream';
          }
        }
        await transport.handleRequest(req, res, req.body);
      } catch {
        next();
      }
    });
  };
}

/** 把能力模型装配为 MCP 服务端（低层 API：技能 → 工具，执行器 → tools/call）。 */
function buildMcpServer(
  capabilities: CapabilityDeclaration,
  implement: ImplExecutor,
  principal: { userName: string } | undefined,
): Server {
  const skills = capabilities.skills ?? [];
  const server = new Server(
    { name: capabilities.name, version: capabilities.version ?? '0.0.0' },
    { capabilities: { tools: {} }, instructions: capabilities.description },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: skills.map(skillToMcpTool),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(implement, skills, request.params, principal),
  );
  return server;
}

/** 技能声明 → MCP 工具描述。 */
function skillToMcpTool(skill: AgentSkill) {
  return {
    name: skill.name,
    description: skill.description ?? skill.name,
    inputSchema: {
      type: 'object' as const,
      properties: {
        input: {
          type: 'string' as const,
          description: `「${skill.name}」的用户输入文本`,
        },
      },
      required: ['input'],
    },
  };
}

/** 处理一次 tools/call：参数文本化 → 执行器 → 聚合结果。 */
async function callTool(
  implement: ImplExecutor,
  skills: readonly AgentSkill[],
  params: { name?: unknown; arguments?: Record<string, unknown> },
  principal: { userName: string } | undefined,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError: boolean }> {
  const name = typeof params.name === 'string' ? params.name : '';
  if (!skills.some((skill) => skill.name === name)) {
    throw new McpError(ErrorCode.InvalidParams, `未知工具：「${name}」`);
  }

  const args = params.arguments ?? {};
  let input = '';
  for (const key of ARG_TEXT_KEYS) {
    if (typeof args[key] === 'string') {
      input = args[key] as string;
      break;
    }
  }
  if (input === '') {
    input = Object.keys(args).length > 0 ? JSON.stringify(args) : name;
  }

  const taskId = crypto.randomUUID();
  const chunks: string[] = [];
  let failed: string | undefined;
  const emit: ImplEventEmitter = {
    text: (text) => chunks.push(text),
    message: (message) => {
      const text = messageText(message);
      if (text !== undefined) chunks.push(text);
    },
    task: () => {},
    status: (_taskId, state, message) => {
      if ((state === 'failed' || state === 'rejected') && failed === undefined) {
        failed = message !== undefined ? messageText(message) ?? state : state;
      }
    },
    artifact: (_taskId, artifact) => {
      const text = (artifact.parts ?? [])
        .map((part) => (part.type === 'text' ? part.text : ''))
        .filter((part) => part !== '')
        .join('\n');
      if (text !== '') chunks.push(text);
    },
  };

  try {
    await implement(
      {
        taskId,
        contextId: undefined,
        message: textMessage(input),
        user: principal,
        task: undefined,
      },
      emit,
    );
  } catch (error) {
    failed = error instanceof Error ? error.message : String(error);
  }

  if (failed !== undefined) {
    return { content: [{ type: 'text', text: failed }], isError: true };
  }
  return { content: [{ type: 'text', text: chunks.join('\n') }], isError: false };
}