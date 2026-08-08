import { createCliPathFingerprintInputs } from '../../../core/providers/cli/CliPathFingerprintInputs';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { createRuntimeInputFingerprint } from '../../../core/providers/settings/RuntimeInputFingerprint';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import { getHostnameKey, parseEnvironmentVariables } from '../../../utils/env';
import {
  decodeCopilotModelId,
  encodeCopilotModelId,
} from '../models';
import {
  clearCurrentCopilotCatalog,
  getCopilotProviderSettings,
  updateCopilotProviderSettings,
} from '../settings';

export function computeCopilotEnvironmentHash(settings: Record<string, unknown>): string {
  const providerSettings = getCopilotProviderSettings(settings);
  const cliPathInputs = createCliPathFingerprintInputs(
    providerSettings.cliPathsByHost[getHostnameKey()],
    providerSettings.cliPath,
  );
  const environmentText = getRuntimeEnvironmentText(settings, 'copilot');
  const environment = Object.entries(parseEnvironmentVariables(environmentText))
    .sort(([left], [right]) => left.localeCompare(right));
  return createRuntimeInputFingerprint({
    additionalInputs: cliPathInputs,
    environmentKeys: environment.map(([key]) => key),
    environmentText,
  });
}

export const copilotSettingsReconciler: ProviderSettingsReconciler = {
  environmentSessionPolicy: 'reload',

  invalidateConversationSessions: () => [],

  reconcileModelWithEnvironment(settings) {
    const providerSettings = getCopilotProviderSettings(settings);
    if (!providerSettings.enabled) {
      return { changed: false, invalidatedConversations: [] };
    }

    const environmentHash = computeCopilotEnvironmentHash(settings);
    if (providerSettings.environmentHash === environmentHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    clearCurrentCopilotCatalog(settings);
    updateCopilotProviderSettings(settings, { environmentHash });
    return { changed: true, invalidatedConversations: [] };
  },

  normalizeModelVariantSettings(settings): boolean {
    let changed = false;
    changed = normalizeSelectionAt(settings, 'model') || changed;
    changed = normalizeSelectionAt(settings, 'titleGenerationModel') || changed;

    if (isRecord(settings.savedProviderModel)) {
      changed = normalizeSelectionAt(settings.savedProviderModel, 'copilot') || changed;
    }
    return changed;
  },
};

function normalizeSelectionAt(settings: Record<string, unknown>, key: string): boolean {
  const current = settings[key];
  if (typeof current !== 'string') {
    return false;
  }

  const trimmed = current.trim();
  const rawModelId = decodeCopilotModelId(trimmed);
  let normalized: string | null = null;
  if (rawModelId) {
    normalized = encodeCopilotModelId(rawModelId);
  } else if (trimmed.startsWith('copilot')) {
    normalized = '';
  }

  if (normalized === null || normalized === current) {
    return false;
  }
  settings[key] = normalized;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
