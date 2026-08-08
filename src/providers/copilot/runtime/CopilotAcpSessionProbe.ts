import type {
  AcpInitializeResponse,
  AcpSessionConfigOption,
  AcpSessionModelState,
  AcpSessionModeState,
} from '@/providers/acp';

import {
  type CopilotExecutionNativeConnection,
  CopilotExecutionNativeConnectionImpl,
  type CopilotExecutionNativeCreateOptions,
} from '../execution/CopilotExecutionNativeConnection';
import type {
  CopilotAcpSessionProbeRequest,
  CopilotAcpSessionProbeResult,
} from './CopilotModelCatalogService';

export interface CopilotAcpSessionProbeOptions {
  readonly createConnection?: (
    options: CopilotExecutionNativeCreateOptions,
  ) => CopilotExecutionNativeConnection;
}

/**
 * Negotiates Copilot's ACP metadata in a short-lived, non-history session.
 * The session is never listed or retained by this helper.
 */
export class CopilotAcpSessionProbe {
  private readonly createConnection: (
    options: CopilotExecutionNativeCreateOptions,
  ) => CopilotExecutionNativeConnection;

  constructor(options: CopilotAcpSessionProbeOptions = {}) {
    this.createConnection = options.createConnection
      ?? (connectionOptions => new CopilotExecutionNativeConnectionImpl(connectionOptions));
  }

  async probe(request: CopilotAcpSessionProbeRequest): Promise<CopilotAcpSessionProbeResult> {
    if (request.signal?.aborted) {
      throw new DOMException('The operation was aborted', 'AbortError');
    }

    const connection = this.createConnection({
      command: request.command,
      cwd: request.cwd,
      env: request.env,
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      version: request.version,
    });

    try {
      await connection.initialize();
      if (request.signal?.aborted) {
        throw new DOMException('The operation was aborted', 'AbortError');
      }

      const session = await connection.newSession({ cwd: request.cwd, mcpServers: [] });
      return createProbeResult(
        connection.getInitializeResponse?.() ?? null,
        session.models,
        session.modes,
        session.configOptions,
      );
    } finally {
      await connection.shutdown();
    }
  }
}

function createProbeResult(
  initializeResponse: AcpInitializeResponse | null,
  models: AcpSessionModelState | null | undefined,
  modes: AcpSessionModeState | null | undefined,
  configOptions: AcpSessionConfigOption[] | null | undefined,
): CopilotAcpSessionProbeResult {
  const currentModelId = models?.currentModelId ?? findCurrentModel(configOptions);
  const version = initializeResponse?.agentInfo?.version?.trim() || null;

  return {
    agentInfo: initializeResponse?.agentInfo ?? null,
    configOptions: configOptions ?? null,
    defaultModelId: currentModelId ?? null,
    models: models ?? null,
    modes: modes ?? null,
    version,
  };
}

function findCurrentModel(options: AcpSessionConfigOption[] | null | undefined): string | null {
  const modelOption = options?.find(option => (
    option.type === 'select'
      && (option.id.trim().toLowerCase() === 'model'
        || option.category?.trim().toLowerCase() === 'model')
  ));
  return modelOption?.type === 'select' ? modelOption.currentValue : null;
}
