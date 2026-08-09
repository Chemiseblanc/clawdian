import type { ProviderToolPolicy } from '@/core/execution';
import type { HostToolCatalog, HostToolDefinition } from '@/core/tools/HostToolCatalog';
import {
  buildClaudeHostToolRegistration,
  canonicalizeClaudeHostToolName,
} from '@/providers/claude/runtime/ClaudeHostToolAdapter';

const definitions: readonly HostToolDefinition[] = [
  {
    name: 'claudian.periodic_job.list',
    description: 'List jobs.',
    inputSchema: { type: 'object' },
    effect: 'read',
  },
  {
    name: 'claudian.periodic_job.create',
    description: 'Create a job.',
    inputSchema: { type: 'object' },
    effect: 'write',
  },
  {
    name: 'claudian.periodic_job.delete',
    description: 'Delete a job.',
    inputSchema: { type: 'object' },
    effect: 'destructive',
  },
];
const catalog = { list: () => definitions } as HostToolCatalog;

function names(
  policy: ProviderToolPolicy,
  access: 'enabled' | 'disabled' = 'enabled',
): string[] {
  return buildClaudeHostToolRegistration(catalog, policy, access)
    .definitions.map(definition => definition.name);
}

describe('ClaudeHostToolAdapter', () => {
  it('advertises no definitions without explicit session access', () => {
    expect(names({ kind: 'provider-default' }, 'disabled')).toEqual([]);
  });

  it('filters definitions for every tool policy', () => {
    expect(names({ kind: 'passive' })).toEqual([]);
    expect(names({ kind: 'read-only' })).toEqual(['periodic_job_list']);
    expect(names({ kind: 'provider-default' })).toEqual([
      'periodic_job_list',
      'periodic_job_create',
      'periodic_job_delete',
    ]);
    expect(names({ kind: 'unrestricted' })).toEqual([
      'periodic_job_list',
      'periodic_job_create',
      'periodic_job_delete',
    ]);
    expect(names({
      kind: 'allow-list',
      names: ['claudian.periodic_job.create'],
    })).toEqual(['periodic_job_create']);
  });

  it('maps Claude MCP names to canonical names', () => {
    const registration = buildClaudeHostToolRegistration(
      catalog,
      { kind: 'provider-default' },
      'enabled',
    );
    expect(registration.canonicalNameByNativeName).toEqual({
      mcp__claudian__periodic_job_list: 'claudian.periodic_job.list',
      mcp__claudian__periodic_job_create: 'claudian.periodic_job.create',
      mcp__claudian__periodic_job_delete: 'claudian.periodic_job.delete',
    });
    expect(canonicalizeClaudeHostToolName('mcp__claudian__periodic_job_list'))
      .toBe('claudian.periodic_job.list');
    expect(canonicalizeClaudeHostToolName('Read')).toBe('Read');
  });
});
