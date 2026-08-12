import { Notice } from 'obsidian';

import { type McpTestResult,testMcpServer } from '@/core/mcp/McpTester';
import { NotifiedMutationError } from '@/core/storage/NotifiedMutationError';
import type { ManagedMcpServer } from '@/core/types';
import { McpSettingsManager } from '@/shared/settings/McpSettingsManager';
import { McpTestModal } from '@/shared/settings/McpTestModal';

jest.mock('@/core/mcp/McpTester', () => ({
  testMcpServer: jest.fn(),
}));
const mockedTestMcpServer = jest.mocked(testMcpServer);

jest.mock('@/shared/settings/McpTestModal', () => {
  class MockMcpTestModal {
    open(): void {}

    setResult(_result: McpTestResult): void {}

    setError(_error: string): void {}
  }

  return { McpTestModal: MockMcpTestModal };
});

type TestManager = {
  servers: ManagedMcpServer[];
  containerEl: {
    ownerDocument: {
      removeEventListener: jest.Mock;
    };
  };
  mcpStorage: {
    load: jest.Mock;
    mutate: jest.Mock;
  };
  broadcastMcpReload: jest.Mock;
  render: jest.Mock;
  loadError: Error | null;
  mutationQueue: Promise<void>;
  saveServer: (server: ManagedMcpServer, existing: ManagedMcpServer | null) => Promise<void>;
  importPastedConfig: (text: string) => Promise<boolean>;
  loadAndRender: () => Promise<void>;
  testServer: (server: ManagedMcpServer) => Promise<void>;
  dispose: () => void;
  getServerPreview: (server: ManagedMcpServer, type: 'stdio') => string;
};
function createManager(overrides: Record<string, unknown> = {}): TestManager {
  const manager = Object.create(McpSettingsManager.prototype) as TestManager;
  Object.assign(manager, {
    app: {},
    containerEl: {
      ownerDocument: {
        removeEventListener: jest.fn(),
      },
    },
    mcpStorage: {
      load: jest.fn().mockResolvedValue([]),
      mutate: jest.fn().mockResolvedValue(undefined),
    },
    broadcastMcpReload: jest.fn().mockResolvedValue(undefined),
    render: jest.fn(),
    servers: [],
    loadError: null,
    loadGeneration: 0,
    disposed: false,
    mutationQueue: Promise.resolve(),
    portable: true,
    ...overrides,
  });
  return manager;
}

function stdioServer(name: string): ManagedMcpServer {
  return {
    name,
    config: { type: 'stdio', command: name },
    enabled: true,
    contextSaving: false,
  };
}

describe('McpSettingsManager portable persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedTestMcpServer.mockReset();
  });

  it('uses an upsert delta and restores local state when persistence fails', async () => {
    const manager = createManager({
      mcpStorage: {
        load: jest.fn().mockResolvedValue([]),
        mutate: jest.fn().mockRejectedValue(new NotifiedMutationError('invalid JSON')),
      },
    });

    await expect(manager.saveServer(stdioServer('alpha'), null)).rejects.toThrow('invalid JSON');

    expect(manager.servers).toEqual([]);
    expect(manager.mcpStorage.mutate).toHaveBeenCalledWith({
      type: 'upsert',
      server: stdioServer('alpha'),
    });
  });

  it('keeps a committed save when runtime reload fails', async () => {
    const broadcastMcpReload = jest.fn().mockRejectedValue(new Error('reload failed'));
    const manager = createManager({ broadcastMcpReload });

    await manager.saveServer(stdioServer('alpha'), null);

    expect(manager.servers).toEqual([stdioServer('alpha')]);
    expect(manager.mcpStorage.mutate).toHaveBeenCalledTimes(1);
    expect(Notice).toHaveBeenCalledWith(
      'Setting saved but reload failed. Changes will apply on next session.',
    );
  });

  it('serializes concurrent successful saves into one displayed snapshot', async () => {
    let releaseFirst!: () => void;
    const firstPersist = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const mutate = jest.fn()
      .mockImplementationOnce(() => firstPersist)
      .mockResolvedValue(undefined);
    const manager = createManager({
      mcpStorage: { load: jest.fn(), mutate },
    });

    const firstSave = manager.saveServer(stdioServer('alpha'), null);
    const secondSave = manager.saveServer(stdioServer('beta'), null);
    await Promise.resolve();

    expect(mutate).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([firstSave, secondSave]);

    expect(manager.servers).toEqual([stdioServer('alpha'), stdioServer('beta')]);
  });

  it('imports every valid entry atomically with one delta', async () => {
    const manager = createManager();

    await expect(manager.importPastedConfig(JSON.stringify({
      mcpServers: {
        alpha: { type: 'stdio', command: 'alpha' },
        beta: { type: 'http', url: 'https://example.test/mcp' },
      },
    }))).resolves.toBe(true);

    expect(manager.mcpStorage.mutate).toHaveBeenCalledWith({
      type: 'import',
      servers: [
        stdioServer('alpha'),
        {
          name: 'beta',
          config: { type: 'http', url: 'https://example.test/mcp' },
          enabled: true,
          contextSaving: false,
        },
      ],
    });
  });

  it('rejects mixed-validity imports without writing a partial result', async () => {
    const mutate = jest.fn().mockResolvedValue(undefined);
    const manager = createManager({ mcpStorage: { load: jest.fn(), mutate } });

    await expect(manager.importPastedConfig(JSON.stringify({
      mcpServers: {
        alpha: { type: 'stdio', command: 'alpha' },
        broken: { type: 'http', url: 'not-absolute' },
      },
    }))).resolves.toBe(false);

    expect(mutate).not.toHaveBeenCalled();
    expect(manager.servers).toEqual([]);
  });

  it('rejects reserved and malformed portable names before mutation', async () => {
    const mutate = jest.fn().mockResolvedValue(undefined);
    const manager = createManager({ mcpStorage: { load: jest.fn(), mutate } });

    await expect(manager.importPastedConfig(JSON.stringify({
      mcpServers: {
        workspace: { type: 'stdio', command: 'alpha' },
      },
    }))).resolves.toBe(false);
    await expect(manager.importPastedConfig(JSON.stringify({
      mcpServers: {
        'has.dot': { type: 'stdio', command: 'alpha' },
      },
    }))).resolves.toBe(false);

    expect(mutate).not.toHaveBeenCalled();
  });
});

  it('opens verification before the asynchronous server test starts', async () => {
    const events: string[] = [];
    mockedTestMcpServer.mockImplementation(() => {
      events.push('verify');
      return Promise.resolve({ success: true, tools: [] } satisfies McpTestResult);
    });
    const open = jest.spyOn(McpTestModal.prototype, 'open').mockImplementation(() => {
      events.push('open');
    });
    const manager = createManager();

    await manager.testServer(stdioServer('alpha'));

    expect(events).toEqual(['open', 'verify']);
    open.mockRestore();
  });

describe('McpSettingsManager asynchronous lifecycle', () => {
  it('does not let an older refresh overwrite a newer result', async () => {
    let resolveFirst!: (servers: ManagedMcpServer[]) => void;
    let resolveSecond!: (servers: ManagedMcpServer[]) => void;
    const first = new Promise<ManagedMcpServer[]>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<ManagedMcpServer[]>((resolve) => {
      resolveSecond = resolve;
    });
    const load = jest.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const manager = createManager({ mcpStorage: { load, mutate: jest.fn() } });

    const firstRefresh = manager.loadAndRender();
    const secondRefresh = manager.loadAndRender();
    resolveSecond([stdioServer('newer')]);
    await secondRefresh;
    resolveFirst([stdioServer('older')]);
    await firstRefresh;

    expect(manager.servers).toEqual([stdioServer('newer')]);
  });

  it('enters a stable read-only error state when loading fails', async () => {
    const manager = createManager({
      mcpStorage: {
        load: jest.fn().mockRejectedValue(new Error('malformed .mcp.json')),
        mutate: jest.fn(),
      },
    });

    await manager.loadAndRender();

    expect(manager.loadError?.message).toBe('malformed .mcp.json');
    await expect(manager.saveServer(stdioServer('alpha'), null)).rejects.toThrow(
      '.mcp.json cannot be read',
    );
    expect(manager.mcpStorage.mutate).not.toHaveBeenCalled();
  });

  it('does not update after disposal while a refresh is pending', async () => {
    let resolveLoad!: (servers: ManagedMcpServer[]) => void;
    const loadPromise = new Promise<ManagedMcpServer[]>((resolve) => {
      resolveLoad = resolve;
    });
    const manager = createManager({
      mcpStorage: { load: jest.fn().mockReturnValue(loadPromise), mutate: jest.fn() },
    });
    const refresh = manager.loadAndRender();
    manager.dispose();
    resolveLoad([stdioServer('late')]);
    await refresh;

    expect(manager.servers).toEqual([]);
    expect(manager.render).not.toHaveBeenCalled();
  });
  it('still reloads runtimes when disposed during persistence', async () => {
    let releasePersistence!: () => void;
    const persistence = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const mutate = jest.fn().mockReturnValue(persistence);
    const broadcastMcpReload = jest.fn().mockResolvedValue(undefined);
    const manager = createManager({
      mcpStorage: { load: jest.fn(), mutate },
      broadcastMcpReload,
    });

    const save = manager.saveServer(stdioServer('alpha'), null);
    await Promise.resolve();
    manager.dispose();
    releasePersistence();
    await save;

    expect(broadcastMcpReload).toHaveBeenCalledTimes(1);
    expect(manager.servers).toEqual([]);
    expect(manager.render).not.toHaveBeenCalled();
  });

});

describe('McpSettingsManager server previews', () => {
  it('shows argument boundaries for stdio paths containing spaces', () => {
    const manager = createManager() as TestManager & {
      getServerPreview: (server: ManagedMcpServer, type: 'stdio') => string;
    };
    const iCloudPath =
      '/Users/alice/Library/Mobile Documents/iCloud~md~obsidian/Documents/My Vault/server.js';

    const preview = manager.getServerPreview(
      {
        ...stdioServer('icloud-server'),
        config: { type: 'stdio', command: 'node', args: [iCloudPath, '--verbose'] },
      },
      'stdio',
    );

    expect(preview).toBe(`node "${iCloudPath}" --verbose`);
  });
});
