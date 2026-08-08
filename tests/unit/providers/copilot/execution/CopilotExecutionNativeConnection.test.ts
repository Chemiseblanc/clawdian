import type {
  AcpLoadSessionRequest,
  AcpNewSessionRequest,
  AcpPromptRequest,
  AcpRequestPermissionRequest,
  AcpRequestPermissionResponse,
  AcpSessionNotification,
  AcpSetSessionConfigOptionRequest,
  AcpSetSessionModelRequest,
  AcpSetSessionModeRequest,
} from '@/providers/acp';

const mockAcpSubprocess = jest.fn();
const mockAcpJsonRpcTransport = jest.fn();
const mockAcpClientConnection = jest.fn();
const mockProcessStart = jest.fn();
const mockProcessShutdown = jest.fn();
const mockProcessIsAlive = jest.fn();
const mockProcessOnClose = jest.fn(() => jest.fn());
const mockTransportDispose = jest.fn();
const mockTransportFlush = jest.fn();
const mockTransportOnNotification = jest.fn(() => jest.fn());
const mockConnectionDispose = jest.fn();
const mockConnectionInitialize = jest.fn();
const mockConnectionNewSession = jest.fn();
const mockConnectionLoadSession = jest.fn();
const mockConnectionListSessions = jest.fn();
const mockConnectionPrompt = jest.fn();
const mockConnectionCancel = jest.fn();
const mockConnectionSetMode = jest.fn();
const mockConnectionSetModel = jest.fn();
const mockConnectionSetConfigOption = jest.fn();
const mockConnectionOnSessionNotification = jest.fn();
let connectionNotificationListener: (
  | ((notification: AcpSessionNotification) => void | Promise<void>)
  | null
) = null;
type MockConnectionOptions = {
  delegate?: {
    onSessionNotification?: (notification: AcpSessionNotification) => void | Promise<void>;
  };
};

jest.mock('@/providers/acp', () => {
  const actual = jest.requireActual('@/providers/acp');
  mockAcpSubprocess.mockImplementation((options) => ({
    ...options,
    isAlive: mockProcessIsAlive,
    onClose: mockProcessOnClose,
    shutdown: mockProcessShutdown,
    start: mockProcessStart,
    stdin: {},
    stdout: {},
  }));
  mockAcpJsonRpcTransport.mockImplementation(() => ({
    dispose: mockTransportDispose,
    flush: mockTransportFlush,
    onNotification: mockTransportOnNotification,
    onRequest: jest.fn(() => jest.fn()),
    onClose: jest.fn(() => jest.fn()),
    request: jest.fn(),
    start: jest.fn(),
  }));
  mockAcpClientConnection.mockImplementation((options) => {
    const typedOptions = options as MockConnectionOptions;
    connectionNotificationListener = typedOptions.delegate?.onSessionNotification ?? null;
    mockConnectionOnSessionNotification.mockImplementation((listener) => {
      connectionNotificationListener = listener;
      return jest.fn(() => { connectionNotificationListener = null; });
    });
    return {
      dispose: mockConnectionDispose,
      initialize: mockConnectionInitialize,
      loadSession: mockConnectionLoadSession,
      listSessions: mockConnectionListSessions,
      newSession: mockConnectionNewSession,
      onSessionNotification: mockConnectionOnSessionNotification,
      prompt: mockConnectionPrompt,
      cancel: mockConnectionCancel,
      setConfigOption: mockConnectionSetConfigOption,
      setMode: mockConnectionSetMode,
      setModel: mockConnectionSetModel,
    };
  });
  return {
    ...actual,
    AcpClientConnection: mockAcpClientConnection,
    AcpJsonRpcTransport: mockAcpJsonRpcTransport,
    AcpSubprocess: mockAcpSubprocess,
  };
});

import { CopilotExecutionNativeConnectionImpl } from '@/providers/copilot/execution/CopilotExecutionNativeConnection';

type NativeCreateOptions = {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  requestPermission: (
    request: AcpRequestPermissionRequest,
    signal?: AbortSignal,
  ) => Promise<AcpRequestPermissionResponse>;
  version: string;
};

function createOptions(
  overrides: Partial<NativeCreateOptions> = {},
): NativeCreateOptions {
  return {
    command: '/opt/copilot',
    cwd: '/vault',
    env: { COPILOT_TEST: '1' },
    requestPermission: jest.fn(async () => ({
      outcome: { outcome: 'selected' as const, optionId: 'allow_once' },
    })),
    version: '1.0.26',
    ...overrides,
  };
}

describe('CopilotExecutionNativeConnectionImpl', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    connectionNotificationListener = null;
    mockProcessShutdown.mockResolvedValue(undefined);
    mockProcessIsAlive.mockReturnValue(true);
    mockTransportFlush.mockResolvedValue(undefined);
    mockConnectionInitialize.mockResolvedValue({
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: true } },
    });
    mockConnectionNewSession.mockResolvedValue({ sessionId: 'new-session' });
    mockConnectionLoadSession.mockResolvedValue({ sessionId: 'loaded-session' });
    mockConnectionListSessions.mockResolvedValue({ sessions: [] });
    mockConnectionPrompt.mockResolvedValue({ stopReason: 'end_turn' });
    mockConnectionSetMode.mockResolvedValue({});
    mockConnectionSetModel.mockResolvedValue({});
    mockConnectionSetConfigOption.mockResolvedValue({ configOptions: [] });
  });

  it('launches exactly copilot ACP mode and forwards standard ACP lifecycle methods', async () => {
    const native = new CopilotExecutionNativeConnectionImpl(createOptions());

    expect(mockAcpSubprocess).toHaveBeenCalledWith({
      args: ['--acp', '--no-auto-update'],
      command: '/opt/copilot',
      cwd: '/vault',
      env: { COPILOT_TEST: '1' },
    });
    expect(mockProcessStart).toHaveBeenCalledTimes(1);

    await native.initialize();
    const newRequest: AcpNewSessionRequest = { cwd: '/vault', mcpServers: [] };
    const loadRequest: AcpLoadSessionRequest = { ...newRequest, sessionId: 'saved-session' };
    await native.newSession(newRequest);
    await native.loadSession(loadRequest);
    await native.listSessions({ cwd: '/vault' });
    const prompt: AcpPromptRequest = {
      prompt: [{ text: 'hello', type: 'text' }],
      sessionId: 'new-session',
    };
    await native.prompt(prompt);

    expect(mockConnectionInitialize).toHaveBeenCalledTimes(1);
    expect(mockConnectionNewSession).toHaveBeenCalledWith(newRequest);
    expect(mockConnectionLoadSession).toHaveBeenCalledWith(loadRequest);
    expect(mockConnectionListSessions).toHaveBeenCalledWith({ cwd: '/vault' });
    expect(mockConnectionPrompt).toHaveBeenCalledWith(prompt);
  });

  it('routes model, mode, reasoning configuration, cancellation, and flush through standard ACP methods', async () => {
    const native = new CopilotExecutionNativeConnectionImpl(createOptions());
    const sessionId = 'session-1';
    const model: AcpSetSessionModelRequest = { modelId: 'gpt-5', sessionId };
    const mode: AcpSetSessionModeRequest = { modeId: 'plan#agent', sessionId };
    const reasoning: AcpSetSessionConfigOptionRequest = {
      configId: 'reasoning_effort',
      sessionId,
      type: 'select',
      value: 'high',
    };

    await native.setModel(model);
    await native.setMode(mode);
    await native.setConfigOption(reasoning);
    native.cancel(sessionId);
    await native.flush();

    expect(mockConnectionSetModel).toHaveBeenCalledWith(model);
    expect(mockConnectionSetMode).toHaveBeenCalledWith(mode);
    expect(mockConnectionSetConfigOption).toHaveBeenCalledWith(reasoning);
    expect(mockConnectionCancel).toHaveBeenCalledWith({ sessionId });
    expect(mockTransportFlush).toHaveBeenCalledTimes(1);
  });

  it('forwards standard session notifications and shuts down every acquired resource', async () => {
    const listener = jest.fn();
    const native = new CopilotExecutionNativeConnectionImpl(createOptions());
    native.onNotification(listener);
    const notification: AcpSessionNotification = {
      sessionId: 'session-1',
      update: {
        content: { text: 'live', type: 'text' },
        messageId: 'message-1',
        sessionUpdate: 'agent_message_chunk',
      },
    };
    void connectionNotificationListener?.(notification);
    expect(listener).toHaveBeenCalledWith(notification);
    expect(native.isAlive()).toBe(true);

    await native.shutdown();

    expect(mockConnectionDispose).toHaveBeenCalledTimes(1);
    expect(mockTransportDispose).toHaveBeenCalledTimes(1);
    expect(mockProcessShutdown).toHaveBeenCalledTimes(1);
  });
});
