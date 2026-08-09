import type { ProviderToolPolicy } from '@/core/execution';
import type {
  HostToolCatalog,
  HostToolDefinition,
} from '@/core/tools/HostToolCatalog';
import type {
  AcpHostToolDefinition,
  AcpHostToolRegistration,
} from '@/providers/acp';

export const COPILOT_HOST_TOOL_SERVER_NAME = 'claudian';

export type CopilotHostToolDefinition = AcpHostToolDefinition;
export type CopilotHostToolRegistration = AcpHostToolRegistration;

export function buildCopilotHostToolRegistration(
  catalog: HostToolCatalog,
  policy: ProviderToolPolicy,
  access: 'enabled' | 'disabled' | undefined,
): CopilotHostToolRegistration {
  if (access !== 'enabled' || policy.kind === 'passive') {
    return {
      definitions: [],
      canonicalNameByNativeName: {},
      canonicalNameByToolName: {},
    };
  }

  const allowList = policy.kind === 'allow-list' ? new Set(policy.names) : null;
  const definitions: CopilotHostToolDefinition[] = [];
  const canonicalNameByNativeName: Record<string, string> = {};
  const canonicalNameByToolName: Record<string, string> = {};
  for (const definition of catalog.list()) {
    if (!isDefinitionAllowed(definition, policy, allowList)) continue;
    const toolName = toCopilotHostToolName(definition.name);
    const nativeName = `${COPILOT_HOST_TOOL_SERVER_NAME}_${toolName}`;
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

export function canonicalizeCopilotHostToolName(name: string): string {
  const trimmed = name.trim();
  const normalized = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const match = /^(?:claudian_)?periodic_job_(list|create|update|delete)$/.exec(normalized);
  return match ? `claudian.periodic_job.${match[1]}` : trimmed;
}

function toCopilotHostToolName(name: string): string {
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
