import { MCP_CONFIG_PATH, McpStorage } from '@/app/storage/McpStorage';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { ManagedMcpServer } from '@/core/types';

type MockAdapter = VaultFileAdapter & { files: Record<string, string> };

function createMockAdapter(initial: Record<string, string> = {}): MockAdapter {
  const files = { ...initial };
  return {
    files,
    exists: async (path: string) => Object.prototype.hasOwnProperty.call(files, path),
    read: async (path: string) => {
      if (!Object.prototype.hasOwnProperty.call(files, path)) throw new Error(`Missing ${path}`);
      return files[path];
    },
    write: async (path: string, content: string) => {
      files[path] = content;
    },
  } as unknown as MockAdapter;
}

function server(name: string, config: ManagedMcpServer['config']): ManagedMcpServer {
  return { name, config, enabled: true, contextSaving: false };
}

function configWithExtensions(
  config: ManagedMcpServer['config'],
  extensions: Record<string, unknown>,
): ManagedMcpServer['config'] {
  return { ...config, ...extensions } as ManagedMcpServer['config'];
}

describe('app-owned McpStorage', () => {
  it('uses the vault root and leaves legacy provider storage untouched', async () => {
    const legacy = '{"mcpServers":{"legacy":{"type":"stdio","command":"old"}}}';
    const adapter = createMockAdapter({ '.claude/mcp.json': legacy });
    const storage = new McpStorage(adapter);

    expect(await storage.load()).toEqual([]);
    await storage.mutate({
      type: 'upsert',
      server: server('root', { type: 'stdio', command: 'new' }),
    });

    expect(adapter.files['.claude/mcp.json']).toBe(legacy);
    expect(JSON.parse(adapter.files[MCP_CONFIG_PATH]).mcpServers.root).toEqual({
      type: 'stdio',
      command: 'new',
    });
  });

  it('round-trips explicit portable transports with runtime-only defaults', async () => {
    const adapter = createMockAdapter();
    const storage = new McpStorage(adapter);
    await storage.mutate({
      type: 'import',
      servers: [
        server('local', { type: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: 'x' } }),
        server('events', { type: 'sse', url: 'https://example.test/events', headers: { Authorization: 'x' } }),
        server('remote', { type: 'http', url: 'https://example.test/mcp' }),
      ],
    });

    const saved = JSON.parse(adapter.files[MCP_CONFIG_PATH]);
    expect(saved._claudian).toBeUndefined();
    expect(await storage.load()).toEqual([
      { name: 'local', config: saved.mcpServers.local, enabled: true, contextSaving: false },
      { name: 'events', config: saved.mcpServers.events, enabled: true, contextSaving: false },
      { name: 'remote', config: saved.mcpServers.remote, enabled: true, contextSaving: false },
    ]);
  });

  it('rejects malformed bytes and entries without overwriting them', async () => {
    const malformed = '{not json';
    const malformedAdapter = createMockAdapter({ [MCP_CONFIG_PATH]: malformed });
    const malformedStorage = new McpStorage(malformedAdapter);
    await expect(malformedStorage.load()).rejects.toThrow('.mcp.json');
    await expect(malformedStorage.mutate({
      type: 'delete',
      name: 'missing',
    })).rejects.toThrow('.mcp.json');
    expect(malformedAdapter.files[MCP_CONFIG_PATH]).toBe(malformed);

    const invalidEntry = JSON.stringify({
      mcpServers: {
        valid: { type: 'stdio', command: 'ok' },
        invalid: { type: 'stdio', command: '' },
      },
    });
    const invalidAdapter = createMockAdapter({ [MCP_CONFIG_PATH]: invalidEntry });
    const invalidStorage = new McpStorage(invalidAdapter);
    await expect(invalidStorage.load()).rejects.toThrow('.mcp.json');
    await expect(invalidStorage.mutate({
      type: 'upsert',
      server: server('other', { type: 'stdio', command: 'other' }),
    })).rejects.toThrow('.mcp.json');
    expect(invalidAdapter.files[MCP_CONFIG_PATH]).toBe(invalidEntry);
  });

  it('preserves top-level and same-transport extensions while removing incompatible fields', async () => {
    const initial = JSON.stringify({
      customTopLevel: { keep: true },
      _claudian: { ignored: true },
      mcpServers: {
        alpha: {
          type: 'stdio',
          command: 'old',
          args: ['old'],
          customEntry: { keep: true },
        },
      },
    });
    const adapter = createMockAdapter({ [MCP_CONFIG_PATH]: initial });
    const storage = new McpStorage(adapter);

    await storage.mutate({
      type: 'upsert',
      previousName: 'alpha',
      server: server('alpha', { type: 'stdio', command: 'new' }),
    });
    let saved = JSON.parse(adapter.files[MCP_CONFIG_PATH]);
    expect(saved.customTopLevel).toEqual({ keep: true });
    expect(saved._claudian).toEqual({ ignored: true });
    expect(saved.mcpServers.alpha).toEqual({
      type: 'stdio',
      command: 'new',
      customEntry: { keep: true },
    });

    await storage.mutate({
      type: 'upsert',
      previousName: 'alpha',
      server: server('alpha', { type: 'http', url: 'https://example.test/mcp' }),
    });
    saved = JSON.parse(adapter.files[MCP_CONFIG_PATH]);
    expect(saved.mcpServers.alpha).toEqual({
      type: 'http',
      url: 'https://example.test/mcp',
      customEntry: { keep: true },
    });
  });

  it('serializes deltas against the latest on-disk object', async () => {
    const adapter = createMockAdapter();
    const storage = new McpStorage(adapter);
    const first = storage.mutate({
      type: 'upsert',
      server: server('first', { type: 'stdio', command: 'one' }),
    });
    const second = storage.mutate({
      type: 'upsert',
      server: server('second', { type: 'stdio', command: 'two' }),
    });
    await Promise.all([first, second]);

    expect(Object.keys(JSON.parse(adapter.files[MCP_CONFIG_PATH]).mcpServers)).toEqual([
      'first',
      'second',
    ]);
  });

  it('rejects a stale create when the latest file gained the destination', async () => {
    const adapter = createMockAdapter({
      [MCP_CONFIG_PATH]: JSON.stringify({ mcpServers: {} }),
    });
    const storage = new McpStorage(adapter);
    await storage.load();

    const latest = JSON.stringify({
      mcpServers: {
        shared: { type: 'stdio', command: 'external' },
      },
    });
    adapter.files[MCP_CONFIG_PATH] = latest;

    await expect(storage.mutate({
      type: 'upsert',
      server: server('shared', { type: 'stdio', command: 'stale' }),
    })).rejects.toThrow('already exists');
    expect(adapter.files[MCP_CONFIG_PATH]).toBe(latest);
  });

  it('renames from the latest old-name entry and preserves external extensions', async () => {
    const initial = JSON.stringify({
      mcpServers: {
        original: {
          type: 'stdio',
          command: 'old',
          extension: { version: 1 },
        },
      },
    });
    const adapter = createMockAdapter({ [MCP_CONFIG_PATH]: initial });
    const storage = new McpStorage(adapter);
    await storage.load();

    adapter.files[MCP_CONFIG_PATH] = JSON.stringify({
      mcpServers: {
        original: {
          type: 'stdio',
          command: 'external',
          extension: { version: 2 },
        },
      },
    });

    await storage.mutate({
      type: 'upsert',
      previousName: 'original',
      server: server('renamed', configWithExtensions(
        { type: 'stdio', command: 'new' },
        { extension: { version: 1 } },
      )),
    });

    expect(JSON.parse(adapter.files[MCP_CONFIG_PATH]).mcpServers).toEqual({
      renamed: {
        type: 'stdio',
        command: 'new',
        extension: { version: 2 },
      },
    });
  });

  it('keeps a changed latest extension when editing portable fields', async () => {
    const initial = JSON.stringify({
      mcpServers: {
        editable: {
          type: 'stdio',
          command: 'old',
          extension: { version: 1 },
        },
      },
    });
    const adapter = createMockAdapter({ [MCP_CONFIG_PATH]: initial });
    const storage = new McpStorage(adapter);
    await storage.load();

    adapter.files[MCP_CONFIG_PATH] = JSON.stringify({
      mcpServers: {
        editable: {
          type: 'stdio',
          command: 'external',
          extension: { version: 2 },
        },
      },
    });

    await storage.mutate({
      type: 'upsert',
      previousName: 'editable',
      server: server('editable', configWithExtensions(
        { type: 'stdio', command: 'new' },
        { extension: { version: 1 } },
      )),
    });

    expect(JSON.parse(adapter.files[MCP_CONFIG_PATH]).mcpServers.editable).toEqual({
      type: 'stdio',
      command: 'new',
      extension: { version: 2 },
    });
  });

  it('rejects mixed-invalid imports atomically', async () => {
    const existing = JSON.stringify({
      mcpServers: { existing: { type: 'stdio', command: 'keep' } },
    });
    const adapter = createMockAdapter({ [MCP_CONFIG_PATH]: existing });
    const storage = new McpStorage(adapter);

    await expect(storage.mutate({
      type: 'import',
      servers: [
        server('valid', { type: 'stdio', command: 'ok' }),
        server('invalid', { type: 'http', url: 'file:///not-portable' }),
      ],
    })).rejects.toThrow('.mcp.json');
    expect(adapter.files[MCP_CONFIG_PATH]).toBe(existing);
  });
});
