import type { ProviderCommandCatalog } from '@/core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderModelCatalogRefreshResult,
  ProviderTabWarmupPolicy,
  ProviderTransitionOwnerContext,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '@/core/providers/types';

import { CopilotCommandCatalog } from '../commands/CopilotCommandCatalog';
import { CopilotAcpSessionProbe } from '../runtime/CopilotAcpSessionProbe';
import { CopilotCliResolver } from '../runtime/CopilotCliResolver';
import {
  CopilotModelCatalogCoordinator,
} from '../runtime/CopilotModelCatalogCoordinator';
import {
  type CopilotAcpSessionProbeLike,
  CopilotModelCatalogService,
} from '../runtime/CopilotModelCatalogService';
import { copilotSettingsTabRenderer } from '../ui/CopilotSettingsTab';

export interface CopilotWorkspaceServices extends ProviderWorkspaceServices {
  cliResolver: CopilotCliResolver;
  commandCatalog: ProviderCommandCatalog;
  modelCatalogCoordinator: CopilotModelCatalogCoordinator;
  refreshModelCatalog(
    context?: ProviderTransitionOwnerContext,
  ): Promise<ProviderModelCatalogRefreshResult>;
  prepareSettings(): Promise<void>;
  dispose(): Promise<void>;
}

export interface CopilotWorkspaceServicesOptions {
  readonly sessionProbe?: CopilotAcpSessionProbeLike;
  /** Alias retained for callers that name the dependency after the ACP probe. */
  readonly probe?: CopilotAcpSessionProbeLike;
}

const copilotTabWarmupPolicy: ProviderTabWarmupPolicy = {
  resolveMode() {
    return 'commands';
  },
};

export async function createCopilotWorkspaceServices(
  plugin: ProviderHost,
  options: CopilotWorkspaceServicesOptions = {},
): Promise<CopilotWorkspaceServices> {
  const providedSessionProbe = options.sessionProbe ?? options.probe;
  const ownsSessionProbe = providedSessionProbe === undefined;
  const sessionProbe = providedSessionProbe ?? new CopilotAcpSessionProbe();
  const modelCatalogService = new CopilotModelCatalogService(plugin, {
    probe: sessionProbe,
  });
  const modelCatalogCoordinator = new CopilotModelCatalogCoordinator(
    plugin,
    modelCatalogService,
  );
  const unregisterTransitionHook = plugin.executionLifecycleRegistry.registerTransitionHook('copilot', {
    beforeTransition: async () => {
      modelCatalogCoordinator.beginEnvironmentTransition();
      await modelCatalogCoordinator.quiesceForEnvironmentChange();
    },
    afterTransition: async () => {
      try {
        await modelCatalogCoordinator.quiesceForEnvironmentChange();
      } finally {
        modelCatalogCoordinator.endEnvironmentTransition();
      }
    },
  });

  let disposePromise: Promise<void> | null = null;
  return {
    cliResolver: new CopilotCliResolver(),
    commandCatalog: new CopilotCommandCatalog(),
    modelCatalogCoordinator,
    refreshModelCatalog: context => modelCatalogCoordinator.refreshModelCatalog(context),
    settingsTabRenderer: copilotSettingsTabRenderer,
    tabWarmupPolicy: copilotTabWarmupPolicy,
    async prepareSettings() {
      await modelCatalogCoordinator.ensureFresh('settings');
    },
    async dispose() {
      if (disposePromise) return disposePromise;
      unregisterTransitionHook();
      modelCatalogCoordinator.dispose();
      disposePromise = modelCatalogCoordinator.quiesceForEnvironmentChange().then(async () => {
        if (
          ownsSessionProbe
          && 'dispose' in sessionProbe
          && typeof sessionProbe.dispose === 'function'
        ) {
          await sessionProbe.dispose();
        }
      });
      return disposePromise;
    },
  };
}

export const copilotWorkspaceRegistration: ProviderWorkspaceRegistration<CopilotWorkspaceServices> = {
  initialize: async ({ plugin }) => createCopilotWorkspaceServices(plugin),
};

export function getCopilotWorkspaceServices(): CopilotWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('copilot') as CopilotWorkspaceServices;
}

export function maybeGetCopilotWorkspaceServices(): CopilotWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('copilot') as CopilotWorkspaceServices | null;
}
