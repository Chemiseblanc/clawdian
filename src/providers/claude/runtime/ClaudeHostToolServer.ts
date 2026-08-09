import type { HostToolCatalog } from '@/core/tools/HostToolCatalog';
import { AcpHostToolServer } from '@/providers/acp';

import {
  CLAUDE_HOST_TOOL_SERVER_NAME,
  type ClaudeHostToolRegistration,
} from './ClaudeHostToolAdapter';

interface ClaudeHostToolServerOptions {
  readonly catalog: HostToolCatalog;
  readonly model: string;
  readonly registration: ClaudeHostToolRegistration;
}

export class ClaudeHostToolServer extends AcpHostToolServer {
  constructor(options: ClaudeHostToolServerOptions) {
    super({
      ...options,
      providerId: 'claude',
      serverName: CLAUDE_HOST_TOOL_SERVER_NAME,
    });
  }
}
