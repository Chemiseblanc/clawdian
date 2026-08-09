import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { HostToolCatalog } from '@/core/tools/HostToolCatalog';
import { buildCopilotHostToolRegistration } from '@/providers/copilot/runtime/CopilotHostToolAdapter';
import { CopilotHostToolServer } from '@/providers/copilot/runtime/CopilotHostToolServer';

function createCatalog(): jest.Mocked<HostToolCatalog> {
  const catalog: HostToolCatalog = {
    list: jest.fn(() => [
      {
        name: 'claudian.periodic_job.list',
        description: 'List jobs.',
        effect: 'read' as const,
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: 'claudian.periodic_job.create',
        description: 'Create a job.',
        effect: 'write' as const,
        inputSchema: { type: 'object' },
      },
    ]),
    invoke: jest.fn(async (name, input, context) => ({
      ok: true as const,
      value: { context, input, name },
    })),
  };
  return catalog as jest.Mocked<HostToolCatalog>;
}

async function connect(server: CopilotHostToolServer) {
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

describe('CopilotHostToolServer', () => {
  it('translates canonical inputs and committed outputs through MCP', async () => {
    const catalog = createCatalog();
    const registration = buildCopilotHostToolRegistration(
      catalog,
      { kind: 'provider-default' },
      'enabled',
    );
    const server = new CopilotHostToolServer({
      catalog,
      model: 'copilot/gpt-5',
      registration,
    });
    const client = await connect(server);

    try {
      await expect(client.listTools()).resolves.toMatchObject({
        tools: expect.arrayContaining([expect.objectContaining({ name: 'periodic_job_create' })]),
      });
      const result = await client.callTool({
        name: 'periodic_job_create',
        arguments: { name: 'Daily review' },
      });
      expect(result.isError).not.toBe(true);
      expect(catalog.invoke).toHaveBeenCalledWith(
        'claudian.periodic_job.create',
        { name: 'Daily review' },
        { providerId: 'copilot', model: 'copilot/gpt-5' },
      );
      expect(result.content).toEqual([expect.objectContaining({
        text: expect.stringContaining('claudian.periodic_job.create'),
        type: 'text',
      })]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects calls hidden by policy without invoking the catalog', async () => {
    const catalog = createCatalog();
    const registration = buildCopilotHostToolRegistration(
      catalog,
      { kind: 'read-only' },
      'enabled',
    );
    const server = new CopilotHostToolServer({
      catalog,
      model: 'copilot/gpt-5',
      registration,
    });
    const client = await connect(server);

    try {
      await expect(client.callTool({
        name: 'periodic_job_create',
        arguments: {},
      })).resolves.toMatchObject({
        isError: true,
        content: [{
          type: 'text',
          text: 'Host tool invocation is not authorized.',
        }],
      });
      expect(catalog.invoke).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
