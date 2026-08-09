import { setImmediate as nextTurn } from 'node:timers/promises';

import type {
  ProviderExecutionEvent,
  ProviderExecutionRequest,
  ProviderInteractionPort,
  ProviderSessionConfig,
} from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { HostToolCatalog } from '@/core/tools/HostToolCatalog';
import type {
  AcpPromptResponse,
  AcpSessionNotification,
  AcpSessionUpdate,
} from '@/providers/acp';
import {
  CopilotExecutionBackend,
  type CopilotExecutionNativeConnection,
  type CopilotExecutionNativeFactory,
} from '@/providers/copilot/execution/CopilotExecutionBackend';
import type { CopilotExecutionNativeCreateOptions } from '@/providers/copilot/execution/CopilotExecutionNativeConnection';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(nextResolve => { resolve = nextResolve; });
  return { promise, resolve };
}

function createPlugin(): ProviderHost {
  return {
    app: { vault: { adapter: { basePath: '/vault' } } },
    getResolvedProviderCliPath: jest.fn(async () => '/opt/copilot'),
    settings: { providerConfigs: { copilot: { enabled: true } } },
  } as unknown as ProviderHost;
}

function createConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  const interactionPort: ProviderInteractionPort = {
    requestApproval: jest.fn(async ({ interactionId }) => ({
      decision: 'allow' as const,
      interactionId,
    })),
    askUserQuestion: jest.fn(),
    requestPlanDecision: jest.fn(),
    dismissInteraction: jest.fn(),
  };
  return {
    interactionPort,
    lifecycle: 'persistent',
    nativePersistence: 'enabled',
    vaultWorkingDirectory: '/vault',
    ...overrides,
  };
}

function createRequest(overrides: Partial<ProviderExecutionRequest> = {}): ProviderExecutionRequest {
  return {
    configuration: {
      model: 'copilot/gpt-5',
      mode: 'plan',
      permissionMode: 'plan',
      reasoning: 'high',
      systemInstructions: { kind: 'provider-default' },
    },
    conversationHistory: [],
    input: [{ text: 'hello', type: 'text' }],
    signal: new AbortController().signal,
    toolPolicy: { kind: 'provider-default' },
    ...overrides,
  };
}

class FakeNative implements CopilotExecutionNativeConnection {
  readonly notifications: Array<
    (notification: AcpSessionNotification) => void | Promise<void>
  > = [];
  readonly newSessionCalls: unknown[] = [];
  readonly loadSessionCalls: unknown[] = [];
  readonly promptCalls: unknown[] = [];
  readonly setModelCalls: unknown[] = [];
  readonly setModeCalls: unknown[] = [];
  readonly setConfigOptionCalls: unknown[] = [];
  cancelCalls: string[] = [];
  flushCalls = 0;
  shutdownCalls = 0;
  promptDeferred: Deferred<AcpPromptResponse> | null = null;
  loadReplay: AcpSessionUpdate[] = [];
  alive = true;

  initialize = jest.fn(async (): Promise<void> => undefined);

  onNotification(
    listener: (notification: AcpSessionNotification) => void | Promise<void>,
  ): () => void {
    this.notifications.push(listener);
    return () => {
      const index = this.notifications.indexOf(listener);
      if (index >= 0) this.notifications.splice(index, 1);
    };
  }

  newSession = jest.fn(async (request: unknown) => {
    this.newSessionCalls.push(request);
    return {
      configOptions: [{
        category: 'thought_level',
        currentValue: 'medium',
        id: 'reasoning_effort',
        name: 'Reasoning',
        options: [
          { name: 'Medium', value: 'medium' },
          { name: 'High', value: 'high' },
        ],
        type: 'select' as const,
      }],
      modes: {
        availableModes: [
          { id: 'https://copilot/mode#agent', name: 'Agent' },
          { id: 'https://copilot/mode#plan', name: 'Plan' },
          { id: 'https://copilot/mode#autopilot', name: 'Autopilot' },
        ],
        currentModeId: 'https://copilot/mode#agent',
      },
      models: {
        availableModels: [{ id: 'gpt-5', name: 'GPT-5' }],
        currentModelId: 'gpt-5',
      },
      sessionId: 'new-session',
    };
  });

  loadSession = jest.fn(async (request: unknown) => {
    this.loadSessionCalls.push(request);
    for (const update of this.loadReplay) this.emit(update, 'saved-session');
    return {
      configOptions: [{
        category: 'thought_level',
        currentValue: 'medium',
        id: 'reasoning_effort',
        name: 'Reasoning',
        options: [{ name: 'High', value: 'high' }],
        type: 'select' as const,
      }],
      modes: {
        availableModes: [
          { id: 'https://copilot/mode#agent', name: 'Agent' },
          { id: 'https://copilot/mode#plan', name: 'Plan' },
        ],
        currentModeId: 'https://copilot/mode#agent',
      },
      models: {
        availableModels: [{ id: 'gpt-5', name: 'GPT-5' }],
        currentModelId: 'gpt-5',
      },
      sessionId: 'saved-session',
    };
  });
  listSessions = jest.fn(async () => ({ sessions: [] }));

  prompt = jest.fn(async (request: unknown) => {
    this.promptCalls.push(request);
    this.promptDeferred ??= deferred<AcpPromptResponse>();
    return this.promptDeferred.promise;
  });

  setModel = jest.fn(async (request: unknown) => { this.setModelCalls.push(request); return {}; });
  setMode = jest.fn(async (request: unknown) => { this.setModeCalls.push(request); return {}; });
  setConfigOption = jest.fn(async (request: unknown) => {
    this.setConfigOptionCalls.push(request);
    return { configOptions: [] };
  });

  cancel(sessionId: string): void { this.cancelCalls.push(sessionId); }

  flush = jest.fn(async () => { this.flushCalls += 1; });

  isAlive(): boolean { return this.alive; }

  shutdown = jest.fn(async () => {
    this.shutdownCalls += 1;
    this.alive = false;
  });

  emit(update: AcpSessionUpdate, sessionId = 'saved-session'): void {
    const notification = { sessionId, update };
    for (const listener of [...this.notifications]) listener(notification);
  }

  completePrompt(response: AcpPromptResponse = { stopReason: 'end_turn' }): void {
    this.promptDeferred?.resolve(response);
  }
}

async function collect(events: AsyncIterable<ProviderExecutionEvent>): Promise<ProviderExecutionEvent[]> {
  const values: ProviderExecutionEvent[] = [];
  for await (const event of events) values.push(event);
  return values;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
    await nextTurn();
  }
  expect(condition()).toBe(true);
}

describe('CopilotExecutionSession', () => {
  it('loads native sessions, applies model/mode/reasoning, suppresses replay, and normalizes live ACP output', async () => {
    const native = new FakeNative();
    native.loadReplay = [{
      content: { text: 'historic output', type: 'text' },
      messageId: 'historic-1',
      sessionUpdate: 'agent_message_chunk',
    }];
    const commandCatalog = { setCommandSnapshot: jest.fn() };
    const factory = {
      create: jest.fn(() => native),
    } as unknown as CopilotExecutionNativeFactory;
    const session = new CopilotExecutionBackend(createPlugin(), {
      commandCatalog,
      nativeFactory: factory,
    }).createSession(createConfig({
      resumeSeed: { providerSessionId: 'saved-session' },
    }));
    const run = session.execute(createRequest());
    await waitFor(() => native.promptCalls.length === 1);

    native.emit({
      content: { text: 'live output', type: 'text' },
      messageId: 'live-1',
      sessionUpdate: 'agent_message_chunk',
    });
    native.emit({
      kind: 'execute',
      rawInput: { command: 'pwd' },
      rawOutput: 'done',
      status: 'completed',
      title: 'Run command',
      toolCallId: 'tool-1',
      sessionUpdate: 'tool_call',
    });
    native.emit({
      sessionUpdate: 'usage_update',
      size: 1000,
      used: 240,
    });
    native.completePrompt({ stopReason: 'end_turn', userMessageId: 'user-1' });
    const events = await collect(run.events);

    expect(native.loadSessionCalls).toEqual([expect.objectContaining({
      cwd: '/vault',
      mcpServers: [],
      sessionId: 'saved-session',
    })]);
    expect(native.newSessionCalls).toHaveLength(0);
    expect(native.setModelCalls).toEqual([{ modelId: 'gpt-5', sessionId: 'saved-session' }]);
    expect(native.setModeCalls).toEqual([expect.objectContaining({
      modeId: expect.stringMatching(/#plan$/),
      sessionId: 'saved-session',
    })]);
    expect(native.setConfigOptionCalls).toEqual([expect.objectContaining({
      configId: 'reasoning_effort',
      sessionId: 'saved-session',
      value: 'high',
    })]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'live output', type: 'text_delta' }),
      expect.objectContaining({ type: 'tool_started', toolCallId: 'tool-1' }),
      expect.objectContaining({ type: 'tool_completed', toolCallId: 'tool-1' }),
      expect.objectContaining({ type: 'usage_updated' }),
      expect.objectContaining({ type: 'turn_completed' }),
    ]));
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'historic output' }),
    ]));
    expect(session.getSnapshot()).toMatchObject({
      providerSessionId: 'saved-session',
      status: 'idle',
    });
    await session.dispose();
  });

  it('creates a new session and cancels idempotently before prompt completion, flushing then shutting down', async () => {
    const native = new FakeNative();
    const factory = {
      create: jest.fn(() => native),
    } as unknown as CopilotExecutionNativeFactory;
    const session = new CopilotExecutionBackend(createPlugin(), {
      nativeFactory: factory,
    }).createSession(createConfig());
    const run = session.execute(createRequest({
      configuration: {
        ...createRequest().configuration,
        mode: 'agent',
        permissionMode: 'normal',
      },
    }));
    await waitFor(() => native.promptCalls.length === 1);

    run.cancel();
    run.cancel();
    const events = await collect(run.events);
    await session.dispose();

    expect(native.newSessionCalls).toEqual([expect.objectContaining({ cwd: '/vault', mcpServers: [] })]);
    expect(native.cancelCalls).toEqual(['new-session']);
    expect(native.flushCalls).toBe(1);
    expect(native.shutdownCalls).toBe(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'cancelled', type: 'cancelled' }),
    ]));
  });

  it('advertises host tools, canonicalizes live calls, and suppresses replayed calls', async () => {
    const catalog: HostToolCatalog = {
      list: jest.fn(() => [{
        name: 'claudian.periodic_job.list',
        description: 'List jobs.',
        effect: 'read',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      }]),
      invoke: jest.fn(),
    };
    const plugin = { ...createPlugin(), hostTools: catalog } as ProviderHost;
    const native = new FakeNative();
    native.loadReplay = [{
      kind: 'read',
      rawInput: {},
      rawOutput: { jobs: [] },
      status: 'completed',
      title: 'claudian/periodic_job_list',
      toolCallId: 'historic-tool',
      sessionUpdate: 'tool_call',
    }];
    const factory = {
      create: jest.fn(() => native),
    } as unknown as CopilotExecutionNativeFactory;
    const session = new CopilotExecutionBackend(plugin, {
      nativeFactory: factory,
    }).createSession(createConfig({
      hostToolAccess: 'enabled',
      resumeSeed: { providerSessionId: 'saved-session' },
    }));
    const run = session.execute(createRequest({ toolPolicy: { kind: 'read-only' } }));
    await waitFor(() => native.promptCalls.length === 1);

    native.emit({
      kind: 'read',
      rawInput: {},
      rawOutput: { jobs: [] },
      status: 'completed',
      title: 'claudian/periodic_job_list',
      toolCallId: 'live-tool',
      sessionUpdate: 'tool_call',
    });
    native.completePrompt();
    const events = await collect(run.events);

    expect(native.loadSessionCalls).toEqual([expect.objectContaining({
      mcpServers: [expect.objectContaining({
        name: 'claudian',
        type: 'http',
      })],
    })]);
    expect(events.filter(event => (
      event.type === 'tool_started' && event.toolCallId === 'live-tool'
    ))).toEqual([expect.objectContaining({
      name: 'claudian.periodic_job.list',
    })]);
    expect(events.filter(event => (
      event.type === 'tool_completed' && event.toolCallId === 'live-tool'
    ))).toHaveLength(1);
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ toolCallId: 'historic-tool' }),
    ]));
    expect(catalog.invoke).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('passes write host-tool calls through Copilot native authorization', async () => {
    const requestApproval = jest.fn(async ({ interactionId }) => ({
      decision: 'allow' as const,
      interactionId,
    }));
    const interactionPort: ProviderInteractionPort = {
      requestApproval,
      askUserQuestion: jest.fn(),
      requestPlanDecision: jest.fn(),
      dismissInteraction: jest.fn(),
    };
    const catalog: HostToolCatalog = {
      list: () => [{
        name: 'claudian.periodic_job.create',
        description: 'Create a job.',
        effect: 'write',
        inputSchema: { type: 'object' },
      }],
      invoke: jest.fn(),
    };
    const native = new FakeNative();
    let createOptions: CopilotExecutionNativeCreateOptions | null = null;
    const factory: CopilotExecutionNativeFactory = {
      create: (options) => {
        createOptions = options;
        return native;
      },
    };
    const session = new CopilotExecutionBackend({
      ...createPlugin(),
      hostTools: catalog,
    } as ProviderHost, { nativeFactory: factory }).createSession(createConfig({
      hostToolAccess: 'enabled',
      interactionPort,
    }));
    const run = session.execute(createRequest());
    await waitFor(() => native.promptCalls.length === 1);

    const response = await createOptions!.requestPermission({
      options: [{ kind: 'allow_once', name: 'Allow once', optionId: 'allow-once' }],
      sessionId: 'new-session',
      toolCall: {
        kind: 'other',
        rawInput: { name: 'Daily review' },
        title: 'claudian/periodic_job_create',
        toolCallId: 'create-tool',
      },
    });

    expect(response).toEqual({
      outcome: { optionId: 'allow-once', outcome: 'selected' },
    });
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'claudian/periodic_job_create',
    }), expect.any(AbortSignal));
    native.completePrompt();
    await collect(run.events);
    await session.dispose();
  });
});
