import type { App } from 'obsidian';
import { Modal, Notice, Setting } from 'obsidian';

import {
  assertPortableMcpServerName,
  isPortableMcpServerConfig,
  parsePortableKeyValueLines,
} from '../../core/mcp/McpConfigParser';
import type {
  ManagedMcpServer,
  McpHttpServerConfig,
  McpServerConfig,
  McpServerType,
  McpSSEServerConfig,
  McpStdioServerConfig,
} from '../../core/types';
import { DEFAULT_MCP_SERVER, getMcpServerType } from '../../core/types';
import { formatCommand, parseCommand } from '../../utils/mcp';

export interface McpServerModalOptions {
  portable?: boolean;
}

export class McpServerModal extends Modal {
  private existingServer: ManagedMcpServer | null;
  private onSave: (server: ManagedMcpServer) => void | Promise<void>;
  private portable: boolean;

  private serverName = '';
  private serverType: McpServerType = 'stdio';
  private enabled = DEFAULT_MCP_SERVER.enabled;
  private contextSaving = DEFAULT_MCP_SERVER.contextSaving;
  private command = '';
  private env = '';
  private url = '';
  private headers = '';
  private typeFieldsEl: HTMLElement | null = null;
  private nameInputEl: HTMLInputElement | null = null;
  private saveBtnEl: HTMLButtonElement | null = null;
  private saving = false;
  private sourceConfig: McpServerConfig | null = null;

  constructor(
    app: App,
    existingServer: ManagedMcpServer | null,
    onSave: (server: ManagedMcpServer) => void | Promise<void>,
    initialType?: McpServerType,
    prefillConfig?: { name: string; config: McpServerConfig },
    options?: McpServerModalOptions
  ) {
    super(app);
    this.existingServer = existingServer;
    this.onSave = onSave;
    this.portable = options?.portable ?? false;

    if (existingServer) {
      this.serverName = existingServer.name;
      this.serverType = getMcpServerType(existingServer.config);
      this.enabled = existingServer.enabled;
      this.contextSaving = existingServer.contextSaving;
      this.sourceConfig = existingServer.config;
      this.initFromConfig(existingServer.config);
    } else if (prefillConfig) {
      this.serverName = prefillConfig.name;
      this.serverType = getMcpServerType(prefillConfig.config);
      this.sourceConfig = prefillConfig.config;
      this.initFromConfig(prefillConfig.config);
    } else if (initialType) {
      this.serverType = initialType;
    }
  }

  private initFromConfig(config: McpServerConfig) {
    if ('command' in config) {
      this.command = formatCommand(config.command, config.args);
      this.env = this.envRecordToString(config.env);
    } else {
      this.url = config.url;
      this.headers = this.envRecordToString(config.headers);
    }
  }

  onOpen() {
    this.setTitle(this.existingServer ? 'Edit MCP Server' : 'Add MCP Server');
    this.modalEl.addClass('claudian-mcp-modal');

    const { contentEl } = this;

    new Setting(contentEl)
      .setName('Server name')
      .setDesc('Unique identifier for this server')
      .addText((text) => {
        this.nameInputEl = text.inputEl;
        text.setValue(this.serverName);
        text.setPlaceholder('My-mcp-server');
        text.onChange((value) => {
          this.serverName = value;
        });
        text.inputEl.addEventListener('keydown', (e) => this.handleKeyDown(e));
      });

    new Setting(contentEl)
      .setName('Type')
      .setDesc('Server connection type')
      .addDropdown((dropdown) => {
        dropdown.addOption('stdio', 'Stdio (local command)');
        dropdown.addOption('sse', 'Sse (server-sent events)');
        dropdown.addOption('http', 'HTTP (HTTP endpoint)');
        dropdown.setValue(this.serverType);
        dropdown.onChange((value) => {
          this.serverType = value as McpServerType;
          this.renderTypeFields();
        });
      });

    this.typeFieldsEl = contentEl.createDiv({ cls: 'claudian-mcp-type-fields' });
    this.renderTypeFields();

    if (!this.portable) {
      new Setting(contentEl)
        .setName('Enabled')
        .setDesc('Whether this server is active')
        .addToggle((toggle) => {
          toggle.setValue(this.enabled);
          toggle.onChange((value) => {
            this.enabled = value;
          });
        });

      new Setting(contentEl)
        .setName('Context-saving mode')
        .setDesc('Hide tools from agent unless @-mentioned (saves context window)')
        .addToggle((toggle) => {
          toggle.setValue(this.contextSaving);
          toggle.onChange((value) => {
            this.contextSaving = value;
          });
        });
    }

    const buttonContainer = contentEl.createDiv({ cls: 'claudian-mcp-buttons' });

    const cancelBtn = buttonContainer.createEl('button', {
      text: 'Cancel',
      cls: 'claudian-cancel-btn',
    });
    cancelBtn.addEventListener('click', () => this.close());

    this.saveBtnEl = buttonContainer.createEl('button', {
      text: this.existingServer ? 'Update' : 'Add',
      cls: 'claudian-save-btn mod-cta',
    });
    this.saveBtnEl.addEventListener('click', () => {
      void this.save();
    });
  }

  private renderTypeFields() {
    if (!this.typeFieldsEl) return;
    this.typeFieldsEl.empty();

    if (this.serverType === 'stdio') {
      this.renderStdioFields();
    } else {
      this.renderUrlFields();
    }
  }

  private renderStdioFields() {
    if (!this.typeFieldsEl) return;

    const cmdSetting = new Setting(this.typeFieldsEl)
      .setName('Command')
      .setDesc('Full command with arguments');
    cmdSetting.settingEl.addClass('claudian-mcp-cmd-setting');

    const cmdTextarea = cmdSetting.controlEl.createEl('textarea', {
      cls: 'claudian-mcp-cmd-textarea',
    });
    cmdTextarea.value = this.command;
    cmdTextarea.placeholder = 'Docker exec -i mcp-server python -m src.server';
    cmdTextarea.rows = 2;
    cmdTextarea.addEventListener('input', () => {
      this.command = cmdTextarea.value;
    });

    const envSetting = new Setting(this.typeFieldsEl)
      .setName('Environment variables')
      .setDesc('Key=value per line (optional)');
    envSetting.settingEl.addClass('claudian-mcp-env-setting');

    const envTextarea = envSetting.controlEl.createEl('textarea', {
      cls: 'claudian-mcp-env-textarea',
    });
    envTextarea.value = this.env;
    envTextarea.placeholder = 'API_key=your-key';
    envTextarea.rows = 2;
    envTextarea.addEventListener('input', () => {
      this.env = envTextarea.value;
    });
  }

  private renderUrlFields() {
    if (!this.typeFieldsEl) return;

    new Setting(this.typeFieldsEl)
      .setName('URL')
      .setDesc(this.serverType === 'sse' ? 'SSE endpoint URL' : 'HTTP endpoint URL')
      .addText((text) => {
        text.setValue(this.url);
        text.setPlaceholder('HTTPS://localhost:3000/mcp');
        text.onChange((value) => {
          this.url = value;
        });
        text.inputEl.addEventListener('keydown', (e) => this.handleKeyDown(e));
      });

    const headersSetting = new Setting(this.typeFieldsEl)
      .setName('Headers')
      .setDesc('HTTP headers (key=value per line)');
    headersSetting.settingEl.addClass('claudian-mcp-env-setting');

    const headersTextarea = headersSetting.controlEl.createEl('textarea', {
      cls: 'claudian-mcp-env-textarea',
    });
    headersTextarea.value = this.headers;
    headersTextarea.placeholder = 'Authorization=bearer token\ncontent-type=application/JSON';
    headersTextarea.rows = 3;
    headersTextarea.addEventListener('input', () => {
      this.headers = headersTextarea.value;
    });
  }

  private handleKeyDown(e: KeyboardEvent) {
    // !e.isComposing for IME support
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void this.save();
    } else if (e.key === 'Escape' && !e.isComposing) {
      e.preventDefault();
      this.close();
    }
  }

  private async save(): Promise<void> {
    if (this.saving) return;

    const name = this.serverName.trim();
    if (!name) {
      new Notice('Please enter a server name');
      this.nameInputEl?.focus();
      return;
    }

    try {
      if (this.portable) {
        assertPortableMcpServerName(name);
      } else if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
        throw new Error('Server name can only contain letters, numbers, dots, hyphens, and underscores');
      }
    } catch (error) {
      new Notice(error instanceof Error ? error.message : 'Invalid server name');
      this.nameInputEl?.focus();
      return;
    }

    let config: McpServerConfig;
    try {
      config = this.buildConfig();
      if (this.portable && !isPortableMcpServerConfig(config)) {
        throw new Error('Invalid portable MCP server configuration');
      }
    } catch (error) {
      new Notice(error instanceof Error ? error.message : 'Invalid MCP server configuration');
      return;
    }

    const server: ManagedMcpServer = this.portable
      ? { name, config, enabled: true, contextSaving: false }
      : {
          name,
          config,
          enabled: this.enabled,
          contextSaving: this.contextSaving,
          disabledTools: this.existingServer?.disabledTools,
        };

    this.saving = true;
    if (this.saveBtnEl) this.saveBtnEl.disabled = true;
    try {
      await this.onSave(server);
      this.close();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : 'Failed to save MCP server');
    } finally {
      this.saving = false;
      if (this.saveBtnEl) this.saveBtnEl.disabled = false;
    }
  }

  private buildConfig(): McpServerConfig {
    const previous: Record<string, unknown> = {};
    if (this.sourceConfig) {
      for (const [key, value] of Object.entries(this.sourceConfig)) {
        previous[key] = value;
      }
    }
    const hadExplicitType = typeof previous.type === 'string';

    delete previous.type;
    delete previous.command;
    delete previous.args;
    delete previous.env;
    delete previous.url;
    delete previous.headers;

    if (this.serverType === 'stdio') {
      const fullCommand = this.command.trim();
      if (!fullCommand) throw new Error('Please enter a command');
      const { cmd, args } = this.parsePortableCommand(fullCommand);
      if (!cmd.trim()) throw new Error('Please enter a command');

      const config: McpStdioServerConfig & Record<string, unknown> = {
        ...previous,
        command: cmd,
      };
      if (this.portable || hadExplicitType) config.type = 'stdio';
      if (args.length > 0) config.args = args;

      const env = this.parseEnvString(this.env, 'environment variable');
      if (Object.keys(env).length > 0) config.env = env;
      return config;
    }

    const url = this.url.trim();
    if (!url) throw new Error('Please enter a URL');
    if (!/^https?:\/\//i.test(url)) throw new Error('URL must be an absolute HTTP(S) URL');

    const config: (McpSSEServerConfig | McpHttpServerConfig) & Record<string, unknown> = {
      ...previous,
      type: this.serverType,
      url,
    };

    const headers = this.parseEnvString(this.headers, 'header');
    if (Object.keys(headers).length > 0) config.headers = headers;
    return config;
  }

  private parsePortableCommand(command: string): { cmd: string; args: string[] } {
    let quote: '"' | "'" | null = null;
    let escaped = false;
    for (const char of command) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      }
    }
    if (quote) throw new Error('Command contains an unterminated quote');
    return parseCommand(command);
  }

  private parseEnvString(envStr: string, fieldName = 'environment variable'): Record<string, string> {
    return parsePortableKeyValueLines(envStr, fieldName);
  }

  private envRecordToString(env: Record<string, string> | undefined): string {
    if (!env) return '';
    return Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
  }

  onClose() {
    this.contentEl.empty();
  }
}
