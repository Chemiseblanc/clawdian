import '@/providers';

import { OneOffJobsService } from '@/app/jobs/OneOffJobsService';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import type { JobExecutionService } from '@/core/auxiliary/JobExecutionService';
import type { OneOffJob } from '@/core/types';

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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    const nextTurn = promiseConstructor.withResolvers<void>();
    setImmediate(nextTurn.resolve);
    await nextTurn.promise;
  }
  throw new Error('Timed out waiting for one-off job condition.');
}

function storedJob(overrides: Partial<OneOffJob> = {}): OneOffJob {
  return {
    id: 'one-off-job-1',
    name: 'Research task',
    prompt: 'Research the vault',
    model: { providerId: 'claude', model: 'sonnet' },
    startedAt: 100,
    status: 'running',
    summary: '',
    ...overrides,
  };
}

function createHarness(options: {
  jobs?: OneOffJob[];
  runner?: FakeRunner;
  initializeProvider?: () => Promise<void>;
} = {}) {
  let now = 100;
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  settings.oneOffJobs = structuredClone(options.jobs ?? []);
  const persist = jest.fn(async () => undefined);
  const runner = options.runner ?? new FakeRunner();
  const initializeProvider = jest.fn(options.initializeProvider ?? (async () => undefined));
  const createExecutionService = jest.fn(() => runner as unknown as JobExecutionService);
  const coordinator = new SettingsCoordinator(settings, persist);
  const service = new OneOffJobsService(
    coordinator,
    () => settings,
    {
      clock: { now: () => now },
      initializeProvider,
      createExecutionService,
    },
  );
  return {
    createExecutionService,
    initializeProvider,
    persist,
    runner,
    service,
    settings,
    setNow: (value: number) => { now = value; },
  };
}

describe('OneOffJobsService', () => {
  it('persists a running job and returns before its independent execution finishes', async () => {
    const completion = promiseConstructor.withResolvers<string>();
    const runner = new FakeRunner();
    runner.execute.mockReturnValueOnce(completion.promise);
    const harness = createHarness({ runner });

    const created = await harness.service.start({
      name: ' Research task ',
      prompt: ' Research the vault ',
      model: { providerId: 'claude', model: 'sonnet' },
    });

    expect(created).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^one-off-job-100-/),
      name: 'Research task',
      prompt: 'Research the vault',
      startedAt: 100,
      status: 'running',
      summary: '',
    }));
    expect(harness.settings.oneOffJobs).toEqual([created]);
    await waitFor(() => runner.execute.mock.calls.length === 1);
    expect(harness.persist).toHaveBeenCalledTimes(1);

    harness.setNow(200);
    completion.resolve(' Finished research ');
    await waitFor(() => harness.settings.oneOffJobs[0].status === 'succeeded');
    expect(harness.settings.oneOffJobs[0]).toMatchObject({
      completedAt: 200,
      status: 'succeeded',
      summary: 'Finished research',
    });
    expect(runner.dispose).toHaveBeenCalled();
  });

  it('records execution failures without rejecting the already-started operation', async () => {
    const runner = new FakeRunner();
    runner.execute.mockRejectedValueOnce(new Error('provider failed'));
    const harness = createHarness({ runner });

    await expect(harness.service.start({
      name: 'Failure',
      prompt: 'Fail',
      model: { providerId: 'claude', model: 'sonnet' },
    })).resolves.toEqual(expect.objectContaining({ status: 'running' }));

    await waitFor(() => harness.settings.oneOffJobs[0].status === 'failed');
    expect(harness.settings.oneOffJobs[0].summary).toBe('provider failed');
  });

  it('reconciles persisted running jobs as interrupted without restarting them', async () => {
    const harness = createHarness({ jobs: [storedJob()] });
    harness.setNow(300);

    await harness.service.reconcileInterruptedRuns();

    expect(harness.settings.oneOffJobs[0]).toEqual({
      ...storedJob(),
      completedAt: 300,
      status: 'interrupted',
      summary: 'Obsidian closed before the job completed.',
    });
    expect(harness.createExecutionService).not.toHaveBeenCalled();
  });

  it('cancels a running job before deleting its durable record', async () => {
    const completion = promiseConstructor.withResolvers<string>();
    const runner = new FakeRunner();
    runner.execute.mockReturnValueOnce(completion.promise);
    const harness = createHarness({ runner });
    const job = await harness.service.start({
      name: 'Delete me',
      prompt: 'Wait',
      model: { providerId: 'claude', model: 'sonnet' },
    });
    await waitFor(() => runner.execute.mock.calls.length === 1);

    await harness.service.delete(job.id);

    expect(runner.cancel).toHaveBeenCalled();
    expect(runner.dispose).toHaveBeenCalled();
    expect(harness.settings.oneOffJobs).toEqual([]);
    completion.resolve('late');
  });
});
