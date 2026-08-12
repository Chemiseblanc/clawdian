import type {
  AcpRequestPermissionRequest,
  AcpRequestPermissionResponse,
} from '@/providers/acp';

const mockAcpSubprocess = jest.fn();
const mockAcpJsonRpcTransport = jest.fn();
const mockAcpClientConnection = jest.fn();
const mockProcessShutdown = jest.fn();
const mockTransportDispose = jest.fn();
const mockTransportRequest = jest.fn();
const mockConnectionDispose = jest.fn();

jest.mock('@/providers/acp', () => {
  const actual = jest.requireActual('@/providers/acp');
  mockAcpSubprocess.mockImplementation(() => ({
    isAlive: jest.fn(() => true),
    onClose: jest.fn(() => jest.fn()),
    shutdown: mockProcessShutdown,
    start: jest.fn(),
    stdin: {},
    stdout: {},
  }));
  mockAcpJsonRpcTransport.mockImplementation(() => ({
    dispose: mockTransportDispose,
    flush: jest.fn(async () => undefined),
    onNotification: jest.fn(() => jest.fn()),
    onRequest: jest.fn(() => jest.fn()),
    request: mockTransportRequest,
  }));
  mockAcpClientConnection.mockImplementation(() => ({
    dispose: mockConnectionDispose,
  }));
  return {
    ...actual,
    AcpClientConnection: mockAcpClientConnection,
    AcpJsonRpcTransport: mockAcpJsonRpcTransport,
    AcpSubprocess: mockAcpSubprocess,
  };
});

import { GrokExecutionNativeConnectionImpl } from '@/providers/grok/execution/GrokExecutionNativeConnection';

describe('GrokExecutionNativeConnectionImpl', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProcessShutdown.mockResolvedValue(undefined);
    mockTransportRequest.mockResolvedValue({
      commands: [{ description: 'Review changes', name: 'review' }],
    });
  });

  it('loads commands through the supported Grok extension method', async () => {
    const requestPermission = jest.fn(async (
      _request: AcpRequestPermissionRequest,
    ): Promise<AcpRequestPermissionResponse> => ({
      outcome: { outcome: 'cancelled' },
    }));
    const native = new GrokExecutionNativeConnectionImpl({
      command: '/configured/grok',
      cwd: '/vault',
      env: {},
      requestExtension: jest.fn(async () => undefined),
      requestPermission,
      version: 'test',
    });
    const signal = new AbortController().signal;

    await expect(native.listCommands('/vault', signal)).resolves.toEqual([
      expect.objectContaining({ name: 'review' }),
    ]);
    expect(mockTransportRequest).toHaveBeenCalledWith(
      '_x.ai/commands/list',
      { cwd: '/vault' },
      { signal, timeoutMs: 5_000 },
    );

    await native.shutdown();
  });
});
