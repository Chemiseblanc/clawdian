import type { App } from 'obsidian';
import { Notice, setIcon } from 'obsidian';

import type { AppMcpStorage, McpConfigMutation } from '../../core/bootstrap/storage';
import {
  assertPortableMcpServerName,
  isPortableMcpServerConfig,
  parseClipboardConfig,
} from '../../core/mcp/McpConfigParser';
import { testMcpServer } from '../../core/mcp/McpTester';
import { isNotifiedMutationError } from '../../core/storage/NotifiedMutationError';
import type { ManagedMcpServer, McpServerConfig, McpServerType } from '../../core/types';
import { getMcpServerType } from '../../core/types';
import { formatCommand } from '../../utils/mcp';
import { confirmDelete } from '../modals/ConfirmModal';
import { McpImportModal } from './McpImportModal';
import { McpServerModal } from './McpServerModal';
import { McpTestModal } from './McpTestModal';
const PORTABLE_DEFAULTS = {
  enabled: true,
  contextSaving: false,
} as const;

export interface McpSettingsManagerDeps {
  app: App;
  mcpStorage: AppMcpStorage;
  broadcastMcpReload: () => Promise<void>;
}

export interface McpSettingsManagerOptions {
  portable?: boolean;
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

export class McpSettingsManager {
  private app: App;
  private containerEl: HTMLElement;
  private mcpStorage: AppMcpStorage;
  private broadcastMcpReload: () => Promise<void>;
  private portable: boolean;
  private servers: ManagedMcpServer[] = [];
  private loadError: Error | null = null;
  private loadGeneration = 0;
  private disposed = false;
  private mutationQueue: Promise<void> = Promise.resolve();
  private outsideClickHandler: (() => void) | null = null;

  constructor(
    containerEl: HTMLElement,
    deps: McpSettingsManagerDeps,
    options: McpSettingsManagerOptions = {},
  ) {
    this.app = deps.app;
    this.containerEl = containerEl;
    this.mcpStorage = deps.mcpStorage;
    this.broadcastMcpReload = deps.broadcastMcpReload;
    this.portable = options.portable ?? true;
    void this.loadAndRender();
  }

  private async loadAndRender(): Promise<void> {
    const generation = ++this.loadGeneration;
    try {
      const servers = await this.mcpStorage.load();
      if (this.disposed || generation !== this.loadGeneration) return;
      this.servers = servers;
      this.loadError = null;
      this.render();
    } catch (error) {
      if (this.disposed || generation !== this.loadGeneration) return;
      this.servers = [];
      this.loadError = asError(error, 'Unable to read .mcp.json');
      this.render();
    }
  }

  private render() {
    if (this.disposed) return;
    if (this.outsideClickHandler) {
      const doc = this.containerEl.ownerDocument;
      doc?.removeEventListener('click', this.outsideClickHandler);
      this.outsideClickHandler = null;
    }
    this.containerEl.empty();

    const headerEl = this.containerEl.createDiv({ cls: 'claudian-mcp-header' });
    headerEl.createSpan({ text: 'MCP Servers', cls: 'claudian-mcp-label' });

    if (this.loadError) {
      const errorEl = this.containerEl.createDiv({
        cls: 'claudian-mcp-error',
        attr: { role: 'alert' },
      });
      errorEl.createEl('strong', { text: 'Unable to read .mcp.json' });
      errorEl.createDiv({
        text: this.loadError.message || 'The MCP configuration is read-only until it can be read.',
      });
      return;
    }

    const addContainer = headerEl.createDiv({ cls: 'claudian-mcp-add-container' });
    const addBtn = addContainer.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { 'aria-label': 'Add' },
    });
    setIcon(addBtn, 'plus');

    const dropdown = addContainer.createDiv({ cls: 'claudian-mcp-add-dropdown' });

    const stdioOption = dropdown.createDiv({ cls: 'claudian-mcp-add-option' });
    setIcon(stdioOption.createSpan({ cls: 'claudian-mcp-add-option-icon' }), 'terminal');
    stdioOption.createSpan({ text: 'stdio (local command)' });
    stdioOption.addEventListener('click', () => {
      dropdown.removeClass('is-visible');
      this.openModal(null, 'stdio');
    });

    const httpOption = dropdown.createDiv({ cls: 'claudian-mcp-add-option' });
    setIcon(httpOption.createSpan({ cls: 'claudian-mcp-add-option-icon' }), 'globe');
    httpOption.createSpan({ text: 'http / sse (remote)' });
    httpOption.addEventListener('click', () => {
      dropdown.removeClass('is-visible');
      this.openModal(null, 'http');
    });

    const importOption = dropdown.createDiv({ cls: 'claudian-mcp-add-option' });
    setIcon(importOption.createSpan({ cls: 'claudian-mcp-add-option-icon' }), 'clipboard-paste');
    importOption.createSpan({ text: 'Paste configuration' });
    importOption.addEventListener('click', () => {
      dropdown.removeClass('is-visible');
      this.openImportModal();
    });

    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.toggleClass('is-visible', !dropdown.hasClass('is-visible'));
    });

    const doc = this.containerEl.ownerDocument;
    if (doc) {
      this.outsideClickHandler = () => dropdown.removeClass('is-visible');
      doc.addEventListener('click', this.outsideClickHandler);
    }

    if (this.servers.length === 0) {
      const emptyEl = this.containerEl.createDiv({ cls: 'claudian-mcp-empty' });
      emptyEl.setText('No mcp servers configured. Click "add" to add one.');
      return;
    }

    const listEl = this.containerEl.createDiv({ cls: 'claudian-mcp-list' });
    for (const server of this.servers) {
      this.renderServerItem(listEl, server);
    }
  }

  private renderServerItem(listEl: HTMLElement, server: ManagedMcpServer) {
    const itemEl = listEl.createDiv({ cls: 'claudian-mcp-item' });
    const infoEl = itemEl.createDiv({ cls: 'claudian-mcp-info' });
    const nameRow = infoEl.createDiv({ cls: 'claudian-mcp-name-row' });
    const nameEl = nameRow.createSpan({ cls: 'claudian-mcp-name' });
    nameEl.setText(server.name);

    const serverType = getMcpServerType(server.config);
    const typeEl = nameRow.createSpan({ cls: 'claudian-mcp-type-badge' });
    typeEl.setText(serverType);

    const previewEl = infoEl.createDiv({ cls: 'claudian-mcp-preview' });
    previewEl.setText(this.getServerPreview(server, serverType));

    const actionsEl = itemEl.createDiv({ cls: 'claudian-mcp-actions' });

    const testBtn = actionsEl.createEl('button', {
      cls: 'claudian-mcp-action-btn',
      attr: { 'aria-label': 'Verify (show tools)' },
    });
    setIcon(testBtn, 'zap');
    testBtn.addEventListener('click', () => {
      void this.testServer(server);
    });

    const editBtn = actionsEl.createEl('button', {
      cls: 'claudian-mcp-action-btn',
      attr: { 'aria-label': 'Edit' },
    });
    setIcon(editBtn, 'pencil');
    editBtn.addEventListener('click', () => this.openModal(server));

    const deleteBtn = actionsEl.createEl('button', {
      cls: 'claudian-mcp-action-btn claudian-mcp-delete-btn',
      attr: { 'aria-label': 'Delete' },
    });
    setIcon(deleteBtn, 'trash-2');
    deleteBtn.addEventListener('click', () => {
      void this.deleteServer(server).catch((error: unknown) => {
        this.showMutationError(error, 'Failed to delete MCP server');
      });
    });
  }

  private async testServer(server: ManagedMcpServer) {
    const modal = new McpTestModal(
      this.app,
      server.name,
      undefined,
      undefined,
      undefined,
      { readOnly: this.portable },
    );
    modal.open();
    try {
      const result = await testMcpServer(server);
      if (!this.disposed) modal.setResult(result);
    } catch (error) {
      if (!this.disposed) {
        modal.setError(error instanceof Error ? error.message : 'Verification failed');
      }
    }
  }

  private getServerPreview(server: ManagedMcpServer, type: McpServerType): string {
    if (type === 'stdio') {
      const config = server.config as { command: string; args?: string[] };
      return formatCommand(config.command, config.args);
    }
    const config = server.config as { url: string };
    return config.url;
  }

  private openModal(existing: ManagedMcpServer | null, initialType?: McpServerType) {
    const modal = new McpServerModal(
      this.app,
      existing,
      async (server) => {
        try {
          await this.saveServer(server, existing);
        } catch (error) {
          this.showMutationError(error, 'Failed to save MCP server');
          throw error;
        }
      },
      initialType,
      undefined,
      { portable: this.portable },
    );
    modal.open();
  }

  private openImportModal(): void {
    const modal = new McpImportModal(this.app, (config) => this.importPastedConfig(config));
    modal.open();
  }

  private parsePortableImport(text: string) {
    return parseClipboardConfig(text.trim());
  }

  private async importPastedConfig(text: string): Promise<boolean> {
    try {
      const parsed = this.parsePortableImport(text);
      if (parsed.needsName) {
        const server = parsed.servers[0];
        const modal = new McpServerModal(
          this.app,
          null,
          async (savedServer) => {
            try {
              await this.saveServer(savedServer, null);
            } catch (error) {
              this.showMutationError(error, 'Failed to save MCP server');
              throw error;
            }
          },
          getMcpServerType(server.config),
          server,
          { portable: this.portable },
        );
        modal.open();
        new Notice('Enter a name for the server');
        return true;
      }

      await this.importServers(parsed.servers);
      return true;
    } catch (error) {
      this.showMutationError(error, 'Failed to import MCP configuration');
      return false;
    }
  }

  private assertMutable(): void {
    if (this.disposed) throw new Error('MCP settings manager is disposed');
    if (this.loadError) {
      throw new Error('Cannot modify MCP servers while .mcp.json cannot be read');
    }
  }

  private commitMutation(
    mutation: McpConfigMutation,
    getCommittedServers: () => ManagedMcpServer[],
  ): Promise<void> {
    const commit = this.mutationQueue.then(async () => {
      this.assertMutable();
      const committedServers = getCommittedServers();
      await this.mcpStorage.mutate(mutation);
      if (!this.disposed) {
        this.loadError = null;
        this.servers = committedServers;
        this.render();
      }
      try {
        await this.broadcastMcpReload();
      } catch {
        if (!this.disposed) {
          new Notice('Setting saved but reload failed. Changes will apply on next session.');
        }
      }
    });
    this.mutationQueue = commit.catch(() => undefined);
    return commit;
  }

  private async saveServer(server: ManagedMcpServer, existing: ManagedMcpServer | null) {
    this.assertMutable();
    assertPortableMcpServerName(server.name);
    if (!isPortableMcpServerConfig(server.config)) {
      throw new Error('Invalid portable MCP server configuration');
    }
    const normalizedServer: ManagedMcpServer = {
      name: server.name,
      config: server.config,
      ...PORTABLE_DEFAULTS,
    };

    await this.commitMutation(
      {
        type: 'upsert',
        server: normalizedServer,
        ...(existing ? { previousName: existing.name } : {}),
      },
      () => {
        const index = existing
          ? this.servers.findIndex((item) => item.name === existing.name)
          : -1;
        if (existing && index === -1) {
          throw new Error(`MCP server "${existing.name}" no longer exists`);
        }
        const conflict = this.servers.find(
          (item) => item.name === normalizedServer.name && item.name !== existing?.name,
        );
        if (conflict) {
          throw new Error(`Server "${normalizedServer.name}" already exists`);
        }
        const committedServers = [...this.servers];
        if (index === -1) {
          committedServers.push(normalizedServer);
        } else {
          committedServers[index] = normalizedServer;
        }
        return committedServers;
      },
    );
    if (!this.disposed) {
      new Notice(
        existing
          ? `MCP server "${normalizedServer.name}" updated`
          : `MCP server "${normalizedServer.name}" added`,
      );
    }
  }

  private async importServers(
    servers: Array<{ name: string; config: McpServerConfig }>,
  ): Promise<void> {
    this.assertMutable();
    if (servers.length === 0) throw new Error('No MCP servers found');

    const names = new Set<string>();
    const imported = servers.map(({ name, config }) => {
      assertPortableMcpServerName(name);
      if (names.has(name)) throw new Error(`Server "${name}" appears more than once`);
      names.add(name);
      if (!isPortableMcpServerConfig(config)) {
        throw new Error(`Invalid MCP server config for "${name}"`);
      }
      return {
        name,
        config,
        ...PORTABLE_DEFAULTS,
      };
    });

    await this.commitMutation(
      { type: 'import', servers: imported },
      () => {
        const conflict = imported.find((server) =>
          this.servers.some((existing) => existing.name === server.name),
        );
        if (conflict) {
          throw new Error(`Server "${conflict.name}" already exists`);
        }
        return [...this.servers, ...imported];
      },
    );
    if (!this.disposed) {
      new Notice(`Imported ${imported.length} MCP server${imported.length > 1 ? 's' : ''}`);
    }
  }
  private async deleteServer(server: ManagedMcpServer) {
    this.assertMutable();
    if (!(await confirmDelete(this.app, `Delete MCP server "${server.name}"?`))) return;

    await this.commitMutation(
      { type: 'delete', name: server.name },
      () => this.servers.filter((item) => item.name !== server.name),
    );
    if (!this.disposed) {
      new Notice(`MCP server "${server.name}" deleted`);
    }
  }


  /** Refresh the server list (call after external changes). */
  public refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.loadAndRender();
  }

  /** Stop asynchronous reads and DOM callbacks from updating this editor. */
  public dispose(): void {
    this.disposed = true;
    ++this.loadGeneration;
    if (this.outsideClickHandler) {
      this.containerEl.ownerDocument?.removeEventListener('click', this.outsideClickHandler);
      this.outsideClickHandler = null;
    }
  }

  private showMutationError(error: unknown, fallback: string): void {
    if (isNotifiedMutationError(error)) return;
    new Notice(error instanceof Error ? error.message : fallback);
  }
}
