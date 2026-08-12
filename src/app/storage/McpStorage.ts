import type { AppMcpStorage, McpConfigMutation } from '../../core/bootstrap/storage';
import type { VaultFileAdapter } from '../../core/storage/VaultFileAdapter';
import type { ManagedMcpServer, McpServerConfig, McpServerType } from '../../core/types';

export const MCP_CONFIG_PATH = '.mcp.json';

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const RESERVED_SERVER_NAMES: Record<string, true> = {
  workspace: true,
  'claude-in-chrome': true,
  'computer-use': true,
  'Claude Preview': true,
  'Claude Browser': true,
};
const TRANSPORT_FIELDS = ['type', 'command', 'args', 'env', 'url', 'headers'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function invalidConfig(message: string, cause?: unknown): Error {
  return new Error(`Invalid ${MCP_CONFIG_PATH}: ${message}`, cause === undefined ? undefined : { cause });
}

function assertServerName(name: unknown): asserts name is string {
  if (
    typeof name !== 'string'
    || !SERVER_NAME_PATTERN.test(name)
    || RESERVED_SERVER_NAMES[name] === true
  ) {
    throw invalidConfig(`server name ${JSON.stringify(name)} is not portable`);
  }
}

function assertStringMap(
  value: unknown,
  field: string,
): asserts value is Record<string, string> {
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== 'string')) {
    throw invalidConfig(`${field} must be an object containing only string values`);
  }
}

function assertAbsoluteHttpUrl(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw invalidConfig('remote server url must be an absolute HTTP(S) URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidConfig('remote server url must be an absolute HTTP(S) URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalidConfig('remote server url must be an absolute HTTP(S) URL');
  }
}

function getTransportType(config: Record<string, unknown>): McpServerType {
  if (config.type === 'stdio' || config.type === 'http' || config.type === 'sse') {
    return config.type;
  }
  throw invalidConfig('server type must be explicit stdio, http, or sse');
}

/** Validate a portable config while retaining unknown JSON extension fields. */
function decodeConfig(value: unknown): McpServerConfig {
  if (!isRecord(value)) {
    throw invalidConfig('each mcpServers entry must be an object');
  }

  const type = getTransportType(value);
  if (type === 'stdio') {
    if (hasOwn(value, 'url') || hasOwn(value, 'headers')) {
      throw invalidConfig('stdio servers cannot contain remote transport fields');
    }

    const command = value.command;
    if (typeof command !== 'string' || command.trim().length === 0) {
      throw invalidConfig('stdio servers require a nonblank command');
    }

    let args: string[] | undefined;
    if (hasOwn(value, 'args')) {
      const rawArgs = value.args;
      if (!Array.isArray(rawArgs) || !rawArgs.every((arg): arg is string => typeof arg === 'string')) {
        throw invalidConfig('stdio args must be an array of strings');
      }
      args = rawArgs;
    }

    let env: Record<string, string> | undefined;
    if (hasOwn(value, 'env')) {
      const rawEnv = value.env;
      assertStringMap(rawEnv, 'stdio env');
      env = rawEnv;
    }

    const config: McpServerConfig & Record<string, unknown> = {
      ...value,
      type: 'stdio',
      command,
    };
    if (args !== undefined) config.args = args;
    if (env !== undefined) config.env = env;
    return config;
  }

  if (hasOwn(value, 'command') || hasOwn(value, 'args') || hasOwn(value, 'env')) {
    throw invalidConfig('remote servers cannot contain stdio transport fields');
  }

  const url = value.url;
  assertAbsoluteHttpUrl(url);

  let headers: Record<string, string> | undefined;
  if (hasOwn(value, 'headers')) {
    const rawHeaders = value.headers;
    assertStringMap(rawHeaders, 'remote headers');
    headers = rawHeaders;
  }

  if (type === 'http') {
    const config: McpServerConfig & Record<string, unknown> = {
      ...value,
      type: 'http',
      url,
    };
    if (headers !== undefined) config.headers = headers;
    return config;
  }

  const config: McpServerConfig & Record<string, unknown> = {
    ...value,
    type: 'sse',
    url,
  };
  if (headers !== undefined) config.headers = headers;
  return config;
}

type ParsedDocumentFile = Record<string, unknown> & {
  mcpServers: Record<string, unknown>;
};

interface ParsedDocument {
  file: ParsedDocumentFile;
  servers: ManagedMcpServer[];
}

function decodeDocument(raw: string): ParsedDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw invalidConfig('contains malformed JSON', error);
  }

  if (!isRecord(parsed) || !hasOwn(parsed, 'mcpServers')) {
    throw invalidConfig('root mcpServers must be an object');
  }
  const mcpServers = parsed.mcpServers;
  if (!isRecord(mcpServers)) {
    throw invalidConfig('root mcpServers must be an object');
  }

  const servers: ManagedMcpServer[] = [];
  for (const [name, config] of Object.entries(mcpServers)) {
    assertServerName(name);
    servers.push({
      name,
      config: decodeConfig(config),
      enabled: true,
      contextSaving: false,
    });
  }

  return {
    file: { ...parsed, mcpServers },
    servers,
  };
}

function emptyDocument(): ParsedDocument {
  return { file: { mcpServers: {} }, servers: [] };
}

function clonePortableConfig(config: McpServerConfig): Record<string, unknown> {
  const source = config as unknown as Record<string, unknown>;
  const clone: Record<string, unknown> = {};
  for (const field of TRANSPORT_FIELDS) {
    if (hasOwn(source, field)) {
      clone[field] = source[field];
    }
  }
  return clone;
}

function mergeConfig(
  existing: Record<string, unknown> | undefined,
  incoming: McpServerConfig,
): Record<string, unknown> {
  const incomingRecord = clonePortableConfig(incoming);
  const result = existing ? { ...existing } : {};

  // Replace every known transport field so removed optional values do not
  // linger, while leaving all unknown extension keys on an existing entry.
  for (const field of TRANSPORT_FIELDS) {
    delete result[field];
  }
  for (const [key, value] of Object.entries(incomingRecord)) {
    result[key] = value;
  }

  return result;
}
function validateMutationServer(server: unknown): asserts server is ManagedMcpServer {
  if (!isRecord(server)) {
    throw invalidConfig('mutation server must be an object');
  }
  assertServerName(server.name);
  decodeConfig(server.config);
}

function validateMutation(mutation: McpConfigMutation): void {
  if (!isRecord(mutation) || typeof mutation.type !== 'string') {
    throw invalidConfig('unsupported mutation');
  }

  if (mutation.type === 'upsert') {
    validateMutationServer(mutation.server);
    if (mutation.previousName !== undefined) {
      assertServerName(mutation.previousName);
    }
    return;
  }

  if (mutation.type === 'delete') {
    assertServerName(mutation.name);
    return;
  }

  if (mutation.type === 'import') {
    if (!Array.isArray(mutation.servers)) {
      throw invalidConfig('import servers must be an array');
    }
    const names = new Set<string>();
    for (const server of mutation.servers) {
      validateMutationServer(server);
      if (names.has(server.name)) {
        throw invalidConfig(`import contains duplicate server name ${JSON.stringify(server.name)}`);
      }
      names.add(server.name);
    }
    return;
  }

  throw invalidConfig('unsupported mutation type');
}



export class McpStorage implements AppMcpStorage {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly adapter: VaultFileAdapter) {}

  async load(): Promise<ManagedMcpServer[]> {
    const document = await this.readLatest();
    return document.servers;
  }

  async mutate(mutation: McpConfigMutation): Promise<void> {
    validateMutation(mutation);

    const next = this.mutationQueue.then(() => this.applyMutation(mutation));
    this.mutationQueue = next.catch(() => undefined);
    await next;
  }

  private async readLatest(): Promise<ParsedDocument> {
    if (!(await this.adapter.exists(MCP_CONFIG_PATH))) {
      return emptyDocument();
    }
    return decodeDocument(await this.adapter.read(MCP_CONFIG_PATH));
  }

  private async applyMutation(mutation: McpConfigMutation): Promise<void> {
    const document = await this.readLatest();
    const file = { ...document.file };
    const mcpServers: Record<string, unknown> = { ...document.file.mcpServers };
    file.mcpServers = mcpServers;

    // Claudian metadata is not consumed or generated. Preserve it, along
    // with every other unrelated top-level extension, when rewriting.

    if (mutation.type === 'upsert') {
      const { server, previousName } = mutation;

      if (previousName === undefined) {
        if (hasOwn(mcpServers, server.name)) {
          throw invalidConfig(`server name ${JSON.stringify(server.name)} already exists`);
        }
        mcpServers[server.name] = mergeConfig(undefined, server.config);
      } else {
        if (!hasOwn(mcpServers, previousName)) {
          throw invalidConfig(`server name ${JSON.stringify(previousName)} does not exist`);
        }
        if (previousName !== server.name && hasOwn(mcpServers, server.name)) {
          throw invalidConfig(`server name ${JSON.stringify(server.name)} already exists`);
        }

        const existing = mcpServers[previousName];
        const merged = mergeConfig(
          isRecord(existing) ? existing : undefined,
          server.config,
        );
        if (previousName !== server.name) {
          delete mcpServers[previousName];
        }
        mcpServers[server.name] = merged;
      }
    } else if (mutation.type === 'delete') {
      delete mcpServers[mutation.name];
    } else {
      for (const server of mutation.servers) {
        if (hasOwn(mcpServers, server.name)) {
          throw invalidConfig(`server name ${JSON.stringify(server.name)} already exists`);
        }
      }
      for (const server of mutation.servers) {
        mcpServers[server.name] = mergeConfig(undefined, server.config);
      }
    }

    await this.adapter.write(MCP_CONFIG_PATH, JSON.stringify(file, null, 2));
  }
}
