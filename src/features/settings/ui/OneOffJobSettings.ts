import { Notice } from 'obsidian';

import { t } from '../../../i18n/i18n';
import { confirmDelete } from '../../../shared/modals/ConfirmModal';
import type { FeatureHost } from '../../FeatureHost';

export class OneOffJobSettings {
  private disposed = false;
  private readonly rootEl: HTMLDivElement;
  private readonly unsubscribe: () => void;

  constructor(
    containerEl: HTMLElement,
    private readonly plugin: FeatureHost,
  ) {
    this.rootEl = containerEl.createDiv({ cls: 'claudian-one-off-jobs' });
    this.unsubscribe = plugin.oneOffJobs.subscribe(() => this.render());
    this.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
  }

  private render(): void {
    if (this.disposed) return;
    this.rootEl.empty();
    this.rootEl.createEl('h3', { text: t('settings.jobs.oneOff.title') });
    this.rootEl.createDiv({
      cls: 'claudian-sp-item-desc claudian-one-off-jobs-description',
      text: t('settings.jobs.oneOff.description'),
    });

    const jobs = this.plugin.oneOffJobs.list();
    if (jobs.length === 0) {
      this.rootEl.createDiv({
        cls: 'claudian-sp-empty-state',
        text: t('settings.jobs.oneOff.empty'),
      });
      return;
    }

    const list = this.rootEl.createDiv({ cls: 'claudian-sp-list claudian-one-off-job-list' });
    for (const job of jobs) {
      const item = list.createDiv({ cls: 'claudian-sp-item claudian-one-off-job-item' });
      const content = item.createDiv({ cls: 'claudian-sp-info' });
      const header = content.createDiv({ cls: 'claudian-sp-item-header' });
      header.createSpan({ cls: 'claudian-sp-item-name', text: job.name });
      header.createSpan({
        cls: `claudian-one-off-job-status claudian-one-off-job-status--${job.status}`,
        text: t(`settings.jobs.status.${job.status}` as const),
      });
      content.createDiv({
        cls: 'claudian-sp-item-desc',
        text: t('settings.jobs.oneOff.started', {
          date: new Date(job.startedAt).toLocaleString(),
        }),
      });
      content.createDiv({
        cls: 'claudian-one-off-job-prompt',
        text: job.prompt,
      });
      if (job.summary) {
        content.createDiv({
          cls: 'claudian-periodic-job-summary claudian-one-off-job-summary',
          text: job.summary,
        });
      }

      const actions = item.createDiv({ cls: 'claudian-sp-item-actions' });
      if (job.status === 'running') {
        const interruptButton = actions.createEl('button', {
          cls: 'claudian-settings-action-btn claudian-one-off-job-interrupt',
          text: t('settings.jobs.oneOff.interrupt'),
        });
        interruptButton.addEventListener('click', () => {
          void this.interruptJob(job.id);
        });
        continue;
      }
      if (job.status === 'interrupted') {
        const retryButton = actions.createEl('button', {
          cls: 'claudian-settings-action-btn claudian-one-off-job-retry',
          text: t('settings.jobs.oneOff.retry'),
        });
        retryButton.addEventListener('click', () => {
          void this.retryJob(job.id);
        });
      }
      const deleteButton = actions.createEl('button', {
        cls: 'claudian-settings-action-btn claudian-one-off-job-delete',
        text: t('settings.jobs.oneOff.delete'),
      });
      deleteButton.addEventListener('click', () => {
        void this.deleteJob(job.id, job.name);
      });
    }
  }

  private async interruptJob(id: string): Promise<void> {
    try {
      await this.plugin.oneOffJobs.interrupt(id);
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : t('settings.jobs.oneOff.interruptFailed');
      new Notice(t('settings.jobs.oneOff.interruptFailedWithMessage', { message }));
    }
  }

  private async retryJob(id: string): Promise<void> {
    try {
      await this.plugin.oneOffJobs.retry(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('settings.jobs.oneOff.retryFailed');
      new Notice(t('settings.jobs.oneOff.retryFailedWithMessage', { message }));
    }
  }

  private async deleteJob(id: string, name: string): Promise<void> {
    const confirmed = await confirmDelete(
      this.plugin.app,
      t('settings.jobs.oneOff.deleteConfirm', { name }),
    );
    if (!confirmed) return;
    await this.plugin.oneOffJobs.delete(id);
  }

}
