import { formatReasoningValueLabel } from '../../core/providers/reasoning';

export interface CopilotReasoningEffort {
  description?: string;
  label: string;
  value: string;
}

export interface CopilotDiscoveredModel {
  contextWindow?: number;
  defaultReasoningEffort?: string;
  description?: string;
  displayName: string;
  rawId: string;
  reasoningEfforts: CopilotReasoningEffort[];
  reasoningMetadataResolved?: boolean;
  supportsReasoning: boolean;
}

export const COPILOT_MODEL_PREFIX = 'copilot/';
export const COPILOT_REASONING_EFFORT_VALUES = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export const COPILOT_REASONING_EFFORTS = COPILOT_REASONING_EFFORT_VALUES;

const COPILOT_REASONING_EFFORT_SET = new Set<string>(COPILOT_REASONING_EFFORT_VALUES);

type AcpConfigOptionLike = {
  category?: unknown;
  currentValue?: unknown;
  id?: unknown;
  name?: unknown;
  options?: unknown;
  type?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readPositiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

function normalizeEffortValue(value: unknown): string | null {
  const normalized = readTrimmedString(value).toLowerCase();
  return COPILOT_REASONING_EFFORT_SET.has(normalized) ? normalized : null;
}

function flattenOptions(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  const flattened: Array<Record<string, unknown>> = [];
  for (const option of value) {
    if (!isRecord(option)) {
      continue;
    }
    if (Array.isArray(option.options)) {
      flattened.push(...flattenOptions(option.options));
    } else {
      flattened.push(option);
    }
  }
  return flattened;
}

function findReasoningConfigOption(value: unknown): AcpConfigOptionLike | null {
  if (!Array.isArray(value)) {
    return null;
  }
  for (const candidate of value) {
    if (!isRecord(candidate) || candidate.type !== 'select') {
      continue;
    }
    const category = readTrimmedString(candidate.category).toLowerCase().replace(/-/g, '_');
    const id = readTrimmedString(candidate.id).toLowerCase().replace(/-/g, '_');
    if (category === 'reasoning_effort' || category === 'thought_level'
      || id === 'reasoning_effort' || id === 'effort') {
      return candidate;
    }
  }
  return null;
}

function normalizeReasoningEfforts(value: unknown): CopilotReasoningEffort[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized: CopilotReasoningEffort[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const record = isRecord(entry) ? entry : null;
    const effort = normalizeEffortValue(record?.value ?? record?.id ?? entry);
    if (!effort || seen.has(effort)) {
      continue;
    }
    seen.add(effort);
    const label = readTrimmedString(record?.label ?? record?.name) || formatReasoningValueLabel(effort);
    const description = readTrimmedString(record?.description);
    normalized.push({
      ...(description ? { description } : {}),
      label,
      value: effort,
    });
  }
  return normalized;
}

function getStandardReasoningMetadata(
  configOptions: unknown,
): { efforts: CopilotReasoningEffort[]; selected: string | null } {
  const option = findReasoningConfigOption(configOptions);
  if (!option) {
    return { efforts: [], selected: null };
  }
  const efforts = normalizeReasoningEfforts(flattenOptions(option.options));
  const selected = normalizeEffortValue(option.currentValue);
  return { efforts, selected };
}

function getModelEntries(value: unknown): { entries: unknown[]; configOptions: unknown } {
  if (Array.isArray(value)) {
    return { entries: value, configOptions: undefined };
  }
  if (!isRecord(value)) {
    return { entries: [], configOptions: undefined };
  }

  const configOptions = value.configOptions;
  if (Array.isArray(value.availableModels)) {
    return { entries: value.availableModels, configOptions };
  }
  if (isRecord(value.models) && Array.isArray(value.models.availableModels)) {
    return { entries: value.models.availableModels, configOptions };
  }
  if (Array.isArray(value.models)) {
    return { entries: value.models, configOptions };
  }
  return { entries: [], configOptions };
}

export function isCopilotModelSelectionId(model: string): boolean {
  return decodeCopilotModelId(model) !== null;
}

export function encodeCopilotModelId(rawModelId: string): string {
  const normalized = readTrimmedString(rawModelId);
  if (!normalized || normalized === COPILOT_MODEL_PREFIX) {
    return '';
  }
  if (normalized.startsWith(COPILOT_MODEL_PREFIX)) {
    const raw = decodeCopilotModelId(normalized);
    return raw ? `${COPILOT_MODEL_PREFIX}${raw}` : '';
  }
  return `${COPILOT_MODEL_PREFIX}${normalized}`;
}

export function decodeCopilotModelId(model: string): string | null {
  const normalized = readTrimmedString(model);
  if (!normalized.startsWith(COPILOT_MODEL_PREFIX)) {
    return null;
  }
  const rawModelId = normalized.slice(COPILOT_MODEL_PREFIX.length).trim();
  return rawModelId || null;
}

export function normalizeCopilotDiscoveredModels(
  value: unknown,
  configOptions?: unknown,
): CopilotDiscoveredModel[] {
  const source = getModelEntries(value);
  const effectiveConfigOptions = configOptions ?? source.configOptions;
  const standardReasoning = getStandardReasoningMetadata(effectiveConfigOptions);
  const normalizedById = new Map<string, CopilotDiscoveredModel>();

  for (const entry of source.entries) {
    if (!isRecord(entry)) {
      continue;
    }
    const rawId = readTrimmedString(entry.rawId ?? entry.modelId ?? entry.id ?? entry.model);
    if (!rawId) {
      continue;
    }

    const metadata = isRecord(entry._meta) ? entry._meta : {};
    const explicitEfforts = normalizeReasoningEfforts(
      entry.reasoningEfforts ?? entry.reasoning_efforts
        ?? entry.supportedReasoningEfforts ?? entry.supported_reasoning_efforts
        ?? metadata.reasoningEfforts ?? metadata.reasoning_efforts,
    );
    const reasoningEfforts = explicitEfforts.length > 0 ? explicitEfforts : standardReasoning.efforts;
    const defaultReasoningEffort = normalizeEffortValue(
      entry.defaultReasoningEffort ?? entry.default_reasoning_effort
        ?? entry.reasoningEffort ?? entry.reasoning_effort
        ?? metadata.defaultReasoningEffort ?? metadata.default_reasoning_effort,
    ) ?? standardReasoning.selected ?? undefined;
    const supportsReasoning = entry.supportsReasoning === true
      || entry.supports_reasoning === true
      || entry.supportsReasoningEffort === true
      || entry.supports_reasoning_effort === true
      || reasoningEfforts.length > 0
      || Boolean(defaultReasoningEffort);
    const displayName = readTrimmedString(
      entry.displayName ?? entry.display_name ?? entry.name ?? entry.label,
    ) || rawId;
    const description = readTrimmedString(entry.description);
    const contextWindow = readPositiveNumber(
      entry.contextWindow,
      entry.context_window,
      entry.totalContextTokens,
      entry.total_context_tokens,
    );
    const normalized: CopilotDiscoveredModel = {
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      ...(description ? { description } : {}),
      displayName,
      rawId,
      reasoningEfforts,
      ...(entry.reasoningMetadataResolved === true ? { reasoningMetadataResolved: true } : {}),
      supportsReasoning,
    };
    const current = normalizedById.get(rawId);
    normalizedById.set(rawId, current ? mergeCopilotModelMetadata(current, normalized) : normalized);
  }

  return Array.from(normalizedById.values());
}

export function mergeCopilotDiscoveredModels(
  catalogModels: CopilotDiscoveredModel[],
  liveModels: CopilotDiscoveredModel[],
): CopilotDiscoveredModel[] {
  return normalizeCopilotDiscoveredModels([...catalogModels, ...liveModels]);
}

export function findCopilotModel(
  models: CopilotDiscoveredModel[],
  modelId: string,
): CopilotDiscoveredModel | null {
  const rawModelId = decodeCopilotModelId(modelId) ?? readTrimmedString(modelId);
  return rawModelId ? models.find(model => model.rawId === rawModelId) ?? null : null;
}

export function getCopilotAvailableReasoningEfforts(
  model: CopilotDiscoveredModel | null | undefined,
): readonly CopilotReasoningEffort[] {
  return model?.reasoningEfforts ?? [];
}

export function getCopilotReasoningEffortOptions(
  model: CopilotDiscoveredModel | null | undefined,
): readonly CopilotReasoningEffort[] {
  return getCopilotAvailableReasoningEfforts(model);
}

export function resolveCopilotDefaultReasoningEffort(
  model: CopilotDiscoveredModel | null | undefined,
  preferredEffort?: string,
): string | null {
  const availableValues = getCopilotAvailableReasoningEfforts(model).map(effort => effort.value);
  if (availableValues.length === 0) {
    return null;
  }
  const preferred = normalizeEffortValue(preferredEffort);
  if (preferred && availableValues.includes(preferred)) {
    return preferred;
  }
  const declared = normalizeEffortValue(model?.defaultReasoningEffort);
  if (declared && availableValues.includes(declared)) {
    return declared;
  }
  return availableValues[0] ?? null;
}

export function resolveCopilotReasoningEffort(
  model: CopilotDiscoveredModel | null | undefined,
  requestedEffort?: string | null,
): string | null {
  return resolveCopilotDefaultReasoningEffort(model, requestedEffort ?? undefined);
}

export function clearCopilotReasoningMetadata(
  model: CopilotDiscoveredModel,
): CopilotDiscoveredModel {
  const cleared = { ...model };
  delete cleared.defaultReasoningEffort;
  delete cleared.reasoningMetadataResolved;
  cleared.reasoningEfforts = [];
  cleared.supportsReasoning = false;
  return cleared;
}

function mergeCopilotModelMetadata(
  current: CopilotDiscoveredModel,
  incoming: CopilotDiscoveredModel,
): CopilotDiscoveredModel {
  const efforts = incoming.reasoningEfforts.length > 0
    ? incoming.reasoningEfforts
    : current.reasoningEfforts;
  const defaultReasoningEffort = incoming.defaultReasoningEffort ?? current.defaultReasoningEffort;
  return {
    ...(incoming.contextWindow ?? current.contextWindow
      ? { contextWindow: incoming.contextWindow ?? current.contextWindow } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(incoming.description ?? current.description
      ? { description: incoming.description ?? current.description } : {}),
    displayName: incoming.displayName !== incoming.rawId ? incoming.displayName : current.displayName,
    rawId: current.rawId,
    reasoningEfforts: efforts,
    ...(incoming.reasoningMetadataResolved || current.reasoningMetadataResolved
      ? { reasoningMetadataResolved: true } : {}),
    supportsReasoning: incoming.supportsReasoning || current.supportsReasoning || efforts.length > 0,
  };
}
