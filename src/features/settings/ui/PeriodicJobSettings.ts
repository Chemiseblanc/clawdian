import { Notice } from 'obsidian';

import { findProviderModelOption } from '../../../core/providers/conversationModel';
import { encodeProviderModelSelectionId } from '../../../core/providers/modelSelection';
import { ProviderRegistry } from '../../../core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type { ProviderId } from '../../../core/providers/types';
import { parsePeriodicJobSchedule } from '../../../core/scheduling/PeriodicJobSchedule';
import type {
  PeriodicJob,
  PeriodicJobDraft,
  PeriodicJobRunStatus,
} from '../../../core/types';
import { t } from '../../../i18n/i18n';
import { confirmDelete } from '../../../shared/modals/ConfirmModal';
import type { FeatureHost } from '../../FeatureHost';

interface ModelChoice {
  key: string;
  label: string;
  model: string;
  providerId: ProviderId;
}

type ActiveScreen =
  | { kind: 'list' }
  | { kind: 'detail'; jobId: string | null };

export class PeriodicJobSettings {
  private activeScreen: ActiveScreen = { kind: 'list' };
  private detailRuntimeEl: HTMLDivElement | null = null;
  private disposed = false;
  private draft: PeriodicJobDraft | null = null;
  private errorEl: HTMLDivElement | null = null;
  private readonly rootEl: HTMLDivElement;
  private readonly unsubscribe: () => void;

  constructor(
    containerEl: HTMLElement,
    private readonly plugin: FeatureHost,
  ) {
    this.rootEl = containerEl.createDiv({ cls: 'claudian-periodic-jobs' });
    this.unsubscribe = plugin.periodicJobs.subscribe(() => this.handleJobsChanged());
    this.renderList();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
  }

  private renderList(): void {
    if (this.disposed) return;
    this.activeScreen = { kind: 'list' };
    this.detailRuntimeEl = null;
    this.errorEl = null;
    this.rootEl.empty();

    const header = this.rootEl.createDiv({ cls: 'claudian-sp-header claudian-periodic-jobs-header' });
    header.createEl('h3', { text: t('settings.jobs.title') });
    const actions = header.createDiv({ cls: 'claudian-sp-header-actions' });
    const newButton = actions.createEl('button', {
      cls: 'claudian-settings-action-btn claudian-periodic-job-new',
      text: t('settings.jobs.newJob'),
    });
    newButton.addEventListener('click', () => this.openDetails(null));

    const jobs = this.plugin.periodicJobs.list();
    if (jobs.length === 0) {
      this.rootEl.createDiv({
        cls: 'claudian-sp-empty-state',
        text: t('settings.jobs.empty'),
      });
      return;
    }

    const list = this.rootEl.createDiv({ cls: 'claudian-sp-list claudian-periodic-job-list' });
    for (const job of jobs) this.renderJobRow(list, job);
  }

  private renderJobRow(list: HTMLElement, job: PeriodicJob): void {
    const item = list.createDiv({ cls: 'claudian-sp-item claudian-periodic-job-item' });
    const content = item.createDiv({
      cls: 'claudian-sp-info claudian-periodic-job-content',
      attr: {
        'aria-label': t('settings.jobs.openJob', { name: job.name }),
        role: 'button',
        tabindex: '0',
      },
    });
    const activate = () => this.openDetails(job.id);
    content.addEventListener('click', activate);
    content.addEventListener('keydown', (event) => {
      if (event.target !== content || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      activate();
    });

    const itemHeader = content.createDiv({ cls: 'claudian-sp-item-header' });
    itemHeader.createSpan({ cls: 'claudian-sp-item-name', text: job.name });
    itemHeader.createSpan({
      cls: `claudian-periodic-job-enabled claudian-periodic-job-enabled--${job.enabled ? 'on' : 'off'}`,
      text: t(job.enabled ? 'settings.jobs.enabled' : 'settings.jobs.disabled'),
    });
    content.createDiv({
      cls: 'claudian-sp-item-desc',
      text: `${t('settings.jobs.lastRun')}: ${this.formatLastRun(job)}`,
    });
    if (job.lastRun) {
      content.createDiv({
        cls: 'claudian-periodic-job-status',
        text: this.formatStatus(job.lastRun.status),
      });
      if (job.lastRun.summary) {
        content.createDiv({
          cls: 'claudian-periodic-job-summary',
          text: job.lastRun.summary,
        });
      }
    }

    const actions = item.createDiv({ cls: 'claudian-sp-item-actions' });
    const runButton = actions.createEl('button', {
      cls: 'claudian-settings-action-btn claudian-periodic-job-run',
      text: this.plugin.periodicJobs.isRunning(job.id)
        ? t('settings.jobs.running')
        : t('settings.jobs.runNow'),
    });
    runButton.disabled = this.plugin.periodicJobs.isRunning(job.id);
    runButton.addEventListener('click', (event) => {
      event.stopPropagation();
      void this.runJob(job.id);
    });
  }

  private openDetails(jobId: string | null): void {
    const existing = jobId
      ? this.plugin.periodicJobs.list().find(job => job.id === jobId) ?? null
      : null;
    if (jobId && !existing) return;
    const choices = this.getModelChoices();
    const first = choices[0];
    this.draft = existing
      ? {
          enabled: existing.enabled,
          name: existing.name,
          schedule: existing.schedule,
          prompt: existing.prompt,
          model: { ...existing.model },
        }
      : {
          enabled: true,
          name: '',
          schedule: '0 9 * * 1-5',
          prompt: '',
          model: first
            ? { providerId: first.providerId, model: first.model }
            : { providerId: '', model: '' },
        };
    this.activeScreen = { kind: 'detail', jobId };
    this.renderDetails(existing, choices);
  }

  private renderDetails(existing: PeriodicJob | null, choices: ModelChoice[]): void {
    const draft = this.draft;
    if (!draft || this.disposed) return;
    this.rootEl.empty();

    const header = this.rootEl.createDiv({ cls: 'claudian-periodic-job-detail-header' });
    const back = header.createEl('button', {
      cls: 'claudian-settings-action-btn claudian-periodic-job-back',
      text: t('settings.jobs.back'),
    });
    back.addEventListener('click', () => {
      this.draft = null;
      this.renderList();
    });
    header.createEl('h3', {
      text: t(existing ? 'settings.jobs.editTitle' : 'settings.jobs.createTitle'),
    });

    const form = this.rootEl.createDiv({ cls: 'claudian-periodic-job-form' });
    const nameInput = this.renderTextField(form, t('settings.jobs.name'), draft.name);
    nameInput.addEventListener('input', () => {
      if (this.draft) this.draft.name = nameInput.value;
    });

    const scheduleInput = this.renderTextField(
      form,
      t('settings.jobs.schedule'),
      draft.schedule,
      '0 9 * * 1-5',
    );
    scheduleInput.addEventListener('input', () => {
      if (this.draft) this.draft.schedule = scheduleInput.value;
    });

    const promptLabel = form.createEl('label', { cls: 'claudian-periodic-job-field' });
    promptLabel.createSpan({ text: t('settings.jobs.prompt') });
    const promptInput = promptLabel.createEl('textarea', {
      attr: { rows: '8' },
      cls: 'claudian-periodic-job-prompt',
    });
    promptInput.value = draft.prompt;
    promptInput.addEventListener('input', () => {
      if (this.draft) this.draft.prompt = promptInput.value;
    });

    const enabledLabel = form.createEl('label', {
      cls: 'claudian-periodic-job-field claudian-periodic-job-toggle',
    });
    const enabledInput = enabledLabel.createEl('input', { type: 'checkbox' });
    enabledInput.type = 'checkbox';
    enabledInput.checked = draft.enabled;
    enabledLabel.createSpan({ text: t('settings.jobs.enabled') });
    enabledInput.addEventListener('change', () => {
      if (this.draft) this.draft.enabled = enabledInput.checked;
    });

    const modelLabel = form.createEl('label', { cls: 'claudian-periodic-job-field' });
    modelLabel.createSpan({ text: t('settings.jobs.model') });
    const modelSelect = modelLabel.createEl('select', { cls: 'dropdown' });
    const choiceByKey = new Map<string, ModelChoice>();
    for (const choice of choices) {
      choiceByKey.set(choice.key, choice);
      const optionEl = modelSelect.createEl('option', { text: choice.label });
      optionEl.value = choice.key;
    }
    const selectedKey = encodeProviderModelSelectionId(draft.model.providerId, draft.model.model);
    if (!choiceByKey.has(selectedKey) && draft.model.providerId && draft.model.model) {
      const stale = modelSelect.createEl('option', {
        text: t('settings.jobs.unavailableModel', {
          provider: draft.model.providerId,
          model: draft.model.model,
        }),
      });
      stale.value = selectedKey;
      stale.disabled = true;
    }
    modelSelect.value = selectedKey;
    modelSelect.addEventListener('change', () => {
      const choice = choiceByKey.get(modelSelect.value);
      if (choice && this.draft) {
        this.draft.model = { providerId: choice.providerId, model: choice.model };
      }
    });

    this.errorEl = this.rootEl.createDiv({
      cls: 'claudian-setting-validation claudian-setting-validation-error claudian-periodic-job-error',
    });
    this.errorEl.hidden = true;

    const actions = this.rootEl.createDiv({ cls: 'claudian-periodic-job-detail-actions' });
    const saveButton = actions.createEl('button', {
      cls: 'mod-cta claudian-periodic-job-save',
      text: t(existing ? 'common.save' : 'settings.jobs.create'),
    });
    saveButton.addEventListener('click', () => {
      void this.save(existing?.id ?? null, choiceByKey);
    });

    if (existing) {
      const deleteButton = actions.createEl('button', {
        cls: 'mod-warning claudian-periodic-job-delete',
        text: t('settings.jobs.delete'),
      });
      deleteButton.addEventListener('click', () => {
        void this.deleteJob(existing.id, existing.name);
      });
      this.detailRuntimeEl = this.rootEl.createDiv({ cls: 'claudian-periodic-job-runtime' });
      this.updateDetailRuntime();
    } else {
      this.detailRuntimeEl = null;
    }
  }

  private renderTextField(
    container: HTMLElement,
    label: string,
    value: string,
    placeholder?: string,
  ): HTMLInputElement {
    const field = container.createEl('label', { cls: 'claudian-periodic-job-field' });
    field.createSpan({ text: label });
    const input = field.createEl('input', {
      attr: placeholder ? { placeholder, type: 'text' } : { type: 'text' },
    });
    input.value = value;
    return input;
  }

  private async save(
    id: string | null,
    choiceByKey: ReadonlyMap<string, ModelChoice>,
  ): Promise<void> {
    const draft = this.draft;
    if (!draft) return;
    try {
      const schedule = parsePeriodicJobSchedule(draft.schedule);
      if (!draft.name.trim()) throw new Error(t('settings.jobs.nameRequired'));
      if (!draft.prompt.trim()) throw new Error(t('settings.jobs.promptRequired'));
      const selectedKey = encodeProviderModelSelectionId(
        draft.model.providerId,
        draft.model.model,
      );
      const choice = choiceByKey.get(selectedKey);
      if (!choice) throw new Error(t('settings.jobs.modelRequired'));
      const normalized: PeriodicJobDraft = {
        ...draft,
        name: draft.name.trim(),
        prompt: draft.prompt.trim(),
        schedule,
        model: { providerId: choice.providerId, model: choice.model },
      };
      if (id) await this.plugin.periodicJobs.update(id, normalized);
      else await this.plugin.periodicJobs.create(normalized);
      this.draft = null;
      this.renderList();
    } catch (error) {
      this.showError(error instanceof Error ? error.message : t('settings.jobs.saveFailed'));
    }
  }

  private async runJob(id: string): Promise<void> {
    try {
      await this.plugin.periodicJobs.runNow(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('settings.jobs.runFailed');
      new Notice(t('settings.jobs.runFailedWithMessage', { message }));
    }
  }

  private async deleteJob(id: string, name: string): Promise<void> {
    const confirmed = await confirmDelete(
      this.plugin.app,
      t('settings.jobs.deleteConfirm', { name }),
    );
    if (!confirmed) return;
    try {
      await this.plugin.periodicJobs.delete(id);
      this.draft = null;
      this.renderList();
    } catch (error) {
      this.showError(error instanceof Error ? error.message : t('settings.jobs.deleteFailed'));
    }
  }

  private handleJobsChanged(): void {
    if (this.disposed) return;
    if (this.activeScreen.kind === 'list') {
      this.renderList();
      return;
    }
    this.updateDetailRuntime();
  }

  private updateDetailRuntime(): void {
    if (!this.detailRuntimeEl || this.activeScreen.kind !== 'detail') return;
    const id = this.activeScreen.jobId;
    if (!id) return;
    const job = this.plugin.periodicJobs.list().find(candidate => candidate.id === id);
    this.detailRuntimeEl.empty();
    if (!job) return;

    this.detailRuntimeEl.createDiv({
      cls: 'claudian-sp-item-desc',
      text: `${t('settings.jobs.lastRun')}: ${this.formatLastRun(job)}`,
    });
    if (job.lastRun) {
      this.detailRuntimeEl.createDiv({
        cls: 'claudian-periodic-job-status',
        text: this.formatStatus(job.lastRun.status),
      });
      if (job.lastRun.summary) {
        this.detailRuntimeEl.createDiv({
          cls: 'claudian-periodic-job-summary',
          text: job.lastRun.summary,
        });
      }
    }
    const runButton = this.detailRuntimeEl.createEl('button', {
      cls: 'claudian-settings-action-btn claudian-periodic-job-run',
      text: this.plugin.periodicJobs.isRunning(id)
        ? t('settings.jobs.running')
        : t('settings.jobs.runNow'),
    });
    runButton.disabled = this.plugin.periodicJobs.isRunning(id);
    runButton.addEventListener('click', () => {
      void this.runJob(id);
    });
  }

  private getModelChoices(): ModelChoice[] {
    const choices: ModelChoice[] = [];
    const settings = this.plugin.settings;
    for (const providerId of ProviderRegistry.getEnabledProviderIds(settings)) {
      const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
        settings,
        providerId,
      );
      for (const option of ProviderRegistry.getChatUIConfig(providerId).getModelOptions(
        providerSettings,
      )) {
        const exact = findProviderModelOption(providerId, option.value, providerSettings);
        if (!exact) continue;
        choices.push({
          key: encodeProviderModelSelectionId(providerId, option.value),
          label: `${ProviderRegistry.getProviderDisplayName(providerId)}: ${option.label}`,
          model: option.value,
          providerId,
        });
      }
    }
    return choices;
  }

  private formatLastRun(job: PeriodicJob): string {
    return job.lastRun
      ? new Date(job.lastRun.startedAt).toLocaleString()
      : t('settings.jobs.never');
  }

  private formatStatus(status: PeriodicJobRunStatus): string {
    const key = `settings.jobs.status.${status}` as const;
    return t(key);
  }

  private showError(message: string): void {
    if (!this.errorEl) return;
    this.errorEl.textContent = message;
    this.errorEl.hidden = false;
  }
}
