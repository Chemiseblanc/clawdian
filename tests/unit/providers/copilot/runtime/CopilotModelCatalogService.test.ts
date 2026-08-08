import type { ProviderHost } from '@/core/providers/ProviderHost';
import {
  type CopilotAcpSessionProbeLike,
  type CopilotAcpSessionProbeRequest,
  type CopilotAcpSessionProbeResult,
  CopilotModelCatalogService,
} from '@/providers/copilot/runtime/CopilotModelCatalogService';

function makePlugin(enabled = true): ProviderHost {
  return {
    app: { vault: { adapter: { basePath: '/vault' } } },
    getResolvedProviderCliPath: jest.fn(async () => '/opt/copilot'),
    settings: {
      providerConfigs: {
        copilot: {
          enabled,
          environmentVariables: 'COPILOT_TOKEN=secret\nCOPILOT_TEST=1',
        },
      },
      sharedEnvironmentVariables: '',
    },
  } as unknown as ProviderHost;
}

function makeProbe(
  result: CopilotAcpSessionProbeResult,
): {
  probe: jest.Mocked<CopilotAcpSessionProbeLike>;
  requests: CopilotAcpSessionProbeRequest[];
} {
  const requests: CopilotAcpSessionProbeRequest[] = [];
  const probe: jest.Mocked<CopilotAcpSessionProbeLike> = {
    probe: jest.fn(async (request: CopilotAcpSessionProbeRequest) => {
      requests.push(request);
      return result;
    }),
  };
  return { probe, requests };
}

const discoveredModel = {
  displayName: 'GPT-5',
  rawId: 'gpt-5',
  reasoningEfforts: [{ label: 'High', value: 'high' }],
  supportsReasoning: true,
};

describe('CopilotModelCatalogService', () => {
  it('discovers ACP-advertised models with the resolved command and runtime environment', async () => {
    const { probe, requests } = makeProbe({
      defaultModelId: 'gpt-5',
      availableModels: [discoveredModel],
      modes: { availableModes: [{ id: 'agent', name: 'Agent' }], currentModeId: 'agent' },
      configOptions: [],
    });
    const plugin = makePlugin();
    const service = new CopilotModelCatalogService(plugin, { probe });

    const result = await service.discoverCatalog();

    expect(result).toMatchObject({
      defaultModelId: 'gpt-5',
      kind: 'completed',
      fingerprint: expect.stringMatching(/^1:[a-f0-9]{64}$/),
      models: [expect.objectContaining({ rawId: 'gpt-5' })],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      command: '/opt/copilot',
      cwd: '/vault',
      env: expect.objectContaining({
        COPILOT_TEST: '1',
        COPILOT_TOKEN: 'secret',
      }),
      version: 'unknown',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('preserves a valid empty catalog without inventing a model or default', async () => {
    const { probe } = makeProbe({
      defaultModelId: null,
      availableModels: [],
      modes: null,
      configOptions: [],
    });
    const result = await new CopilotModelCatalogService(
      makePlugin(),
      { probe },
    ).discoverCatalog();

    expect(result).toMatchObject({
      defaultModelId: null,
      kind: 'completed',
      models: [],
    });
    expect(JSON.stringify(result)).not.toContain('copilot/');
  });

  it('returns diagnostics for probe failure and does not leak process output or secrets', async () => {
    const probe: jest.Mocked<CopilotAcpSessionProbeLike> = {
      probe: jest.fn(async (_request: CopilotAcpSessionProbeRequest) => {
        throw new Error('spawn failed: token=secret');
      }),
    };
    const result = await new CopilotModelCatalogService(
      makePlugin(),
      { probe },
    ).discoverCatalog();

    expect(result).toMatchObject({
      diagnostics: expect.any(String),
      kind: 'completed',
      models: [],
    });
    expect(JSON.stringify(result)).not.toContain('token=secret');
  });

  it('skips disabled providers without resolving a command or creating a probe process', async () => {
    const plugin = makePlugin(false);
    const { probe } = makeProbe({ availableModels: [], defaultModelId: null });
    const result = await new CopilotModelCatalogService(
      plugin,
      { probe },
    ).discoverCatalog();

    expect(result).toEqual({ kind: 'skipped', reason: 'provider-disabled' });
    expect(plugin.getResolvedProviderCliPath).not.toHaveBeenCalled();
    expect(probe.probe).not.toHaveBeenCalled();
  });

  it('returns a fresh empty result after a failed refresh instead of inventing a model', async () => {
    const first = makeProbe({
      defaultModelId: 'gpt-5',
      availableModels: [discoveredModel],
      modes: null,
      configOptions: [],
    });
    const plugin = makePlugin();
    const service = new CopilotModelCatalogService(plugin, { probe: first.probe });
    const completed = await service.discoverCatalog();
    expect(completed).toMatchObject({ models: [expect.objectContaining({ rawId: 'gpt-5' })] });

    first.probe.probe.mockRejectedValueOnce(new Error('not logged in'));
    const failed = await service.discoverCatalog();
    expect(failed).toMatchObject({ kind: 'completed', models: [] });
    expect(JSON.stringify(failed)).not.toContain('gpt-5');
  });
});
