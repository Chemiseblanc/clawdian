/** @jest-environment jsdom */

const mockConfirmDelete = jest.fn(async (_app: unknown, _message: string) => true);

jest.mock('@/shared/modals/ConfirmModal', () => ({
  confirmDelete: (app: unknown, message: string) => mockConfirmDelete(app, message),
}));

import type { OneOffJob } from '@/core/types';
import type { OneOffJobsPort } from '@/features/FeatureHost';
import { OneOffJobSettings } from '@/features/settings/ui/OneOffJobSettings';

function job(overrides: Partial<OneOffJob> = {}): OneOffJob {
  return {
    id: 'one-off-job-1',
    name: 'Background research',
    prompt: 'Research the linked notes',
    model: { providerId: 'omp', model: 'omp:openai/gpt-5.6' },
    startedAt: new Date('2026-08-10T12:00:00Z').getTime(),
    completedAt: new Date('2026-08-10T12:01:00Z').getTime(),
    status: 'succeeded',
    summary: 'Research complete',
    ...overrides,
  };
}

function createRenderer(initialJobs: OneOffJob[] = []) {
  let jobs = JSON.parse(JSON.stringify(initialJobs)) as OneOffJob[];
  const listeners = new Set<() => void>();
  const port: OneOffJobsPort = {
    list: jest.fn(() => JSON.parse(JSON.stringify(jobs)) as OneOffJob[]),
    interrupt: jest.fn(async (id: string) => {
      jobs = jobs.map(candidate => candidate.id === id
        ? {
            ...candidate,
            completedAt: Date.now(),
            status: 'interrupted',
            summary: 'Interrupted by user.',
          }
        : candidate);
      for (const listener of listeners) listener();
    }),
    retry: jest.fn(async (id: string) => {
      jobs = jobs.map(candidate => candidate.id === id
        ? {
            ...candidate,
            startedAt: Date.now(),
            completedAt: undefined,
            status: 'running',
            summary: '',
          }
        : candidate);
      for (const listener of listeners) listener();
      return JSON.parse(JSON.stringify(
        jobs.find(candidate => candidate.id === id),
      )) as OneOffJob;
    }),
    delete: jest.fn(async (id: string) => {
      jobs = jobs.filter(candidate => candidate.id !== id);
      for (const listener of listeners) listener();
    }),
    subscribe: jest.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const renderer = new OneOffJobSettings(container, {
    app: {},
    oneOffJobs: port,
  } as unknown as ConstructorParameters<typeof OneOffJobSettings>[1]);
  return { container, port, renderer, subscriberCount: () => listeners.size };
}

async function flushActions(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

beforeAll(() => {
  if (!Reflect.has(HTMLElement.prototype, 'empty')) {
    HTMLElement.prototype.empty = function empty(): void {
      this.replaceChildren();
    };
  }
});

beforeEach(() => {
  document.body.empty();
  jest.clearAllMocks();
  mockConfirmDelete.mockResolvedValue(true);
});

describe('OneOffJobSettings', () => {
  it('renders below-page monitoring states for running and completed jobs', () => {
    const empty = createRenderer();
    expect(empty.container.textContent).toContain('One-off jobs');
    expect(empty.container.textContent).toContain('No one-off jobs have been started.');
    empty.renderer.dispose();

    const populated = createRenderer([
      job({ status: 'running', completedAt: undefined, summary: '' }),
      job({ id: 'one-off-job-2', name: 'Finished job' }),
    ]);
    expect(populated.container.textContent).toContain('Background research');
    expect(populated.container.textContent).toContain('Running');
    expect(populated.container.textContent).toContain('Finished job');
    expect(populated.container.textContent).toContain('Research complete');
  });

  it('offers retry only for interrupted jobs', async () => {
    const { container, port } = createRenderer([
      job({
        status: 'interrupted',
        summary: 'Obsidian closed before the job completed.',
      }),
      job({ id: 'one-off-job-2', status: 'failed' }),
    ]);

    const retryButtons = container.querySelectorAll('.claudian-one-off-job-retry');
    expect(retryButtons).toHaveLength(1);
    expect(retryButtons[0].textContent).toBe('Retry job');

    (retryButtons[0] as HTMLButtonElement).click();
    await flushActions();

    expect(port.retry).toHaveBeenCalledWith('one-off-job-1');
    expect(container.textContent).toContain('Running');
  });

  it('replaces delete with interrupt while a job is running', async () => {
    const { container, port } = createRenderer([
      job({ status: 'running', completedAt: undefined, summary: '' }),
    ]);

    const interruptButton = container.querySelector(
      '.claudian-one-off-job-interrupt',
    ) as HTMLButtonElement;
    expect(interruptButton.textContent).toBe('Interrupt job');
    expect(container.querySelector('.claudian-one-off-job-delete')).toBeNull();

    interruptButton.click();
    await flushActions();

    expect(port.interrupt).toHaveBeenCalledWith('one-off-job-1');
    expect(container.textContent).toContain('Interrupted');
    expect(container.querySelector('.claudian-one-off-job-retry')).not.toBeNull();
    expect(container.querySelector('.claudian-one-off-job-delete')).not.toBeNull();
    expect(container.querySelector('.claudian-one-off-job-interrupt')).toBeNull();
  });

  it('deletes a selected job and releases its subscription on disposal', async () => {
    const { container, port, renderer, subscriberCount } = createRenderer([job()]);
    expect(subscriberCount()).toBe(1);

    (container.querySelector('.claudian-one-off-job-delete') as HTMLButtonElement).click();
    await flushActions();

    expect(mockConfirmDelete).toHaveBeenCalledWith({}, 'Delete one-off job "Background research"?');
    expect(port.delete).toHaveBeenCalledWith('one-off-job-1');
    expect(container.textContent).toContain('No one-off jobs have been started.');
    renderer.dispose();
    expect(subscriberCount()).toBe(0);
  });
});
