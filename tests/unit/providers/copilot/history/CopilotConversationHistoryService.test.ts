import type { Conversation } from '@/core/types';
import type {
  AcpListSessionsRequest,
  AcpListSessionsResponse,
  AcpLoadSessionRequest,
  AcpLoadSessionResponse,
  AcpSessionNotification,
} from '@/providers/acp';
import {
  CopilotConversationHistoryService,
  type CopilotHistoryConnection,
  type CopilotHistoryConnectionFactory,
} from '@/providers/copilot/history/CopilotConversationHistoryService';

function makeConversation(sessionId: string | null = 'copilot-session'): Conversation {
  return {
    createdAt: 1,
    id: 'conversation-1',
    lastActivityAt: 1,
    messages: [],
    providerId: 'copilot' as Conversation['providerId'],
    providerState: { futureResumeCursor: { token: 'keep-me' } },
    sessionId,
    title: 'Copilot',
  };
}

function userMessageChunk(text: string, messageId = 'user-1'): AcpSessionNotification {
  return {
    sessionId: 'copilot-session',
    update: {
      content: { text, type: 'text' },
      messageId,
      sessionUpdate: 'user_message_chunk',
    },
  };
}

function agentMessageChunk(text: string, messageId = 'agent-1'): AcpSessionNotification {
  return {
    sessionId: 'copilot-session',
    update: {
      content: { text, type: 'text' },
      messageId,
      sessionUpdate: 'agent_message_chunk',
    },
  };
}

interface FakeConnection extends CopilotHistoryConnection {
  readonly loadRequests: AcpLoadSessionRequest[];
  readonly listRequests: AcpListSessionsRequest[];
  emit(notification: AcpSessionNotification): void;
  setLoadReplay(notifications: AcpSessionNotification[]): void;
}

function makeConnection(): FakeConnection {
  let listener: ((notification: AcpSessionNotification) => void | Promise<void>) | null = null;
  let loadReplay: AcpSessionNotification[] = [];
  const connection: FakeConnection = {
    loadRequests: [],
    listRequests: [],
    initialize: jest.fn(async () => undefined),
    listSessions: jest.fn(async (request: AcpListSessionsRequest = {}): Promise<AcpListSessionsResponse> => {
      connection.listRequests.push(request);
      return { sessions: [{ sessionId: 'copilot-session', title: 'Copilot' }] };
    }),
    loadSession: jest.fn(async (request: AcpLoadSessionRequest): Promise<AcpLoadSessionResponse> => {
      connection.loadRequests.push(request);
      for (const notification of loadReplay) await listener?.(notification);
      return { sessionId: 'copilot-session' };
    }),
    onSessionNotification: jest.fn((next) => {
      listener = next;
      return jest.fn(() => { listener = null; });
    }),
    shutdown: jest.fn(async () => undefined),
    emit(notification) {
      void listener?.(notification);
    },
    setLoadReplay(notifications) {
      loadReplay = notifications;
    },
  };
  return connection;
}

function makeFactory(connection: FakeConnection): CopilotHistoryConnectionFactory {
  return jest.fn(async (options) => {
    expect(options).toEqual(expect.objectContaining({
      command: '/opt/copilot',
      cwd: '/vault',
      env: expect.objectContaining({ COPILOT_TEST: '1' }),
    }));
    return connection;
  });
}
function pathContext(): {
  environment: NodeJS.ProcessEnv;
  settings: Record<string, unknown>;
} {
  return {
    environment: { COPILOT_TEST: '1' },
    settings: { providerConfigs: { copilot: { cliPath: '/opt/copilot' } } },
  };
}

 

describe('CopilotConversationHistoryService', () => {
  it('loads ACP replay notifications into canonical conversation messages and cleans up', async () => {
    const connection = makeConnection();
    connection.setLoadReplay([userMessageChunk('Hello'), agentMessageChunk('Hi there')]);
    const factory = makeFactory(connection);
    const service = new CopilotConversationHistoryService({
      connectionFactory: factory,
      version: '1.0.26',
    });
    const conversation = makeConversation();

    await service.hydrateConversationHistory(conversation, '/vault', pathContext());

    expect(factory).toHaveBeenCalledTimes(1);
    expect(connection.initialize).toHaveBeenCalledTimes(1);
    expect(connection.loadRequests).toEqual([expect.objectContaining({
      cwd: '/vault',
      mcpServers: [],
      sessionId: 'copilot-session',
    })]);
    expect(conversation.messages).toEqual([
      expect.objectContaining({ content: 'Hello', role: 'user' }),
      expect.objectContaining({ content: 'Hi there', role: 'assistant' }),
    ]);
    expect(connection.shutdown).toHaveBeenCalledTimes(1);
  });

  it('reports available, missing, and unknown native sessions without treating empty listings as history', async () => {
    const connection = makeConnection();
    const factory = makeFactory(connection);
    const service = new CopilotConversationHistoryService({ connectionFactory: factory });
    const conversation = makeConversation();

    await expect(service.getConversationSessionAvailability(
      conversation,
      '/vault',
      pathContext(),
    )).resolves.toBe('available');
    expect(connection.listRequests).toHaveLength(1);

    (connection.listSessions as jest.Mock).mockResolvedValueOnce({ sessions: [] });
    await expect(service.getConversationSessionAvailability(
      conversation,
      '/vault',
      pathContext(),
    )).resolves.toBe('missing');

    (connection.listSessions as jest.Mock).mockRejectedValueOnce(new Error('permission denied'));
    await expect(service.getConversationSessionAvailability(
      conversation,
      '/vault',
      pathContext(),
    )).resolves.toBe('unknown');
    expect(connection.shutdown).toHaveBeenCalledTimes(3);
  });

  it('leaves conversations untouched when session id is absent or ACP load reports an unknown failure', async () => {
    const connection = makeConnection();
    const factory = makeFactory(connection);
    const service = new CopilotConversationHistoryService({ connectionFactory: factory });
    const noSession = makeConversation(null);
    await service.hydrateConversationHistory(noSession, '/vault', pathContext());
    expect(factory).not.toHaveBeenCalled();
    expect(noSession.messages).toEqual([]);

    const conversation = makeConversation();
    (connection.loadSession as jest.Mock).mockRejectedValueOnce(new Error('authentication expired'));
    await expect(service.hydrateConversationHistory(
      conversation,
      '/vault',
      pathContext(),
    )).resolves.toBeUndefined();
    expect(conversation.messages).toEqual([]);
    expect(connection.shutdown).toHaveBeenCalledTimes(1);
  });

  it('recognizes an explicitly missing session and disposes the process after failure', async () => {
    const connection = makeConnection();
    const factory = makeFactory(connection);
    const service = new CopilotConversationHistoryService({ connectionFactory: factory });
    const conversation = makeConversation();
    (connection.loadSession as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error('Session not found'), { code: 'session_not_found' }),
    );

    await expect(service.hydrateConversationHistory(
      conversation,
      '/vault',
      pathContext(),
    )).resolves.toBeUndefined();
    expect(conversation.messages).toEqual([]);
    expect(connection.shutdown).toHaveBeenCalledTimes(1);
  });

  it('resolves the persisted native session id and does not invent fork state', () => {
    const service = new CopilotConversationHistoryService();
    const conversation = makeConversation();
    expect(service.resolveSessionIdForConversation(conversation)).toBe('copilot-session');
    expect(service.resolveSessionIdForConversation(null)).toBeNull();
    expect(service.isPendingForkConversation(conversation)).toBe(false);
    expect(service.buildForkProviderState('source', 'checkpoint', conversation.providerState)).toEqual({});
  });
});
