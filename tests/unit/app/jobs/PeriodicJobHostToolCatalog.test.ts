import { PeriodicJobHostToolCatalog } from '@/app/jobs/PeriodicJobHostToolCatalog';
import type { PeriodicJobsHostPort } from '@/core/tools/HostToolCatalog';
import type { PeriodicJob, PeriodicJobDraft } from '@/core/types';

const context = { providerId: 'omp' as const, model: 'omp:openai/gpt-5.6' };

function job(overrides: Partial<PeriodicJob> = {}): PeriodicJob {
  return {
    id: 'job-1',
    enabled: true,
    name: 'Daily summary',
    schedule: '0 9 * * 1-5',
    prompt: 'Summarize the vault',
    model: { providerId: 'omp', model: 'omp:openai/gpt-5.6' },
    lastRun: null,
    ...overrides,
  };
}

function createHarness() {
  const jobs = [job()];
  const port: jest.Mocked<PeriodicJobsHostPort> = {
    list: jest.fn(() => structuredClone(jobs)),
    create: jest.fn(async (draft: PeriodicJobDraft) => job({
      ...draft,
      id: 'job-created',
      name: draft.name.trim(),
      schedule: draft.schedule.trim(),
    })),
    updatePartial: jest.fn(async (id, patch) => job({
      ...patch,
      id,
      name: typeof patch.name === 'string' ? patch.name.trim() : jobs[0].name,
    })),
    delete: jest.fn(async (_id: string) => undefined),
    isRunning: jest.fn(id => id === 'job-1'),
  };
  return { catalog: new PeriodicJobHostToolCatalog(port), port };
}

describe('PeriodicJobHostToolCatalog', () => {
  it('lists cloned jobs with transient running state', async () => {
    const { catalog, port } = createHarness();

    const result = await catalog.invoke('claudian.periodic_job.list', {}, context);

    expect(result).toEqual({ ok: true, value: { jobs: [{ ...job(), running: true }] } });
    const value = result.ok ? result.value as { jobs: PeriodicJob[] } : null;
    value!.jobs[0].name = 'mutated';
    expect(port.list()).toEqual([job()]);
  });

  it('creates with active model defaults and enabled true', async () => {
    const { catalog, port } = createHarness();

    const result = await catalog.invoke('claudian.periodic_job.create', {
      name: ' New job ',
      schedule: ' 0 10 * * * ',
      prompt: 'Run it',
    }, context);

    expect(port.create).toHaveBeenCalledWith({
      enabled: true,
      name: ' New job ',
      schedule: ' 0 10 * * * ',
      prompt: 'Run it',
      model: { providerId: 'omp', model: 'omp:openai/gpt-5.6' },
    });
    expect(result).toEqual({
      ok: true,
      value: { job: expect.objectContaining({ id: 'job-created', name: 'New job' }) },
    });
  });

  it('forwards explicit cross-provider model selection', async () => {
    const { catalog, port } = createHarness();

    await catalog.invoke('claudian.periodic_job.create', {
      name: 'Claude job',
      schedule: '0 10 * * *',
      prompt: 'Run it',
      model: { providerId: 'claude', model: 'sonnet' },
    }, context);

    expect(port.create).toHaveBeenCalledWith(expect.objectContaining({
      model: { providerId: 'claude', model: 'sonnet' },
    }));
  });

  it('passes only supplied update fields to the atomic application operation', async () => {
    const { catalog, port } = createHarness();

    const result = await catalog.invoke('claudian.periodic_job.update', {
      id: 'job-1',
      enabled: false,
      name: ' Updated ',
    }, context);

    expect(port.updatePartial).toHaveBeenCalledWith('job-1', {
      enabled: false,
      name: ' Updated ',
    });
    expect(result).toEqual({
      ok: true,
      value: { job: expect.objectContaining({ id: 'job-1', enabled: false, name: 'Updated' }) },
    });
  });

  it('rejects ID-only updates and malformed input before delegation', async () => {
    const { catalog, port } = createHarness();

    await expect(catalog.invoke('claudian.periodic_job.update', { id: 'job-1' }, context))
      .resolves.toEqual(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'invalid_input' }) }));
    await expect(catalog.invoke('claudian.periodic_job.create', {
      name: 'job', schedule: '0 10 * * *', prompt: 'run', extra: true,
    }, context)).resolves.toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'invalid_input' }),
    }));
    expect(port.updatePartial).not.toHaveBeenCalled();
    expect(port.create).not.toHaveBeenCalled();
  });

  it('deletes by exact ID', async () => {
    const { catalog, port } = createHarness();

    const result = await catalog.invoke('claudian.periodic_job.delete', { id: 'job-1' }, context);

    expect(port.delete).toHaveBeenCalledWith('job-1');
    expect(result).toEqual({ ok: true, value: { deleted: true, id: 'job-1' } });
  });

  it.each([
    ['Periodic job not found.', 'not_found'],
    ['Selected provider is unavailable.', 'provider_unavailable'],
    ['Selected provider is not enabled.', 'provider_disabled'],
    ['Selected model is unavailable.', 'model_unavailable'],
    ['Schedule must use a valid five-field cron pattern.', 'invalid_schedule'],
  ])('maps %s to %s', async (message, code) => {
    const { catalog, port } = createHarness();
    port.delete.mockRejectedValueOnce(new Error(message));

    await expect(catalog.invoke('claudian.periodic_job.delete', { id: 'job-1' }, context))
      .resolves.toEqual({ ok: false, error: { code, message } });
  });

  it('hides unexpected failure details', async () => {
    const { catalog, port } = createHarness();
    const error = new Error('secret database payload');
    error.stack = 'credential stack';
    port.delete.mockRejectedValueOnce(error);

    await expect(catalog.invoke('claudian.periodic_job.delete', { id: 'job-1' }, context))
      .resolves.toEqual({
        ok: false,
        error: { code: 'internal_error', message: 'Periodic job operation failed.' },
      });
  });
});
