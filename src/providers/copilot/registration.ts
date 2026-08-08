import { NOOP_TASK_RESULT_INTERPRETER } from '../../core/providers/NoopTaskResultInterpreter';
import type { ProviderModule } from '../../core/providers/types';
import {
  copilotWorkspaceRegistration,
  getCopilotWorkspaceServices,
} from './app/CopilotWorkspaceServices';
import { COPILOT_PROVIDER_CAPABILITIES } from './capabilities';
import { copilotSettingsReconciler } from './env/CopilotSettingsReconciler';
import { CopilotExecutionBackend } from './execution/CopilotExecutionBackend';
import { CopilotConversationHistoryService } from './history/CopilotConversationHistoryService';
import { getCopilotProviderSettings, updateCopilotProviderSettings } from './settings';
import { copilotChatUIConfig } from './ui/CopilotChatUIConfig';

export const copilotProviderRegistration: ProviderModule = {
  id: 'copilot',
  displayName: 'GitHub Copilot',
  blankTabOrder: 14,
  isEnabled: settings => getCopilotProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateCopilotProviderSettings(settings, { enabled }),
  capabilities: COPILOT_PROVIDER_CAPABILITIES,
  environmentKeyPatterns: [/^COPILOT_/i, /^GITHUB_/i, /^GH_/i],
  chatUIConfig: copilotChatUIConfig,
  settingsReconciler: copilotSettingsReconciler,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost', 'catalogsByHost'],
    normalizeStored(target, stored) {
      updateCopilotProviderSettings(target, getCopilotProviderSettings(stored));
      return false;
    },
  },
  createExecutionBackend: (plugin) => {
    const workspace = getCopilotWorkspaceServices();
    return new CopilotExecutionBackend(plugin, {
      commandCatalog: workspace.commandCatalog,
      modelCatalogCoordinator: workspace.modelCatalogCoordinator,
    });
  },
  resolveTitleGenerationModel: (plugin) => {
    const settings = plugin.settings as unknown as Record<string, unknown>;
    const titleModel = typeof settings.titleGenerationModel === 'string'
      ? settings.titleGenerationModel
      : '';
    return copilotChatUIConfig.ownsModel(titleModel, settings)
      ? titleModel
      : undefined;
  },
  historyService: new CopilotConversationHistoryService(),
  taskResultInterpreter: NOOP_TASK_RESULT_INTERPRETER,
  workspace: copilotWorkspaceRegistration,
};
