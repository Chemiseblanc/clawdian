import type {
  HostToolCatalog,
  HostToolDefinition,
  HostToolErrorCode,
  HostToolInvocationContext,
  HostToolResult,
  OneOffJobsHostPort,
  PeriodicJobPartialUpdate,
  PeriodicJobsHostPort,
} from '../../core/tools/HostToolCatalog';
import type {
  OneOffJobDraft,
  PeriodicJobDraft,
  StoredChatModelSelection,
} from '../../core/types';

export const JOB_HOST_TOOL_NAMES = Object.freeze({
  periodicList: 'claudian.periodic_job.list',
  periodicCreate: 'claudian.periodic_job.create',
  periodicUpdate: 'claudian.periodic_job.update',
  periodicDelete: 'claudian.periodic_job.delete',
  oneOffStart: 'claudian.one_off_job.start',
} as const);

const MODEL_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    providerId: { type: 'string', minLength: 1 },
    model: { type: 'string', minLength: 1 },
  },
  required: ['providerId', 'model'],
  additionalProperties: false,
});

const DEFINITIONS: readonly HostToolDefinition[] = Object.freeze([
  Object.freeze({
    name: JOB_HOST_TOOL_NAMES.periodicList,
    description: 'List all Claudian periodic jobs, including identifiers and current configuration.',
    effect: 'read' as const,
    inputSchema: Object.freeze({
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: JOB_HOST_TOOL_NAMES.periodicCreate,
    description: 'Create a Claudian periodic job.',
    effect: 'write' as const,
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, description: 'Human-readable job name.' },
        schedule: {
          type: 'string',
          minLength: 1,
          description: 'Five-field cron expression: minute hour day-of-month month day-of-week.',
        },
        prompt: { type: 'string', minLength: 1, description: 'Prompt executed on each scheduled run.' },
        enabled: { type: 'boolean', default: true },
        model: {
          ...MODEL_SCHEMA,
          description: 'Optional provider-qualified model. Defaults to the active conversation provider and model.',
        },
      },
      required: ['name', 'schedule', 'prompt'],
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: JOB_HOST_TOOL_NAMES.periodicUpdate,
    description: 'Partially update an existing Claudian periodic job.',
    effect: 'write' as const,
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        id: {
          type: 'string',
          minLength: 1,
          description: 'Stable identifier returned by periodic_job.list or periodic_job.create.',
        },
        name: { type: 'string', minLength: 1 },
        schedule: { type: 'string', minLength: 1 },
        prompt: { type: 'string', minLength: 1 },
        enabled: { type: 'boolean' },
        model: MODEL_SCHEMA,
      },
      required: ['id'],
      additionalProperties: false,
      anyOf: [
        { required: ['name'] },
        { required: ['schedule'] },
        { required: ['prompt'] },
        { required: ['enabled'] },
        { required: ['model'] },
      ],
    }),
  }),
  Object.freeze({
    name: JOB_HOST_TOOL_NAMES.periodicDelete,
    description: 'Permanently delete a Claudian periodic job.',
    effect: 'destructive' as const,
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        id: {
          type: 'string',
          minLength: 1,
          description: 'Stable identifier returned by periodic_job.list or periodic_job.create.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: JOB_HOST_TOOL_NAMES.oneOffStart,
    description: 'Start an independent one-off Claudian job and return immediately while it runs.',
    effect: 'write' as const,
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, description: 'Human-readable job name.' },
        prompt: { type: 'string', minLength: 1, description: 'Prompt executed by the new job.' },
        model: {
          ...MODEL_SCHEMA,
          description: 'Optional provider-qualified model. Defaults to the active agent provider and model.',
        },
      },
      required: ['name', 'prompt'],
      additionalProperties: false,
    }),
  }),
]);

const EMPTY_KEYS: Readonly<Record<string, true>> = Object.freeze({});
const ID_KEYS: Readonly<Record<string, true>> = Object.freeze({ id: true });
const MODEL_KEYS: Readonly<Record<string, true>> = Object.freeze({
  providerId: true,
  model: true,
});
const CREATE_KEYS: Readonly<Record<string, true>> = Object.freeze({
  name: true,
  schedule: true,
  prompt: true,
  enabled: true,
  model: true,
});
const ONE_OFF_START_KEYS: Readonly<Record<string, true>> = Object.freeze({
  name: true,
  prompt: true,
  model: true,
});
const UPDATE_KEYS: Readonly<Record<string, true>> = Object.freeze({
  id: true,
  ...CREATE_KEYS,
});
const UPDATE_FIELDS = ['name', 'schedule', 'prompt', 'enabled', 'model'] as const;

export class JobHostToolCatalog implements HostToolCatalog {
  constructor(
    private readonly periodicJobs: PeriodicJobsHostPort,
    private readonly oneOffJobs: OneOffJobsHostPort,
  ) {}

  list(): readonly HostToolDefinition[] {
    return DEFINITIONS;
  }

  async invoke(
    name: string,
    input: unknown,
    context: HostToolInvocationContext,
  ): Promise<HostToolResult> {
    try {
      switch (name) {
        case JOB_HOST_TOOL_NAMES.periodicList:
          requireExactObject(input, EMPTY_KEYS);
          return {
            ok: true,
            value: {
              jobs: this.periodicJobs.list().map(job => ({
                ...structuredClone(job),
                running: this.periodicJobs.isRunning(job.id),
              })),
            },
          };
        case JOB_HOST_TOOL_NAMES.periodicCreate: {
          const value = requireExactObject(input, CREATE_KEYS);
          const draft = parseCreateInput(value, context);
          return { ok: true, value: { job: await this.periodicJobs.create(draft) } };
        }
        case JOB_HOST_TOOL_NAMES.periodicUpdate: {
          const value = requireExactObject(input, UPDATE_KEYS);
          const id = requireNonEmptyString(value, 'id');
          const patch = parseUpdatePatch(value);
          return { ok: true, value: { job: await this.periodicJobs.updatePartial(id, patch) } };
        }
        case JOB_HOST_TOOL_NAMES.periodicDelete: {
          const value = requireExactObject(input, ID_KEYS);
          const id = requireNonEmptyString(value, 'id');
          await this.periodicJobs.delete(id);
          return { ok: true, value: { deleted: true, id } };
        }
        case JOB_HOST_TOOL_NAMES.oneOffStart: {
          const value = requireExactObject(input, ONE_OFF_START_KEYS);
          const draft: OneOffJobDraft = {
            name: requireNonEmptyString(value, 'name'),
            prompt: requireNonEmptyString(value, 'prompt'),
            model: Object.hasOwn(value, 'model')
              ? parseModel(value.model)
              : { providerId: context.providerId, model: context.model },
          };
          return { ok: true, value: { job: await this.oneOffJobs.start(draft) } };
        }
        default:
          return failure('invalid_input', 'Unknown host tool.');
      }
    } catch (error) {
      return mapError(error);
    }
  }
}

function parseCreateInput(
  value: Record<string, unknown>,
  context: HostToolInvocationContext,
): PeriodicJobDraft {
  return {
    name: requireNonEmptyString(value, 'name'),
    schedule: requireNonEmptyString(value, 'schedule'),
    prompt: requireNonEmptyString(value, 'prompt'),
    enabled: Object.hasOwn(value, 'enabled') ? requireBoolean(value, 'enabled') : true,
    model: Object.hasOwn(value, 'model')
      ? parseModel(value.model)
      : { providerId: context.providerId, model: context.model },
  };
}

function parseUpdatePatch(value: Record<string, unknown>): PeriodicJobPartialUpdate {
  const patch: PeriodicJobPartialUpdate = {};
  for (const field of UPDATE_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    switch (field) {
      case 'enabled':
        patch.enabled = requireBoolean(value, field);
        break;
      case 'model':
        patch.model = parseModel(value[field]);
        break;
      default:
        patch[field] = requireNonEmptyString(value, field);
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new HostToolInputError('At least one periodic job field is required.');
  }
  return patch;
}

function parseModel(value: unknown): StoredChatModelSelection {
  const record = requireExactObject(value, MODEL_KEYS);
  if (!Object.hasOwn(record, 'providerId') || !Object.hasOwn(record, 'model')) {
    throw new HostToolInputError('Model requires providerId and model.');
  }
  return {
    providerId: requireNonEmptyString(record, 'providerId'),
    model: requireNonEmptyString(record, 'model'),
  };
}

function requireExactObject(
  value: unknown,
  allowedKeys: Readonly<Record<string, true>>,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HostToolInputError('Tool input must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !Object.hasOwn(allowedKeys, key))) {
    throw new HostToolInputError('Tool input contains an unsupported field.');
  }
  return record;
}

function requireNonEmptyString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new HostToolInputError(`${key} must be a non-empty string.`);
  }
  return field;
}

function requireBoolean(value: Record<string, unknown>, key: string): boolean {
  const field = value[key];
  if (typeof field !== 'boolean') {
    throw new HostToolInputError(`${key} must be a boolean.`);
  }
  return field;
}

class HostToolInputError extends Error {}

function mapError(error: unknown): HostToolResult {
  if (error instanceof HostToolInputError) {
    return failure('invalid_input', error.message);
  }
  if (!(error instanceof Error)) {
    return failure('internal_error', 'Job operation failed.');
  }
  const code = errorCodeForMessage(error.message);
  return code
    ? failure(code, error.message)
    : failure('internal_error', 'Job operation failed.');
}

function errorCodeForMessage(message: string): HostToolErrorCode | null {
  switch (message) {
    case 'Periodic job not found.':
    case 'One-off job not found.':
      return 'not_found';
    case 'Selected provider is unavailable.':
      return 'provider_unavailable';
    case 'Selected provider is not enabled.':
      return 'provider_disabled';
    case 'Selected model is unavailable.':
      return 'model_unavailable';
    case 'Schedule must use a valid five-field cron pattern.':
      return 'invalid_schedule';
    case 'Periodic job name is required.':
    case 'Periodic job prompt is required.':
    case 'One-off job name is required.':
    case 'One-off job prompt is required.':
      return 'invalid_input';
    case 'Periodic job is already running.':
      return 'conflict';
    default:
      return null;
  }
}

function failure(code: HostToolErrorCode, message: string): HostToolResult {
  return { ok: false, error: { code, message } };
}
