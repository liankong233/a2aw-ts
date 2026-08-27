/**
 * 协议无关的能力模型：本地声明与远端探测共用同一套结构。
 *
 * - {@link CapabilityDeclaration}：本地实现方声明（{@link A2aImplAdaptor}
 *   据此导出给外部发现并生成 AgentCard）；
 * - {@link CapabilityView}：远端探测视图（{@link A2aInvokeAdaptor.probe}
 *   的产出），是登记 / 展示外部 Agent 的第一手资料。
 *
 * 认证方案（{@link AgentAuthScheme}）只保留公共面需要的投影字段，
 * 协议特有的完整结构由 binding 层在转换时补齐。
 *
 * @packageDocumentation
 */

/** 能力开关（streaming / pushNotifications 投影）。 */
export interface AgentCapabilityFlags {
  readonly streaming?: boolean;
  readonly pushNotifications?: boolean;
}

/** 技能声明。 */
export interface AgentSkill {
  readonly name: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly examples?: readonly string[];
}

/** 认证方案种类（协议 SecurityScheme oneof 的判别投影）。 */
export type AgentAuthSchemeKind =
  | 'apiKey'
  | 'http'
  | 'oauth2'
  | 'openIdConnect'
  | 'mutualTls'
  | 'unknown';

/** 协议无关的认证方案描述。 */
export interface AgentAuthScheme {
  /** 方案 key（对外暴露时的标识，如 'apiKey' / 'bearer'）。 */
  readonly key: string;
  readonly kind: AgentAuthSchemeKind;
  /** apiKey：参数名；http：认证方案名（bearer / basic…）。 */
  readonly name?: string;
  /** apiKey 参数位置。 */
  readonly location?: 'header' | 'query' | 'cookie';
  /** oauth2 / openIdConnect：元数据地址。 */
  readonly url?: string;
  readonly description?: string;
}

/** 本地能力声明（{@link A2aImplAdaptor} 的输入）。 */
export interface CapabilityDeclaration {
  /** Agent 名称。 */
  readonly name: string;
  readonly description: string;
  readonly version?: string;
  readonly skills?: readonly AgentSkill[];
  readonly capabilities?: AgentCapabilityFlags;
  /** 认证方案列表；声明后外部需带凭据才能调用。 */
  readonly auth?: readonly AgentAuthScheme[];
  readonly defaultInputModes?: readonly string[];
  readonly defaultOutputModes?: readonly string[];
  /** 导出的 JSON-RPC/REST 端点（AgentInterface.url）；缺省由门面挂载路径决定。 */
  readonly url?: string;
  readonly protocolVersion?: string;
}

/** 传输绑定（探测结果里 AgentInterface 的投影）。 */
export interface CapabilityBinding {
  /** 传输绑定协议（如 'JSONRPC' / 'REST'）。 */
  readonly protocol: string;
  readonly version: string;
  readonly url: string;
  readonly tenant: string;
}

/** 远端能力探测视图（{@link A2aInvokeAdaptor.probe} 的产出）。 */
export interface CapabilityView {
  /** 探测地址。 */
  readonly url: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly skills: readonly AgentSkill[];
  readonly capabilities: Required<AgentCapabilityFlags>;
  readonly auth: {
    readonly required: boolean;
    readonly schemes: readonly AgentAuthScheme[];
  };
  readonly bindings: readonly CapabilityBinding[];
}

/** 本地能力声明 → 探测视图（{@link A2aImplAdaptor.probe} 使用）。 */
export function toCapabilityView(
  url: string,
  declaration: CapabilityDeclaration,
): CapabilityView {
  return {
    url,
    name: declaration.name,
    description: declaration.description,
    version: declaration.version ?? '0.0.0',
    skills: declaration.skills ?? [],
    capabilities: {
      streaming: declaration.capabilities?.streaming ?? false,
      pushNotifications: declaration.capabilities?.pushNotifications ?? false,
    },
    auth: {
      required: (declaration.auth?.length ?? 0) > 0,
      schemes: declaration.auth ?? [],
    },
    bindings: [
      {
        protocol: 'JSONRPC',
        version: declaration.protocolVersion ?? '1.0',
        url: declaration.url ?? url,
        tenant: '',
      },
    ],
  };
}