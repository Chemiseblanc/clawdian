import type {
  AcpInitializeResponse,
  AcpListSessionsRequest,
  AcpListSessionsResponse,
  AcpLoadSessionRequest,
  AcpLoadSessionResponse,
  AcpNewSessionRequest,
  AcpNewSessionResponse,
  AcpPromptRequest,
  AcpPromptResponse,
  AcpRequestPermissionRequest,
  AcpRequestPermissionResponse,
  AcpSessionNotification,
  AcpSetSessionConfigOptionRequest,
  AcpSetSessionConfigOptionResponse,
  AcpSetSessionModelRequest,
  AcpSetSessionModelResponse,
  AcpSetSessionModeRequest,
  AcpSetSessionModeResponse,
} from '@/providers/acp';
import {
  AcpClientConnection,
  AcpJsonRpcTransport,
  AcpSubprocess,
} from '@/providers/acp';

export interface CopilotExecutionNativeCreateOptions {
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly requestPermission: (
    request: AcpRequestPermissionRequest,
    signal?: AbortSignal,
  ) => Promise<AcpRequestPermissionResponse>;
  readonly version?: string;
}

export interface CopilotExecutionNativeConnection {
  initialize(): Promise<void>;
  getInitializeResponse?(): AcpInitializeResponse | null;
  newSession(request: AcpNewSessionRequest): Promise<AcpNewSessionResponse>;
  loadSession(request: AcpLoadSessionRequest): Promise<AcpLoadSessionResponse>;
  listSessions(request?: AcpListSessionsRequest): Promise<AcpListSessionsResponse>;
  prompt(request: AcpPromptRequest): Promise<AcpPromptResponse>;
  cancel(sessionId: string): void;
  setMode(request: AcpSetSessionModeRequest): Promise<AcpSetSessionModeResponse>;
  setModel(request: AcpSetSessionModelRequest): Promise<AcpSetSessionModelResponse>;
  setConfigOption(
    request: AcpSetSessionConfigOptionRequest,
  ): Promise<AcpSetSessionConfigOptionResponse>;
  flush(): Promise<void>;
  isAlive(): boolean;
  onNotification(listener: (notification: AcpSessionNotification) => void | Promise<void>): () => void;
  shutdown(): Promise<void>;
}

export interface CopilotExecutionNativeFactory {
  create(options: CopilotExecutionNativeCreateOptions): CopilotExecutionNativeConnection;
}

/** Standard ACP stdio connection for the GitHub Copilot CLI. */
export class CopilotExecutionNativeConnectionImpl implements CopilotExecutionNativeConnection {
  private readonly connection: AcpClientConnection;
  private readonly process: AcpSubprocess;
  private readonly transport: AcpJsonRpcTransport;
  private readonly listeners = new Set<
    (notification: AcpSessionNotification) => void | Promise<void>
  >();
  private readonly unsubscribers: Array<() => void> = [];
  private initializeResponse: AcpInitializeResponse | null = null;

  constructor(options: CopilotExecutionNativeCreateOptions) {
    this.process = new AcpSubprocess({
      args: ['--acp', '--no-auto-update'],
      command: options.command,
      cwd: options.cwd,
      env: options.env,
    });
    this.process.start();

    this.transport = new AcpJsonRpcTransport({
      input: this.process.stdout,
      onClose: listener => this.process.onClose(listener),
      output: this.process.stdin,
    });
    this.transport.start();

    this.connection = new AcpClientConnection({
      clientInfo: {
        name: 'claudian',
        version: options.version ?? '0.0.0',
      },
      delegate: {
        onSessionNotification: notification => this.notify(notification),
        requestPermission: request => options.requestPermission(request, this.transport.signal),
      },
      transport: this.transport,
    });
  }

  async initialize(): Promise<void> {
    this.initializeResponse = await this.connection.initialize();
  }

  getInitializeResponse(): AcpInitializeResponse | null {
    return this.initializeResponse;
  }

  newSession(request: AcpNewSessionRequest): Promise<AcpNewSessionResponse> {
    return this.connection.newSession(request);
  }

  loadSession(request: AcpLoadSessionRequest): Promise<AcpLoadSessionResponse> {
    return this.connection.loadSession(request);
  }

  listSessions(request: AcpListSessionsRequest = {}): Promise<AcpListSessionsResponse> {
    return this.connection.listSessions(request);
  }

  prompt(request: AcpPromptRequest): Promise<AcpPromptResponse> {
    return this.connection.prompt(request);
  }

  cancel(sessionId: string): void {
    this.connection.cancel({ sessionId });
  }

  setMode(request: AcpSetSessionModeRequest): Promise<AcpSetSessionModeResponse> {
    return this.connection.setMode(request);
  }

  setModel(request: AcpSetSessionModelRequest): Promise<AcpSetSessionModelResponse> {
    return this.connection.setModel(request);
  }

  setConfigOption(
    request: AcpSetSessionConfigOptionRequest,
  ): Promise<AcpSetSessionConfigOptionResponse> {
    return this.connection.setConfigOption(request);
  }

  flush(): Promise<void> {
    return this.transport.flush();
  }

  isAlive(): boolean {
    return this.process.isAlive();
  }

  onNotification(
    listener: (notification: AcpSessionNotification) => void | Promise<void>,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async shutdown(): Promise<void> {
    while (this.unsubscribers.length > 0) this.unsubscribers.pop()?.();
    this.listeners.clear();
    this.connection.dispose();
    this.transport.dispose();
    await this.process.shutdown();
  }

  private async notify(notification: AcpSessionNotification): Promise<void> {
    for (const listener of this.listeners) await listener(notification);
  }
}
