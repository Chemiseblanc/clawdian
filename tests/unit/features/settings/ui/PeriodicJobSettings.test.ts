/** @jest-environment jsdom */

import '@/providers';

const mockConfirmDelete = jest.fn(async (_app: unknown, _message: string) => true);

jest.mock('@/shared/modals/ConfirmModal', () => ({
  confirmDelete: (app: unknown, message: string) => mockConfirmDelete(app, message),
}));

import { Notice } from 'obsidian';

import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import type { PeriodicJob, PeriodicJobDraft } from '@/core/types';
import type { PeriodicJobsPort } from '@/features/FeatureHost';
import { PeriodicJobSettings } from '@/features/settings/ui/PeriodicJobSettings';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function job(overrides: Partial<PeriodicJob> = {}): PeriodicJob {
  return {
    id: 'job-1',
    enabled: true,
    name: 'Morning review',
    schedule: '0 9 * * 1-5',
    prompt: 'Review the vault',
    model: { providerId: 'claude', model: 'sonnet' },
    lastRun: null,
    ...overrides,
  };
}

function createJobsPort(initialJobs: PeriodicJob[] = []) {
  let jobs = clone(initialJobs);
  const listeners = new Set<() => void>();
  const running = new Set<string>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const port: PeriodicJobsPort = {
    list: jest.fn(() => clone(jobs)),
    create: jest.fn(async (draft: PeriodicJobDraft) => {
      const created = { id: 'created', ...clone(draft), lastRun: null };
      jobs = [...jobs, created];
      notify();
      return created;
    }),
    update: jest.fn(async (id: string, draft: PeriodicJobDraft) => {
      const current = jobs.find(candidate => candidate.id === id);
      if (!current) throw new Error('Periodic job not found.');
      const updated = { id, ...clone(draft), lastRun: current.lastRun };
      jobs = jobs.map(candidate => candidate.id === id ? updated : candidate);
      notify();
      return updated;
    }),
    delete: jest.fn(async (id: string) => {
      jobs = jobs.filter(candidate => candidate.id !== id);
      notify();
    }),
    runNow: jest.fn(async () => undefined),
    setEnabled: jest.fn(async (id: string, enabled: boolean) => {
      jobs = jobs.map(candidate => candidate.id === id ? { ...candidate, enabled } : candidate);
      notify();
    }),
    isRunning: jest.fn((id: string) => running.has(id)),
    subscribe: jest.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  return {
    notify,
    port,
    running,
    setJobs(next: PeriodicJob[]) {
      jobs = clone(next);
    },
    subscriberCount: () => listeners.size,
  };
}

function createRenderer(initialJobs: PeriodicJob[] = []) {
  const jobs = createJobsPort(initialJobs);
  const settings = clone(DEFAULT_CLAUDIAN_SETTINGS);
  const plugin = {
    app: {},
    periodicJobs: jobs.port,
    settings,
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const renderer = new PeriodicJobSettings(
    container,
    plugin as unknown as ConstructorParameters<typeof PeriodicJobSettings>[1],
  );
  return { container, jobs, renderer };
}

function inputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
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

describe('PeriodicJobSettings', () => {
  it('renders empty and metadata list states with independent navigation and Run Now targets', async () => {
    const empty = createRenderer();
    expect(empty.container.textContent).toContain('No periodic jobs configured.');
    expect(empty.container.querySelector('.claudian-periodic-job-new')).not.toBeNull();
    empty.renderer.dispose();

    const existing = job({
      lastRun: {
        startedAt: 1_700_000_000_000,
        completedAt: 1_700_000_001_000,
        status: 'succeeded',
        summary: 'Summary text',
        trigger: 'manual',
      },
    });
    const { container, jobs } = createRenderer([existing]);
    const content = container.querySelector<HTMLElement>('.claudian-periodic-job-content')!;
    const run = container.querySelector<HTMLButtonElement>('.claudian-periodic-job-run')!;

    expect(content.getAttribute('role')).toBe('button');
    expect(content.tabIndex).toBe(0);
    expect(run.tagName).toBe('BUTTON');
    expect(content.parentElement?.lastElementChild?.contains(run)).toBe(true);
    expect(container.textContent).toContain('Summary text');
    expect(container.textContent).toContain('Succeeded');

    run.click();
    await flushActions();
    expect(jobs.port.runNow).toHaveBeenCalledWith('job-1');
    expect(container.querySelector('.claudian-periodic-job-form')).toBeNull();

    content.querySelector<HTMLElement>('.claudian-sp-item-name')!.click();
    expect(container.querySelector('.claudian-periodic-job-form')).not.toBeNull();
  });

  it('supports keyboard navigation while keeping Run Now out of the navigation target', () => {
    const { container } = createRenderer([job()]);
    const content = container.querySelector<HTMLElement>('.claudian-periodic-job-content')!;

    content.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));

    expect(container.querySelector('.claudian-periodic-job-form')).not.toBeNull();
  });

  it('validates and creates a normalized draft with a collision-free model mapping', async () => {
    const { container, jobs } = createRenderer();
    container.querySelector<HTMLButtonElement>('.claudian-periodic-job-new')!.click();
    const textInputs = container.querySelectorAll<HTMLInputElement>('input[type="text"]');
    const prompt = container.querySelector<HTMLTextAreaElement>('textarea')!;
    const model = container.querySelector<HTMLSelectElement>('select')!;

    expect(Array.from(model.options).some(option => option.text.startsWith('Claude:'))).toBe(true);
    inputValue(textInputs[0], '  New job  ');
    inputValue(textInputs[1], ' 0   8 * * * ');
    inputValue(prompt, '  Do work  ');
    container.querySelector<HTMLButtonElement>('.claudian-periodic-job-save')!.click();
    await flushActions();

    expect(jobs.port.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'New job',
      prompt: 'Do work',
      schedule: '0 8 * * *',
      model: expect.objectContaining({ providerId: 'claude' }),
    }));
    expect(container.querySelector('.claudian-periodic-job-list')).not.toBeNull();
  });

  it('retains edit state for stale models until an available replacement is selected', async () => {
    const stale = job({ model: { providerId: 'claude', model: 'removed-model' } });
    const { container, jobs } = createRenderer([stale]);
    container.querySelector<HTMLElement>('.claudian-periodic-job-content')!.click();
    const select = container.querySelector<HTMLSelectElement>('select')!;
    const staleOption = Array.from(select.options).find(option => option.text.startsWith('Unavailable:'))!;
    const enabled = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

    expect(staleOption.disabled).toBe(true);
    enabled.checked = false;
    enabled.dispatchEvent(new Event('change', { bubbles: true }));
    container.querySelector<HTMLButtonElement>('.claudian-periodic-job-save')!.click();
    await flushActions();
    expect(jobs.port.update).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Select an available model.');

    const available = Array.from(select.options).find(option => !option.disabled)!;
    select.value = available.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    container.querySelector<HTMLButtonElement>('.claudian-periodic-job-save')!.click();
    await flushActions();
    expect(jobs.port.update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ enabled: false }),
    );
  });

  it('shows manual failures, confirms deletion, and disposes idempotently', async () => {
    const { container, jobs, renderer } = createRenderer([job()]);
    (jobs.port.runNow as jest.Mock).mockRejectedValueOnce(new Error('provider failed'));
    container.querySelector<HTMLButtonElement>('.claudian-periodic-job-run')!.click();
    await flushActions();
    expect(Notice).toHaveBeenCalledWith('Periodic job failed: provider failed');

    container.querySelector<HTMLElement>('.claudian-periodic-job-content')!.click();
    container.querySelector<HTMLButtonElement>('.claudian-periodic-job-delete')!.click();
    await flushActions();
    expect(mockConfirmDelete).toHaveBeenCalled();
    expect(jobs.port.delete).toHaveBeenCalledWith('job-1');

    renderer.dispose();
    renderer.dispose();
    expect(jobs.subscriberCount()).toBe(0);
  });

  it('updates run metadata without losing unsaved values, selection, focus, or detail screen', () => {
    const existing = job();
    const { container, jobs } = createRenderer([existing]);
    container.querySelector<HTMLElement>('.claudian-periodic-job-content')!.click();
    const textInputs = container.querySelectorAll<HTMLInputElement>('input[type="text"]');
    const prompt = container.querySelector<HTMLTextAreaElement>('textarea')!;
    const select = container.querySelector<HTMLSelectElement>('select')!;
    inputValue(textInputs[0], 'Unsaved name');
    inputValue(textInputs[1], '15 10 * * *');
    inputValue(prompt, 'Unsaved prompt');
    const selectedModel = select.value;
    prompt.focus();

    jobs.running.add('job-1');
    jobs.setJobs([job({
      lastRun: {
        startedAt: 200,
        status: 'running',
        summary: 'Working',
        trigger: 'manual',
      },
    })]);
    jobs.notify();

    expect(textInputs[0].value).toBe('Unsaved name');
    expect(textInputs[1].value).toBe('15 10 * * *');
    expect(prompt.value).toBe('Unsaved prompt');
    expect(select.value).toBe(selectedModel);
    expect(document.activeElement).toBe(prompt);
    expect(container.querySelector('.claudian-periodic-job-form')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('.claudian-periodic-job-runtime button')?.disabled)
      .toBe(true);
  });
});
