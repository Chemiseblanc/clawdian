import type { AppTabManagerState } from '../providers/types';
import type { VaultFileAdapter } from '../storage/VaultFileAdapter';
import type { ManagedMcpServer } from '../types';
import type { SessionMetadataReader } from './SessionStorage';
/**
 * Atomic mutations supported by the provider-neutral, vault-root MCP storage.
 */
export type McpConfigMutation =
  | { type: 'upsert'; server: ManagedMcpServer; previousName?: string }
  | { type: 'delete'; name: string }
  | { type: 'import'; servers: ManagedMcpServer[] };

export interface AppMcpStorage {
  load(): Promise<ManagedMcpServer[]>;
  mutate(mutation: McpConfigMutation): Promise<void>;
}

/**
 * Minimal shared app storage contract.
 *
 * This interface covers only the storage concerns that are shared across
 * all providers: Claudian settings, tab manager state, session metadata, and
 * the portable vault-root MCP configuration.
 *
 * Provider-specific storage surfaces (CC settings, slash commands, skills,
 * agents) live behind provider-owned modules.
 */
export interface SharedAppStorage {
  initialize(): Promise<{ claudian: Record<string, unknown> }>;
  saveClaudianSettings(settings: Record<string, unknown>): Promise<void>;
  setTabManagerState(state: AppTabManagerState): Promise<void>;
  getTabManagerState(): Promise<AppTabManagerState | null>;
  /** Read-only startup metadata access; conversation writers stay repository-private. */
  sessions: SessionMetadataReader;
  readonly mcp: AppMcpStorage;
  getAdapter(): VaultFileAdapter;
}
