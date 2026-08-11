import type { JobExecutionService } from '../../core/auxiliary/JobExecutionService';
import { findProviderModelOption } from '../../core/providers/conversationModel';
import { ProviderRegistry } from '../../core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '../../core/providers/ProviderSettingsCoordinator';
import type { ProviderId } from '../../core/providers/types';
import { capPeriodicJobSummary } from '../../core/scheduling/PeriodicJobSummary';
import type {
  ClaudianSettings,
  OneOffJob,
  OneOffJobDraft,
} from '../../core/types';
import type { SettingsCoordinator } from '../settings/SettingsCoordinator';

export interface OneOffJobsDependencies {
  clock: { now(): number };
  initializeProvider(providerId: ProviderId): Promise<void>;
  createExecutionService(providerId: ProviderId): JobExecutionService;
}

interface ActiveRun {
  runner: JobExecutionService | null;
  suppressed: boolean;
}

const JOB_NOT_FOUND_MESSAGE = 'One-off job not found.';
const CLOSED_DURING_RUN_MESSAGE = 'Obsidian closed before the job completed.';
const EMPTY_SUCCESS_MESSAGE = 'Completed without a text response.';

export class OneOffJobsService {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly listeners = new Set<() => void>();
  private readonly pendingRuns = new Set<Promise<void>>();
  private stopPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly settingsCoordinator: SettingsCoordinator<ClaudianSettings>,
    private readonly getSettings: () => ClaudianSettings,
    private readonly dependencies: OneOffJobsDependencies,
  ) {}

  list(): readonly OneOffJob[] {
    return structuredClone(this.getSettings().oneOffJobs);
  }

  async start(draft: OneOffJobDraft): Promise<OneOffJob> {
    if (this.stopped) throw new Error('One-off jobs are unavailable during shutdown.');

    let committed: OneOffJob | null = null;
    let active: ActiveRun | null = null;
    await this.settingsCoordinator.mutate((settings) => {
      const normalized = this.normalizeDraft(draft, settings);
      let id: string;
      do {
        id = `one-off-job-${this.dependencies.clock.now()}-${Math.random().toString(36).substring(2, 11)}`;
      } while (settings.oneOffJobs.some(job => job.id === id));

      committed = {
        id,
        ...normalized,
        startedAt: this.dependencies.clock.now(),
        status: 'running',
        summary: '',
      };
      settings.oneOffJobs = [...settings.oneOffJobs, committed];
    }, () => {
      if (!committed) return;
      active = { runner: null, suppressed: false };
      this.activeRuns.set(committed.id, active);
      this.notify();
    });

    if (!committed || !active) throw new Error('One-off job was not started.');
    const run = this.execute(structuredClone(committed), active);
    this.pendingRuns.add(run);
    void run.finally(() => this.pendingRuns.delete(run)).catch(() => undefined);
    return structuredClone(committed);
  }

  async delete(id: string): Promise<void> {
    if (!this.getSettings().oneOffJobs.some(job => job.id === id)) {
      throw new Error(JOB_NOT_FOUND_MESSAGE);
    }
    await this.invalidateRun(id);
    await this.settingsCoordinator.mutate((settings) => {
      const index = settings.oneOffJobs.findIndex(job => job.id === id);
      if (index < 0) throw new Error(JOB_NOT_FOUND_MESSAGE);
      settings.oneOffJobs = settings.oneOffJobs.filter(job => job.id !== id);
    }, () => this.notify());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async reconcileInterruptedRuns(): Promise<void> {
    const completedAt = this.dependencies.clock.now();
    let changed = false;
    await this.settingsCoordinator.mutateConditionally((settings) => {
      const jobs = settings.oneOffJobs.map((job) => {
        if (job.status !== 'running') return job;
        changed = true;
        return {
          ...job,
          completedAt,
          status: 'interrupted' as const,
          summary: CLOSED_DURING_RUN_MESSAGE,
        };
      });
      if (!changed) return false;
      settings.oneOffJobs = jobs;
      return true;
    });
    if (changed) this.notify();
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    const disposals: Promise<void>[] = [];
    const hadActiveRuns = this.activeRuns.size > 0;
    for (const [id, active] of this.activeRuns) {
      active.suppressed = true;
      this.activeRuns.delete(id);
      if (!active.runner) continue;
      active.runner.cancel();
      disposals.push(active.runner.dispose());
    }
    if (hadActiveRuns) this.notify();
    this.stopPromise = this.awaitStopSettlements(disposals);
    return this.stopPromise;
  }

  private async awaitStopSettlements(disposals: Promise<void>[]): Promise<void> {
    const settlements = await Promise.allSettled([...disposals, ...this.pendingRuns]);
    const failure = settlements.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) throw failure.reason;
  }

  private normalizeDraft(draft: OneOffJobDraft, settings: ClaudianSettings): OneOffJobDraft {
    const name = draft.name.trim();
    const prompt = draft.prompt.trim();
    const providerId = draft.model.providerId.trim();
    const requestedModel = draft.model.model.trim();
    if (!name) throw new Error('One-off job name is required.');
    if (!prompt) throw new Error('One-off job prompt is required.');
    if (!ProviderRegistry.getRegisteredProviderIds().includes(providerId)) {
      throw new Error('Selected provider is unavailable.');
    }
    if (!ProviderRegistry.isEnabled(providerId, settings)) {
      throw new Error('Selected provider is not enabled.');
    }
    const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      settings,
      providerId,
    );
    const model = findProviderModelOption(providerId, requestedModel, providerSettings);
    if (!model) throw new Error('Selected model is unavailable.');
    return { name, prompt, model: { providerId, model } };
  }

  private async execute(job: OneOffJob, active: ActiveRun): Promise<void> {
    try {
      const settings = this.getSettings();
      const providerId = job.model.providerId;
      if (!ProviderRegistry.isEnabled(providerId, settings)) {
        await this.finish(job.id, active, 'failed', 'Selected provider is not enabled.');
        return;
      }
      const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
        settings,
        providerId,
      );
      const model = findProviderModelOption(providerId, job.model.model, providerSettings);
      if (!model) {
        await this.finish(job.id, active, 'failed', 'Selected model is unavailable.');
        return;
      }
      const permissionMode = typeof providerSettings.permissionMode === 'string'
        ? providerSettings.permissionMode
        : '';
      if (!permissionMode) {
        await this.finish(job.id, active, 'failed', 'Provider permission mode is unavailable.');
        return;
      }

      await this.dependencies.initializeProvider(providerId);
      if (!this.isCurrentRun(job.id, active)) return;
      const runner = this.dependencies.createExecutionService(providerId);
      if (!this.isCurrentRun(job.id, active)) {
        await runner.dispose();
        return;
      }
      active.runner = runner;
      const text = await runner.execute({ model, permissionMode, prompt: job.prompt });
      if (!this.isCurrentRun(job.id, active)) return;
      await this.finish(
        job.id,
        active,
        'succeeded',
        text.trim() || EMPTY_SUCCESS_MESSAGE,
      );
    } catch (error) {
      if (this.isCurrentRun(job.id, active)) {
        await this.finish(job.id, active, 'failed', this.failureMessage(error));
      }
    } finally {
      if (active.runner) await active.runner.dispose();
      if (this.activeRuns.get(job.id) === active) {
        this.activeRuns.delete(job.id);
        this.notify();
      }
    }
  }

  private async finish(
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
      const job = settings.oneOffJobs.find(candidate => candidate.id === id);
      if (!job || job.status !== 'running') return false;
      job.completedAt = completedAt;
      job.status = status;
      job.summary = capPeriodicJobSummary(summary.trim() || 'One-off job failed.');
      changed = true;
      return true;
    });
    if (changed && this.isCurrentRun(id, active)) this.notify();
  }

  private isCurrentRun(id: string, active: ActiveRun): boolean {
    return !active.suppressed && this.activeRuns.get(id) === active;
  }

  private async invalidateRun(id: string): Promise<void> {
    const active = this.activeRuns.get(id);
    if (!active) return;
    active.suppressed = true;
    this.activeRuns.delete(id);
    this.notify();
    if (!active.runner) return;
    active.runner.cancel();
    await active.runner.dispose();
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
