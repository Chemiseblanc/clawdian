import { isVersionedRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import {
  computeCopilotEnvironmentHash,
  copilotSettingsReconciler,
} from '@/providers/copilot/env/CopilotSettingsReconciler';
import { getCopilotProviderSettings } from '@/providers/copilot/settings';

jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'current-host',
}));

describe('CopilotSettingsReconciler', () => {
  const catalog = (rawId: string) => ({
    defaultModelId: rawId,
    fingerprint: `${rawId}-fingerprint`,
    models: [{
      displayName: rawId,
      rawId,
      reasoningEfforts: [],
      supportsReasoning: false,
    }],
    refreshedAt: 1,
  });

  it('clears only the current host catalog when ACP environment inputs change', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        claude: { enabled: true, marker: 'untouched' },
        copilot: {
          catalogsByHost: {
            'current-host': catalog('current-model'),
            'other-host': catalog('other-model'),
          },
          cliPathsByHost: { 'current-host': '/bin/copilot' },
          enabled: true,
          environmentHash: 'stale-hash',
          environmentVariables: 'COPILOT_HOME=/tmp/copilot-new\nCOPILOT_TOKEN=secret',
        },
      },
      sharedEnvironmentVariables: 'HTTPS_PROXY=https://proxy.example.com',
    };

    const result = copilotSettingsReconciler.reconcileModelWithEnvironment(settings, []);

    expect(result).toEqual({ changed: true, invalidatedConversations: [] });
    expect(getCopilotProviderSettings(settings).catalogsByHost).toEqual({
      'other-host': catalog('other-model'),
    });
    expect(getCopilotProviderSettings(settings).currentCatalog).toBeNull();
    expect(getCopilotProviderSettings(settings).environmentHash)
      .toBe(computeCopilotEnvironmentHash(settings));
    expect(isVersionedRuntimeInputFingerprint(
      getCopilotProviderSettings(settings).environmentHash,
    )).toBe(true);
    expect(getCopilotProviderSettings(settings).environmentHash).not.toContain('secret');
    expect((settings.providerConfigs as Record<string, unknown>).claude).toEqual({
      enabled: true,
      marker: 'untouched',
    });
  });

  it('keeps the current catalog when the ACP environment fingerprint is unchanged', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        copilot: {
          catalogsByHost: { 'current-host': catalog('current-model') },
          cliPathsByHost: { 'current-host': '/bin/copilot' },
          enabled: true,
          environmentVariables: 'COPILOT_HOME=/tmp/copilot',
        },
      },
    };
    (settings.providerConfigs as Record<string, any>).copilot.environmentHash =
      computeCopilotEnvironmentHash(settings);

    expect(copilotSettingsReconciler.reconcileModelWithEnvironment(settings, []))
      .toEqual({ changed: false, invalidatedConversations: [] });
    expect(getCopilotProviderSettings(settings).currentCatalog).toEqual(catalog('current-model'));
  });
});
