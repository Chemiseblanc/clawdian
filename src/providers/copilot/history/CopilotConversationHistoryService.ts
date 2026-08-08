import { getProviderConfig } from '../../../core/providers/providerConfig';
import { getRuntimeEnvironmentVariables } from '../../../core/providers/providerEnvironment';
import type {
  ProviderConversationHistoryService,
  ProviderConversationSessionAvailability,
  ProviderHistoryPathContext,
} from '../../../core/providers/types';
import type { ChatMessage, ContentBlock, Conversation } from '../../../core/types';
import type { ToolCallInfo } from '../../../core/types/tools';
import { getHostnameKey } from '../../../utils/env';
import {
  AcpClientConnection,
  AcpJsonRpcTransport,
  type AcpListSessionsRequest,
  type AcpListSessionsResponse,
  type AcpLoadSessionRequest,
  type AcpLoadSessionResponse,
  type AcpSessionNotification,
  type AcpSessionUpdate,
  AcpSubprocess,
  type AcpToolCall,
  type AcpToolCallUpdate,
} from '../../acp';

const COPILOT_COMMAND = 'copilot';
const COPILOT_ARGS = ['--acp', '--no-auto-update'];
const DEFAULT_CLIENT_VERSION = '0.0.0';

type SessionNotificationListener = (
  notification: AcpSessionNotification,
) => void | Promise<void>;

export interface CopilotHistoryConnection {
  initialize(): Promise<unknown>;
  listSessions(request?: AcpListSessionsRequest): Promise<AcpListSessionsResponse>;
  loadSession(request: AcpLoadSessionRequest): Promise<AcpLoadSessionResponse>;
  onSessionNotification(listener: SessionNotificationListener): () => void;
  shutdown(): Promise<void>;
}

export interface CopilotHistoryConnectionOptions {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  version: string;
}

export type CopilotHistoryConnectionFactory = (
  options: CopilotHistoryConnectionOptions,
) => CopilotHistoryConnection | Promise<CopilotHistoryConnection>;

export interface CopilotConversationHistoryServiceOptions {
  connectionFactory?: CopilotHistoryConnectionFactory;
  version?: string;
}

interface ReplayTurn {
  assistantContent: string;
  assistantId?: string;
  blocks: ContentBlock[];
  startedAt: number;
  tools: Map<string, ToolCallInfo>;
  toolOrder: string[];
  userContent: string;
  userId?: string;
}

/** Read-only history access through Copilot's standard ACP session/list and session/load methods. */
export class CopilotConversationHistoryService implements ProviderConversationHistoryService {
  private readonly connectionFactory: CopilotHistoryConnectionFactory;
  private readonly version: string;
  private readonly hydratedKeys = new Map<string, string>();

  constructor(options: CopilotConversationHistoryServiceOptions = {}) {
    this.connectionFactory = options.connectionFactory ?? createCopilotHistoryConnection;
    this.version = options.version ?? DEFAULT_CLIENT_VERSION;
  }

  async getConversationSessionAvailability(
    conversation: Conversation,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<ProviderConversationSessionAvailability> {
    const sessionId = this.resolveSessionIdForConversation(conversation);
    if (!sessionId) return 'unknown';

    const launch = resolveCopilotLaunchOptions(vaultPath, pathContext);
    if (!launch) return 'unknown';

    let connection: CopilotHistoryConnection | null = null;
    try {
      connection = await this.connectionFactory({ ...launch, version: this.version });
      await connection.initialize();
      const sessions = await this.listAllSessions(connection, launch.cwd);
      return sessions.some(session => session.sessionId === sessionId)
        ? 'available'
        : 'missing';
    } catch {
      return 'unknown';
    } finally {
      await shutdownConnection(connection);
    }
  }

  async hydrateConversationHistory(
    conversation: Conversation,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<void> {
    const sessionId = this.resolveSessionIdForConversation(conversation);
    if (!sessionId) {
      this.hydratedKeys.delete(conversation.id);
      return;
    }

    const launch = resolveCopilotLaunchOptions(vaultPath, pathContext);
    if (!launch) return;
    const hydrationKey = `${sessionId}\u0000${launch.cwd}\u0000${launch.command}`;
    if (this.hydratedKeys.get(conversation.id) === hydrationKey && conversation.messages.length > 0) {
      return;
    }

    let connection: CopilotHistoryConnection | null = null;
    try {
      connection = await this.connectionFactory({ ...launch, version: this.version });
      await connection.initialize();
      const sessions = await this.listAllSessions(connection, launch.cwd);
      if (!sessions.some(session => session.sessionId === sessionId)) {
        return;
      }

      const notifications: AcpSessionNotification[] = [];
      // ACP replays session/load notifications while the request is in flight. Register first,
      // otherwise the first user/agent chunk can be lost on fast agents.
      const unsubscribe = connection.onSessionNotification((notification) => {
        if (notification.sessionId === sessionId) notifications.push(notification);
      });
      try {
        await connection.loadSession({
          cwd: launch.cwd,
          mcpServers: [],
          sessionId,
        });
      } finally {
        unsubscribe();
      }

      const messages = replayCopilotNotifications(notifications, sessionId);
      // An absent/empty load must not replace persisted messages with fabricated history.
      if (messages.length === 0) return;
      conversation.messages = messages;
      this.hydratedKeys.set(conversation.id, hydrationKey);
    } catch {
      // History is best-effort. In particular, a load failure must not mutate the conversation.
      return;
    } finally {
      await shutdownConnection(connection);
    }
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    return conversation?.sessionId ?? null;
  }

  isPendingForkConversation(_conversation: Conversation): boolean {
    return false;
  }

  buildForkProviderState(
    _sourceSessionId: string,
    _resumeAt: string,
    _sourceProviderState?: Record<string, unknown>,
    _vaultPath?: string | null,
    _pathContext?: ProviderHistoryPathContext,
  ): Record<string, unknown> {
    // Copilot ACP does not advertise a fork operation. Native provider state remains untouched.
    return {};
  }

  private async listAllSessions(
    connection: CopilotHistoryConnection,
    cwd: string,
  ): Promise<AcpListSessionsResponse['sessions']> {
    const sessions: AcpListSessionsResponse['sessions'] = [];
    let cursor: string | null | undefined;
    do {
      const response = await connection.listSessions({ cwd, ...(cursor ? { cursor } : {}) });
      if (!response || !Array.isArray(response.sessions)) {
        throw new Error('Copilot returned malformed session/list response.');
      }
      sessions.push(...response.sessions);
      cursor = response.nextCursor;
    } while (cursor);
    return sessions;
  }
}

function resolveCopilotLaunchOptions(
  vaultPath: string | null,
  pathContext?: ProviderHistoryPathContext,
): Omit<CopilotHistoryConnectionOptions, 'version'> | null {
  const cwd = vaultPath ?? pathContext?.vaultPath ?? null;
  if (!cwd) return null;

  const settings = pathContext?.settings ?? {};
  const config = getProviderConfig(settings, 'copilot');
  const hostname = getHostnameKey();
  const configuredHostPaths = readStringMap(
    config.cliPathsByHost ?? settings.copilotCliPathsByHost,
  );
  const command = (
    configuredHostPaths[hostname]
      ?? readString(config.cliPath)
      ?? readString(settings.copilotCliPath)
      ?? COPILOT_COMMAND
  ).trim() || COPILOT_COMMAND;

  const configuredEnvironment = getRuntimeEnvironmentVariables(settings, 'copilot');
  const baseEnvironment = pathContext?.environment ?? process.env;
  return {
    command,
    cwd,
    env: { ...baseEnvironment, ...configuredEnvironment },
  };
}

function createCopilotHistoryConnection(
  options: CopilotHistoryConnectionOptions,
): CopilotHistoryConnection {
  const process = new AcpSubprocess({
    args: COPILOT_ARGS,
    command: options.command,
    cwd: options.cwd,
    env: options.env,
  });
  process.start();

  const transport = new AcpJsonRpcTransport({
    input: process.stdout,
    onClose: listener => process.onClose(listener),
    output: process.stdin,
  });
  const connection = new AcpClientConnection({
    clientInfo: { name: 'claudian', version: options.version },
    transport,
  });

  let stopped = false;
  return {
    initialize: () => connection.initialize(),
    listSessions: request => connection.listSessions(request),
    loadSession: request => connection.loadSession(request),
    onSessionNotification: listener => connection.onSessionNotification(listener),
    shutdown: async () => {
      if (stopped) return;
      stopped = true;
      connection.dispose();
      transport.dispose();
      await process.shutdown();
    },
  };
}

async function shutdownConnection(connection: CopilotHistoryConnection | null): Promise<void> {
  if (!connection) return;
  try {
    await connection.shutdown();
  } catch {
    // Cleanup must not mask the availability/load result.
  }
}

function replayCopilotNotifications(
  notifications: readonly AcpSessionNotification[],
  sessionId: string,
): ChatMessage[] {
  const turns: ReplayTurn[] = [];
  let current: ReplayTurn | null = null;
  const seenChunks = new Set<string>();
  const baseTimestamp = Date.now();

  for (const notification of notifications) {
    if (notification.sessionId !== sessionId) continue;
    const update = notification.update;
    const fingerprint = fingerprintUpdate(update);
    if (seenChunks.has(fingerprint)) continue;
    seenChunks.add(fingerprint);

    switch (update.sessionUpdate) {
      case 'user_message_chunk': {
        const incomingId = normalizeId(update.messageId);
        if (
          current
          && (
            current.assistantContent.length > 0
            || current.tools.size > 0
            || current.blocks.length > 0
            || (current.userId && incomingId && current.userId !== incomingId)
          )
        ) {
          turns.push(current);
          current = null;
        }
        current ??= createReplayTurn(baseTimestamp + turns.length);
        current.userId ??= incomingId;
        current.userContent += extractContentText(update.content);
        break;
      }
      case 'agent_message_chunk': {
        if (!current) break;
        current.assistantId ??= normalizeId(update.messageId);
        const text = extractContentText(update.content);
        current.assistantContent += text;
        appendTextBlock(current.blocks, 'text', text);
        break;
      }
      case 'agent_thought_chunk': {
        if (!current) break;
        appendTextBlock(current.blocks, 'thinking', extractContentText(update.content));
        break;
      }
      case 'tool_call':
        if (current) applyToolCall(current, update);
        break;
      case 'tool_call_update':
        if (current) applyToolCallUpdate(current, update);
        break;
      default:
        break;
    }
  }
  if (current) turns.push(current);

  const messages: ChatMessage[] = [];
  turns.forEach((turn, index) => {
    if (!turn.userContent.trim()) return;
    const userId = turn.userId ?? `copilot-${safeId(sessionId)}-user-${index}`;
    messages.push({
      content: turn.userContent,
      id: userId,
      role: 'user',
      timestamp: turn.startedAt,
      ...(turn.userId ? { userMessageId: turn.userId } : {}),
    });
    if (
      !turn.assistantContent
      && turn.blocks.length === 0
      && turn.tools.size === 0
    ) {
      return;
    }
    const toolCalls = turn.toolOrder.flatMap(id => {
      const tool = turn.tools.get(id);
      return tool ? [tool] : [];
    });
    messages.push({
      assistantMessageId: turn.assistantId ?? `copilot-${safeId(sessionId)}-assistant-${index}`,
      content: turn.assistantContent,
      ...(turn.blocks.length > 0 ? { contentBlocks: turn.blocks } : {}),
      id: turn.assistantId ?? `copilot-${safeId(sessionId)}-assistant-${index}`,
      role: 'assistant',
      timestamp: turn.startedAt,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    });
  });
  return messages;
}

function createReplayTurn(timestamp: number): ReplayTurn {
  return {
    assistantContent: '',
    blocks: [],
    startedAt: timestamp,
    tools: new Map(),
    toolOrder: [],
    userContent: '',
  };
}

function applyToolCall(turn: ReplayTurn, update: AcpToolCall): void {
  const id = normalizeId(update.toolCallId);
  if (!id) return;
  const existing = turn.tools.get(id);
  const next = normalizeToolCall(update, existing);
  if (!existing) {
    turn.toolOrder.push(id);
    turn.blocks.push({ type: 'tool_use', toolId: id });
  }
  turn.tools.set(id, next);
}

function applyToolCallUpdate(turn: ReplayTurn, update: AcpToolCallUpdate): void {
  const id = normalizeId(update.toolCallId);
  if (!id) return;
  const existing = turn.tools.get(id);
  const next = normalizeToolCall(update, existing);
  if (!existing) {
    turn.toolOrder.push(id);
    turn.blocks.push({ type: 'tool_use', toolId: id });
  }
  turn.tools.set(id, next);
}

function normalizeToolCall(
  update: AcpToolCall | AcpToolCallUpdate,
  existing?: ToolCallInfo,
): ToolCallInfo {
  const rawInput = update.rawInput !== undefined ? update.rawInput : existing?.providerPayload?.rawInput;
  const rawOutput = update.rawOutput !== undefined ? update.rawOutput : existing?.providerPayload?.rawOutput;
  const input = normalizeToolInput(rawInput ?? existing?.input);
  const title = 'title' in update ? update.title : undefined;
  const name = title?.trim() || ('kind' in update ? update.kind?.trim() : undefined) || existing?.name || 'tool';
  const status = normalizeToolStatus(update.status, existing?.status);
  const renderedOutput = renderToolOutput(update.content) || renderRawOutput(rawOutput) || existing?.result;
  return {
    id: normalizeId(update.toolCallId) ?? existing?.id ?? 'tool',
    input,
    name,
    status,
    ...(renderedOutput ? { result: renderedOutput } : {}),
    providerPayload: {
      ...(rawInput !== undefined ? { rawInput } : {}),
      ...(rawOutput !== undefined ? { rawOutput } : {}),
      rawName: name,
    },
  };
}

function normalizeToolInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function normalizeToolStatus(
  status: AcpToolCall['status'] | undefined,
  fallback?: ToolCallInfo['status'],
): ToolCallInfo['status'] {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'error';
  if (status === 'pending' || status === 'in_progress') return 'running';
  return fallback ?? 'running';
}

function appendTextBlock(
  blocks: ContentBlock[],
  type: 'text' | 'thinking',
  text: string,
): void {
  if (!text) return;
  const previous = blocks[blocks.length - 1];
  if (previous?.type === type) {
    previous.content += text;
    return;
  }
  blocks.push({ type, content: text });
}

function extractContentText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const content = value as Record<string, unknown>;
  if (content.type === 'text' && typeof content.text === 'string') return content.text;
  if (content.type === 'resource' && content.resource && typeof content.resource === 'object') {
    const resource = content.resource as Record<string, unknown>;
    return typeof resource.text === 'string' ? resource.text : '';
  }
  return '';
}

function renderToolOutput(content: unknown): string {
  if (!Array.isArray(content)) return extractContentText(content);
  return content.map(extractContentText).filter(Boolean).join('');
}

function renderRawOutput(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function fingerprintUpdate(update: AcpSessionUpdate): string {
  try {
    return JSON.stringify(update);
  } catch {
    return `${update.sessionUpdate}:${'toolCallId' in update ? update.toolCallId : ''}`;
  }
}

function normalizeId(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64) || 'session';
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}
