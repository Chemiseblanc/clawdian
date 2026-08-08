import * as fs from 'node:fs';
import * as path from 'node:path';

import { Notice, Setting } from 'obsidian';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderSettingsTabRenderer,
  ProviderSettingsTabRendererContext,
} from '../../../core/providers/types';
import type { ClaudianSettings } from '../../../core/types';
import { t } from '../../../i18n/i18n';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import { renderHostnameCliPathSetting } from '../../../shared/settings/HostnameCliPathSetting';
import { renderNativeMcpSettingsSection } from '../../../shared/settings/NativeMcpSettingsSection';
import { renderProviderEnablementSetting } from '../../../shared/settings/ProviderEnablementSetting';
import {
  renderLastEnabledProviderWarning,
  renderProviderModelEnablementWarning,
} from '../../../shared/settings/ProviderModelEnablementWarning';
import {
  type ProviderModelPickerModel,
  type ProviderModelPickerState,
  renderProviderModelPicker,
} from '../../../shared/settings/ProviderModelPicker';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import type { CopilotWorkspaceServices } from '../app/CopilotWorkspaceServices';
import type { CopilotDiscoveredModel } from '../models';
import {
  clearCurrentCopilotCatalog,
  getCopilotProviderSettings,
  getOrderedCopilotVisibleModelIds,
  normalizeCopilotVisibleModels,
  updateCopilotProviderSettings,
  updateCopilotVisibleModels,
} from '../settings';

const COPILOT_PROVIDER_ID = 'copilot' as const;

export const copilotSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const hostnameKey = getHostnameKey();
    const workspace = getCopilotWorkspaceServices();

    const refreshModelCatalog = async (): Promise<'empty' | 'failed' | 'loaded'> => {
      const result = await workspace.refreshModelCatalog();
      if (result.diagnostics) {
        new Notice(`GitHub Copilot model discovery failed: ${result.diagnostics}`);
        return 'failed';
      }
      modelWarning.context.notifyProviderModelOptionsChanged(COPILOT_PROVIDER_ID);
      return (getCopilotProviderSettings(settingsBag).currentCatalog?.models.length ?? 0) > 0
        ? 'loaded'
        : 'empty';
    };

    new Setting(container).setName('Setup').setHeading();

    renderProviderEnablementSetting({
      container,
      description: t('settings.providerEnablement.desc', { provider: 'GitHub Copilot' }),
      getValue: () => getCopilotProviderSettings(settingsBag).enabled,
      name: t('settings.providerEnablement.name', { provider: 'GitHub Copilot' }),
      onChange: async (enabled) => {
        if (!ProviderSettingsCoordinator.canApplyProviderEnablement(
          settingsBag,
          COPILOT_PROVIDER_ID,
          enabled,
        )) {
          lastProviderWarning.showFor();
          return;
        }

        let accepted = true;
        await context.plugin.runProviderExecutionTransition(
          [COPILOT_PROVIDER_ID],
          async () => context.plugin.mutateSettings((settings) => {
            accepted = ProviderSettingsCoordinator.applyProviderEnablement(
              settings,
              COPILOT_PROVIDER_ID,
              enabled,
            );
          }),
        );
        if (accepted) {
          lastProviderWarning.hide();
        } else {
          lastProviderWarning.showFor();
        }
        modelWarning.context.notifyProviderModelOptionsChanged(COPILOT_PROVIDER_ID);
      },
    });

    const lastProviderWarning = renderLastEnabledProviderWarning(container);

    const modelWarning = renderProviderModelEnablementWarning(container, context, {
      getHasEnabledModels: () => getOrderedCopilotVisibleModelIds(
        getCopilotProviderSettings(settingsBag),
      ).length > 0,
      getIsEnabled: () => getCopilotProviderSettings(settingsBag).enabled,
      providerId: COPILOT_PROVIDER_ID,
      providerName: 'GitHub Copilot',
    });

    renderHostnameCliPathSetting({
      container,
      description: 'Optional absolute path to GitHub Copilot CLI for this computer. Leave empty to prefer known installs, then `copilot` from PATH.',
      getValue: () => {
        const current = getCopilotProviderSettings(settingsBag);
        return current.cliPathsByHost[hostnameKey] ?? current.cliPath ?? '';
      },
      name: 'CLI path',
      onChange: async (value) => {
        const cliPathsByHost = {
          ...getCopilotProviderSettings(settingsBag).cliPathsByHost,
        };
        if (value) {
          cliPathsByHost[hostnameKey] = value;
        } else {
          delete cliPathsByHost[hostnameKey];
        }
        const mutation = (settings: ClaudianSettings): void => {
          updateCopilotProviderSettings(settings, {
            cliPath: '',
            cliPathsByHost,
          });
          clearCurrentCopilotCatalog(settings);
        };
        await context.plugin.applyProviderRuntimeSettings(
          [COPILOT_PROVIDER_ID],
          mutation,
          () => workspace.cliResolver.reset(),
        );
        modelWarning.context.notifyProviderModelOptionsChanged(COPILOT_PROVIDER_ID);
      },
      placeholder: process.platform === 'win32'
        ? 'C:\\Users\\you\\AppData\\Local\\Programs\\GitHub Copilot\\copilot.exe'
        : '/usr/local/bin/copilot',
      validate: validateCliPath,
    });

    new Setting(container).setName('Models').setHeading();
    renderCopilotModelPicker(container, modelWarning.context, settingsBag, refreshModelCatalog);

    new Setting(container).setName('Commands').setHeading();
    context.renderHiddenProviderCommandSetting(container, COPILOT_PROVIDER_ID, {
      name: 'Hidden GitHub Copilot commands',
      desc: 'Hide commands advertised by GitHub Copilot CLI from the command dropdown. Enter names without the leading slash, one per line.',
      placeholder: 'compact\nreview',
    });

    renderNativeMcpSettingsSection(container, {
      descriptionAfterCommand: ' and they will be available in Claudian. ',
      descriptionBeforeCommand: 'GitHub Copilot CLI manages MCP servers through its own CLI. Configure them with ',
      documentationLabel: 'GitHub Copilot CLI documentation',
      documentationUrl: 'https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli',
      heading: t('settings.mcpServers.name'),
      setupCommand: 'copilot mcp add',
    });

    renderEnvironmentSettingsSection({
      container,
      desc: 'Environment variables passed only to GitHub Copilot CLI.',
      heading: 'Environment',
      name: 'GitHub Copilot environment variables',
      placeholder: 'GH_TOKEN=github_pat_...',
      plugin: context.plugin,
      renderCustomContextLimits: target => context.renderCustomContextLimits(
        target,
        COPILOT_PROVIDER_ID,
      ),
      scope: 'provider:copilot',
    });
  },
};

function renderCopilotModelPicker(
  container: HTMLElement,
  context: ProviderSettingsTabRendererContext,
  settingsBag: Record<string, unknown>,
  loadCatalog: () => Promise<'empty' | 'failed' | 'loaded'>,
): void {
  const getState = (): ProviderModelPickerState => {
    const settings = getCopilotProviderSettings(settingsBag);
    const catalogModels = settings.currentCatalog?.models ?? [];
    const selectedIds = getOrderedCopilotVisibleModelIds(settings);
    return {
      aliases: settings.modelAliases,
      discoveredCount: catalogModels.length,
      models: buildCopilotPickerModels(catalogModels, selectedIds),
      selectedIds,
    };
  };

  renderProviderModelPicker({
    checkCatalogFreshnessWhenCached: true,
    container,
    emptyCatalogText: 'No GitHub Copilot models discovered yet. Sign in with GitHub Copilot CLI, then click Discover.',
    failedCatalogText: 'Could not load the GitHub Copilot model catalog. Check the CLI path and authentication, then try again.',
    getState,
    initiallyOpen: (getCopilotProviderSettings(settingsBag).currentCatalog?.models.length ?? 0) === 0,
    loadCatalog,
    loadingCatalogText: 'Loading the GitHub Copilot model catalog...',
    modifier: 'copilot',
    async onAliasesChange(modelAliases) {
      await context.plugin.mutateSettings((settings) => {
        updateCopilotProviderSettings(settings, { modelAliases });
      });
      context.notifyProviderModelOptionsChanged(COPILOT_PROVIDER_ID);
    },
    async onSelectedIdsChange(selectedIds) {
      const current = getCopilotProviderSettings(settingsBag);
      const models = current.currentCatalog?.models ?? [];
      const allowedIds = new Set(models.map(model => model.rawId));
      const nextVisibleModels = normalizeCopilotVisibleModels(
        selectedIds,
        allowedIds,
        models.length > 0,
      );
      if (sameOptionalList(current.visibleModels, nextVisibleModels)) {
        return;
      }
      await context.plugin.mutateSettings((settings) => {
        updateCopilotVisibleModels(settings, nextVisibleModels);
      });
      context.notifyProviderModelOptionsChanged(COPILOT_PROVIDER_ID);
    },
    providerName: 'GitHub Copilot',
    searchPlaceholder: 'Filter by model name, description, or alias ID...',
  });
}

function buildCopilotPickerModels(
  catalogModels: CopilotDiscoveredModel[],
  selectedIds: string[],
): ProviderModelPickerModel[] {
  const models: ProviderModelPickerModel[] = catalogModels.map(model => ({
    description: model.description,
    id: model.rawId,
    isAvailable: true,
    name: model.displayName,
  }));
  const catalogIds = new Set(catalogModels.map(model => model.rawId));
  for (const rawId of selectedIds) {
    if (catalogIds.has(rawId)) {
      continue;
    }
    models.push({
      description: 'Selected model',
      id: rawId,
      isAvailable: false,
      name: rawId,
      unavailableMessage: 'Not currently reported by GitHub Copilot CLI',
    });
  }
  return models;
}

function sameOptionalList(left: string[] | null, right: string[] | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateCliPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const expandedPath = expandHomePath(trimmed);
  if (!path.posix.isAbsolute(expandedPath) && !path.win32.isAbsolute(expandedPath)) {
    return 'Path must be absolute';
  }
  try {
    if (!fs.existsSync(expandedPath)) {
      return 'Path does not exist';
    }
    if (!fs.statSync(expandedPath).isFile()) {
      return 'Path must point to a file';
    }
    if (process.platform !== 'win32') {
      fs.accessSync(expandedPath, fs.constants.X_OK);
    }
  } catch {
    return process.platform === 'win32'
      ? 'Path is not accessible'
      : 'Path must be executable';
  }
  return null;
}

function getCopilotWorkspaceServices(): CopilotWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices(COPILOT_PROVIDER_ID) as CopilotWorkspaceServices;
}
