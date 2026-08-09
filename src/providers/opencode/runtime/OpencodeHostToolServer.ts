import type { HostToolCatalog } from '@/core/tools/HostToolCatalog';
import { AcpHostToolServer } from '@/providers/acp';

import {
  OPENCODE_HOST_TOOL_SERVER_NAME,
  type OpencodeHostToolRegistration,
} from './OpencodeHostToolAdapter';

interface OpencodeHostToolServerOptions {
  readonly catalog: HostToolCatalog;
  readonly model: string;
  readonly registration: OpencodeHostToolRegistration;
}

export class OpencodeHostToolServer extends AcpHostToolServer {
  constructor(options: OpencodeHostToolServerOptions) {
    super({
      ...options,
      providerId: 'opencode',
      serverName: OPENCODE_HOST_TOOL_SERVER_NAME,
    });
  }
}
