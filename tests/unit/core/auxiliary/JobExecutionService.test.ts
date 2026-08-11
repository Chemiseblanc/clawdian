import { JobExecutionService } from '@/core/auxiliary/JobExecutionService';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution';

import {
  FakeAuxiliaryBackend,
  waitFor,
} from './AuxiliaryExecutionTestHarness';

function createService() {
  const backend = new FakeAuxiliaryBackend();
  const lifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  const service = new JobExecutionService({
    backend,
    interactionPort: {
      askUserQuestion: jest.fn(),
      dismissInteraction: jest.fn(),
      requestApproval: jest.fn(),
      requestPlanDecision: jest.fn(),
    },
    lifecycleRegistry,
    vaultWorkingDirectory: '/vault',
  });
  return { backend, lifecycleRegistry, service };
}

const request = {
  model: 'job-model',
  permissionMode: 'normal',
  prompt: 'Run the periodic job',
};

describe('JobExecutionService', () => {
  it('uses the exact unattended request envelope and releases its ephemeral lease', async () => {
    const { backend, service } = createService();

    const execution = service.execute(request);
    await waitFor(() => backend.sessions[0]?.requests.length === 1);
    const session = backend.sessions[0];
    session.emitText('first ');
    session.emitText('second');
    session.complete();

    await expect(execution).resolves.toBe('first second');
    expect(backend.configs).toEqual([expect.objectContaining({
      hostToolAccess: 'enabled',
      lifecycle: 'ephemeral',
      nativePersistence: 'disabled-if-supported',
      vaultWorkingDirectory: '/vault',
    })]);
    expect(session.requests[0]).toMatchObject({
      configuration: {
        model: 'job-model',
        permissionMode: 'normal',
        systemInstructions: { kind: 'provider-default' },
      },
      input: [{ text: 'Run the periodic job', type: 'text' }],
      toolPolicy: { kind: 'provider-default' },
    });
    expect(session.disposeCalls).toBe(1);
  });

  it('propagates provider errors and still releases the lease', async () => {
    const { backend, service } = createService();

    const execution = service.execute(request);
    await waitFor(() => backend.sessions[0]?.requests.length === 1);
    backend.sessions[0].fail('provider failed');

    await expect(execution).rejects.toThrow('provider failed');
    expect(backend.sessions[0].disposeCalls).toBe(1);
  });

  it('cancels an active execution', async () => {
    const { backend, service } = createService();

    const execution = service.execute(request);
    await waitFor(() => backend.sessions[0]?.requests.length === 1);
    service.cancel();

    await expect(execution).rejects.toThrow('Cancelled');
    expect(backend.sessions[0].cancelCalls).toBeGreaterThan(0);
  });

  it('invalidates execution during a provider transition', async () => {
    const { backend, lifecycleRegistry, service } = createService();

    const execution = service.execute(request);
    await waitFor(() => backend.sessions[0]?.requests.length === 1);
    const transition = lifecycleRegistry.runTransition(['claude'], async () => undefined);

    await expect(execution).rejects.toThrow('Cancelled');
    await transition;
    expect(backend.sessions[0].disposeCalls).toBe(1);
  });
});
