import { CachedProviderCliResolver } from '@/core/providers/cli/CachedProviderCliResolver';
import { getRuntimeEnvironmentText } from '@/core/providers/providerEnvironment';

import { getCopilotProviderSettings } from '../settings';

/** Resolves the Copilot CLI using host-specific and configured path settings. */
export class CopilotCliResolver {
  private readonly resolver = new CachedProviderCliResolver({
    binaryName: 'copilot',
    getSettingsProjection: settings => {
      const providerSettings = getCopilotProviderSettings(settings);
      return {
        cliPathsByHost: providerSettings.cliPathsByHost,
        environmentText: getRuntimeEnvironmentText(settings, 'copilot'),
        legacyCliPath: providerSettings.cliPath,
      };
    },
    providerId: 'copilot',
  });

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    return this.resolver.resolveFromSettings(settings);
  }

  resolve(
    hostnamePaths: Record<string, string> | undefined,
    legacyPath: string,
    environmentText: string,
  ): string | null {
    return this.resolver.resolve({
      cliPathsByHost: hostnamePaths,
      environmentText,
      legacyCliPath: legacyPath,
    });
  }

  reset(): void {
    this.resolver.reset();
  }
}
