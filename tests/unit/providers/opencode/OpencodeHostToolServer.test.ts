import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { HostToolCatalog } from '@/core/tools/HostToolCatalog';
import { buildOpencodeHostToolRegistration } from '@/providers/opencode/runtime/OpencodeHostToolAdapter';
import { OpencodeHostToolServer } from '@/providers/opencode/runtime/OpencodeHostToolServer';

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

async function connect(server: OpencodeHostToolServer) {
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

describe('OpencodeHostToolServer', () => {
  it('lists only registered definitions and invokes canonical catalog tools', async () => {
    const catalog = createCatalog();
    const registration = buildOpencodeHostToolRegistration(
      catalog,
      { kind: 'read-only' },
      'enabled',
    );
    const server = new OpencodeHostToolServer({
      catalog,
      model: 'anthropic/claude',
      registration,
    });
    const client = await connect(server);

    try {
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [{
          name: 'periodic_job_list',
          description: 'List jobs.',
        }],
      });
      const result = await client.callTool({
        name: 'periodic_job_list',
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      expect(catalog.invoke).toHaveBeenCalledWith(
        'claudian.periodic_job.list',
        {},
        { providerId: 'opencode', model: 'anthropic/claude' },
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects an unadvertised native call without invoking the catalog', async () => {
    const catalog = createCatalog();
    const registration = buildOpencodeHostToolRegistration(
      catalog,
      { kind: 'read-only' },
      'enabled',
    );
    const server = new OpencodeHostToolServer({
      catalog,
      model: 'anthropic/claude',
      registration,
    });
    const client = await connect(server);

    try {
      await expect(client.callTool({
        name: 'periodic_job_create',
        arguments: { name: 'Hidden' },
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

  it('preserves catalog failures as MCP tool errors', async () => {
    const catalog = createCatalog();
    catalog.invoke.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'invalid_schedule',
        message: 'Schedule must contain five fields.',
      },
    });
    const registration = buildOpencodeHostToolRegistration(
      catalog,
      { kind: 'provider-default' },
      'enabled',
    );
    const server = new OpencodeHostToolServer({
      catalog,
      model: 'anthropic/claude',
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
          text: 'Schedule must contain five fields.',
        }],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
