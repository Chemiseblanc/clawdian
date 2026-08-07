import { randomBytes } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type { HostToolCatalog } from '@/core/tools/HostToolCatalog';
import type { AcpMcpServer } from '@/providers/acp';

import {
  OPENCODE_HOST_TOOL_SERVER_NAME,
  type OpencodeHostToolRegistration,
} from './OpencodeHostToolAdapter';

interface OpencodeHostToolServerOptions {
  readonly catalog: HostToolCatalog;
  readonly model: string;
  readonly registration: OpencodeHostToolRegistration;
}

export class OpencodeHostToolServer {
  private readonly authorization = `Bearer ${randomBytes(32).toString('hex')}`;
  private httpServer: HttpServer | null = null;
  private descriptor: Extract<AcpMcpServer, { type: 'http' }> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: OpencodeHostToolServerOptions) {}

  async start(): Promise<Extract<AcpMcpServer, { type: 'http' }>> {
    if (this.descriptor) return this.descriptor;
    if (this.httpServer) {
      throw new Error('OpenCode host-tool server is already starting.');
    }

    // The Node transport extends HTTP classes that Obsidian/Jest shims during
    // provider registration, so load it only when a host-tool server starts.
    const { StreamableHTTPServerTransport } = await import(
      '@modelcontextprotocol/sdk/server/streamableHttp.js'
    );
    const httpServer = createServer((request, response) => {
      if (request.headers.authorization !== this.authorization) {
        response.writeHead(401).end('Unauthorized');
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const mcpServer = this.createMcpServer();
      response.once('close', () => {
        void Promise.allSettled([transport.close(), mcpServer.close()]);
      });
      void mcpServer.connect(transport)
        .then(() => transport.handleRequest(request, response))
        .catch(() => {
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
    });
    this.httpServer = httpServer;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          httpServer.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          resolve();
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(0, '127.0.0.1');
      });
      const address = httpServer.address() as AddressInfo | null;
      if (!address) throw new Error('OpenCode host-tool server has no address.');
      this.descriptor = {
        type: 'http',
        name: OPENCODE_HOST_TOOL_SERVER_NAME,
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: [{ name: 'Authorization', value: this.authorization }],
      };
      return this.descriptor;
    } catch (error) {
      this.httpServer = null;
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const httpServer = this.httpServer;
    this.httpServer = null;
    this.descriptor = null;
    this.closePromise = (async () => {
      if (httpServer) {
        await new Promise<void>(resolve => httpServer.close(() => resolve()));
      }
    })();
    return this.closePromise;
  }
  private createMcpServer(): Server {
    const mcpServer = new Server(
      { name: 'claudian-host-tools', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    mcpServer.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({
      tools: this.options.registration.definitions.map(definition => ({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema as {
          type: 'object';
          properties?: Record<string, unknown>;
        },
      })),
    }));
    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const canonicalName = this.options.registration
        .canonicalNameByToolName[request.params.name];
      if (!canonicalName) {
        return {
          isError: true,
          content: [{
            type: 'text' as const,
            text: 'Host tool invocation is not authorized.',
          }],
        };
      }

      const result = await this.options.catalog.invoke(
        canonicalName,
        request.params.arguments ?? {},
        { providerId: 'opencode', model: this.options.model },
      ).catch(() => ({
        ok: false as const,
        error: {
          code: 'internal_error' as const,
          message: 'Host tool operation failed.',
        },
      }));
      if (!result.ok) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: result.error.message }],
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result.value, null, 2),
        }],
      };
    });
    return mcpServer;
  }
}
