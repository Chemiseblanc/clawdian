import type { ProviderToolPolicy } from '@/core/execution';
import type { HostToolCatalog, HostToolDefinition } from '@/core/tools/HostToolCatalog';
import {
  buildCopilotHostToolRegistration,
  canonicalizeCopilotHostToolName,
} from '@/providers/copilot/runtime/CopilotHostToolAdapter';

const definitions: readonly HostToolDefinition[] = [
  {
    name: 'claudian.periodic_job.list',
    description: 'List jobs.',
    effect: 'read',
    inputSchema: { type: 'object' },
  },
  {
    name: 'claudian.periodic_job.create',
    description: 'Create a job.',
    effect: 'write',
    inputSchema: { type: 'object' },
  },
  {
    name: 'claudian.periodic_job.delete',
    description: 'Delete a job.',
    effect: 'destructive',
    inputSchema: { type: 'object' },
  },
];
const catalog = { list: () => definitions } as HostToolCatalog;

function names(
  policy: ProviderToolPolicy,
  access: 'enabled' | 'disabled' = 'enabled',
): string[] {
  return buildCopilotHostToolRegistration(catalog, policy, access)
    .definitions.map(definition => definition.name);
}

describe('CopilotHostToolAdapter', () => {
  it('advertises no definitions without explicit session access', () => {
    expect(names({ kind: 'provider-default' }, 'disabled')).toEqual([]);
  });

  it.each([
    [{ kind: 'passive' } as const, []],
    [{ kind: 'read-only' } as const, ['periodic_job_list']],
    [{ kind: 'provider-default' } as const, [
      'periodic_job_list',
      'periodic_job_create',
      'periodic_job_delete',
    ]],
    [{ kind: 'unrestricted' } as const, [
      'periodic_job_list',
      'periodic_job_create',
      'periodic_job_delete',
    ]],
    [{ kind: 'allow-list', names: ['claudian.periodic_job.create'] } as const, [
      'periodic_job_create',
    ]],
  ])('filters definitions for $kind', (policy, expected) => {
    expect(names(policy, 'enabled')).toEqual(expected);
  });

  it('maps Copilot-native host tool names to canonical names', () => {
    expect(canonicalizeCopilotHostToolName('claudian_periodic_job_list'))
      .toBe('claudian.periodic_job.list');
    expect(canonicalizeCopilotHostToolName('claudian/periodic_job_list'))
      .toBe('claudian.periodic_job.list');
    expect(canonicalizeCopilotHostToolName('periodic_job_list'))
      .toBe('claudian.periodic_job.list');
    expect(canonicalizeCopilotHostToolName('Run command')).toBe('Run command');
  });
});
