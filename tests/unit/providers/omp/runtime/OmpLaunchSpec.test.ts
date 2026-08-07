import { buildOmpLaunchSpec } from '@/providers/omp/runtime/OmpLaunchSpec';
import type { OmpProviderSettings } from '@/providers/omp/settings';

const baseSettings: OmpProviderSettings = {
  cliPath: '',
  cliPathsByHost: {},
  discoveredModels: [],
  enabled: true,
  environmentHash: '',
  environmentVariables: '',
  modelAliases: {},
  preferredThinkingByModel: {},
  toolMode: 'all',
  visibleModels: [],
};

describe('OmpLaunchSpec', () => {
  it('builds main launch args with replacement system prompt and model flags', () => {
    expect(buildOmpLaunchSpec({
      command: '/bin/omp',
      cwd: '/vault',
      model: 'omp:anthropic/claude/sonnet',
      providerState: { sessionFile: '/tmp/session.jsonl' },
      settings: baseSettings,
      systemPrompt: 'System prompt',
      thinkingLevel: 'high',
    }).args).toEqual([
      '--mode',
      'rpc',
      '--system-prompt',
      'System prompt',
      '--resume',
      '/tmp/session.jsonl',
      '--provider',
      'anthropic',
      '--model',
      'claude/sonnet',
      '--thinking',
      'high',
    ]);
  });

  it('adds no-session and read-only tools when requested', () => {
    expect(buildOmpLaunchSpec({
      command: 'omp',
      cwd: '/vault',
      noSession: true,
      settings: {
        ...baseSettings,
        toolMode: 'readonly',
      },
    }).args).toEqual([
      '--mode',
      'rpc',
      '--no-session',
      '--tools',
      'read,grep,glob',
    ]);
  });

  it('does not resume from detached previous sessions', () => {
    expect(buildOmpLaunchSpec({
      command: 'omp',
      cwd: '/vault',
      providerState: {
        previousSessions: [{
          leafEntryId: 'assistant-1',
          sessionFile: '/tmp/previous.jsonl',
          sessionId: 'previous-session',
        }],
      },
      settings: baseSettings,
    }).args).toEqual(['--mode', 'rpc']);
  });

  it('passes max thinking through to Omp', () => {
    expect(buildOmpLaunchSpec({
      command: 'omp',
      cwd: '/vault',
      noSession: true,
      settings: baseSettings,
      thinkingLevel: 'max',
    }).args).toEqual([
      '--mode',
      'rpc',
      '--no-session',
      '--thinking',
      'max',
    ]);
  });

  it('uses no-tools for passive auxiliary launches', () => {
    expect(buildOmpLaunchSpec({
      command: 'omp',
      cwd: '/vault',
      noSession: true,
      noTools: true,
      settings: baseSettings,
    }).args).toEqual([
      '--mode',
      'rpc',
      '--no-session',
      '--no-tools',
    ]);
  });

  it('includes full runtime environment text in the launch key', () => {
    const first = buildOmpLaunchSpec({
      command: 'omp',
      cwd: '/vault',
      envText: 'PATH=/first',
      settings: baseSettings,
    });
    const second = buildOmpLaunchSpec({
      command: 'omp',
      cwd: '/vault',
      envText: 'PATH=/second',
      settings: baseSettings,
    });

    expect(first.launchKey).not.toBe(second.launchKey);
  });
});
