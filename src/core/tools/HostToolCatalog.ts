import type { ProviderId } from '../types/provider';
import type {
  OneOffJob,
  OneOffJobDraft,
  PeriodicJob,
  PeriodicJobDraft,
} from '../types/settings';

export type HostToolEffect = 'read' | 'write' | 'destructive';

export interface HostToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly effect: HostToolEffect;
}

export interface HostToolInvocationContext {
  readonly providerId: ProviderId;
  readonly model: string;
}

export type HostToolErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'provider_unavailable'
  | 'provider_disabled'
  | 'model_unavailable'
  | 'invalid_schedule'
  | 'permission_denied'
  | 'conflict'
  | 'internal_error';

export type HostToolResult =
  | { readonly ok: true; readonly value: unknown }
  | {
    readonly ok: false;
    readonly error: {
      readonly code: HostToolErrorCode;
      readonly message: string;
    };
  };

export interface HostToolCatalog {
  list(): readonly HostToolDefinition[];
  invoke(
    name: string,
    input: unknown,
    context: HostToolInvocationContext,
  ): Promise<HostToolResult>;
}

export type PeriodicJobPartialUpdate = Partial<PeriodicJobDraft>;

/** Application-owned periodic-job operations available to the host-tool catalog. */
export interface PeriodicJobsHostPort {
  list(): readonly PeriodicJob[];
  create(draft: PeriodicJobDraft): Promise<PeriodicJob>;
  updatePartial(id: string, patch: PeriodicJobPartialUpdate): Promise<PeriodicJob>;
  delete(id: string): Promise<void>;
  isRunning(id: string): boolean;
}

/** Application-owned one-off job operations available to the host-tool catalog. */
export interface OneOffJobsHostPort {
  start(draft: OneOffJobDraft): Promise<OneOffJob>;
}
