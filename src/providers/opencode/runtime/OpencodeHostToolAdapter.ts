import type { ProviderToolPolicy } from '@/core/execution';
import type {
  HostToolCatalog,
  HostToolDefinition,
} from '@/core/tools/HostToolCatalog';

export const OPENCODE_HOST_TOOL_SERVER_NAME = 'claudian';

export interface OpencodeHostToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly effect: HostToolDefinition['effect'];
}

export interface OpencodeHostToolRegistration {
  readonly definitions: readonly OpencodeHostToolDefinition[];
  readonly canonicalNameByNativeName: Readonly<Record<string, string>>;
  readonly canonicalNameByToolName: Readonly<Record<string, string>>;
}

export function buildOpencodeHostToolRegistration(
  catalog: HostToolCatalog,
  policy: ProviderToolPolicy,
  access: 'enabled' | 'disabled' | undefined,
): OpencodeHostToolRegistration {
  if (access !== 'enabled' || policy.kind === 'passive') {
    return {
      definitions: [],
      canonicalNameByNativeName: {},
      canonicalNameByToolName: {},
    };
  }

  const allowList = policy.kind === 'allow-list' ? new Set(policy.names) : null;
  const definitions: OpencodeHostToolDefinition[] = [];
  const canonicalNameByNativeName: Record<string, string> = {};
  const canonicalNameByToolName: Record<string, string> = {};
  for (const definition of catalog.list()) {
    if (!isDefinitionAllowed(definition, policy, allowList)) continue;
    const toolName = toOpencodeHostToolName(definition.name);
    const nativeName = `${OPENCODE_HOST_TOOL_SERVER_NAME}_${toolName}`;
    definitions.push({
      name: toolName,
      description: definition.description,
      inputSchema: definition.inputSchema,
      effect: definition.effect,
    });
    canonicalNameByNativeName[nativeName] = definition.name;
    canonicalNameByToolName[toolName] = definition.name;
  }
  return {
    definitions,
    canonicalNameByNativeName,
    canonicalNameByToolName,
  };
}

export function canonicalizeOpencodeHostToolName(name: string): string {
  return name.startsWith('claudian_periodic_job_')
    ? name.replace('claudian_periodic_job_', 'claudian.periodic_job.')
    : name;
}

function toOpencodeHostToolName(name: string): string {
  const localName = name.startsWith('claudian.')
    ? name.slice('claudian.'.length)
    : name;
  return localName.replace(/[^a-zA-Z0-9_-]/g, '_');
}


function isDefinitionAllowed(
  definition: HostToolDefinition,
  policy: ProviderToolPolicy,
  allowList: ReadonlySet<string> | null,
): boolean {
  if (policy.kind === 'read-only') return definition.effect === 'read';
  if (policy.kind === 'allow-list') return allowList?.has(definition.name) === true;
  return true;
}
