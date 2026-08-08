const mockGetHostnameKey = jest.fn(() => 'current-host');

jest.mock('../../../../src/utils/env', () => ({
  ...jest.requireActual('../../../../src/utils/env'),
  getHostnameKey: () => mockGetHostnameKey(),
}));

import {
  clearCurrentCopilotCatalog,
  DEFAULT_COPILOT_PROVIDER_SETTINGS,
  getCopilotProviderSettings,
  getCurrentCopilotCatalog,
  getOrderedCopilotVisibleModelIds,
  updateCopilotProviderSettings,
  updateCurrentCopilotCatalog,
} from '@/providers/copilot/settings';

describe('Copilot settings', () => {
  const currentCatalog = {
    defaultModelId: 'gpt-5',
    fingerprint: 'current-fingerprint',
    models: [{
      displayName: 'GPT-5',
      rawId: 'gpt-5',
      reasoningEfforts: [{ label: 'High', value: 'high' }],
      supportsReasoning: true,
    }],
    refreshedAt: 100,
  };
  const otherCatalog = {
    defaultModelId: 'claude-sonnet-4',
    fingerprint: 'other-fingerprint',
    models: [{
      displayName: 'Claude Sonnet 4',
      rawId: 'claude-sonnet-4',
      reasoningEfforts: [],
      supportsReasoning: false,
    }],
    refreshedAt: 50,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetHostnameKey.mockReturnValue('current-host');
  });

  it('defaults Copilot to disabled with no synthetic model or catalog state', () => {
    expect(DEFAULT_COPILOT_PROVIDER_SETTINGS).toEqual({
      catalogsByHost: {},
      cliPath: '',
      cliPathsByHost: {},
      enabled: false,
      environmentHash: '',
      environmentVariables: '',
      modelAliases: {},
      preferredReasoningByModel: {},
      visibleModels: null,
    });
    expect(getOrderedCopilotVisibleModelIds(getCopilotProviderSettings({}))).toEqual([]);
  });

  it('merges hostname-scoped CLI paths and catalogs without assigning another host to this device', () => {
    mockGetHostnameKey.mockReturnValue('device:current');

    const settings = getCopilotProviderSettings({
      providerConfigs: {
        copilot: {
          catalogsByHost: {
            'host-a': currentCatalog,
            'host-b': otherCatalog,
          },
          cliPathsByHost: {
            'host-a': '/host-a/copilot',
            'host-b': '/host-b/copilot',
          },
        },
      },
    });

    expect(settings.cliPathsByHost).toEqual({
      'host-a': '/host-a/copilot',
      'host-b': '/host-b/copilot',
    });
    expect(settings.catalogsByHost).toEqual({
      'host-a': currentCatalog,
      'host-b': otherCatalog,
    });
    expect(settings.currentCatalog).toBeNull();
  });

  it('round-trips only the current host catalog and preserves other host snapshots', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        copilot: {
          catalogsByHost: {
            'current-host': currentCatalog,
            'other-host': otherCatalog,
          },
        },
      },
    };
    const replacement = {
      ...currentCatalog,
      fingerprint: 'replacement-fingerprint',
      refreshedAt: 200,
    };

    expect(updateCurrentCopilotCatalog(settings, replacement)).toEqual(replacement);
    expect(getCurrentCopilotCatalog(settings)).toEqual(replacement);
    expect(getCopilotProviderSettings(settings).catalogsByHost['other-host']).toEqual(otherCatalog);
    expect(clearCurrentCopilotCatalog(settings)).toBe(true);
    expect(getCurrentCopilotCatalog(settings)).toBeNull();
    expect(getCopilotProviderSettings(settings).catalogsByHost['other-host']).toEqual(otherCatalog);
    expect(clearCurrentCopilotCatalog(settings)).toBe(false);
  });

  it('preserves catalog visibility and aliases for a selected model missing from discovery', () => {
    const settings = getCopilotProviderSettings({
      model: 'copilot/legacy-model',
      providerConfigs: {
        copilot: {
          catalogsByHost: { 'current-host': currentCatalog },
          modelAliases: {
            'gpt-5': ' GPT ',
            'legacy-model': ' Legacy model ',
          },
          preferredReasoningByModel: {
            'gpt-5': 'high',
            'legacy-model': 'low',
          },
          visibleModels: ['gpt-5', 'legacy-model', 'gpt-5'],
        },
      },
      savedProviderModel: {
        copilot: 'copilot/legacy-model',
      },
      titleGenerationModel: 'copilot/legacy-model',
    });

    expect(settings.visibleModels).toEqual(['gpt-5', 'legacy-model']);
    expect(settings.modelAliases).toEqual({
      'gpt-5': 'GPT',
      'legacy-model': 'Legacy model',
    });
    expect(settings.preferredReasoningByModel).toEqual({
      'gpt-5': 'high',
      'legacy-model': 'low',
    });
  });

  it('orders all discovered models with the ACP default first when visibility is unset', () => {
    const settings = getCopilotProviderSettings({
      providerConfigs: {
        copilot: {
          catalogsByHost: {
            'current-host': {
              ...currentCatalog,
              defaultModelId: 'gpt-5',
              models: [
                { displayName: 'Other', rawId: 'other', reasoningEfforts: [], supportsReasoning: false },
                ...currentCatalog.models,
              ],
            },
          },
          visibleModels: null,
        },
      },
    });

    expect(getOrderedCopilotVisibleModelIds(settings)).toEqual(['gpt-5', 'other']);
  });

  it('persists normalized CLI settings without clobbering another provider', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        claude: { enabled: true, marker: 'untouched' },
        copilot: { catalogsByHost: { 'current-host': currentCatalog } },
      },
    };

    const next = updateCopilotProviderSettings(settings, {
      cliPath: ' /opt/bin/copilot ',
      enabled: true,
      modelAliases: { 'gpt-5': ' GPT ' },
      visibleModels: ['gpt-5'],
    });

    expect(next).toMatchObject({
      cliPath: '',
      cliPathsByHost: { 'current-host': '/opt/bin/copilot' },
      enabled: true,
      modelAliases: { 'gpt-5': 'GPT' },
      visibleModels: ['gpt-5'],
    });
    expect((settings.providerConfigs as Record<string, unknown>).claude).toEqual({
      enabled: true,
      marker: 'untouched',
    });
  });
});
