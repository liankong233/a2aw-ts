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
 * 统一能力模型：本地导出声明与远端探测共用一套类型。
 *
 * - {@link A2aCapabilityDeclaration}：本地能力声明（A2aExportClient 据此
 *   生成并导出 AgentCard）；
 * - {@link toAgentCard}：声明 → AgentCard（SDK 卡片结构）；
 * - {@link fromAgentCard} / {@link A2aProbeResult}：远端卡片 → 统一能力
 *   视图（skills / capabilities / 认证要求 / 传输绑定），供探测（probe）
 *   与登记流程使用（设计文档 §4.14 管理 API `/api/a2a/probe`）。
 *
 * @packageDocumentation
 */

import type {
  AgentCard,
  AgentCapabilities,
  AgentInterface,
  AgentSkill,
  SecurityScheme,
} from '@a2a-js/sdk';

/** 统一技能声明（本地声明与探测结果共用）。 */
export interface A2aSkillDeclaration {
  readonly name: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly examples?: readonly string[];
}

/** 统一能力开关（A2A AgentCapabilities 的投影：streaming/pushNotifications）。 */
export interface A2aCapabilityDeclarationFlags {
  readonly streaming?: boolean;
  readonly pushNotifications?: boolean;
}

/**
 * 本地能力声明：内部模块声明对外导出的能力，由 {@link toAgentCard}
 * 转换为 A2A AgentCard 供外部客户端发现。
 */
export interface A2aCapabilityDeclaration {
  /** Agent 名称（AgentCard.name）。 */
  readonly name: string;
  /** 描述（AgentCard.description）。 */
  readonly description: string;
  /** 版本（AgentCard.version）。 */
  readonly version?: string;
  /** 声明提供的技能（AgentCard.skills）。 */
  readonly skills?: readonly A2aSkillDeclaration[];
  /** 能力开关。 */
  readonly capabilities?: A2aCapabilityDeclarationFlags;
  /** 认证方案（map：方案 key → SecurityScheme），声明后外部需带凭据。 */
  readonly securitySchemes?: Readonly<Record<string, SecurityScheme>>;
  /** AgentCard.defaultInputModes / defaultOutputModes。 */
  readonly defaultInputModes?: readonly string[];
  readonly defaultOutputModes?: readonly string[];
  /** 导出的 JSON-RPC 端点（AgentInterface.url）；缺省时由门面挂载路径决定。 */
  readonly url?: string;
  /** 协议版本（AgentInterface.protocolVersion），缺省 '1.0'。 */
  readonly protocolVersion?: string;
}

/** 认证方案种类（SecurityScheme oneof 判别投影）。 */
export type A2aSchemeKind =
  | 'apiKey'
  | 'http'
  | 'oauth2'
  | 'openIdConnect'
  | 'mutualTls'
  | 'unknown';

/** 识别 SecurityScheme 的种类。 */
export function securitySchemeKind(scheme: SecurityScheme): A2aSchemeKind {
  switch (scheme.scheme?.$case) {
    case 'apiKeySecurityScheme':
      return 'apiKey';
    case 'httpAuthSecurityScheme':
      return 'http';
    case 'oauth2SecurityScheme':
      return 'oauth2';
    case 'openIdConnectSecurityScheme':
      return 'openIdConnect';
    case 'mtlsSecurityScheme':
      return 'mutualTls';
    default:
      return 'unknown';
  }
}

/** 技能声明 → AgentCard 技能条目（补齐 SDK 必填字段的空默认值）。 */
export function toAgentSkill(skill: A2aSkillDeclaration): AgentSkill {
  return {
    id: skill.name,
    name: skill.name,
    description: skill.description ?? '',
    tags: [...(skill.tags ?? [])],
    examples: [...(skill.examples ?? [])],
    inputModes: [],
    outputModes: [],
    securityRequirements: [],
  };
}

/** 本地能力声明 → AgentCard。 */
export function toAgentCard(
  declaration: A2aCapabilityDeclaration,
  url?: string,
): AgentCard {
  const capabilities: AgentCapabilities = {
    streaming: declaration.capabilities?.streaming ?? false,
    pushNotifications: declaration.capabilities?.pushNotifications ?? false,
    extensions: [],
  };
  const agentInterface: AgentInterface = {
    url: url ?? declaration.url ?? '/jsonrpc',
    protocolBinding: 'JSONRPC',
    tenant: '',
    protocolVersion: declaration.protocolVersion ?? '1.0',
  };
  return {
    name: declaration.name,
    description: declaration.description,
    version: declaration.version ?? '0.0.0',
    supportedInterfaces: [agentInterface],
    provider: undefined,
    capabilities,
    securitySchemes: { ...(declaration.securitySchemes ?? {}) },
    securityRequirements: [],
    defaultInputModes: [...(declaration.defaultInputModes ?? [])],
    defaultOutputModes: [...(declaration.defaultOutputModes ?? [])],
    skills: (declaration.skills ?? []).map(toAgentSkill),
    signatures: [],
  };
}

/** 传输绑定（探测结果里的 AgentInterface 投影）。 */
export interface A2aProbeBinding {
  readonly protocolBinding: string;
  readonly protocolVersion: string;
  readonly url: string;
  readonly tenant: string;
}

/** 认证要求摘要（探测结果）。 */
export interface A2aProbeAuthentication {
  /** 是否要求认证（AgentCard.securitySchemes 非空）。 */
  readonly required: boolean;
  readonly requirements: ReadonlyArray<{
    readonly key: string;
    readonly kind: A2aSchemeKind;
  }>;
}

/**
 * 探测结果：远端 AgentCard 的统一能力视图。
 *
 * 由 {@link fromAgentCard} 生成，是登记外部 A2A Agent 时的第一手资料
 * （名称 / 技能 / 能力 / 认证要求 / 传输绑定）。
 */
export interface A2aProbeResult {
  /** 探测地址。 */
  readonly url: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly skills: readonly A2aSkillDeclaration[];
  readonly capabilities: Required<A2aCapabilityDeclarationFlags>;
  readonly authentication: A2aProbeAuthentication;
  readonly interfaces: readonly A2aProbeBinding[];
  /** 原始 AgentCard（需要签名校验/完整结构时使用）。 */
  readonly card: AgentCard;
}

/** 探测能力视图 ← AgentCard。 */
export function fromAgentCard(card: AgentCard, url: string): A2aProbeResult {
  const capabilities: Required<A2aCapabilityDeclarationFlags> = {
    streaming: card.capabilities?.streaming ?? false,
    pushNotifications: card.capabilities?.pushNotifications ?? false,
  };
  const schemes = card.securitySchemes ?? {};
  return {
    url,
    name: card.name,
    description: card.description,
    version: card.version,
    skills: (card.skills ?? []).map((skill) => ({
      name: skill.name,
      description: skill.description === '' ? undefined : skill.description,
      tags: skill.tags,
      examples: skill.examples,
    })),
    capabilities,
    authentication: {
      required: Object.keys(schemes).length > 0,
      requirements: Object.entries(schemes).map(([key, scheme]) => ({
        key,
        kind: securitySchemeKind(scheme),
      })),
    },
    interfaces: (card.supportedInterfaces ?? []).map((agentInterface) => ({
      protocolBinding: agentInterface.protocolBinding,
      protocolVersion: agentInterface.protocolVersion,
      url: agentInterface.url,
      tenant: agentInterface.tenant,
    })),
    card,
  };
}