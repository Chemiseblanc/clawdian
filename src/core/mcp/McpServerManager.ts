import { extractMcpMentions, transformMcpMentions } from '../../utils/mcp';
import type { ManagedMcpServer, McpServerConfig } from '../types';

/** Storage interface for loading MCP servers. */
export interface McpStorageAdapter {
  load(): Promise<ManagedMcpServer[]>;
}

export class McpServerManager {
  private servers: ManagedMcpServer[] = [];
  private storage: McpStorageAdapter;
  private loadPromise: Promise<void> | null = null;
  private reloadPromise: Promise<void> | null = null;
  private loadGeneration = 0;
  private loaded = false;

  constructor(storage: McpStorageAdapter) {
    this.storage = storage;
  }

  async loadServers(): Promise<void> {
    if (this.loadPromise) {
      return this.loadPromise;
    }

    const promise = this.beginLoad();
    try {
      await promise;
    } finally {
      if (this.loadPromise === promise) {
        this.loadPromise = null;
      }
    }
  }

  /**
   * Reloads from storage after any active read has settled.
   *
   * A reload is deliberately a fresh read rather than a join with the active
   * load. Serializing reload requests and fencing completions prevents a
   * slower, older read from replacing the newest server snapshot.
   */
  async reloadServers(): Promise<void> {
    const previousReload = this.reloadPromise;
    const operation = (async () => {
      if (previousReload) {
        await previousReload.catch(() => undefined);
      }

      const activeLoad = this.loadPromise;
      if (activeLoad) {
        await activeLoad.catch(() => undefined);
      }

      const promise = this.beginLoad();
      try {
        await promise;
      } finally {
        if (this.loadPromise === promise) {
          this.loadPromise = null;
        }
      }
    })();
    this.reloadPromise = operation;
    try {
      await operation;
    } finally {
      if (this.reloadPromise === operation) {
        this.reloadPromise = null;
      }
    }
  }

  private beginLoad(): Promise<void> {
    const generation = ++this.loadGeneration;
    let storageLoad: Promise<ManagedMcpServer[]>;
    try {
      storageLoad = Promise.resolve(this.storage.load());
    } catch (error) {
      storageLoad = Promise.reject(error);
    }

    const promise = storageLoad.then((servers) => {
      if (generation !== this.loadGeneration) {
        return;
      }
      this.servers = servers;
      this.loaded = true;
    });
    this.loadPromise = promise;
    return promise;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    await this.loadServers();
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  getServers(): ManagedMcpServer[] {
    return this.servers;
  }

  getEnabledCount(): number {
    return this.servers.filter((s) => s.enabled).length;
  }

  /**
   * Get servers to include in SDK options.
   *
   * A server is included if:
   * - It is enabled AND
   * - Either context-saving is disabled OR the server is @-mentioned
   *
   * @param mentionedNames Set of server names that were @-mentioned in the prompt
   */
  getActiveServers(mentionedNames: Set<string>): Record<string, McpServerConfig> {
    const result: Record<string, McpServerConfig> = {};

    for (const server of this.servers) {
      if (!server.enabled) continue;

      // If context-saving is enabled, only include if @-mentioned
      if (server.contextSaving && !mentionedNames.has(server.name)) {
        continue;
      }

      result[server.name] = server.config;
    }

    return result;
  }

  /**
   * Get disabled MCP tools formatted for SDK disallowedTools option.
   *
   * Only returns disabled tools from servers that would be active (same filter as getActiveServers).
   *
   * @param mentionedNames Set of server names that were @-mentioned in the prompt
   */
  getDisallowedMcpTools(mentionedNames: Set<string>): string[] {
    return this.collectDisallowedTools(
      (s) => !s.contextSaving || mentionedNames.has(s.name)
    );
  }

  /**
   * Get all disabled MCP tools from ALL enabled servers (ignoring @-mentions).
   *
   * Used for persistent queries to pre-register all disabled tools upfront,
   * so @-mentioning servers doesn't require cold start.
   */
  getAllDisallowedMcpTools(): string[] {
    return this.collectDisallowedTools().sort();
  }

  private collectDisallowedTools(filter?: (server: ManagedMcpServer) => boolean): string[] {
    const disallowed = new Set<string>();

    for (const server of this.servers) {
      if (!server.enabled) continue;
      if (filter && !filter(server)) continue;
      if (!server.disabledTools || server.disabledTools.length === 0) continue;

      for (const tool of server.disabledTools) {
        const normalized = tool.trim();
        if (!normalized) continue;
        disallowed.add(`mcp__${server.name}__${normalized}`);
      }
    }

    return Array.from(disallowed);
  }

  hasServers(): boolean {
    return this.servers.length > 0;
  }

  getContextSavingServers(): ManagedMcpServer[] {
    return this.servers.filter((s) => s.enabled && s.contextSaving);
  }

  private getContextSavingNames(): Set<string> {
    return new Set(this.getContextSavingServers().map((s) => s.name));
  }

  /** Only matches against enabled servers with context-saving mode. */
  extractMentions(text: string): Set<string> {
    return extractMcpMentions(text, this.getContextSavingNames());
  }

  /**
   * Appends " MCP" after each valid @mention. Applied to API requests only, not shown in UI.
   */
  transformMentions(text: string): string {
    return transformMcpMentions(text, this.getContextSavingNames());
  }
}
