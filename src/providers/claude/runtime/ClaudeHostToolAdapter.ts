import type { ProviderToolPolicy } from '@/core/execution';
import type {
  HostToolCatalog,
  HostToolDefinition,
} from '@/core/tools/HostToolCatalog';
import type {
  AcpHostToolDefinition,
  AcpHostToolRegistration,
} from '@/providers/acp';

export const CLAUDE_HOST_TOOL_SERVER_NAME = 'claudian';

export type ClaudeHostToolDefinition = AcpHostToolDefinition;
export type ClaudeHostToolRegistration = AcpHostToolRegistration;

export function buildClaudeHostToolRegistration(
  catalog: HostToolCatalog,
  policy: ProviderToolPolicy,
  access: 'enabled' | 'disabled' | undefined,
): ClaudeHostToolRegistration {
  if (access !== 'enabled' || policy.kind === 'passive') {
    return {
      definitions: [],
      canonicalNameByNativeName: {},
      canonicalNameByToolName: {},
    };
  }

  const allowList = policy.kind === 'allow-list' ? new Set(policy.names) : null;
  const definitions: ClaudeHostToolDefinition[] = [];
  const canonicalNameByNativeName: Record<string, string> = {};
  const canonicalNameByToolName: Record<string, string> = {};
  for (const definition of catalog.list()) {
    if (!isDefinitionAllowed(definition, policy, allowList)) continue;
    const toolName = toClaudeHostToolName(definition.name);
    const nativeName = toClaudeNativeHostToolName(toolName);
    definitions.push({
      name: toolName,
      description: definition.description,
      inputSchema: definition.inputSchema,
      effect: definition.effect,
    });
    canonicalNameByNativeName[nativeName] = definition.name;
    canonicalNameByToolName[toolName] = definition.name;
  }
  return { definitions, canonicalNameByNativeName, canonicalNameByToolName };
}

export function canonicalizeClaudeHostToolName(name: string): string {
  return /^mcp__claudian__periodic_job_(list|create|update|delete)$/.test(name)
    ? name.replace('mcp__claudian__periodic_job_', 'claudian.periodic_job.')
    : name;
}

export function toClaudeNativeHostToolName(toolName: string): string {
  return `mcp__${CLAUDE_HOST_TOOL_SERVER_NAME}__${toolName}`;
}

function toClaudeHostToolName(name: string): string {
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
  if (allowList) return allowList.has(definition.name);
  return true;
}

