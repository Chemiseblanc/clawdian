import '@/providers';

import { PeriodicJobsService } from '@/app/jobs/PeriodicJobsService';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import type { JobExecutionService } from '@/core/auxiliary/JobExecutionService';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { PeriodicJob, PeriodicJobDraft } from '@/core/types';

interface ScheduleRecord {
  callback: () => Promise<void>;
  onError: (error: unknown) => void;
  pattern: string;
  stop: jest.Mock<void, []>;
}

interface PromiseResolvers<T> {
  promise: Promise<T>;
  reject(reason?: unknown): void;
  resolve(value: T | PromiseLike<T>): void;
}

const promiseConstructor = Promise as PromiseConstructor & {
  withResolvers<T>(): PromiseResolvers<T>;
};

class FakeRunner {
  readonly cancel = jest.fn<void, []>();
  readonly dispose = jest.fn(async () => undefined);
  readonly execute = jest.fn(async () => 'completed');
}

function deferred<T>() {
  return promiseConstructor.withResolvers<T>();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    const nextTurn = promiseConstructor.withResolvers<void>();
    setImmediate(nextTurn.resolve);
    await nextTurn.promise;
  }
  throw new Error('Timed out waiting for periodic job condition.');
}

const draft: PeriodicJobDraft = {
  enabled: true,
  name: 'Daily summary',
  schedule: '0 9 * * 1-5',
  prompt: 'Summarize the vault',
  model: { providerId: 'claude', model: 'sonnet' },
};

function storedJob(overrides: Partial<PeriodicJob> = {}): PeriodicJob {
  return {
    id: 'job-1',
    enabled: true,
    name: 'Daily summary',
    schedule: '0 9 * * 1-5',
    prompt: 'Summarize the vault',
    model: { providerId: 'claude', model: 'sonnet' },
    lastRun: null,
    ...overrides,
  };
}

function createHarness(options: {
  jobs?: PeriodicJob[];
  persist?: (settings: typeof DEFAULT_CLAUDIAN_SETTINGS) => Promise<void>;
  initializeProvider?: () => Promise<void>;
  runner?: FakeRunner;
  findPreviousScheduledRun?: (pattern: string, before: number) => number | null;
} = {}) {
  let now = 100;
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  settings.periodicJobs = structuredClone(options.jobs ?? []);
  const persist = jest.fn(options.persist ?? (async () => undefined));
  const schedules: ScheduleRecord[] = [];
  const runner = options.runner ?? new FakeRunner();
  const initializeProvider = jest.fn(options.initializeProvider ?? (async () => undefined));
  const findPreviousScheduledRun = jest.fn(
    options.findPreviousScheduledRun ?? (() => null),
  );
  const createExecutionService = jest.fn(() => (
    runner as unknown as JobExecutionService
  ));
  const coordinator = new SettingsCoordinator(settings, persist);
  const service = new PeriodicJobsService(
    coordinator,
    () => settings,
    {} as unknown as ProviderHost,
    {
      clock: { now: () => now },
      createSchedule: (pattern, callback, onError) => {
        const record = { callback, onError, pattern, stop: jest.fn<void, []>() };
        schedules.push(record);
        return record;
      },
      findPreviousScheduledRun,
      initializeProvider,
      createExecutionService,
    },
  );
  return {
    findPreviousScheduledRun,
    createExecutionService,
    initializeProvider,
    persist,
    runner,
    schedules,
    service,
    settings,
    setNow: (value: number) => { now = value; },
  };
}

describe('PeriodicJobsService', () => {
  it('creates normalized jobs through rollback-safe settings persistence', async () => {
    const harness = createHarness();

    const created = await harness.service.create({
      ...draft,
      name: '  Daily summary  ',
      prompt: '  Summarize the vault  ',
      schedule: ' 0   9 * * 1-5 ',
      model: { providerId: ' claude ', model: ' sonnet ' },
    });

    expect(created).toMatchObject({
      enabled: true,
      name: 'Daily summary',
      prompt: 'Summarize the vault',
      schedule: '0 9 * * 1-5',
      model: { providerId: 'claude', model: 'sonnet' },
      lastRun: null,
    });
    expect(created.id).toMatch(/^job-100-/);
    expect(harness.settings.periodicJobs).toEqual([created]);
    expect(harness.persist).toHaveBeenCalledTimes(1);
  });

  it('rolls back a failed create and does not notify or schedule', async () => {
    const listener = jest.fn();
    const harness = createHarness({
      persist: async () => { throw new Error('disk failed'); },
    });
    harness.service.subscribe(listener);
    harness.service.start();

    await expect(harness.service.create(draft)).rejects.toThrow('disk failed');

    expect(harness.settings.periodicJobs).toEqual([]);
    expect(harness.schedules).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('updates fields while preserving id and last-run metadata', async () => {
    const lastRun = {
      startedAt: 1,
      completedAt: 2,
      status: 'succeeded' as const,
      summary: 'old',
      trigger: 'manual' as const,
    };
    const harness = createHarness({ jobs: [storedJob({ lastRun })] });

    const updated = await harness.service.update('job-1', {
      ...draft,
      enabled: false,
      name: 'Updated',
    });

    expect(updated).toMatchObject({ id: 'job-1', enabled: false, name: 'Updated', lastRun });
    await expect(harness.service.update('missing', draft)).rejects.toThrow(
      'Periodic job not found.',
    );
  });

  it('merges partial updates atomically and preserves omitted fields and last-run metadata', async () => {
    const lastRun = {
      startedAt: 1,
      completedAt: 2,
      status: 'succeeded' as const,
      summary: 'old',
      trigger: 'manual' as const,
    };
    const harness = createHarness({ jobs: [storedJob({ lastRun })] });

    const updated = await harness.service.updatePartial('job-1', {
      enabled: false,
      name: ' Updated ',
    });

    expect(updated).toEqual({
      ...storedJob({ lastRun }),
      enabled: false,
      name: 'Updated',
    });
  });

  it('merges concurrent partial updates from the latest serialized state', async () => {
    const firstPersist = deferred<void>();
    let persistCount = 0;
    const harness = createHarness({
      jobs: [storedJob()],
      persist: async () => {
        persistCount += 1;
        if (persistCount === 1) await firstPersist.promise;
      },
    });

    const first = harness.service.updatePartial('job-1', { name: 'Renamed' });
    await waitFor(() => persistCount === 1);
    const second = harness.service.updatePartial('job-1', { prompt: 'New prompt' });
    firstPersist.resolve();
    await Promise.all([first, second]);

    expect(harness.settings.periodicJobs[0]).toEqual({
      ...storedJob(),
      name: 'Renamed',
      prompt: 'New prompt',
    });
  });

  it('schedules only enabled jobs from the next future Cron registration', () => {
    const harness = createHarness({
      jobs: [storedJob(), storedJob({ id: 'disabled', enabled: false })],
    });

    harness.service.start();
    harness.service.start();

    expect(harness.schedules).toHaveLength(1);
    expect(harness.schedules[0].pattern).toBe('0 9 * * 1-5');
  });

  it('runs one missed occurrence when an enabled job starts after its latest schedule', async () => {
    const harness = createHarness({
      jobs: [storedJob({
        lastRun: {
          startedAt: 50,
          completedAt: 60,
          status: 'succeeded',
          summary: 'previous',
          trigger: 'scheduled',
        },
      })],
      findPreviousScheduledRun: () => 90,
    });

    harness.service.start();
    await waitFor(() => harness.runner.execute.mock.calls.length === 1);

    expect(harness.findPreviousScheduledRun).toHaveBeenCalledWith('0 9 * * 1-5', 100);
    expect(harness.runner.execute).toHaveBeenCalledTimes(1);
    expect(harness.settings.periodicJobs[0].lastRun).toMatchObject({
      startedAt: 100,
      status: 'succeeded',
      trigger: 'scheduled',
    });
  });

  it('does not catch up handled or disabled jobs', () => {
    const harness = createHarness({
      jobs: [
        storedJob({
          lastRun: {
            startedAt: 95,
            completedAt: 96,
            status: 'succeeded',
            summary: 'latest',
            trigger: 'scheduled',
          },
        }),
        storedJob({ id: 'disabled', enabled: false }),
      ],
      findPreviousScheduledRun: () => 90,
    });

    harness.service.start();

    expect(harness.runner.execute).not.toHaveBeenCalled();
    expect(harness.findPreviousScheduledRun).toHaveBeenCalledTimes(1);
    expect(harness.schedules).toHaveLength(1);
  });

  it('recreates only the affected schedule after update and enable changes', async () => {
    const harness = createHarness({ jobs: [storedJob()] });
    harness.service.start();
    const original = harness.schedules[0];

    await harness.service.update('job-1', { ...draft, schedule: '30 10 * * *' });

    expect(original.stop).toHaveBeenCalledTimes(1);
    expect(harness.schedules.at(-1)?.pattern).toBe('30 10 * * *');
    const updatedSchedule = harness.schedules.at(-1);
    await harness.service.setEnabled('job-1', false);
    expect(updatedSchedule?.stop).toHaveBeenCalledTimes(1);
    await harness.service.setEnabled('job-1', true);
    expect(harness.schedules.at(-1)?.pattern).toBe('30 10 * * *');
  });

  it('runs disabled jobs manually with the exact selected model and permission mode', async () => {
    const harness = createHarness({ jobs: [storedJob({ enabled: false })] });

    await harness.service.runNow('job-1');

    expect(harness.runner.execute).toHaveBeenCalledWith({
      model: 'sonnet',
      permissionMode: 'yolo',
      prompt: 'Summarize the vault',
    });
    expect(harness.settings.periodicJobs[0].lastRun).toMatchObject({
      startedAt: 100,
      completedAt: 100,
      status: 'succeeded',
      summary: 'completed',
      trigger: 'manual',
    });
  });

  it('reserves runs before persistence so manual overlap rejects and scheduled overlap skips', async () => {
    const persistence = deferred<void>();
    const harness = createHarness({
      jobs: [storedJob()],
      persist: () => persistence.promise,
    });

    const first = harness.service.runNow('job-1');
    await expect(harness.service.runNow('job-1')).rejects.toThrow(
      'Periodic job is already running.',
    );
    harness.service.start();
    await expect(harness.schedules[0].callback()).resolves.toBeUndefined();
    persistence.resolve();
    await first;
    expect(harness.runner.execute).toHaveBeenCalledTimes(1);
  });

  it('persists one failed terminal state and rejects manual execution for stale models', async () => {
    const harness = createHarness({
      jobs: [storedJob({ model: { providerId: 'claude', model: 'removed-model' } })],
    });

    await expect(harness.service.runNow('job-1')).rejects.toThrow(
      'Selected model is unavailable.',
    );

    expect(harness.createExecutionService).not.toHaveBeenCalled();
    expect(harness.persist).toHaveBeenCalledTimes(2);
    expect(harness.settings.periodicJobs[0].lastRun).toMatchObject({
      status: 'failed',
      summary: 'Selected model is unavailable.',
    });
  });

  it('caps success and failure summaries and fills empty success text', async () => {
    const successRunner = new FakeRunner();
    successRunner.execute.mockResolvedValue('x'.repeat(2_001));
    const success = createHarness({ jobs: [storedJob()], runner: successRunner });
    await success.service.runNow('job-1');
    expect(success.settings.periodicJobs[0].lastRun?.summary).toHaveLength(2_000);
    expect(success.settings.periodicJobs[0].lastRun?.summary.endsWith('…')).toBe(true);

    const emptyRunner = new FakeRunner();
    emptyRunner.execute.mockResolvedValue('   ');
    const empty = createHarness({ jobs: [storedJob()], runner: emptyRunner });
    await empty.service.runNow('job-1');
    expect(empty.settings.periodicJobs[0].lastRun?.summary)
      .toBe('Completed without a text response.');

    const failedRunner = new FakeRunner();
    failedRunner.execute.mockRejectedValue(new Error('y'.repeat(2_001)));
    const failed = createHarness({ jobs: [storedJob()], runner: failedRunner });
    await expect(failed.service.runNow('job-1')).rejects.toThrow();
    expect(failed.settings.periodicJobs[0].lastRun?.summary).toHaveLength(2_000);
  });

  it('reconciles stale running records atomically without scheduling catch-up work', async () => {
    const harness = createHarness({
      jobs: [storedJob({
        lastRun: {
          startedAt: 50,
          status: 'running',
          summary: '',
          trigger: 'scheduled',
        },
      })],
    });
    harness.setNow(200);

    await harness.service.reconcileInterruptedRuns();

    expect(harness.settings.periodicJobs[0].lastRun).toEqual({
      startedAt: 50,
      completedAt: 200,
      status: 'interrupted',
      summary: 'Obsidian closed before the job completed.',
      trigger: 'scheduled',
    });
    expect(harness.runner.execute).not.toHaveBeenCalled();
  });

  it('isolates subscriber failures and notifies after durable and running changes', async () => {
    const harness = createHarness({ jobs: [storedJob()] });
    const first = jest.fn(() => { throw new Error('listener failed'); });
    const second = jest.fn();
    harness.service.subscribe(first);
    const unsubscribe = harness.service.subscribe(second);

    await harness.service.runNow('job-1');

    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
    unsubscribe();
    const calls = second.mock.calls.length;
    await harness.service.setEnabled('job-1', false);
    expect(second).toHaveBeenCalledTimes(calls);
  });

  it('invalidates a run before deleting so late execution cannot write', async () => {
    const execution = deferred<string>();
    const runner = new FakeRunner();
    runner.execute.mockReturnValue(execution.promise);
    const harness = createHarness({ jobs: [storedJob()], runner });
    const run = harness.service.runNow('job-1');
    await waitFor(() => runner.execute.mock.calls.length === 1);

    await harness.service.delete('job-1');
    execution.resolve('late');
    await run;

    expect(runner.cancel).toHaveBeenCalled();
    expect(harness.settings.periodicJobs).toEqual([]);
  });

  it('suppresses a run during provider initialization before a runner can launch', async () => {
    const initialization = deferred<void>();
    const harness = createHarness({
      jobs: [storedJob()],
      initializeProvider: () => initialization.promise,
    });
    const run = harness.service.runNow('job-1');
    await waitFor(() => harness.initializeProvider.mock.calls.length === 1);

    const stop = harness.service.stop();
    expect(harness.service.isRunning('job-1')).toBe(false);
    initialization.resolve();
    await stop;
    await run;

    expect(harness.createExecutionService).not.toHaveBeenCalled();
    expect(harness.settings.periodicJobs[0].lastRun?.status).toBe('running');
  });

  it('suppresses terminal writes synchronously on stop and awaits runner cleanup', async () => {
    const execution = deferred<string>();
    const runner = new FakeRunner();
    runner.execute.mockReturnValue(execution.promise);
    const harness = createHarness({ jobs: [storedJob()], runner });
    harness.service.start();
    const run = harness.service.runNow('job-1');
    await waitFor(() => runner.execute.mock.calls.length === 1);

    const stop = harness.service.stop();
    execution.resolve('late');
    await stop;
    await run;

    expect(harness.schedules[0].stop).toHaveBeenCalled();
    expect(runner.cancel).toHaveBeenCalled();
    expect(runner.dispose).toHaveBeenCalled();
    expect(harness.settings.periodicJobs[0].lastRun?.status).toBe('running');
  });
});
