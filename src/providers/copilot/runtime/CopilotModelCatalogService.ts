import { createHash } from 'node:crypto';

import { getRuntimeEnvironmentVariables } from '@/core/providers/providerEnvironment';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ProviderTransitionOwnerContext } from '@/core/providers/types';
import {
  type AcpSessionConfigOption,
  type AcpSessionModelState,
  type AcpSessionModeState,
  flattenAcpSessionConfigSelectOptions,
} from '@/providers/acp';
import { getVaultPath } from '@/utils/path';

import { type CopilotDiscoveredModel,normalizeCopilotDiscoveredModels } from '../models';
import { getCopilotProviderSettings } from '../settings';
import { buildCopilotRuntimeEnv } from './CopilotRuntimeEnvironment';

const FINGERPRINT_VERSION = '1';

/** The narrow surface used by the catalog; the concrete ACP probe owns transport details. */
export interface CopilotAcpSessionProbeLike {
  probe(request: CopilotAcpSessionProbeRequest): Promise<CopilotAcpSessionProbeResult>;
  dispose?(): Promise<void> | void;
}

export interface CopilotAcpSessionProbeRequest {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  version: string;
  signal?: AbortSignal;
}

export interface CopilotAcpSessionProbeResult {
  configOptions?: AcpSessionConfigOption[] | null;
  defaultModelId?: string | null;
  diagnostics?: string;
  models?: AcpSessionModelState | CopilotDiscoveredModel[] | null;
  modes?: AcpSessionModeState | null;
  /** ACP probes may return normalized model entries directly. */
  availableModels?: unknown;
  /** ACP agentInfo is retained only as an input to the fingerprint. */
  agentInfo?: { version?: string | null } | null;
  version?: string | null;
}

export type CopilotModelCatalogDiscoveryResult =
  | {
    defaultModelId: string | null;
    diagnostics?: string;
    fingerprint: string;
    kind: 'completed';
    models: CopilotDiscoveredModel[];
  }
  | {
    kind: 'skipped';
    reason: 'provider-disabled';
  };

export interface CopilotModelCatalogServiceLike {
  discoverCatalog(
    signal?: AbortSignal,
    context?: ProviderTransitionOwnerContext,
  ): Promise<CopilotModelCatalogDiscoveryResult>;
  getCatalogFingerprint(
    signal?: AbortSignal,
    context?: ProviderTransitionOwnerContext,
  ): Promise<string>;
}

export interface CopilotModelCatalogServiceOptions {
  probe?: CopilotAcpSessionProbeLike;
  /** Used by tests and embedders that provide a version without probing it. */
  version?: string;
}

export interface CopilotCatalogFingerprintInputs {
  command: string;
  environmentKeys: string[];
  version: string;
}

export function buildCopilotCatalogFingerprint(
  inputs: CopilotCatalogFingerprintInputs,
): string {
  const payload = [
    FINGERPRINT_VERSION,
    inputs.command.trim(),
    inputs.version.trim(),
    Array.from(new Set(inputs.environmentKeys.map(key => key.trim()).filter(Boolean))).sort(),
  ];
  return `${FINGERPRINT_VERSION}:${createHash('sha256')
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex')}`;
}

export class CopilotModelCatalogService implements CopilotModelCatalogServiceLike {
  private resolvedVersion: string | null = null;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly options: CopilotModelCatalogServiceOptions = {},
  ) {}

  async getCatalogFingerprint(
    signal?: AbortSignal,
    ownerContext?: ProviderTransitionOwnerContext,
  ): Promise<string> {
    const context = await this.resolveCommandContext(ownerContext);
    if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    return buildCopilotCatalogFingerprint({
      command: context.command,
      environmentKeys: context.environmentKeys,
      version: this.resolvedVersion ?? this.options.version ?? 'unknown',
    });
  }

  async discoverCatalog(
    signal?: AbortSignal,
    ownerContext?: ProviderTransitionOwnerContext,
  ): Promise<CopilotModelCatalogDiscoveryResult> {
    if (!getCopilotProviderSettings(this.plugin.settings).enabled) {
      return { kind: 'skipped', reason: 'provider-disabled' };
    }

    try {
      const context = await this.resolveCommandContext(ownerContext);
      const probe = this.options.probe;
      if (!probe) {
        return {
          defaultModelId: null,
          diagnostics: 'Copilot ACP model probe is unavailable',
          fingerprint: buildCopilotCatalogFingerprint({
            command: context.command,
            environmentKeys: context.environmentKeys,
            version: this.options.version ?? 'unknown',
          }),
          kind: 'completed',
          models: [],
        };
      }

      const result = await probe.probe({
        command: context.command,
        cwd: context.cwd,
        env: context.env,
        signal,
        version: this.options.version ?? 'unknown',
      });
      const version = result.version?.trim()
        || result.agentInfo?.version?.trim()
        || this.options.version
        || 'unknown';
      this.resolvedVersion = version;
      const fingerprint = buildCopilotCatalogFingerprint({
        command: context.command,
        environmentKeys: context.environmentKeys,
        version,
      });
      const modelState = isAcpModelState(result.models) ? result.models : null;
      const rawModels = result.availableModels
        ?? modelState?.availableModels
        ?? result.models
        ?? result;
      let models = normalizeCopilotDiscoveredModels({
        configOptions: result.configOptions,
        models: rawModels,
      });
      if (models.length === 0) {
        models = normalizeCopilotDiscoveredModels(
          extractModelConfigEntries(result.configOptions),
          result.configOptions,
        );
      }
      const defaultModelId = normalizeRawModelId(
        result.defaultModelId
          ?? modelState?.currentModelId
          ?? findCurrentModelConfig(result.configOptions),
      );
      return {
        ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
        defaultModelId,
        fingerprint,
        kind: 'completed',
        models,
      };
    } catch {
      return {
        defaultModelId: null,
        diagnostics: 'Copilot ACP model probe failed',
        fingerprint: await this.safeFingerprint(ownerContext),
        kind: 'completed',
        models: [],
      };
    }
  }

  private async resolveCommandContext(
    ownerContext?: ProviderTransitionOwnerContext,
  ): Promise<{
    command: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    environmentKeys: string[];
  }> {
    const command = await this.plugin.getResolvedProviderCliPath(
      'copilot',
      ownerContext,
    ) ?? 'copilot';
    const configuredEnvironment = getRuntimeEnvironmentVariables(
      this.plugin.settings,
      'copilot',
    );
    return {
      command,
      cwd: getVaultPath(this.plugin.app) ?? process.cwd(),
      env: buildCopilotRuntimeEnv(this.plugin.settings, command),
      environmentKeys: Object.keys(configuredEnvironment),
    };
  }

  private async safeFingerprint(context?: ProviderTransitionOwnerContext): Promise<string> {
    try {
      return await this.getCatalogFingerprint(undefined, context);
    } catch {
      return buildCopilotCatalogFingerprint({ command: '', environmentKeys: [], version: 'unavailable' });
    }
  }
}

function findCurrentModelConfig(options: AcpSessionConfigOption[] | null | undefined): string | null {
  const option = options?.find(candidate => (
    candidate.type === 'select'
      && (candidate.id.trim().toLowerCase() === 'model'
        || candidate.category?.trim().toLowerCase() === 'model')
  ));
  return option?.type === 'select' ? option.currentValue : null;
}

function extractModelConfigEntries(
  options: AcpSessionConfigOption[] | null | undefined,
): Array<{ displayName: string; rawId: string }> {
  const option = options?.find(candidate => (
    candidate.type === 'select'
      && (candidate.id.trim().toLowerCase() === 'model'
        || candidate.category?.trim().toLowerCase() === 'model')
  ));
  if (!option || option.type !== 'select') return [];
  return flattenAcpSessionConfigSelectOptions(option.options).map(item => ({
    displayName: item.name,
    rawId: item.value,
  }));
}

function isAcpModelState(value: unknown): value is AcpSessionModelState {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('availableModels' in value)) {
    return false;
  }
  return Array.isArray(value.availableModels);
}

function normalizeRawModelId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}
