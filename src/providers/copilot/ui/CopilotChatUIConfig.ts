import type {
  ProviderChatUIConfig,
  ProviderIconSvg,
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import {
  decodeCopilotModelId,
  encodeCopilotModelId,
  findCopilotModel,
  getCopilotAvailableReasoningEfforts,
  isCopilotModelSelectionId,
  resolveCopilotDefaultReasoningEffort,
} from '../models';
import {
  getCopilotProviderSettings,
  getOrderedCopilotVisibleModelIds,
  updateCopilotProviderSettings,
} from '../settings';

const DEFAULT_CONTEXT_WINDOW = 200_000;

const COPILOT_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'normal',
  inactiveLabel: 'Safe',
  activeValue: 'yolo',
  activeLabel: 'YOLO',
  planValue: 'plan',
  planLabel: 'PLAN',
};

/** GitHub Copilot's robot mark, rendered with the current UI foreground color. */
const COPILOT_PROVIDER_ICON: ProviderIconSvg = {
  kind: 'composite',
  viewBox: '0 0 24 24',
  children: [
    {
      tag: 'path',
      attributes: {
        d: 'M8.2 3.5 9.4 2l1.1.9-.8 1h4.6l-.8-1L14.6 2l1.2 1.5A6.5 6.5 0 0 1 21 9.9v4.6a6.5 6.5 0 0 1-6.5 6.5h-5A6.5 6.5 0 0 1 3 14.5V9.9a6.5 6.5 0 0 1 5.2-6.4Zm1.3 2A4.5 4.5 0 0 0 5 10v4.5A4.5 4.5 0 0 0 9.5 19h5a4.5 4.5 0 0 0 4.5-4.5V10a4.5 4.5 0 0 0-4.5-4.5h-5Z',
        fill: 'currentColor',
      },
    },
    {
      tag: 'path',
      attributes: {
        d: 'M8.5 9a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM8 15h8v2H8z',
        fill: 'currentColor',
      },
    },
  ],
};

export const copilotChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings): ProviderUIOption[] {
    const copilotSettings = getCopilotProviderSettings(settings);
    const catalogModels = copilotSettings.currentCatalog?.models ?? [];
    const catalogById = new Map(catalogModels.map(model => [model.rawId, model] as const));
    const options: ProviderUIOption[] = [];
    const seen = new Set<string>();

    for (const rawId of [...getOrderedCopilotVisibleModelIds(copilotSettings)].reverse()) {
      const value = encodeCopilotModelId(rawId);
      if (seen.has(value)) {
        continue;
      }
      seen.add(value);
      const model = catalogById.get(rawId);
      options.push({
        value,
        label: copilotSettings.modelAliases[rawId] ?? model?.displayName ?? rawId,
        description: model?.description ?? 'Selected in an existing session',
      });
    }

    return options;
  },

  getDefaultModel(settings): string | null {
    const rawId = getOrderedCopilotVisibleModelIds(getCopilotProviderSettings(settings))[0];
    return rawId ? encodeCopilotModelId(rawId) : null;
  },

  ownsModel(model): boolean {
    return isCopilotModelSelectionId(model);
  },

  isAdaptiveReasoningModel(model, settings): boolean {
    return getCopilotAvailableReasoningEfforts(getSelectedModel(model, settings)).length > 0;
  },

  getReasoningOptions(model, settings): ProviderReasoningOption[] {
    return getCopilotAvailableReasoningEfforts(getSelectedModel(model, settings)).map(option => ({
      ...(option.description ? { description: option.description } : {}),
      label: option.label,
      value: option.value,
    }));
  },

  getDefaultReasoningValue(model, settings): string {
    const rawId = decodeCopilotModelId(model);
    if (!rawId) {
      return '';
    }
    const selectedModel = getSelectedModel(model, settings);
    const efforts = getCopilotAvailableReasoningEfforts(selectedModel);
    if (efforts.length === 0) {
      return '';
    }
    return resolveCopilotDefaultReasoningEffort(
      selectedModel ? { ...selectedModel, reasoningEfforts: [...efforts] } : null,
      getCopilotProviderSettings(settings).preferredReasoningByModel[rawId],
    ) ?? '';
  },

  getContextWindowSize(model, customLimits = {}, settings = {}): number {
    const rawId = decodeCopilotModelId(model);
    const discoveredLimit = rawId
      ? findCopilotModel(
        getCopilotProviderSettings(settings).currentCatalog?.models ?? [],
        rawId,
      )?.contextWindow
      : undefined;
    if (discoveredLimit !== undefined) {
      return discoveredLimit;
    }
    const customLimit = customLimits[model] ?? (rawId ? customLimits[rawId] : undefined);
    return typeof customLimit === 'number' && Number.isFinite(customLimit) && customLimit > 0
      ? Math.floor(customLimit)
      : DEFAULT_CONTEXT_WINDOW;
  },

  isDefaultModel(): boolean {
    return false;
  },

  applyModelDefaults(model, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    const normalizedModel = normalizeSelection(model);
    if (!isCopilotModelSelectionId(normalizedModel)) {
      return;
    }
    clearSavedCopilotEffortProjection(settings);
    settings.model = normalizedModel;
    settings.effortLevel = this.getDefaultReasoningValue(normalizedModel, settings);
  },

  applyTitleGenerationModelSelection(model, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    const rawId = decodeCopilotModelId(model);
    if (rawId) {
      settings.titleGenerationModel = encodeCopilotModelId(rawId);
    }
  },

  applyModelProjectionDefaults(model, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    clearSavedCopilotEffortProjection(settings);
    if (!decodeCopilotModelId(model)) {
      delete settings.effortLevel;
      return;
    }
    settings.effortLevel = this.getDefaultReasoningValue(model, settings);
  },

  applyReasoningSelection(model, value, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    const rawId = decodeCopilotModelId(model);
    if (!rawId) {
      clearSavedCopilotEffortProjection(settings);
      delete settings.effortLevel;
      return;
    }
    const supportedValues = new Set(
      getCopilotAvailableReasoningEfforts(getSelectedModel(model, settings))
        .map(option => option.value),
    );
    const copilotSettings = getCopilotProviderSettings(settings);
    const preferredReasoningByModel = { ...copilotSettings.preferredReasoningByModel };
    if (supportedValues.has(value)) {
      preferredReasoningByModel[rawId] = value;
    } else {
      delete preferredReasoningByModel[rawId];
    }
    updateCopilotProviderSettings(settings, { preferredReasoningByModel });
  },

  normalizeModelVariant(model): string {
    return normalizeSelection(model);
  },

  normalizeAvailableModelSelection(model, settings): string {
    const normalized = normalizeSelection(model);
    return this.getModelOptions(settings).some(option => option.value === normalized)
      ? normalized
      : model;
  },

  getCustomModelIds(): Set<string> {
    return new Set();
  },

  getPermissionModeToggle(): ProviderPermissionModeToggleConfig {
    return COPILOT_PERMISSION_MODE_TOGGLE;
  },

  resolvePermissionMode(settings): string {
    if (settings.permissionMode === 'plan') {
      return 'plan';
    }
    return settings.permissionMode === 'yolo' ? 'yolo' : 'normal';
  },

  applyPermissionMode(value, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    settings.permissionMode = value === 'plan' ? 'plan' : value === 'yolo' ? 'yolo' : 'normal';
  },

  getModeSelector(): null {
    return null;
  },

  getProviderIcon(): ProviderIconSvg {
    return COPILOT_PROVIDER_ICON;
  },
};

function getSelectedModel(model: string, settings: Record<string, unknown>) {
  const rawId = decodeCopilotModelId(model);
  if (!rawId) {
    return null;
  }
  const copilotSettings = getCopilotProviderSettings(settings);
  if (!getOrderedCopilotVisibleModelIds(copilotSettings).includes(rawId)) {
    return null;
  }
  return findCopilotModel(copilotSettings.currentCatalog?.models ?? [], rawId);
}

function normalizeSelection(model: string): string {
  const rawId = decodeCopilotModelId(model.trim());
  return rawId ? encodeCopilotModelId(rawId) : model;
}

function clearSavedCopilotEffortProjection(settings: Record<string, unknown>): void {
  if (isRecord(settings.savedProviderEffort)) {
    delete settings.savedProviderEffort.copilot;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
