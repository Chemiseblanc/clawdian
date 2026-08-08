import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import { normalizeHostnameStringMap } from '../../core/providers/settings/HostnameStringMap';
import type { HostnameCliPaths } from '../../core/types/settings';
import { getHostnameKey } from '../../utils/env';
import {
  clearCopilotReasoningMetadata,
  type CopilotDiscoveredModel,
  decodeCopilotModelId,
  getCopilotAvailableReasoningEfforts,
  normalizeCopilotDiscoveredModels,
} from './models';

export interface CopilotCatalogSnapshot {
  models: CopilotDiscoveredModel[];
  defaultModelId: string | null;
  fingerprint: string;
  refreshedAt: number;
}

export interface PersistedCopilotProviderSettings {
  enabled: boolean;
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  catalogsByHost: Record<string, CopilotCatalogSnapshot>;
  environmentVariables: string;
  environmentHash: string;
  visibleModels: string[] | null;
  modelAliases: Record<string, string>;
  preferredReasoningByModel: Record<string, string>;
}

export interface CopilotProviderSettings extends PersistedCopilotProviderSettings {
  currentCatalog: CopilotCatalogSnapshot | null;
}

export const DEFAULT_COPILOT_PROVIDER_SETTINGS: Readonly<PersistedCopilotProviderSettings> = Object.freeze({
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

export function getOrderedCopilotVisibleModelIds(
  settings: CopilotProviderSettings,
): string[] {
  if (settings.visibleModels !== null) {
    return [...settings.visibleModels];
  }
  const models = settings.currentCatalog?.models ?? [];
  const defaultModelId = settings.currentCatalog?.defaultModelId;
  if (!defaultModelId || !models.some(model => model.rawId === defaultModelId)) {
    return models.map(model => model.rawId);
  }
  return [
    defaultModelId,
    ...models.filter(model => model.rawId !== defaultModelId).map(model => model.rawId),
  ];
}

export function normalizeCopilotCatalogSnapshot(value: unknown): CopilotCatalogSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  const models = normalizeCopilotDiscoveredModels(value.models, value.configOptions);
  const defaultModelId = normalizeRawModelId(value.defaultModelId);
  const fingerprint = readTrimmedString(value.fingerprint);
  const refreshedAt = typeof value.refreshedAt === 'number'
    && Number.isFinite(value.refreshedAt)
    && value.refreshedAt >= 0
    ? Math.floor(value.refreshedAt)
    : 0;
  return { defaultModelId, fingerprint, models, refreshedAt };
}

export function normalizeCopilotCatalogsByHost(
  value: unknown,
): Record<string, CopilotCatalogSnapshot> {
  if (!isRecord(value)) {
    return {};
  }
  const normalized: Record<string, CopilotCatalogSnapshot> = {};
  for (const [hostKey, snapshot] of Object.entries(value)) {
    const normalizedHostKey = hostKey.trim();
    const normalizedSnapshot = normalizeCopilotCatalogSnapshot(snapshot);
    if (normalizedHostKey && normalizedSnapshot) {
      normalized[normalizedHostKey] = normalizedSnapshot;
    }
  }
  return normalized;
}

export function getCopilotProviderSettings(
  settings: Record<string, unknown>,
): CopilotProviderSettings {
  const config = getProviderConfig(settings, 'copilot');
  const currentHostKey = getHostnameKey();
  const cliPathsByHost = normalizeHostnameStringMap(config.cliPathsByHost);
  const catalogsByHost = normalizeCopilotCatalogsByHost(config.catalogsByHost);
  const currentCatalog = catalogsByHost[currentHostKey] ?? null;
  const catalogModels = currentCatalog?.models ?? [];
  const selectedModelIds = collectSelectedCopilotRawModelIds(settings);
  const allowedModelIds = new Set(catalogModels.map(model => model.rawId));
  for (const modelId of selectedModelIds) {
    allowedModelIds.add(modelId);
  }
  const visibleModels = normalizeCopilotVisibleModels(
    config.visibleModels,
    allowedModelIds,
    catalogModels.length > 0,
  );
  const enabledModelIds = new Set(
    visibleModels ?? catalogModels.map(model => model.rawId),
  );
  return {
    catalogsByHost,
    cliPath: readTrimmedString(config.cliPath) || DEFAULT_COPILOT_PROVIDER_SETTINGS.cliPath,
    cliPathsByHost,
    currentCatalog,
    enabled: typeof config.enabled === 'boolean'
      ? config.enabled
      : DEFAULT_COPILOT_PROVIDER_SETTINGS.enabled,
    environmentHash: readTrimmedString(config.environmentHash),
    environmentVariables: typeof config.environmentVariables === 'string'
      ? config.environmentVariables
      : getProviderEnvironmentVariables(settings, 'copilot')
        ?? DEFAULT_COPILOT_PROVIDER_SETTINGS.environmentVariables,
    modelAliases: normalizeCopilotModelAliases(
      config.modelAliases,
      allowedModelIds,
      catalogModels.length > 0,
    ),
    preferredReasoningByModel: normalizeCopilotPreferredReasoningByModel(
      config.preferredReasoningByModel,
      enabledModelIds,
      catalogModels,
      catalogModels.length > 0,
    ),
    visibleModels,
  };
}

export function updateCopilotProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<PersistedCopilotProviderSettings>,
): CopilotProviderSettings {
  const current = getCopilotProviderSettings(settings);
  const currentHostKey = getHostnameKey();
  const cliPathsByHost = updates.cliPathsByHost !== undefined
    ? normalizeHostnameStringMap(updates.cliPathsByHost)
    : { ...current.cliPathsByHost };
  let cliPath = updates.cliPathsByHost !== undefined
    ? readTrimmedString(updates.cliPath)
    : current.cliPath;
  if ('cliPath' in updates && updates.cliPathsByHost === undefined) {
    const hostCliPath = readTrimmedString(updates.cliPath);
    if (hostCliPath) {
      cliPathsByHost[currentHostKey] = hostCliPath;
    } else {
      delete cliPathsByHost[currentHostKey];
    }
    cliPath = DEFAULT_COPILOT_PROVIDER_SETTINGS.cliPath;
  }

  const catalogsByHost = updates.catalogsByHost !== undefined
    ? normalizeCopilotCatalogsByHost(updates.catalogsByHost)
    : { ...current.catalogsByHost };
  const currentCatalog = catalogsByHost[currentHostKey] ?? null;
  const catalogModels = currentCatalog?.models ?? [];
  const allowedModelIds = new Set(catalogModels.map(model => model.rawId));
  for (const modelId of collectSelectedCopilotRawModelIds(settings)) {
    allowedModelIds.add(modelId);
  }
  const hasCatalog = catalogModels.length > 0;
  const visibleModels = normalizeCopilotVisibleModels(
    updates.visibleModels === undefined ? current.visibleModels : updates.visibleModels,
    allowedModelIds,
    hasCatalog,
  );
  const enabledModelIds = new Set(
    visibleModels ?? catalogModels.map(model => model.rawId),
  );
  const next: PersistedCopilotProviderSettings = {
    catalogsByHost,
    cliPath,
    cliPathsByHost,
    enabled: updates.enabled ?? current.enabled,
    environmentHash: updates.environmentHash !== undefined
      ? readTrimmedString(updates.environmentHash)
      : current.environmentHash,
    environmentVariables: updates.environmentVariables ?? current.environmentVariables,
    modelAliases: normalizeCopilotModelAliases(
      updates.modelAliases ?? current.modelAliases,
      allowedModelIds,
      hasCatalog,
    ),
    preferredReasoningByModel: normalizeCopilotPreferredReasoningByModel(
      updates.preferredReasoningByModel ?? current.preferredReasoningByModel,
      enabledModelIds,
      catalogModels,
      hasCatalog,
    ),
    visibleModels,
  };
  setProviderConfig(settings, 'copilot', next as unknown as Record<string, unknown>);
  return { ...next, currentCatalog };
}

export function updateCopilotVisibleModels(
  settings: Record<string, unknown>,
  visibleModels: string[] | null,
): CopilotProviderSettings {
  const current = getCopilotProviderSettings(settings);
  const normalizedVisibleModels = normalizeCopilotVisibleModels(
    visibleModels,
    new Set(current.currentCatalog?.models.map(model => model.rawId) ?? []),
    Boolean(current.currentCatalog?.models.length),
  );
  const enabledModelIds = new Set(
    normalizedVisibleModels
      ?? current.currentCatalog?.models.map(model => model.rawId)
      ?? [],
  );
  const catalogsByHost = Object.fromEntries(
    Object.entries(current.catalogsByHost).map(([hostKey, catalog]) => [
      hostKey,
      {
        ...catalog,
        models: catalog.models.map(model => (
          normalizedVisibleModels === null || enabledModelIds.has(model.rawId)
            ? model
            : clearCopilotReasoningMetadata(model)
        )),
      },
    ]),
  );
  return updateCopilotProviderSettings(settings, {
    catalogsByHost,
    preferredReasoningByModel: current.preferredReasoningByModel,
    visibleModels: normalizedVisibleModels,
  });
}

export function getCurrentCopilotCatalog(
  settings: Record<string, unknown>,
): CopilotCatalogSnapshot | null {
  return getCopilotProviderSettings(settings).currentCatalog;
}

export function updateCurrentCopilotCatalog(
  settings: Record<string, unknown>,
  snapshot: CopilotCatalogSnapshot,
): CopilotCatalogSnapshot | null {
  const normalized = normalizeCopilotCatalogSnapshot(snapshot);
  if (!normalized) {
    return null;
  }
  const current = getCopilotProviderSettings(settings);
  updateCopilotProviderSettings(settings, {
    catalogsByHost: {
      ...current.catalogsByHost,
      [getHostnameKey()]: normalized,
    },
  });
  return normalized;
}

export function clearCurrentCopilotCatalog(settings: Record<string, unknown>): boolean {
  const current = getCopilotProviderSettings(settings);
  const currentHostKey = getHostnameKey();
  if (!current.catalogsByHost[currentHostKey]) {
    return false;
  }
  const catalogsByHost = { ...current.catalogsByHost };
  delete catalogsByHost[currentHostKey];
  updateCopilotProviderSettings(settings, { catalogsByHost });
  return true;
}

export function normalizeCopilotVisibleModels(
  value: unknown,
  allowedModelIds: ReadonlySet<string> = new Set(),
  restrictToAllowed = allowedModelIds.size > 0,
): string[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const rawModelId = normalizeRawModelId(entry);
    if (!rawModelId || seen.has(rawModelId)
      || (restrictToAllowed && !allowedModelIds.has(rawModelId))) {
      continue;
    }
    seen.add(rawModelId);
    normalized.push(rawModelId);
  }
  return normalized;
}

export function normalizeCopilotModelAliases(
  value: unknown,
  allowedModelIds: ReadonlySet<string> = new Set(),
  restrictToAllowed = allowedModelIds.size > 0,
): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const normalized: Record<string, string> = {};
  for (const [modelId, aliasValue] of Object.entries(value)) {
    const rawModelId = normalizeRawModelId(modelId);
    const alias = readTrimmedString(aliasValue);
    if (!rawModelId || !alias || (restrictToAllowed && !allowedModelIds.has(rawModelId))) {
      continue;
    }
    normalized[rawModelId] = alias;
  }
  return normalized;
}

export function normalizeCopilotPreferredReasoningByModel(
  value: unknown,
  allowedModelIds: ReadonlySet<string> = new Set(),
  catalogModels: CopilotDiscoveredModel[] = [],
  restrictToAllowed = catalogModels.length > 0,
): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const catalogById = new Map(catalogModels.map(model => [model.rawId, model] as const));
  const normalized: Record<string, string> = {};
  for (const [modelId, effortValue] of Object.entries(value)) {
    const rawModelId = normalizeRawModelId(modelId);
    const effort = readTrimmedString(effortValue).toLowerCase();
    if (!rawModelId || !effort || (restrictToAllowed && !allowedModelIds.has(rawModelId))) {
      continue;
    }
    const model = catalogById.get(rawModelId);
    const supportedEfforts = new Set(
      getCopilotAvailableReasoningEfforts(model).map(option => option.value),
    );
    if (catalogModels.length > 0 && model && !supportedEfforts.has(effort)) {
      continue;
    }
    normalized[rawModelId] = effort;
  }
  return normalized;
}

function collectSelectedCopilotRawModelIds(settings: Record<string, unknown>): Set<string> {
  const selected = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== 'string') {
      return;
    }
    const rawModelId = decodeCopilotModelId(value.trim());
    if (rawModelId) {
      selected.add(rawModelId);
    }
  };
  add(settings.model);
  add(settings.titleGenerationModel);
  if (isRecord(settings.savedProviderModel)) {
    add(settings.savedProviderModel.copilot);
  }
  return selected;
}

function normalizeRawModelId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  return decodeCopilotModelId(normalized) ?? normalized;
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
