import type { ProviderToolPolicy } from '../../../core/execution';
import type {
  HostToolCatalog,
  HostToolDefinition,
} from '../../../core/tools/HostToolCatalog';

export interface OmpHostToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly loadMode: 'essential';
}

export interface OmpHostToolRegistration {
  readonly definitions: readonly OmpHostToolDefinition[];
  readonly canonicalNameByNativeName: Readonly<Record<string, string>>;
}

export function buildOmpHostToolRegistration(
  catalog: HostToolCatalog,
  policy: ProviderToolPolicy,
  access: 'enabled' | 'disabled' | undefined,
): OmpHostToolRegistration {
  if (access !== 'enabled' || policy.kind === 'passive') {
    return { definitions: [], canonicalNameByNativeName: {} };
  }

  const allowList = policy.kind === 'allow-list' ? new Set(policy.names) : null;
  const definitions: OmpHostToolDefinition[] = [];
  const canonicalNameByNativeName: Record<string, string> = {};
  for (const definition of catalog.list()) {
    if (!isDefinitionAllowed(definition, policy, allowList)) continue;
    const nativeName = toOmpHostToolName(definition.name);
    definitions.push({
      name: nativeName,
      label: definition.name,
      description: definition.description,
      parameters: definition.inputSchema,
      loadMode: 'essential',
    });
    canonicalNameByNativeName[nativeName] = definition.name;
  }
  return { definitions, canonicalNameByNativeName };
}

export function toOmpHostToolName(name: string): string {
  return name.startsWith('claudian.')
    ? name.replace(/[^a-zA-Z0-9_-]/g, '_')
    : name;
}

export function canonicalizeOmpHostToolName(name: string): string {
  return name.startsWith('claudian_periodic_job_')
    ? name.replace('claudian_periodic_job_', 'claudian.periodic_job.')
    : name;
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
