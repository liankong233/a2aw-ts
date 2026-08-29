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
 * A2A binding 的模型转换层：协议无关模型 ↔ a2a-js SDK 结构。
 *
 * 转换方向：
 *
 * - 模型 → SDK：{@link A2aImplAdaptor} 导出时（能力声明、执行器消息与
 *   状态）、{@link A2aInvokeAdaptor} 发送时（消息）；
 * - SDK → 模型：{@link A2aInvokeAdaptor} 探测 / 订阅时（AgentCard、
 *   任务、流事件）。
 *
 * 本模块与 binding 协议模块是全库唯二 import '@a2a-js/sdk' 实现的地方，
 * 公共面的协议无关性由此保证：新增协议（如 ACP）时，只需为它实现一套
 * 同形的转换函数，适配器代码不变。
 *
 * @packageDocumentation
 */

import {
  Role,
  TaskState,
  type Artifact,
  type Message,
  type Part,
  type SecurityScheme,
  type StreamResponse,
  type Task,
  type TaskArtifactUpdateEvent,
} from '@a2a-js/sdk';
import type {
  AgentAuthScheme,
  AgentAuthSchemeKind,
  CapabilityDeclaration,
  CapabilityView,
} from '../../model/capability.ts';
import type { AgentMessage, AgentMessagePart } from '../../model/message.ts';
import type {
  AgentArtifact,
  AgentTask,
  AgentTaskEvent,
  AgentTaskState,
} from '../../model/task.ts';
import type { A2aCapabilityDeclaration, A2aProbeResult } from './capabilities.ts';

/** 把 SDK 角色映射为模型角色（其他值一律视为 user）。 */
function fromSdkRole(role: Role): 'user' | 'agent' {
  return role === Role.ROLE_AGENT ? 'agent' : 'user';
}

/**
 * 模型文本 part → SDK Part。
 *
 * 当前模型只支持文本 part；为 SDK 必填标量字段补齐空默认值。
 */
export function toSdkPart(part: AgentMessagePart): Part {
  return {
    content: { $case: 'text', value: part.text },
    metadata: {},
    filename: '',
    mediaType: 'text/plain',
  };
}

/**
 * 模型消息 → SDK Message。
 *
 * 缺省的 messageId 在此生成；taskId / contextId 由调用方上下文注入
 * （调用侧取 `InvokeInput`、实现侧取当前任务上下文）。
 */
export function toSdkMessage(
  message: AgentMessage,
  taskId: string,
  contextId: string,
): Message {
  const parts: Part[] =
    message.parts.length === 0
      ? [toSdkPart({ type: 'text', text: '' })]
      : message.parts.map(toSdkPart);
  return {
    messageId: message.messageId ?? crypto.randomUUID(),
    contextId,
    taskId,
    role: message.role === 'agent' ? Role.ROLE_AGENT : Role.ROLE_USER,
    parts,
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}

/**
 * SDK Message → 模型消息。
 *
 * 非文本 part 当前模型不支持，忽略（后续扩展 {@link AgentMessagePart}
 * 时在此补齐映射）。
 */
export function fromSdkMessage(message: Message): AgentMessage {
  const parts: AgentMessagePart[] = [];
  for (const part of message.parts ?? []) {
    if (part.content?.$case === 'text') {
      parts.push({ type: 'text', text: part.content.value });
    }
  }
  return {
    messageId: message.messageId,
    role: fromSdkRole(message.role),
    parts,
  };
}

/** 模型任务状态 → SDK TaskState。 */
export function toSdkTaskState(state: AgentTaskState): TaskState {
  switch (state) {
    case 'submitted':
      return TaskState.TASK_STATE_SUBMITTED;
    case 'working':
      return TaskState.TASK_STATE_WORKING;
    case 'input-required':
      return TaskState.TASK_STATE_INPUT_REQUIRED;
    case 'auth-required':
      return TaskState.TASK_STATE_AUTH_REQUIRED;
    case 'completed':
      return TaskState.TASK_STATE_COMPLETED;
    case 'failed':
      return TaskState.TASK_STATE_FAILED;
    case 'canceled':
      return TaskState.TASK_STATE_CANCELED;
    case 'rejected':
      return TaskState.TASK_STATE_REJECTED;
    case 'unknown':
      return TaskState.TASK_STATE_UNSPECIFIED;
  }
}

/** SDK TaskState → 模型任务状态（未识别的值归为 unknown）。 */
export function fromSdkTaskState(state: TaskState): AgentTaskState {
  switch (state) {
    case TaskState.TASK_STATE_SUBMITTED:
      return 'submitted';
    case TaskState.TASK_STATE_WORKING:
      return 'working';
    case TaskState.TASK_STATE_INPUT_REQUIRED:
      return 'input-required';
    case TaskState.TASK_STATE_AUTH_REQUIRED:
      return 'auth-required';
    case TaskState.TASK_STATE_COMPLETED:
      return 'completed';
    case TaskState.TASK_STATE_FAILED:
      return 'failed';
    case TaskState.TASK_STATE_CANCELED:
      return 'canceled';
    case TaskState.TASK_STATE_REJECTED:
      return 'rejected';
    default:
      return 'unknown';
  }
}

/** SDK Artifact → 模型工件（仅保留文本 part）。 */
export function fromSdkArtifact(artifact: Artifact): AgentArtifact {
  const parts: AgentMessagePart[] = [];
  for (const part of artifact.parts ?? []) {
    if (part.content?.$case === 'text') {
      parts.push({ type: 'text', text: part.content.value });
    }
  }
  return {
    name: artifact.name,
    description: artifact.description === '' ? undefined : artifact.description,
    ...(parts.length > 0 ? { parts } : {}),
  };
}

/** SDK Task → 模型任务快照（携带远端分配的 contextId，续聊锚点）。 */
export function fromSdkTask(task: Task): AgentTask {
  return {
    taskId: task.id,
    ...(task.contextId !== undefined && task.contextId !== ''
      ? { contextId: task.contextId }
      : {}),
    state:
      task.status?.state !== undefined ? fromSdkTaskState(task.status.state) : 'unknown',
    ...(task.status?.message !== undefined
      ? { message: fromSdkMessage(task.status.message) }
      : {}),
    ...((task.artifacts ?? []).length > 0
      ? { artifacts: (task.artifacts ?? []).map(fromSdkArtifact) }
      : {}),
  };
}

/** 模型任务快照 → SDK Task（实现侧发射器发布 task 事件用）。 */
export function toSdkTask(task: AgentTask, contextId: string): Task {
  return {
    id: task.taskId,
    contextId: task.contextId ?? contextId,
    status: {
      state: toSdkTaskState(task.state),
      message:
        task.message !== undefined
          ? toSdkMessage(task.message, task.taskId, contextId)
          : undefined,
      timestamp: new Date().toISOString(),
    },
    artifacts: [],
    history: [],
    metadata: {},
  };
}

/** 模型工件 → SDK 工件更新事件（实现侧发射器发布 artifact 事件用）。 */
export function toSdkArtifactUpdate(
  taskId: string,
  contextId: string,
  artifact: AgentArtifact,
): TaskArtifactUpdateEvent {
  return {
    taskId,
    contextId,
    artifact: {
      artifactId: crypto.randomUUID(),
      name: artifact.name,
      description: artifact.description ?? '',
      parts: (artifact.parts ?? []).map(toSdkPart),
      metadata: {},
      extensions: [],
    },
    append: false,
    lastChunk: true,
    metadata: {},
  };
}

/** SDK StreamResponse → 模型任务事件；无法映射的载荷返回 undefined（调用方跳过）。 */
export function fromSdkStreamResponse(response: StreamResponse): AgentTaskEvent | undefined {
  switch (response.payload?.$case) {
    case 'task':
      return { type: 'task', task: fromSdkTask(response.payload.value) };
    case 'message':
      return { type: 'message', message: fromSdkMessage(response.payload.value) };
    case 'statusUpdate': {
      const event = response.payload.value;
      return {
        type: 'status',
        taskId: event.taskId,
        state:
          event.status?.state !== undefined
            ? fromSdkTaskState(event.status.state)
            : 'unknown',
        ...(event.status?.message !== undefined
          ? { message: fromSdkMessage(event.status.message) }
          : {}),
      };
    }
    case 'artifactUpdate': {
      const event = response.payload.value;
      if (event.artifact === undefined) {
        return undefined;
      }
      return {
        type: 'artifact',
        taskId: event.taskId,
        artifact: fromSdkArtifact(event.artifact),
      };
    }
    default:
      return undefined;
  }
}

/** 把模型认证方案投影为 SDK SecurityScheme（方案 key → 完整结构）。 */
export function toSdkSecuritySchemes(
  schemes: readonly AgentAuthScheme[],
): Record<string, SecurityScheme> {
  const result: Record<string, SecurityScheme> = {};
  for (const scheme of schemes) {
    result[scheme.key] = toSdkSecurityScheme(scheme);
  }
  return result;
}

/** 单个模型认证方案 → SDK SecurityScheme。 */
function toSdkSecurityScheme(scheme: AgentAuthScheme): SecurityScheme {
  switch (scheme.kind) {
    case 'apiKey':
      return {
        scheme: {
          $case: 'apiKeySecurityScheme',
          value: {
            description: scheme.description ?? '',
            location: scheme.location ?? 'header',
            name: scheme.name ?? scheme.key,
          },
        },
      };
    case 'http':
      return {
        scheme: {
          $case: 'httpAuthSecurityScheme',
          value: {
            description: scheme.description ?? '',
            scheme: scheme.name ?? 'bearer',
            bearerFormat: '',
          },
        },
      };
    case 'oauth2':
      return {
        scheme: {
          $case: 'oauth2SecurityScheme',
          value: {
            description: scheme.description ?? '',
            flows: undefined,
            oauth2MetadataUrl: scheme.url ?? '',
          },
        },
      };
    case 'openIdConnect':
      return {
        scheme: {
          $case: 'openIdConnectSecurityScheme',
          value: {
            description: scheme.description ?? '',
            openIdConnectUrl: scheme.url ?? '',
          },
        },
      };
    case 'mutualTls':
      return {
        scheme: {
          $case: 'mtlsSecurityScheme',
          value: { description: scheme.description ?? '' },
        },
      };
    case 'unknown':
      throw new TypeError(
        `不支持的认证方案类型：${scheme.kind}（key=${scheme.key}）；请改用 apiKey / http / oauth2 / openIdConnect / mutualTls`,
      );
  }
}

/** SDK SecurityScheme 集合 → 模型认证方案投影。 */
export function fromSdkSecuritySchemes(
  schemes: Record<string, SecurityScheme> | undefined,
): AgentAuthScheme[] {
  return Object.entries(schemes ?? {}).map(([key, scheme]) => {
    switch (scheme.scheme?.$case) {
      case 'apiKeySecurityScheme':
        return {
          key,
          kind: 'apiKey' as const,
          name: scheme.scheme.value.name,
          location: normalizeApiKeyLocation(scheme.scheme.value.location),
          ...(scheme.scheme.value.description !== ''
            ? { description: scheme.scheme.value.description }
            : {}),
        };
      case 'httpAuthSecurityScheme':
        return {
          key,
          kind: 'http' as const,
          name: scheme.scheme.value.scheme || undefined,
          ...(scheme.scheme.value.description !== ''
            ? { description: scheme.scheme.value.description }
            : {}),
        };
      case 'oauth2SecurityScheme':
        return {
          key,
          kind: 'oauth2' as const,
          url: scheme.scheme.value.oauth2MetadataUrl || undefined,
          ...(scheme.scheme.value.description !== ''
            ? { description: scheme.scheme.value.description }
            : {}),
        };
      case 'openIdConnectSecurityScheme':
        return {
          key,
          kind: 'openIdConnect' as const,
          url: scheme.scheme.value.openIdConnectUrl || undefined,
          ...(scheme.scheme.value.description !== ''
            ? { description: scheme.scheme.value.description }
            : {}),
        };
      case 'mtlsSecurityScheme':
        return {
          key,
          kind: 'mutualTls' as const,
          ...(scheme.scheme.value.description !== ''
            ? { description: scheme.scheme.value.description }
            : {}),
        };
      default:
        return { key, kind: 'unknown' as const };
    }
  });
}

/** 归一整型认证方案种类（投影用）。 */
function normalizeApiKeyLocation(location: string): AgentAuthScheme['location'] {
  return location === 'query' || location === 'cookie' ? location : 'header';
}

export type { AgentAuthSchemeKind };

/** 模型能力声明 → binding 的 A2A 能力声明（生成 AgentCard 的输入）。 */
export function toSdkCapabilityDeclaration(
  declaration: CapabilityDeclaration,
): A2aCapabilityDeclaration {
  return {
    name: declaration.name,
    description: declaration.description,
    ...(declaration.version !== undefined ? { version: declaration.version } : {}),
    ...(declaration.skills !== undefined ? { skills: declaration.skills } : {}),
    ...(declaration.capabilities !== undefined
      ? { capabilities: declaration.capabilities }
      : {}),
    ...(declaration.auth !== undefined
      ? { securitySchemes: toSdkSecuritySchemes(declaration.auth) }
      : {}),
    ...(declaration.defaultInputModes !== undefined
      ? { defaultInputModes: declaration.defaultInputModes }
      : {}),
    ...(declaration.defaultOutputModes !== undefined
      ? { defaultOutputModes: declaration.defaultOutputModes }
      : {}),
    ...(declaration.url !== undefined ? { url: declaration.url } : {}),
    ...(declaration.protocolVersion !== undefined
      ? { protocolVersion: declaration.protocolVersion }
      : {}),
  };
}

/** binding 探测视图 → 模型能力视图（剥掉 SDK AgentCard）。 */
export function fromCardView(view: A2aProbeResult): CapabilityView {
  return {
    url: view.url,
    name: view.name,
    description: view.description,
    version: view.version,
    skills: view.skills,
    capabilities: view.capabilities,
    auth: {
      required: view.authentication.required,
      schemes: view.authentication.requirements.map((requirement) => ({
        key: requirement.key,
        kind: requirement.kind,
      })),
    },
    signature: { present: view.signaturePresent },
    bindings: view.interfaces.map((agentInterface) => ({
      protocol: agentInterface.protocolBinding,
      version: agentInterface.protocolVersion,
      url: agentInterface.url,
      tenant: agentInterface.tenant,
    })),
  };
}