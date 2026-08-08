import type {
  ProviderExecutionBackend,
  ProviderExecutionSession,
  ProviderSessionConfig,
} from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';

import type { CopilotCommandCatalog } from '../commands/CopilotCommandCatalog';
import type { CopilotDiscoveredModel } from '../models';
import {
  type CopilotExecutionNativeConnection,
  CopilotExecutionNativeConnectionImpl,
  type CopilotExecutionNativeFactory,
} from './CopilotExecutionNativeConnection';
import { CopilotExecutionSession } from './CopilotExecutionSession';

export interface CopilotModelCatalogCoordinator {
  mergeLiveModels(
    models: CopilotDiscoveredModel[],
    defaultModelId?: string,
    sourceContextKey?: string,
  ): Promise<unknown> | unknown;
}
export interface CopilotExecutionBackendOptions {
  readonly commandCatalog?: Pick<CopilotCommandCatalog, 'setCommandSnapshot'>;
  readonly modelCatalogCoordinator?: CopilotModelCatalogCoordinator;
  readonly nativeFactory?: CopilotExecutionNativeFactory;
}

export class CopilotExecutionBackend implements ProviderExecutionBackend {
  readonly providerId = 'copilot' as const;
  private readonly nativeFactory: CopilotExecutionNativeFactory;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly options: CopilotExecutionBackendOptions = {},
  ) {
    this.nativeFactory = options.nativeFactory ?? {
      create: nativeOptions => new CopilotExecutionNativeConnectionImpl(nativeOptions),
    };
  }

  createSession(config: ProviderSessionConfig): ProviderExecutionSession {
    return new CopilotExecutionSession(this.plugin, config, {
      commandCatalog: this.options.commandCatalog,
      modelCatalogCoordinator: this.options.modelCatalogCoordinator,
      nativeFactory: this.nativeFactory,
    });
  }
}

export type {
  CopilotExecutionNativeConnection,
  CopilotExecutionNativeFactory,
};
