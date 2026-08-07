import type { ProviderToolPolicy } from '@/core/execution';
import type { HostToolCatalog, HostToolDefinition } from '@/core/tools/HostToolCatalog';
import {
  buildOmpHostToolRegistration,
  canonicalizeOmpHostToolName,
} from '@/providers/omp/runtime/OmpHostToolAdapter';

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

function names(policy: ProviderToolPolicy, access: 'enabled' | 'disabled' = 'enabled') {
  return buildOmpHostToolRegistration(catalog, policy, access)
    .definitions.map(definition => definition.name);
}

describe('OmpHostToolAdapter', () => {
  it('advertises no definitions without explicit session access', () => {
    expect(names({ kind: 'provider-default' }, 'disabled')).toEqual([]);
  });

  it.each([
    [{ kind: 'passive' } as const, []],
    [{ kind: 'read-only' } as const, ['claudian_periodic_job_list']],
    [{ kind: 'provider-default' } as const, [
      'claudian_periodic_job_list',
      'claudian_periodic_job_create',
      'claudian_periodic_job_delete',
    ]],
    [{ kind: 'unrestricted' } as const, [
      'claudian_periodic_job_list',
      'claudian_periodic_job_create',
      'claudian_periodic_job_delete',
    ]],
    [{ kind: 'allow-list', names: ['claudian.periodic_job.create'] } as const, [
      'claudian_periodic_job_create',
    ]],
  ])('filters definitions for $kind', (policy, expected) => {
    expect(names(policy, 'enabled')).toEqual(expected);
  });

  it('preserves the canonical name through the flattened OMP boundary', () => {
    const registration = buildOmpHostToolRegistration(
      catalog,
      { kind: 'provider-default' },
      'enabled',
    );

    expect(registration.canonicalNameByNativeName).toEqual({
      claudian_periodic_job_list: 'claudian.periodic_job.list',
      claudian_periodic_job_create: 'claudian.periodic_job.create',
      claudian_periodic_job_delete: 'claudian.periodic_job.delete',
    });
    expect(canonicalizeOmpHostToolName('claudian_periodic_job_list'))
      .toBe('claudian.periodic_job.list');
  });
});
