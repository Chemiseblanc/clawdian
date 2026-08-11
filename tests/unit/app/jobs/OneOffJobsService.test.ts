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

  it('retries an interrupted job in place with a fresh execution', async () => {
    const interrupted = storedJob({
      completedAt: 300,
      status: 'interrupted',
      summary: 'Obsidian closed before the job completed.',
    });
    const harness = createHarness({ jobs: [interrupted] });
    harness.setNow(400);

    await expect(harness.service.retry(interrupted.id)).resolves.toEqual({
      ...interrupted,
      startedAt: 400,
      completedAt: undefined,
      status: 'running',
      summary: '',
    });

    await waitFor(() => harness.settings.oneOffJobs[0].status === 'succeeded');
    expect(harness.initializeProvider).toHaveBeenCalledWith('claude');
    expect(harness.runner.execute).toHaveBeenCalledWith({
      model: 'sonnet',
      permissionMode: 'yolo',
      prompt: 'Research the vault',
    });
    expect(harness.settings.oneOffJobs).toEqual([{
      ...interrupted,
      startedAt: 400,
      completedAt: 400,
      status: 'succeeded',
      summary: 'completed',
    }]);
  });

  it('rejects retrying a one-off job that was not interrupted', async () => {
    const harness = createHarness({ jobs: [storedJob({ status: 'failed' })] });

    await expect(harness.service.retry('one-off-job-1'))
      .rejects.toThrow('Only interrupted one-off jobs can be retried.');
    expect(harness.createExecutionService).not.toHaveBeenCalled();
  });

  it('interrupts a running job without deleting its durable record', async () => {
    const completion = promiseConstructor.withResolvers<string>();
    const runner = new FakeRunner();
    runner.execute.mockReturnValueOnce(completion.promise);
    const harness = createHarness({ runner });
    const job = await harness.service.start({
      name: 'Interrupt me',
      prompt: 'Wait',
      model: { providerId: 'claude', model: 'sonnet' },
    });
    await waitFor(() => runner.execute.mock.calls.length === 1);
    harness.setNow(250);

    await harness.service.interrupt(job.id);

    expect(runner.cancel).toHaveBeenCalled();
    expect(runner.dispose).toHaveBeenCalled();
    expect(harness.settings.oneOffJobs).toEqual([{
      ...job,
      completedAt: 250,
      status: 'interrupted',
      summary: 'Interrupted by user.',
    }]);

    completion.resolve('late success');
    await waitFor(() => runner.dispose.mock.calls.length > 1);
    expect(harness.settings.oneOffJobs[0].status).toBe('interrupted');
  });

  it('rejects interrupting a one-off job that is no longer running', async () => {
    const harness = createHarness({ jobs: [storedJob({ status: 'succeeded' })] });

    await expect(harness.service.interrupt('one-off-job-1'))
      .rejects.toThrow('Only running one-off jobs can be interrupted.');
    expect(harness.runner.cancel).not.toHaveBeenCalled();
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
