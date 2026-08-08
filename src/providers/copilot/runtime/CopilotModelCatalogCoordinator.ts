import type { ProviderHost } from '@/core/providers/ProviderHost';
import type {
  ProviderModelCatalogRefreshResult,
  ProviderTransitionOwnerContext,
} from '@/core/providers/types';
import { toError } from '@/utils/error';

import { computeCopilotEnvironmentHash } from '../env/CopilotSettingsReconciler';
import {
  clearCopilotReasoningMetadata,
  type CopilotDiscoveredModel,
  mergeCopilotDiscoveredModels,
  normalizeCopilotDiscoveredModels,
} from '../models';
import {
  type CopilotCatalogSnapshot,
  getCopilotProviderSettings,
  getCurrentCopilotCatalog,
  updateCurrentCopilotCatalog,
} from '../settings';
import type {
  CopilotModelCatalogDiscoveryResult,
  CopilotModelCatalogServiceLike,
} from './CopilotModelCatalogService';

const CATALOG_TTL_MS = 5 * 60 * 1000;

export type CopilotCatalogState = 'failed' | 'idle' | 'ready' | 'refreshing';

export interface CopilotCatalogResult {
  catalog: CopilotCatalogSnapshot | null;
  changed: boolean;
  diagnostics?: string;
  kind: 'completed' | 'skipped';
  persistedSettingsChanged: boolean;
}

export interface CopilotCatalogEnsureResult extends CopilotCatalogResult {
  backgroundRefresh?: Promise<CopilotCatalogResult>;
}

export class CopilotModelCatalogCoordinator {
  private readonly activeMetadataOperations = new Set<Promise<unknown>>();
  private abortController: AbortController | null = null;
  private disposed = false;
  private inFlightRefresh: {
    contextKey: string;
    generation: number;
    promise: Promise<CopilotCatalogResult>;
    transitionOwner: boolean;
  } | null = null;
  private liveContextKey: string | null = null;
  private liveDefaultModelId: string | null = null;
  private liveDefaultRevision = 0;
  private readonly liveModelsById = new Map<string, { model: CopilotDiscoveredModel; revision: number }>();
  private liveRevision = 0;
  private readonly pendingLiveRevisions = new Set<number>();
  private refreshGeneration = 0;
  private state: CopilotCatalogState = 'idle';
  private transitionActive = false;
  private readonly transitionWaiters = new Set<() => void>();

  constructor(
    private readonly plugin: ProviderHost,
    private readonly service: CopilotModelCatalogServiceLike,
  ) {}

  getCachedCatalog(): CopilotCatalogSnapshot | null {
    return getCurrentCopilotCatalog(this.plugin.settings);
  }

  getState(): CopilotCatalogState {
    return this.state;
  }

  getStatus(context?: ProviderTransitionOwnerContext): Promise<'fresh' | 'missing' | 'stale'> {
    if (this.disposed) return Promise.resolve(this.getCachedCatalog() ? 'stale' : 'missing');
    return this.runMetadataOperation(
      () => this.getStatusUnfenced(context),
      context?.providerTransitionOwner === true,
      () => this.getCachedCatalog() ? 'stale' : 'missing',
    );
  }

  private async getStatusUnfenced(
    context?: ProviderTransitionOwnerContext,
  ): Promise<'fresh' | 'missing' | 'stale'> {
    const catalog = this.getCachedCatalog();
    if (!catalog || !catalog.fingerprint) return 'missing';
    try {
      const fingerprint = await this.service.getCatalogFingerprint(undefined, context);
      if (fingerprint !== catalog.fingerprint) return 'stale';
    } catch {
      return 'stale';
    }
    return Date.now() - catalog.refreshedAt > CATALOG_TTL_MS ? 'stale' : 'fresh';
  }

  ensureFresh(
    _reason: string,
    options: { force?: boolean } = {},
  ): Promise<CopilotCatalogEnsureResult> {
    if (this.disposed || !getCopilotProviderSettings(this.plugin.settings).enabled) {
      return Promise.resolve(this.skippedResult());
    }
    return this.runMetadataOperation(
      () => this.ensureFreshUnfenced(options),
      false,
      () => this.skippedResult(),
    );
  }

  private async ensureFreshUnfenced(
    options: { force?: boolean },
  ): Promise<CopilotCatalogEnsureResult> {
    if (options.force) return this.refreshUnfenced();
    let status: 'fresh' | 'missing' | 'stale';
    try {
      status = await this.getStatusUnfenced();
    } catch {
      status = this.getCachedCatalog() ? 'stale' : 'missing';
    }
    if (status === 'fresh') return this.completedResult();
    if (status === 'missing') return this.refreshUnfenced();
    return { ...this.completedResult(), backgroundRefresh: this.refreshUnfenced() };
  }

  refresh(context?: ProviderTransitionOwnerContext): Promise<CopilotCatalogResult> {
    if (this.disposed || !getCopilotProviderSettings(this.plugin.settings).enabled) {
      return Promise.resolve(this.skippedResult());
    }
    return this.runMetadataOperation(
      () => this.refreshUnfenced(context),
      context?.providerTransitionOwner === true,
      () => this.skippedResult(),
    );
  }

  async refreshModelCatalog(
    context?: ProviderTransitionOwnerContext,
  ): Promise<ProviderModelCatalogRefreshResult> {
    const result = await this.refresh(context);
    return {
      changed: result.changed,
      ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
      ...(result.persistedSettingsChanged ? { persistedSettingsChanged: true } : {}),
    };
  }

  mergeLiveModels(
    liveModels: CopilotDiscoveredModel[],
    defaultModelId?: string,
    sourceContextKey?: string,
  ): Promise<ProviderModelCatalogRefreshResult> {
    if (this.disposed) return Promise.resolve({ changed: false });
    return this.runMetadataOperation(
      () => this.mergeLiveModelsUnfenced(liveModels, defaultModelId, sourceContextKey),
      false,
      () => ({ changed: false }),
    );
  }

  private async mergeLiveModelsUnfenced(
    liveModels: CopilotDiscoveredModel[],
    defaultModelId?: string,
    sourceContextKey?: string,
  ): Promise<ProviderModelCatalogRefreshResult> {
    const contextKey = this.getContextKey();
    if (
      sourceContextKey
      && sourceContextKey !== contextKey
      && sourceContextKey !== 'copilot-runtime'
    ) return { changed: false };
    this.prepareLiveContext(contextKey);
    const settings = getCopilotProviderSettings(this.plugin.settings);
    const enabledModelIds = new Set(settings.visibleModels ?? []);
    const normalized = normalizeCopilotDiscoveredModels(liveModels).map(model => (
      settings.visibleModels === null || enabledModelIds.has(model.rawId)
        ? model
        : clearCopilotReasoningMetadata(model)
    ));
    if (normalized.length === 0) return { changed: false };

    const revision = ++this.liveRevision;
    for (const model of normalized) {
      const current = this.liveModelsById.get(model.rawId);
      this.liveModelsById.set(model.rawId, {
        model: current ? mergeCopilotDiscoveredModels([current.model], [model])[0] : model,
        revision,
      });
    }
    const normalizedDefault = defaultModelId?.trim() || null;
    if (normalizedDefault) {
      this.liveDefaultModelId = normalizedDefault;
      this.liveDefaultRevision = revision;
    }
    this.pendingLiveRevisions.add(revision);
    try {
      const persisted = await this.persistLiveModels(normalized, revision, contextKey);
      if (persisted.changed) this.plugin.notifyProviderChatOptionsChanged('copilot');
      return persisted;
    } finally {
      this.pendingLiveRevisions.delete(revision);
    }
  }

  cancel(): void {
    this.abortController?.abort();
  }

  beginEnvironmentTransition(): void {
    if (!this.disposed) this.transitionActive = true;
  }

  endEnvironmentTransition(): void {
    if (this.disposed) return;
    this.transitionActive = false;
    const waiters = [...this.transitionWaiters];
    this.transitionWaiters.clear();
    waiters.forEach(resolve => resolve());
  }

  async quiesceForEnvironmentChange(): Promise<void> {
    const flight = this.inFlightRefresh;
    const active = [...this.activeMetadataOperations];
    this.refreshGeneration += 1;
    this.abortController?.abort();
    if (flight) {
      await flight.promise.catch(() => undefined);
      if (this.inFlightRefresh === flight) this.inFlightRefresh = null;
    }
    await Promise.all(active.map(operation => operation.catch(() => undefined)));
    this.liveContextKey = null;
    this.liveDefaultModelId = null;
    this.liveDefaultRevision = 0;
    this.liveModelsById.clear();
    this.pendingLiveRevisions.clear();
    this.state = 'idle';
  }

  dispose(): void {
    this.disposed = true;
    this.transitionActive = false;
    const waiters = [...this.transitionWaiters];
    this.transitionWaiters.clear();
    waiters.forEach(resolve => resolve());
    this.cancel();
  }

  private async refreshUnfenced(context?: ProviderTransitionOwnerContext): Promise<CopilotCatalogResult> {
    if (this.transitionActive && context?.providerTransitionOwner !== true) {
      await this.waitForTransition();
      return this.refreshUnfenced(context);
    }
    const contextKey = this.getContextKey();
    const transitionOwner = context?.providerTransitionOwner === true;
    this.prepareLiveContext(contextKey);
    if (this.inFlightRefresh?.contextKey === contextKey
      && (!transitionOwner || this.inFlightRefresh.transitionOwner)) {
      return this.inFlightRefresh.promise;
    }
    if (this.inFlightRefresh) this.abortController?.abort();
    const generation = ++this.refreshGeneration;
    const promise = this.runRefresh(generation, contextKey, context);
    const flight = { contextKey, generation, promise, transitionOwner };
    this.inFlightRefresh = flight;
    try {
      return await promise;
    } finally {
      if (this.inFlightRefresh === flight) this.inFlightRefresh = null;
    }
  }

  private async runRefresh(
    generation: number,
    contextKey: string,
    context?: ProviderTransitionOwnerContext,
  ): Promise<CopilotCatalogResult> {
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;
    this.state = 'refreshing';
    const refreshStartRevision = this.liveRevision;
    const pendingAtStart = new Set(this.pendingLiveRevisions);
    try {
      const discovery = await this.service.discoverCatalog(controller.signal, context);
      if (!this.isCurrentRefresh(generation) || contextKey !== this.getContextKey()) {
        this.state = this.disposed ? 'idle' : this.state;
        return this.skippedResult();
      }
      if (discovery.kind === 'skipped') {
        this.state = this.getCachedCatalog() ? 'ready' : 'idle';
        return this.skippedResult();
      }
      if (discovery.diagnostics) {
        this.state = 'failed';
        return { ...this.completedResult(), diagnostics: discovery.diagnostics };
      }
      const persisted = await this.persistDiscovery(
        discovery,
        refreshStartRevision,
        pendingAtStart,
        contextKey,
        generation,
      );
      if (!this.isCurrentRefresh(generation)) return this.skippedResult();
      this.state = 'ready';
      if (persisted.changed) this.plugin.notifyProviderChatOptionsChanged('copilot');
      return { catalog: this.getCachedCatalog(), kind: 'completed', ...persisted };
    } catch (error) {
      if (!this.isCurrentRefresh(generation)) return this.skippedResult();
      this.state = 'failed';
      const message = error instanceof Error ? error.message : 'Copilot model catalog refresh failed';
      return { ...this.completedResult(), diagnostics: message };
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
  }

  private async persistDiscovery(
    discovery: Extract<CopilotModelCatalogDiscoveryResult, { kind: 'completed' }>,
    refreshStartRevision: number,
    pendingAtStart: ReadonlySet<number>,
    expectedContextKey: string,
    expectedGeneration: number,
  ): Promise<{ changed: boolean; persistedSettingsChanged: boolean }> {
    return this.persistCatalog(expectedContextKey, current => {
      const applies = (revision: number) => revision > refreshStartRevision || pendingAtStart.has(revision);
      const liveModels = this.liveContextKey === expectedContextKey
        ? [...this.liveModelsById.values()].filter(entry => applies(entry.revision)).map(entry => entry.model)
        : [];
      const liveDefault = this.liveContextKey === expectedContextKey && applies(this.liveDefaultRevision)
        ? this.liveDefaultModelId
        : null;
      const currentById = new Map((current?.models ?? []).map(model => [model.rawId, model] as const));
      const discovered = discovery.models.map(model => {
        const old = currentById.get(model.rawId);
        return old ? mergeCopilotDiscoveredModels([old], [model])[0] : model;
      });
      return {
        defaultModelId: liveDefault ?? discovery.defaultModelId,
        fingerprint: discovery.fingerprint,
        models: mergeCopilotDiscoveredModels(discovered, liveModels),
        refreshedAt: Date.now(),
      };
    }, expectedGeneration);
  }

  private async persistLiveModels(
    liveModels: CopilotDiscoveredModel[],
    revision: number,
    expectedContextKey: string,
  ): Promise<{ changed: boolean; persistedSettingsChanged: boolean }> {
    return this.persistCatalog(expectedContextKey, current => {
      const latest = liveModels.map(model => {
        const entry = this.liveContextKey === expectedContextKey ? this.liveModelsById.get(model.rawId) : null;
        return entry && entry.revision >= revision ? entry.model : model;
      });
      const latestDefault = this.liveContextKey === expectedContextKey && this.liveDefaultRevision >= revision
        ? this.liveDefaultModelId
        : null;
      return {
        defaultModelId: latestDefault ?? current?.defaultModelId ?? null,
        fingerprint: current?.fingerprint ?? '',
        models: mergeCopilotDiscoveredModels(current?.models ?? [], latest),
        refreshedAt: current?.refreshedAt ?? 0,
      };
    });
  }

  private async persistCatalog(
    expectedContextKey: string,
    buildSnapshot: (current: CopilotCatalogSnapshot | null) => CopilotCatalogSnapshot,
    expectedGeneration?: number,
  ): Promise<{ changed: boolean; persistedSettingsChanged: boolean }> {
    let result = { changed: false, persistedSettingsChanged: false };
    await this.plugin.mutateSettingsConditionally(settings => {
      if (this.disposed
        || (expectedGeneration !== undefined && !this.isCurrentRefresh(expectedGeneration))
        || computeCopilotEnvironmentHash(settings) !== expectedContextKey) {
        return false;
      }
      const current = getCurrentCopilotCatalog(settings);
      const built = buildSnapshot(current);
      const visibleModels = getCopilotProviderSettings(settings).visibleModels;
      const enabled = new Set(visibleModels ?? []);
      const snapshot = visibleModels === null
        ? built
        : { ...built, models: built.models.map(model => enabled.has(model.rawId) ? model : clearCopilotReasoningMetadata(model)) };
      const changed = current !== null && JSON.stringify({ defaultModelId: current.defaultModelId, models: current.models })
        === JSON.stringify({ defaultModelId: snapshot.defaultModelId, models: snapshot.models })
        ? false
        : true;
      const persistedSettingsChanged = current === null || JSON.stringify(current) !== JSON.stringify(snapshot);
      if (persistedSettingsChanged) updateCurrentCopilotCatalog(settings, snapshot);
      result = { changed, persistedSettingsChanged };
      return persistedSettingsChanged;
    });
    return result;
  }

  private getContextKey(): string {
    return computeCopilotEnvironmentHash(this.plugin.settings);
  }

  private isCurrentRefresh(generation: number): boolean {
    return !this.disposed && generation === this.refreshGeneration;
  }

  private prepareLiveContext(contextKey: string): void {
    if (this.liveContextKey === contextKey) return;
    this.liveContextKey = contextKey;
    this.liveDefaultModelId = null;
    this.liveDefaultRevision = 0;
    this.liveModelsById.clear();
    this.pendingLiveRevisions.clear();
  }

  private runMetadataOperation<T>(
    operation: () => Promise<T>,
    transitionOwner: boolean,
    disposedResult: () => T,
  ): Promise<T> {
    if (this.disposed) return Promise.resolve(disposedResult());
    if (this.transitionActive && !transitionOwner) {
      return this.waitForTransition().then(() => this.runMetadataOperation(operation, transitionOwner, disposedResult));
    }
    let promise: Promise<T>;
    try {
      promise = operation();
    } catch (error) {
      promise = Promise.reject(toError(error, 'Copilot metadata operation failed'));
    }
    this.activeMetadataOperations.add(promise);
    void promise.then(
      () => this.activeMetadataOperations.delete(promise),
      () => this.activeMetadataOperations.delete(promise),
    );
    return promise;
  }

  private waitForTransition(): Promise<void> {
    if (this.disposed || !this.transitionActive) return Promise.resolve();
    let resolve: (() => void) | undefined;
    const promise = new Promise<void>(resolver => {
      resolve = resolver;
    });
    if (resolve) this.transitionWaiters.add(resolve);
    return promise;
  }

  private completedResult(): CopilotCatalogResult {
    return {
      catalog: this.getCachedCatalog(),
      changed: false,
      kind: 'completed',
      persistedSettingsChanged: false,
    };
  }

  private skippedResult(): CopilotCatalogResult {
    return {
      catalog: this.getCachedCatalog(),
      changed: false,
      kind: 'skipped',
      persistedSettingsChanged: false,
    };
  }
}
