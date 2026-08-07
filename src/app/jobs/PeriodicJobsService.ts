import type { PeriodicJobExecutionService } from '../../core/auxiliary/PeriodicJobExecutionService';
import { findProviderModelOption } from '../../core/providers/conversationModel';
import type { ProviderHost } from '../../core/providers/ProviderHost';
import { ProviderRegistry } from '../../core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '../../core/providers/ProviderSettingsCoordinator';
import type { ProviderId } from '../../core/providers/types';
import { parsePeriodicJobSchedule } from '../../core/scheduling/PeriodicJobSchedule';
import { capPeriodicJobSummary } from '../../core/scheduling/PeriodicJobSummary';
import type { PeriodicJobPartialUpdate } from '../../core/tools/HostToolCatalog';
import type {
  ClaudianSettings,
  PeriodicJob,
  PeriodicJobDraft,
  PeriodicJobRunTrigger,
} from '../../core/types';
import type { PeriodicJobsPort } from '../../features/FeatureHost';
import type { SettingsCoordinator } from '../settings/SettingsCoordinator';

export interface PeriodicJobsDependencies {
  clock: { now(): number };
  createSchedule(
    pattern: string,
    callback: () => Promise<void>,
    onError: (error: unknown) => void,
  ): { stop(): void };
  initializeProvider(providerId: ProviderId): Promise<void>;
  createExecutionService(providerId: ProviderId): PeriodicJobExecutionService;
}

interface ActiveRun {
  readonly runId: string;
  runner: PeriodicJobExecutionService | null;
  suppressed: boolean;
}

interface RunSuccess {
  status: 'succeeded';
}

interface RunFailure {
  status: 'failed';
  message: string;
}

type RunOutcome = RunSuccess | RunFailure;

const JOB_NOT_FOUND_MESSAGE = 'Periodic job not found.';
const JOB_ALREADY_RUNNING_MESSAGE = 'Periodic job is already running.';
const CLOSED_DURING_RUN_MESSAGE = 'Obsidian closed before the job completed.';
const EMPTY_SUCCESS_MESSAGE = 'Completed without a text response.';

export class PeriodicJobsService implements PeriodicJobsPort {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly listeners = new Set<() => void>();
  private readonly pendingRuns = new Set<Promise<RunOutcome>>();
  private readonly schedules = new Map<string, { stop(): void }>();
  private started = false;
  private stopPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly settingsCoordinator: SettingsCoordinator<ClaudianSettings>,
    private readonly getSettings: () => ClaudianSettings,
    private readonly providerHost: ProviderHost,
    private readonly dependencies: PeriodicJobsDependencies,
  ) {}

  list(): readonly PeriodicJob[] {
    return structuredClone(this.getSettings().periodicJobs);
  }

  async create(draft: PeriodicJobDraft): Promise<PeriodicJob> {
    let committed: PeriodicJob | null = null;
    await this.settingsCoordinator.mutate((settings) => {
      const normalized = this.normalizeDraft(draft, settings);
      let id: string;
      do {
        id = `job-${this.dependencies.clock.now()}-${Math.random().toString(36).substring(2, 11)}`;
      } while (settings.periodicJobs.some(job => job.id === id));

      committed = { id, ...normalized, lastRun: null };
      settings.periodicJobs = [...settings.periodicJobs, committed];
    }, () => {
      if (committed) this.syncSchedule(committed);
      this.notify();
    });

    if (!committed) throw new Error('Periodic job was not created.');
    return structuredClone(committed);
  }

  async update(id: string, draft: PeriodicJobDraft): Promise<PeriodicJob> {
    return this.updatePartial(id, draft);
  }

  async updatePartial(id: string, patch: PeriodicJobPartialUpdate): Promise<PeriodicJob> {
    let committed: PeriodicJob | null = null;
    await this.settingsCoordinator.mutate((settings) => {
      const index = settings.periodicJobs.findIndex(job => job.id === id);
      if (index < 0) throw new Error(JOB_NOT_FOUND_MESSAGE);
      const previous = settings.periodicJobs[index];
      const merged: PeriodicJobDraft = {
        enabled: patch.enabled ?? previous.enabled,
        name: patch.name ?? previous.name,
        schedule: patch.schedule ?? previous.schedule,
        prompt: patch.prompt ?? previous.prompt,
        model: patch.model ?? previous.model,
      };
      committed = {
        id: previous.id,
        ...this.normalizeDraft(merged, settings),
        lastRun: previous.lastRun,
      };
      settings.periodicJobs = settings.periodicJobs.map((job, jobIndex) => (
        jobIndex === index ? committed as PeriodicJob : job
      ));
    }, () => {
      if (committed) this.syncSchedule(committed);
      this.notify();
    });

    if (!committed) throw new Error(JOB_NOT_FOUND_MESSAGE);
    return structuredClone(committed);
  }

  async delete(id: string): Promise<void> {
    if (!this.getSettings().periodicJobs.some(job => job.id === id)) {
      throw new Error(JOB_NOT_FOUND_MESSAGE);
    }

    const cleanup = this.invalidateRun(id);
    this.stopSchedule(id);
    try {
      await cleanup;
      await this.settingsCoordinator.mutate((settings) => {
        const index = settings.periodicJobs.findIndex(job => job.id === id);
        if (index < 0) throw new Error(JOB_NOT_FOUND_MESSAGE);
        settings.periodicJobs = settings.periodicJobs.filter(job => job.id !== id);
      }, () => this.notify());
    } catch (error) {
      const current = this.getSettings().periodicJobs.find(job => job.id === id);
      if (current) this.syncSchedule(current);
      throw error;
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    let committed: PeriodicJob | null = null;
    await this.settingsCoordinator.mutateConditionally((settings) => {
      const current = settings.periodicJobs.find(job => job.id === id);
      if (!current) throw new Error(JOB_NOT_FOUND_MESSAGE);
      if (current.enabled === enabled) return false;
      committed = { ...current, enabled };
      settings.periodicJobs = settings.periodicJobs.map(job => (
        job.id === id ? committed as PeriodicJob : job
      ));
      return true;
    });
    if (committed) {
      this.syncSchedule(committed);
      this.notify();
    }
  }

  async runNow(id: string): Promise<void> {
    const outcome = await this.beginRun(id, 'manual');
    if (outcome.status === 'failed') {
      throw new Error(outcome.message);
    }
  }

  isRunning(id: string): boolean {
    return this.activeRuns.has(id);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async reconcileInterruptedRuns(): Promise<void> {
    const completedAt = this.dependencies.clock.now();
    let changed = false;
    await this.settingsCoordinator.mutateConditionally((settings) => {
      const periodicJobs = settings.periodicJobs.map((job) => {
        if (job.lastRun?.status !== 'running') return job;
        changed = true;
        return {
          ...job,
          lastRun: {
            ...job.lastRun,
            completedAt,
            status: 'interrupted' as const,
            summary: CLOSED_DURING_RUN_MESSAGE,
          },
        };
      });
      if (!changed) return false;
      settings.periodicJobs = periodicJobs;
      return true;
    });
    if (changed) this.notify();
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    for (const job of this.getSettings().periodicJobs) {
      this.syncSchedule(job);
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }
    this.stopped = true;
    this.started = false;
    for (const schedule of this.schedules.values()) schedule.stop();
    this.schedules.clear();

    const disposals: Promise<void>[] = [];
    const hadActiveRuns = this.activeRuns.size > 0;
    for (const [jobId, active] of this.activeRuns) {
      active.suppressed = true;
      this.activeRuns.delete(jobId);
      if (active.runner) {
        active.runner.cancel();
        disposals.push(active.runner.dispose());
      }
    }
    if (hadActiveRuns) this.notify();

    this.stopPromise = this.awaitStopSettlements(disposals);
    await this.stopPromise;
  }

  private async awaitStopSettlements(disposals: Promise<void>[]): Promise<void> {
    const settlements = await Promise.allSettled([
      ...disposals,
      ...this.pendingRuns,
    ]);
    const failure = settlements.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) throw failure.reason;
  }

  private normalizeDraft(
    draft: PeriodicJobDraft,
    settings: ClaudianSettings,
  ): PeriodicJobDraft {
    const name = draft.name.trim();
    const prompt = draft.prompt.trim();
    const providerId = draft.model.providerId.trim();
    const requestedModel = draft.model.model.trim();
    if (!name) throw new Error('Periodic job name is required.');
    if (!prompt) throw new Error('Periodic job prompt is required.');

    const schedule = parsePeriodicJobSchedule(draft.schedule);
    if (!ProviderRegistry.getRegisteredProviderIds().includes(providerId)) {
      throw new Error('Selected provider is unavailable.');
    }
    const typedProviderId = providerId;
    if (!ProviderRegistry.isEnabled(typedProviderId, settings)) {
      throw new Error('Selected provider is not enabled.');
    }
    const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      settings,
      typedProviderId,
    );
    const model = findProviderModelOption(
      typedProviderId,
      requestedModel,
      providerSettings,
    );
    if (!model) throw new Error('Selected model is unavailable.');

    return {
      enabled: draft.enabled,
      name,
      schedule,
      prompt,
      model: { providerId: typedProviderId, model },
    };
  }

  private syncSchedule(job: PeriodicJob): void {
    this.stopSchedule(job.id);
    if (!this.started || this.stopped || !job.enabled) return;
    const pattern = parsePeriodicJobSchedule(job.schedule);
    const schedule = this.dependencies.createSchedule(
      pattern,
      async () => {
        await this.beginRun(job.id, 'scheduled');
      },
      () => undefined,
    );
    this.schedules.set(job.id, schedule);
  }

  private stopSchedule(id: string): void {
    this.schedules.get(id)?.stop();
    this.schedules.delete(id);
  }

  private beginRun(id: string, trigger: PeriodicJobRunTrigger): Promise<RunOutcome> {
    const job = this.getSettings().periodicJobs.find(candidate => candidate.id === id);
    if (!job) return Promise.reject(new Error(JOB_NOT_FOUND_MESSAGE));
    if (this.activeRuns.has(id)) {
      return trigger === 'scheduled'
        ? Promise.resolve({ status: 'succeeded' })
        : Promise.reject(new Error(JOB_ALREADY_RUNNING_MESSAGE));
    }

    const active: ActiveRun = {
      runId: `${id}-${this.dependencies.clock.now()}-${Math.random().toString(36).substring(2, 11)}`,
      runner: null,
      suppressed: false,
    };
    this.activeRuns.set(id, active);
    this.notify();
    const run = this.executeReservedRun(structuredClone(job), trigger, active);
    this.pendingRuns.add(run);
    void run.finally(() => this.pendingRuns.delete(run)).catch(() => undefined);
    return run;
  }

  private async executeReservedRun(
    job: PeriodicJob,
    trigger: PeriodicJobRunTrigger,
    active: ActiveRun,
  ): Promise<RunOutcome> {
    const startedAt = this.dependencies.clock.now();
    try {
      await this.settingsCoordinator.mutateConditionally((settings) => {
        if (!this.isCurrentRun(job.id, active)) return false;
        const current = settings.periodicJobs.find(candidate => candidate.id === job.id);
        if (!current) return false;
        current.lastRun = {
          startedAt,
          status: 'running',
          summary: '',
          trigger,
        };
        return true;
      });
      if (!this.isCurrentRun(job.id, active)) return { status: 'succeeded' };
      this.notify();

      const settings = this.getSettings();
      const providerId = job.model.providerId;
      let model: string | null = null;
      let permissionMode = '';
      try {
        if (!ProviderRegistry.isEnabled(providerId, settings)) {
          return await this.finishFailure(job.id, active, 'Selected provider is not enabled.');
        }
        const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
          settings,
          providerId,
        );
        model = findProviderModelOption(providerId, job.model.model, providerSettings);
        if (!model) {
          return await this.finishFailure(job.id, active, 'Selected model is unavailable.');
        }
        permissionMode = typeof providerSettings.permissionMode === 'string'
          ? providerSettings.permissionMode
          : '';
        if (!permissionMode) {
          return await this.finishFailure(job.id, active, 'Provider permission mode is unavailable.');
        }
      } catch (error) {
        return await this.finishFailure(job.id, active, this.failureMessage(error));
      }

      try {
        await this.dependencies.initializeProvider(providerId);
        if (!this.isCurrentRun(job.id, active)) return { status: 'succeeded' };
        const runner = this.dependencies.createExecutionService(providerId);
        if (!this.isCurrentRun(job.id, active)) {
          await runner.dispose();
          return { status: 'succeeded' };
        }
        active.runner = runner;
        if (!this.isCurrentRun(job.id, active)) return { status: 'succeeded' };
        const text = await runner.execute({
          model,
          permissionMode,
          prompt: job.prompt,
        });
        if (!this.isCurrentRun(job.id, active)) return { status: 'succeeded' };
        const summary = capPeriodicJobSummary(text.trim() || EMPTY_SUCCESS_MESSAGE);
        await this.finishTerminal(job.id, active, 'succeeded', summary);
        return { status: 'succeeded' };
      } catch (error) {
        if (!this.isCurrentRun(job.id, active)) return { status: 'succeeded' };
        return await this.finishFailure(job.id, active, this.failureMessage(error));
      }
    } finally {
      if (active.runner) await active.runner.dispose();
      if (this.activeRuns.get(job.id) === active) {
        this.activeRuns.delete(job.id);
        this.notify();
      }
    }
  }

  private async finishFailure(
    id: string,
    active: ActiveRun,
    message: string,
  ): Promise<RunFailure> {
    const summary = capPeriodicJobSummary(message.trim() || 'Periodic job failed.');
    await this.finishTerminal(id, active, 'failed', summary);
    return { status: 'failed', message: summary };
  }

  private async finishTerminal(
    id: string,
    active: ActiveRun,
    status: 'succeeded' | 'failed',
    summary: string,
  ): Promise<void> {
    if (!this.isCurrentRun(id, active)) return;
    const completedAt = this.dependencies.clock.now();
    let changed = false;
    await this.settingsCoordinator.mutateConditionally((settings) => {
      if (!this.isCurrentRun(id, active)) return false;
      const job = settings.periodicJobs.find(candidate => candidate.id === id);
      if (!job || job.lastRun?.status !== 'running') return false;
      job.lastRun = {
        ...job.lastRun,
        completedAt,
        status,
        summary,
      };
      changed = true;
      return true;
    });
    if (changed && this.isCurrentRun(id, active)) this.notify();
  }

  private isCurrentRun(id: string, active: ActiveRun): boolean {
    return !active.suppressed && this.activeRuns.get(id) === active;
  }

  private invalidateRun(id: string): Promise<void> {
    const active = this.activeRuns.get(id);
    if (!active) return Promise.resolve();
    active.suppressed = true;
    this.activeRuns.delete(id);
    this.notify();
    if (!active.runner) return Promise.resolve();
    active.runner.cancel();
    return active.runner.dispose();
  }

  private failureMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Subscriber failures must not corrupt persisted state or other listeners.
      }
    }
  }
}
