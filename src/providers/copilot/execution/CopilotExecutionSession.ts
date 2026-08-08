import { randomUUID } from 'node:crypto';

import type {
  ProviderExecutionEvent,
  ProviderExecutionRequest,
  ProviderExecutionRun,
  ProviderExecutionSession,
  ProviderRequestedEventScope,
  ProviderSessionConfig,
  ProviderSessionEvent,
  ProviderSessionSnapshot,
  ProviderSessionStatus,
} from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ChatMessage } from '@/core/types';
import {
  AcpExecutionEventNormalizer,
  AcpInteractionController,
  type AcpLoadSessionResponse,
  type AcpNewSessionResponse,
  type AcpPromptResponse,
  type AcpSessionConfigOption,
  type AcpSessionModelState,
  type AcpSessionModeState,
  type AcpSessionNotification,
  buildAcpUsageInfo,
  extractAcpSessionThoughtLevelState,
} from '@/providers/acp';

import type { CopilotCommandCatalog } from '../commands/CopilotCommandCatalog';
import { computeCopilotEnvironmentHash } from '../env/CopilotSettingsReconciler';
import {
  decodeCopilotModelId,
  normalizeCopilotDiscoveredModels,
  resolveCopilotReasoningEffort,
} from '../models';
import { buildCopilotPromptBlocks } from '../runtime/buildCopilotPrompt';
import { buildCopilotRuntimeEnv } from '../runtime/CopilotRuntimeEnvironment';
import type { CopilotModelCatalogCoordinator } from './CopilotExecutionBackend';
import type {
  CopilotExecutionNativeConnection,
  CopilotExecutionNativeFactory,
} from './CopilotExecutionNativeConnection';

export interface CopilotExecutionSessionOptions {
  readonly commandCatalog?: Pick<CopilotCommandCatalog, 'setCommandSnapshot'>;
  readonly modelCatalogCoordinator?: CopilotModelCatalogCoordinator;
  readonly nativeFactory: CopilotExecutionNativeFactory;
}

class ExecutionEventQueue implements AsyncIterableIterator<ProviderExecutionEvent> {
  private closed = false;
  private readonly values: ProviderExecutionEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<ProviderExecutionEvent>) => void> = [];

  constructor(private readonly onEarlyReturn: () => void) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<ProviderExecutionEvent> {
    return this;
  }

  next(): Promise<IteratorResult<ProviderExecutionEvent>> {
    const value = this.values.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise(resolve => this.waiters.push(resolve));
  }

  return(): Promise<IteratorResult<ProviderExecutionEvent>> {
    if (!this.closed) this.onEarlyReturn();
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }

  push(event: ProviderExecutionEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else this.values.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }
}

class CopilotExecutionRun implements ProviderExecutionRun {
  readonly executionId = randomUUID();
  readonly turnId = randomUUID();
  readonly queue: ExecutionEventQueue;
  readonly events: AsyncIterable<ProviderExecutionEvent>;
  terminal = false;
  accepted = false;
  acceptingLiveOutput = false;
  cancellationRequested = false;
  sequence = 0;
  abortCleanup: (() => void) | null = null;

  constructor(
    readonly sessionInstanceId: string,
    private readonly cancelCallback: (run: CopilotExecutionRun) => void,
  ) {
    this.queue = new ExecutionEventQueue(() => this.cancel());
    this.events = this.queue;
  }

  cancel(): void {
    if (!this.terminal) this.cancelCallback(this);
  }

  scope(): ProviderRequestedEventScope {
    return {
      executionId: this.executionId,
      kind: 'requested',
      sequence: ++this.sequence,
      sessionInstanceId: this.sessionInstanceId,
      turnId: this.turnId,
    };
  }

  emit(event: ProviderExecutionEvent): void {
    if (this.terminal) return;
    this.sequence = Math.max(this.sequence, event.scope.sequence);
    this.queue.push(event);
  }

  finish(event: ProviderExecutionEvent): void {
    if (this.terminal) return;
    this.terminal = true;
    this.acceptingLiveOutput = false;
    this.abortCleanup?.();
    this.abortCleanup = null;
    this.queue.push(event);
    this.queue.close();
  }
}

interface NativeOwner {
  readonly generation: number;
  readonly native: CopilotExecutionNativeConnection;
  initialized: boolean;
  loadedSessionId: string | null;
  loadedConfigurationKey: string | null;
  modes: AcpSessionModeState | null;
  models: AcpSessionModelState | null;
  configOptions: AcpSessionConfigOption[];
  replaying: boolean;
  notificationUnsubscribe: () => void;
  shutdownFlight: Promise<void> | null;
}

export class CopilotExecutionSession implements ProviderExecutionSession {
  readonly providerId = 'copilot' as const;
  readonly sessionInstanceId = randomUUID();

  private readonly interactionController: AcpInteractionController;
  private readonly listeners = new Set<(event: ProviderSessionEvent) => void>();
  private readonly createNative: CopilotExecutionNativeFactory;
  private readonly seedProviderState: Readonly<Record<string, unknown>>;
  private providerSessionId: string | null;
  private providerState: Readonly<Record<string, unknown>>;
  private activeRun: CopilotExecutionRun | null = null;
  private activeRequest: ProviderExecutionRequest | null = null;
  private nativeOwner: NativeOwner | null = null;
  private nativeStartupFlight: Promise<CopilotExecutionNativeConnection> | null = null;
  private nativeGeneration = 0;
  private lifecycleGeneration = 0;
  private cancellationFlight: Promise<void> | null = null;
  private disposalFlight: Promise<void> | null = null;
  private disposed = false;
  private revision = 0;
  private sessionEventSequence = 0;
  private nativeConversationContextEstablished: boolean;
  private snapshot: ProviderSessionSnapshot;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly config: ProviderSessionConfig,
    private readonly options: CopilotExecutionSessionOptions,
  ) {
    this.createNative = options.nativeFactory;
    this.providerSessionId = config.resumeSeed?.providerSessionId ?? null;
    this.providerState = Object.freeze({ ...(config.resumeSeed?.providerState ?? {}) });
    this.seedProviderState = this.providerState;
    this.nativeConversationContextEstablished = this.providerSessionId !== null;
    this.snapshot = this.createSnapshot('idle');
    this.interactionController = new AcpInteractionController({
      getTurnId: () => this.activeRun?.turnId ?? null,
      interactionPort: config.interactionPort,
      sessionInstanceId: this.sessionInstanceId,
    });
  }

  execute(request: ProviderExecutionRequest): ProviderExecutionRun {
    if (this.disposed) throw new Error('Copilot execution session is disposed.');
    if (this.activeRun) throw new Error('Copilot execution session is already executing.');

    const run = new CopilotExecutionRun(
      this.sessionInstanceId,
      active => { void this.cancelRun(active, 'cancelled'); },
    );
    this.activeRun = run;
    this.activeRequest = request;
    this.updateSnapshot('executing');
    this.emitRunSnapshot(run);

    const onAbort = (): void => { void this.cancelRun(run, 'cancelled'); };
    request.signal.addEventListener('abort', onAbort, { once: true });
    run.abortCleanup = () => request.signal.removeEventListener('abort', onAbort);
    if (request.signal.aborted) {
      void this.cancelRun(run, 'cancelled');
    } else {
      void this.performExecution(run, request);
    }
    return run;
  }

  cancel(): void {
    const run = this.activeRun;
    if (run) void this.cancelRun(run, 'cancelled');
  }

  getSnapshot(): ProviderSessionSnapshot {
    return this.snapshot;
  }

  getStatus(): ProviderSessionStatus {
    return this.snapshot.status;
  }

  onEvent(listener: (event: ProviderSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): Promise<void> {
    if (this.disposalFlight) return this.disposalFlight;
    this.disposed = true;
    this.lifecycleGeneration += 1;
    this.disposalFlight = (async () => {
      const run = this.activeRun;
      if (run && !run.terminal) await this.cancelRun(run, 'session-disposed');
      if (this.cancellationFlight) await this.cancellationFlight;
      await this.shutdownNative();
      this.interactionController.dispose();
      this.listeners.clear();
      this.activeRun = null;
      this.activeRequest = null;
      this.updateSnapshot('disposed');
    })();
    return this.disposalFlight;
  }

  private async performExecution(
    run: CopilotExecutionRun,
    request: ProviderExecutionRequest,
  ): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    try {
      if (this.cancellationFlight) await this.cancellationFlight;
      if (!this.isCurrent(run, generation)) return;

      const native = await this.ensureNative(run, generation);
      if (!this.isCurrent(run, generation)) return;
      const sessionId = await this.ensureSession(native, request, run, generation);
      if (!this.isCurrent(run, generation)) return;
      await this.applyConfiguration(native, sessionId, request, run, generation);
      if (!this.isCurrent(run, generation)) return;

      const owner = this.requireNativeOwner(native);
      owner.replaying = false;
      run.acceptingLiveOutput = true;
      const response = await native.prompt({
        prompt: buildPromptBlocks(request, !this.nativeConversationContextEstablished),
        sessionId,
      });
      this.markConversationEstablished(run);
      this.accept(run, response);
      if (response.usage) {
        const usage = buildAcpUsageInfo({ promptUsage: response.usage });
        if (usage) {
          run.emit({
            providerPayload: response.usage,
            scope: run.scope(),
            type: 'usage_updated',
            usage,
          });
        }
      }
      this.updateSnapshot('idle');
      this.emitRunSnapshot(run);
      run.finish({
        providerPayload: response,
        reason: mapStopReason(response.stopReason),
        scope: run.scope(),
        type: 'turn_completed',
      });
      this.activeRun = null;
      this.activeRequest = null;
    } catch (error) {
      if (!this.isCurrent(run, generation)) return;
      const category = classifyCopilotError(error);
      const missingSessionId = category === 'provider-session-missing'
        ? this.providerSessionId ?? undefined
        : undefined;
      this.updateSnapshot('invalidated', {
        message: formatError(error),
        reason: category === 'provider-session-missing'
          ? 'provider-session-missing'
          : category === 'transport'
            ? 'transport-closed'
            : 'provider-error',
        recoverable: true,
      });
      this.emitRunSnapshot(run);
      run.finish({
        category,
        message: formatError(error),
        ...(missingSessionId ? { missingProviderSessionId: missingSessionId } : {}),
        recoverable: true,
        scope: run.scope(),
        type: 'execution_error',
      });
      this.activeRun = null;
      this.activeRequest = null;
      await this.shutdownNative();
    }
  }

  private async ensureNative(
    run: CopilotExecutionRun,
    generation: number,
  ): Promise<CopilotExecutionNativeConnection> {
    const owner = this.nativeOwner;
    if (owner?.initialized && owner.native.isAlive() !== false) return owner.native;
    let startup = this.nativeStartupFlight;
    if (!startup) {
      startup = this.startNative();
      this.nativeStartupFlight = startup;
      void startup.then(
        () => { if (this.nativeStartupFlight === startup) this.nativeStartupFlight = null; },
        () => { if (this.nativeStartupFlight === startup) this.nativeStartupFlight = null; },
      );
    }
    const native = await startup;
    if (!this.isCurrent(run, generation)) throw new CopilotExecutionCancellationError();
    return native;
  }

  private async startNative(): Promise<CopilotExecutionNativeConnection> {
    await this.shutdownNative();
    const command = await this.plugin.getResolvedProviderCliPath?.('copilot') ?? 'copilot';
    const generation = ++this.nativeGeneration;
    const native = this.createNative.create({
      command,
      cwd: this.config.vaultWorkingDirectory,
      env: buildCopilotRuntimeEnv(this.plugin.settings, command),
      requestPermission: (permission, signal) => {
        const policy = this.activeRequest?.toolPolicy.kind;
        if (policy === 'passive' || policy === 'read-only') {
          return Promise.resolve({ outcome: { outcome: 'cancelled' } });
        }
        return this.interactionController.requestPermission(
          permission,
          signal ?? undefined,
        );
      },
      version: this.plugin.manifest?.version,
    });
    const owner: NativeOwner = {
      configOptions: [],
      generation,
      initialized: false,
      loadedConfigurationKey: null,
      loadedSessionId: null,
      modes: null,
      models: null,
      native,
      notificationUnsubscribe: () => {},
      replaying: false,
      shutdownFlight: null,
    };
    this.nativeOwner = owner;
    try {
      owner.notificationUnsubscribe = native.onNotification(notification => {
        if (this.isCurrentNativeOwner(owner)) this.handleNotification(notification);
      });
      await native.initialize();
      if (this.disposed || !this.isCurrentNativeOwner(owner)) {
        throw new CopilotExecutionCancellationError();
      }
      owner.initialized = true;
      return native;
    } catch (error) {
      await this.shutdownNativeOwner(owner);
      throw error;
    }
  }
  private async ensureSession(
    native: CopilotExecutionNativeConnection,
    request: ProviderExecutionRequest,
    run: CopilotExecutionRun,
    generation: number,
  ): Promise<string> {
    const owner = this.requireNativeOwner(native);
    const configKey = buildConfigurationKey(request);
    if (owner.loadedSessionId === this.providerSessionId && owner.loadedSessionId) {
      if (owner.loadedConfigurationKey !== configKey) {
        await this.shutdownNative();
        if (!this.isCurrent(run, generation)) throw new CopilotExecutionCancellationError();
        return this.ensureSession(await this.ensureNative(run, generation), request, run, generation);
      }
      return owner.loadedSessionId;
    }

    if (this.providerSessionId) {
      const attemptedSessionId = this.providerSessionId;
      owner.replaying = true;
      try {
        const response = await native.loadSession({
          cwd: this.config.vaultWorkingDirectory,
          mcpServers: [],
          sessionId: attemptedSessionId,
        });
        if (!this.isCurrent(run, generation)) throw new CopilotExecutionCancellationError();
        const loadedSessionId = response.sessionId ?? attemptedSessionId;
        this.captureSession(loadedSessionId);
        this.captureMetadata(owner, response);
        owner.loadedSessionId = loadedSessionId;
        owner.loadedConfigurationKey = configKey;
        return loadedSessionId;
      } catch (error) {
        throw classifyCopilotLoadError(error, attemptedSessionId);
      } finally {
        owner.replaying = false;
      }
    }

    const response = await native.newSession({
      cwd: this.config.vaultWorkingDirectory,
      mcpServers: [],
    });
    if (!this.isCurrent(run, generation)) throw new CopilotExecutionCancellationError();
    this.captureSession(response.sessionId);
    this.captureMetadata(owner, response);
    owner.loadedSessionId = response.sessionId;
    owner.loadedConfigurationKey = configKey;
    return response.sessionId;
  }

  private async applyConfiguration(
    native: CopilotExecutionNativeConnection,
    sessionId: string,
    request: ProviderExecutionRequest,
    run: CopilotExecutionRun,
    generation: number,
  ): Promise<void> {
    const owner = this.requireNativeOwner(native);
    const rawModel = decodeCopilotModelId(request.configuration.model ?? '');
    if (rawModel) {
      await native.setModel({ modelId: rawModel, sessionId });
      if (!this.isCurrent(run, generation)) throw new CopilotExecutionCancellationError();
    }

    const mode = resolveModeSuffix(request.configuration.mode, request.configuration.permissionMode);
    const modeId = mode ? findModeId(owner.modes, mode) : null;
    if (modeId) {
      await native.setMode({ modeId, sessionId });
      if (!this.isCurrent(run, generation)) throw new CopilotExecutionCancellationError();
    }

    const requestedReasoning = request.configuration.reasoning?.trim();
    if (requestedReasoning) {
      const selected = resolveCopilotReasoningEffort(null, requestedReasoning) ?? requestedReasoning;
      const thoughtState = extractAcpSessionThoughtLevelState({ configOptions: owner.configOptions });
      const configId = thoughtState.configId ?? (
        owner.configOptions.some(option => option.id === 'reasoning_effort')
          ? 'reasoning_effort'
          : null
      );
      const available = thoughtState.availableLevels.map(level => level.id);
      if (configId && (available.length === 0 || available.includes(selected))) {
        const result = await native.setConfigOption({
          configId,
          sessionId,
          type: 'select',
          value: selected,
        });
        owner.configOptions = result.configOptions ?? owner.configOptions;
      }
    }
  }

  private handleNotification(notification: AcpSessionNotification): void {
    const owner = this.nativeOwner;
    if (
      this.disposed
      || !owner
      || owner.replaying
      || notification.sessionId !== this.providerSessionId
    ) return;

    const run = this.activeRun;
    if (!run || run.cancellationRequested || run.terminal) return;
    const normalizer = this.getNormalizer(run);
    let result;
    try {
      result = normalizer.normalize(notification.update);
    } catch {
      return;
    }

    if (result.metadata?.type === 'commands') {
      this.options.commandCatalog?.setCommandSnapshot([...result.metadata.commands]);
    }
    if (result.metadata?.type === 'config_options') {
      owner.configOptions = result.metadata.configOptions;
      void this.publishModels(owner, owner.configOptions);
    }
    if (result.metadata?.type === 'current_mode') {
      this.emitSessionMode(modeSuffixToLogical(result.metadata.currentModeId));
    }

    if (!run.acceptingLiveOutput || result.events.length === 0) return;
    this.accept(run);
    for (const event of result.events) {
      run.emit({ ...event, scope: run.scope() });
    }
  }

  private readonly normalizers = new WeakMap<CopilotExecutionRun, AcpExecutionEventNormalizer>();

  private getNormalizer(run: CopilotExecutionRun): AcpExecutionEventNormalizer {
    let normalizer = this.normalizers.get(run);
    if (!normalizer) {
      normalizer = new AcpExecutionEventNormalizer({
        mapUsage: usage => buildAcpUsageInfo({ contextWindow: usage }),
        scope: {
          executionId: run.executionId,
          kind: 'requested',
          sessionInstanceId: this.sessionInstanceId,
          turnId: run.turnId,
        },
      });
      this.normalizers.set(run, normalizer);
    }
    return normalizer;
  }

  private accept(run: CopilotExecutionRun, response?: AcpPromptResponse): void {
    if (run.accepted || run.terminal) return;
    run.accepted = true;
    if (!this.nativeConversationContextEstablished) this.markConversationEstablished(run);
    run.emit({
      accepted: true,
      ...(response?.userMessageId ? { nativeUserMessageId: response.userMessageId } : {}),
      scope: run.scope(),
      type: 'turn_started',
    });
  }

  private async cancelRun(run: CopilotExecutionRun, reason: string): Promise<void> {
    if (this.activeRun !== run || run.terminal) return;
    if (this.cancellationFlight) return this.cancellationFlight;
    run.cancellationRequested = true;
    run.acceptingLiveOutput = false;
    ++this.lifecycleGeneration;
    this.updateSnapshot('cancelling');
    this.emitRunSnapshot(run);
    this.interactionController.dismissAll('cancelled');
    const owner = this.nativeOwner;
    const flight = (async () => {
      try {
        try {
          if (owner && this.providerSessionId) owner.native.cancel(this.providerSessionId);
          await owner?.native.flush?.();
        } catch {
          // Cancellation remains authoritative even if delivery fails.
        }
        try {
          await this.shutdownNative();
        } catch {
          // Cancellation remains authoritative even if teardown fails.
        }
        if (!this.disposed) {
          this.updateSnapshot('invalidated', {
            message: 'The Copilot process was cancelled and will be replaced.',
            reason: 'cancelled',
            recoverable: true,
          });
          this.emitRunSnapshot(run);
        }
      } finally {
        run.finish({ reason, scope: run.scope(), type: 'cancelled' });
        this.activeRun = null;
        this.activeRequest = null;
      }
    })();
    const cancellation = flight.finally(() => {
      if (this.cancellationFlight === cancellation) this.cancellationFlight = null;
    });
    this.cancellationFlight = cancellation;
    return cancellation;
  }

  private async shutdownNative(): Promise<void> {
    const startup = this.nativeStartupFlight;
    const owner = this.nativeOwner;
    if (owner) await this.shutdownNativeOwner(owner);
    if (startup) {
      try { await startup; } catch { /* startup error belongs to its caller */ }
    }
    if (this.nativeOwner) await this.shutdownNativeOwner(this.nativeOwner);
  }

  private async shutdownNativeOwner(owner: NativeOwner): Promise<void> {
    if (this.nativeOwner === owner) {
      this.nativeOwner = null;
      this.nativeGeneration += 1;
      try { owner.notificationUnsubscribe(); } catch { /* best effort */ }
    }
    if (!owner.shutdownFlight) {
      owner.shutdownFlight = Promise.resolve().then(() => owner.native.shutdown());
    }
    await owner.shutdownFlight;
  }

  private isCurrent(run: CopilotExecutionRun, generation: number): boolean {
    return !this.disposed
      && this.activeRun === run
      && !run.terminal
      && !run.cancellationRequested
      && generation === this.lifecycleGeneration;
  }

  private isCurrentNativeOwner(owner: NativeOwner): boolean {
    return !this.disposed
      && this.nativeOwner === owner
      && owner.generation === this.nativeGeneration;
  }

  private requireNativeOwner(native: CopilotExecutionNativeConnection): NativeOwner {
    const owner = this.nativeOwner;
    if (!owner || owner.native !== native) throw new Error('Copilot native ownership changed.');
    return owner;
  }

  private captureSession(sessionId: string): void {
    this.providerSessionId = sessionId;
    this.updateSnapshot(this.activeRun ? 'executing' : 'idle');
    if (this.activeRun) this.emitRunSnapshot(this.activeRun);
  }

  private captureMetadata(
    owner: NativeOwner,
    response: AcpNewSessionResponse | AcpLoadSessionResponse,
  ): void {
    owner.configOptions = response.configOptions ? [...response.configOptions] : [];
    owner.modes = response.modes ?? null;
    owner.models = response.models ?? null;
    void this.publishModels(owner, owner.configOptions);
  }

  private async publishModels(owner: NativeOwner, configOptions: readonly AcpSessionConfigOption[]): Promise<void> {
    if (!this.options.modelCatalogCoordinator || !this.isCurrentNativeOwner(owner)) return;
    const state = owner.models;
    const models = normalizeCopilotDiscoveredModels(state?.availableModels ?? [], configOptions);
    if (models.length === 0) return;
    try {
      await this.options.modelCatalogCoordinator.mergeLiveModels(
        models,
        state?.currentModelId,
        computeCopilotEnvironmentHash(this.plugin.settings),
      );
    } catch {
      // Catalog synchronization is best effort.
    }
  }

  private markConversationEstablished(run: CopilotExecutionRun): void {
    if (this.nativeConversationContextEstablished) return;
    this.nativeConversationContextEstablished = true;
    this.providerState = Object.freeze({
      ...this.providerState,
      nativeConversationContextEstablished: true,
    });
    this.updateSnapshot('executing');
    this.emitRunSnapshot(run);
  }

  private emitRunSnapshot(run: CopilotExecutionRun): void {
    run.emit({ scope: run.scope(), snapshot: this.snapshot, type: 'session_state_changed' });
  }

  private emitSessionMode(mode: string): void {
    this.emitSessionEvent({
      mode,
      scope: {
        kind: 'session',
        sequence: ++this.sessionEventSequence,
        sessionInstanceId: this.sessionInstanceId,
      },
      snapshot: this.snapshot,
      type: 'mode_changed',
    });
  }

  private emitSessionEvent(event: ProviderSessionEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* listener failures do not affect execution */ }
    }
  }

  private updateSnapshot(
    status: ProviderSessionStatus,
    invalidation?: ProviderSessionSnapshot['invalidation'],
  ): void {
    const providerState = this.providerState;
    const base = {
      ...(this.providerSessionId ? { providerSessionId: this.providerSessionId } : {}),
      ...(Object.keys(providerState).length > 0 ? { providerState } : {}),
      providerId: this.providerId,
      revision: this.revision++,
    };
    this.snapshot = status === 'invalidated'
      ? Object.freeze({ ...base, invalidation: invalidation!, status })
      : Object.freeze({ ...base, status });
  }

  private createSnapshot(status: Exclude<ProviderSessionStatus, 'invalidated'>): ProviderSessionSnapshot {
    const providerState = this.seedProviderState;
    return Object.freeze({
      ...(this.providerSessionId ? { providerSessionId: this.providerSessionId } : {}),
      ...(Object.keys(providerState).length > 0 ? { providerState } : {}),
      providerId: this.providerId,
      revision: this.revision++,
      status,
    });
  }
}

function buildPromptBlocks(
  request: ProviderExecutionRequest,
  replayConversationHistory: boolean,
) {
  const text = request.input
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n');
  const images = request.input
    .filter((block): block is Extract<typeof block, { type: 'image' }> => block.type === 'image')
    .map(block => block.image);
  const note = request.context?.currentNote;
  return buildCopilotPromptBlocks({
    browserSelection: request.context?.browserSelection,
    canvasSelection: request.context?.canvasSelection,
    currentNoteContent: note?.content,
    currentNotePath: note?.path,
    editorSelection: request.context?.editorSelection,
    externalContextPaths: request.context?.externalContextPaths,
    images,
    text,
  }, replayConversationHistory ? [...(request.conversationHistory ?? [])] as ChatMessage[] : []);
}

function buildConfigurationKey(request: ProviderExecutionRequest): string {
  return JSON.stringify([
    request.configuration.systemInstructions,
    request.configuration.model ?? null,
    request.configuration.reasoning ?? null,
    request.configuration.mode ?? null,
    request.configuration.permissionMode ?? null,
    request.toolPolicy,
  ]);
}

function resolveModeSuffix(mode: string | undefined, permissionMode: string | undefined): 'agent' | 'plan' | 'autopilot' | null {
  const requested = mode || permissionMode;
  if (requested?.endsWith('#agent')) return 'agent';
  if (requested?.endsWith('#plan')) return 'plan';
  if (requested?.endsWith('#autopilot')) return 'autopilot';
  if (requested === 'plan') return 'plan';
  if (requested === 'yolo') return 'autopilot';
  if (requested === 'normal' || requested === 'default') return 'agent';
  return permissionMode === 'plan'
    ? 'plan'
    : permissionMode === 'yolo'
      ? 'autopilot'
      : permissionMode === 'normal'
        ? 'agent'
        : null;
}

function findModeId(modes: AcpSessionModeState | null, suffix: string): string | null {
  return modes?.availableModes.find(mode => mode.id.endsWith(`#${suffix}`))?.id ?? null;
}

function modeSuffixToLogical(modeId: string): string {
  if (modeId.endsWith('#plan')) return 'plan';
  if (modeId.endsWith('#autopilot')) return 'yolo';
  if (modeId.endsWith('#agent')) return 'normal';
  return modeId;
}

function classifyCopilotLoadError(error: unknown, sessionId: string): unknown {
  const message = formatError(error).toLowerCase();
  return message.includes('session') && (
    message.includes('missing') || message.includes('not found') || message.includes('unknown')
  )
    ? new CopilotSessionMissingError(sessionId, error)
    : error;
}

function classifyCopilotError(
  error: unknown,
): 'authentication' | 'configuration' | 'provider-session-missing' | 'transport' | 'provider' | 'unknown' {
  const message = formatError(error).toLowerCase();
  if (message.includes('auth') || message.includes('unauthorized') || message.includes('credential')) return 'authentication';
  if (message.includes('session') && (message.includes('missing') || message.includes('not found') || message.includes('unknown'))) return 'provider-session-missing';
  if (message.includes('transport') || message.includes('closed') || message.includes('broken pipe') || message.includes('eof')) return 'transport';
  if (message.includes('config') || message.includes('model')) return 'configuration';
  return 'provider';
}

function mapStopReason(reason: string): 'completed' | 'max-tokens' | 'tool-ended' | 'provider-ended' {
  if (reason === 'max_tokens' || reason === 'max-tokens') return 'max-tokens';
  if (reason === 'tool_use' || reason === 'tool-ended') return 'tool-ended';
  if (reason === 'end_turn' || reason === 'completed') return 'completed';
  return 'provider-ended';
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class CopilotSessionMissingError extends Error {
  readonly name = 'CopilotSessionMissingError';
  constructor(readonly sessionId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Copilot session is missing.');
  }
}

class CopilotExecutionCancellationError extends Error {
  constructor() {
    super('Copilot execution was cancelled.');
    this.name = 'CopilotExecutionCancellationError';
  }
}
