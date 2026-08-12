import type { App } from 'obsidian';

import type { ManagedMcpServer } from '@/core/types';
import { McpServerModal } from '@/shared/settings/McpServerModal';

type ModalInternals = {
  command: string;
  env: string;
  serverName: string;
  serverType: 'stdio' | 'http' | 'sse';
  save(): Promise<void>;
};

describe('McpServerModal', () => {
  it('preserves iCloud paths as single arguments when an existing server is saved', async () => {
    const iCloudPath =
      '/Users/alice/Library/Mobile Documents/iCloud~md~obsidian/Documents/My Vault/server.js';
    const existingServer: ManagedMcpServer = {
      name: 'icloud-server',
      config: {
        command: 'node',
        args: [iCloudPath, '--verbose'],
      },
      enabled: true,
      contextSaving: false,
    };
    const onSave = jest.fn();
    const modal = new McpServerModal({} as App, existingServer, onSave);
    const testModal = modal as unknown as ModalInternals;

    expect(testModal.command).toContain(`"${iCloudPath}"`);

    await testModal.save();

    expect(onSave).toHaveBeenCalledWith(existingServer);
  });

  it('serializes portable stdio output exactly and parses values after the first equals', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    const modal = new McpServerModal(
      {} as App,
      null,
      onSave,
      'stdio',
      undefined,
      { portable: true }
    );
    const testModal = modal as unknown as ModalInternals;
    Object.assign(testModal, {
      serverName: 'portable_server',
      command: 'node "server.js" --stdio',
      env: 'TOKEN=left=right\nEMPTY=',
    });

    await testModal.save();

    expect(onSave).toHaveBeenCalledWith({
      name: 'portable_server',
      config: {
        type: 'stdio',
        command: 'node',
        args: ['server.js', '--stdio'],
        env: { TOKEN: 'left=right', EMPTY: '' },
      },
      enabled: true,
      contextSaving: false,
    });
  });

  it('rejects reserved portable names', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    const modal = new McpServerModal({} as App, null, onSave, 'stdio', undefined, {
      portable: true,
    });
    const testModal = modal as unknown as ModalInternals;
    Object.assign(testModal, { serverName: 'workspace', command: 'node' });

    await testModal.save();

    expect(onSave).not.toHaveBeenCalled();
  });

  it('retains input and stays open when async persistence rejects', async () => {
    const onSave = jest.fn().mockRejectedValue(new Error('write failed'));
    const modal = new McpServerModal({} as App, null, onSave, 'stdio', undefined, {
      portable: true,
    });
    const close = jest.spyOn(modal, 'close');
    const testModal = modal as unknown as ModalInternals;
    Object.assign(testModal, {
      serverName: 'portable_server',
      command: 'node server.js',
      env: 'TOKEN=keep-me',
    });

    await testModal.save();

    expect(close).not.toHaveBeenCalled();
    expect(testModal.serverName).toBe('portable_server');
    expect(testModal.command).toBe('node server.js');
    expect(testModal.env).toBe('TOKEN=keep-me');
  });

  it('preserves same-transport extension fields and removes incompatible fields on switch', async () => {
    const extendedConfig = {
      type: 'http' as const,
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer old' },
      extension: { keep: true },
    };
    const existingServer: ManagedMcpServer = {
      name: 'extended',
      config: extendedConfig,
      enabled: true,
      contextSaving: false,
    };
    const onSave = jest.fn().mockResolvedValue(undefined);
    const modal = new McpServerModal({} as App, existingServer, onSave, undefined, undefined, {
      portable: true,
    });
    const testModal = modal as unknown as ModalInternals;
    Object.assign(testModal, { serverType: 'stdio', command: 'node server.js', env: '' });

    await testModal.save();

    expect(onSave).toHaveBeenCalledWith({
      name: 'extended',
      config: {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        extension: { keep: true },
      },
      enabled: true,
      contextSaving: false,
    });
  });
});
