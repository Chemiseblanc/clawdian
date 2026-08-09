import type { HostToolCatalog } from '@/core/tools/HostToolCatalog';
import { AcpHostToolServer } from '@/providers/acp';

import {
  COPILOT_HOST_TOOL_SERVER_NAME,
  type CopilotHostToolRegistration,
} from './CopilotHostToolAdapter';

interface CopilotHostToolServerOptions {
  readonly catalog: HostToolCatalog;
  readonly model: string;
  readonly registration: CopilotHostToolRegistration;
}

export class CopilotHostToolServer extends AcpHostToolServer {
  constructor(options: CopilotHostToolServerOptions) {
    super({
      ...options,
      providerId: 'copilot',
      serverName: COPILOT_HOST_TOOL_SERVER_NAME,
    });
  }
}
