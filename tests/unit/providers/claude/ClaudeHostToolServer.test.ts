import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { HostToolCatalog } from '@/core/tools/HostToolCatalog';
import { buildClaudeHostToolRegistration } from '@/providers/claude/runtime/ClaudeHostToolAdapter';
import { ClaudeHostToolServer } from '@/providers/claude/runtime/ClaudeHostToolServer';

function createCatalog(): jest.Mocked<HostToolCatalog> {
  const catalog: HostToolCatalog = {
    list: jest.fn(() => [{
      name: 'claudian.periodic_job.create',
      description: 'Create a job.',
      inputSchema: { type: 'object', properties: {} },
      effect: 'write',
    }]),
    invoke: jest.fn(async () => ({
      ok: true as const,
      value: { job: { id: 'job-1', name: 'Committed name' } },
    })),
  };
  return catalog as jest.Mocked<HostToolCatalog>;
}

async function connect(server: ClaudeHostToolServer): Promise<Client> {
  const descriptor = await server.start();
  const headers = Object.fromEntries(
    (descriptor.headers ?? []).map(({ name, value }) => [name, value]),
  );
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(descriptor.url),
    { requestInit: { headers } },
  ));
  return client;
}

describe('ClaudeHostToolServer', () => {
  it('translates canonical inputs and committed outputs through MCP', async () => {
    const catalog = createCatalog();
    const registration = buildClaudeHostToolRegistration(
      catalog,
      { kind: 'provider-default' },
      'enabled',
    );
    const server = new ClaudeHostToolServer({
      catalog,
      model: 'claude/claude-sonnet-4-5',
      registration,
    });
    const client = await connect(server);

    try {
      await expect(client.listTools()).resolves.toEqual(expect.objectContaining({
        tools: [expect.objectContaining({ name: 'periodic_job_create' })],
      }));
      const result = await client.callTool({
        name: 'periodic_job_create',
        arguments: { name: 'Requested name' },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([expect.objectContaining({
        text: expect.stringContaining('Committed name'),
      })]);
      expect(catalog.invoke).toHaveBeenCalledWith(
        'claudian.periodic_job.create',
        { name: 'Requested name' },
        {
          providerId: 'claude',
          model: 'claude/claude-sonnet-4-5',
        },
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('rejects calls excluded by the active policy', async () => {
    const catalog = createCatalog();
    const registration = buildClaudeHostToolRegistration(
      catalog,
      { kind: 'read-only' },
      'enabled',
    );
    const server = new ClaudeHostToolServer({
      catalog,
      model: 'claude/claude-sonnet-4-5',
      registration,
    });
    const client = await connect(server);

    try {
      const result = await client.callTool({
        name: 'periodic_job_create',
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(catalog.invoke).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
