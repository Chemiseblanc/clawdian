import type { McpServerConfig, ParsedMcpConfig } from '../types';

const PORTABLE_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const PORTABLE_SERVER_CONFIG_FIELDS: Record<string, true> = {
  type: true,
  command: true,
  url: true,
  args: true,
  env: true,
  headers: true,
};

/** Names reserved by Claude Code and unavailable to portable MCP servers. */
export const PORTABLE_RESERVED_MCP_SERVER_NAMES = new Set([
  'workspace',
  'claude-in-chrome',
  'computer-use',
  'Claude Preview',
  'Claude Browser',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}

/** Return whether a server name is valid in a vault-root portable config. */
export function isPortableMcpServerName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    PORTABLE_SERVER_NAME_PATTERN.test(name) &&
    !PORTABLE_RESERVED_MCP_SERVER_NAMES.has(name)
  );
}

/** Assert a portable server name, returning a useful boundary error. */
export function assertPortableMcpServerName(name: string): void {
  if (!isPortableMcpServerName(name)) {
    throw new Error(
      `Invalid MCP server name "${name}". Names must match ${PORTABLE_SERVER_NAME_PATTERN.source} and must not be reserved.`
    );
  }
}

/**
 * Validate a portable MCP config without inferring a transport.
 *
 * Unknown extension fields are intentionally allowed. Transport-side fields,
 * however, must belong to the selected transport and all known collection
 * fields must have their documented shape.
 */
export function isPortableMcpServerConfig(obj: unknown): obj is McpServerConfig {
  if (!isRecord(obj) || typeof obj.type !== 'string') return false;

  if (obj.type === 'stdio') {
    if (typeof obj.command !== 'string' || obj.command.trim().length === 0) return false;
    if (hasOwn(obj, 'url') || hasOwn(obj, 'headers')) return false;
    if (hasOwn(obj, 'args') && (!Array.isArray(obj.args) || !obj.args.every((arg) => typeof arg === 'string'))) {
      return false;
    }
    if (hasOwn(obj, 'env') && !isStringMap(obj.env)) return false;
    return true;
  }

  if (obj.type !== 'http' && obj.type !== 'sse') return false;
  if (typeof obj.url !== 'string' || !/^https?:\/\//i.test(obj.url)) return false;
  try {
    const url = new URL(obj.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (!url.hostname) return false;
  } catch {
    return false;
  }

  if (hasOwn(obj, 'command') || hasOwn(obj, 'args') || hasOwn(obj, 'env')) return false;
  if (hasOwn(obj, 'headers') && !isStringMap(obj.headers)) return false;
  return true;
}

/** Alias emphasizing that this validator is for the portable editor/import path. */
export const validatePortableMcpServerConfig = isPortableMcpServerConfig;

/**
 * Parse key/value textarea input. Empty lines and comment lines are ignored;
 * every other line must contain a nonblank key and uses the first `=` only.
 */
export function parsePortableKeyValueLines(input: string, fieldName: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const equals = trimmed.indexOf('=');
    if (equals < 0) {
      throw new Error(`Invalid ${fieldName} entry: expected key=value`);
    }

    const key = trimmed.slice(0, equals).trim();
    if (!key) throw new Error(`Invalid ${fieldName} entry: key is required`);
    values[key] = trimmed.slice(equals + 1).trim();
  }
  return values;
}

function parseNamedServers(
  entries: [string, unknown][],
  source: string
): Array<{ name: string; config: McpServerConfig }> {
  if (entries.length === 0) throw new Error(`No valid server configs found in ${source}`);

  return entries.map(([name, config]) => {
    assertPortableMcpServerName(name);
    if (!isPortableMcpServerConfig(config)) {
      throw new Error(`Invalid MCP server config for "${name}"`);
    }
    return { name, config };
  });
}

/**
 * Parse pasted portable JSON. Every original server entry is validated; a
 * single malformed or unsupported entry rejects the complete import.
 *
 * Supported shapes are the portable `mcpServers` wrapper, a single unnamed
 * config, a single named config, and a map of named configs.
 */
export function parseClipboardConfig(json: string): ParsedMcpConfig {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isRecord(parsed)) throw new Error('Invalid JSON object');

    if (hasOwn(parsed, 'mcpServers')) {
      if (!isRecord(parsed.mcpServers)) throw new Error('Invalid mcpServers object');
      return { servers: parseNamedServers(Object.entries(parsed.mcpServers), 'mcpServers'), needsName: false };
    }

    if (isPortableMcpServerConfig(parsed)) {
      return { servers: [{ name: '', config: parsed }], needsName: true };
    }

    // A top-level scalar `type` is the portable config discriminator. Do not
    // reinterpret malformed transport input as a named map with server `type`.
    // A named map may still contain a server called `type` when its value is
    // an object, which remains unambiguous below.
    if (hasOwn(parsed, 'type') && !isRecord(parsed.type)) {
      throw new Error('Invalid MCP configuration format');
    }

    const entries = Object.entries(parsed);
    if (entries.length === 0) throw new Error('Invalid MCP configuration format');
    if (entries.length === 1) {
      const [name, config] = entries[0];
      if (!isRecord(config) && PORTABLE_SERVER_CONFIG_FIELDS[name]) {
        throw new Error('Invalid MCP configuration format');
      }
      return { servers: parseNamedServers([[name, config]], 'configuration'), needsName: false };
    }

    return { servers: parseNamedServers(entries, 'configuration'), needsName: false };
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Invalid JSON', { cause: error });
    throw error;
  }
}

/** Try to parse clipboard content as portable MCP config. */
export function tryParseClipboardConfig(text: string): ParsedMcpConfig | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;

  try {
    return parseClipboardConfig(trimmed);
  } catch {
    return null;
  }
}
