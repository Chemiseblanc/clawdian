import { decodeOmpModelId, normalizeOmpThinkingLevel } from '../models';
import type { OmpProviderSettings } from '../settings';
import type { OmpProviderState } from '../types';

export interface BuildOmpLaunchSpecParams {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  envText?: string;
  model?: string | null;
  noSession?: boolean;
  noTools?: boolean;
  tools?: readonly string[];
  providerState?: OmpProviderState | null;
  settings: OmpProviderSettings;
  systemPrompt?: string;
  thinkingLevel?: string | null;
}

export interface OmpLaunchSpec {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  launchKey: string;
}

const READONLY_TOOLS = 'read,grep,glob';

export function buildOmpLaunchSpec(params: BuildOmpLaunchSpecParams): OmpLaunchSpec {
  const args = ['--mode', 'rpc'];
  const systemPrompt = params.systemPrompt?.trim();
  if (systemPrompt) {
    args.push('--system-prompt', systemPrompt);
  }

  if (params.noSession) {
    args.push('--no-session');
  } else if (params.providerState?.sessionFile || params.providerState?.sessionId) {
    args.push('--resume', params.providerState.sessionFile ?? params.providerState.sessionId!);
  }

  if (params.noTools) {
    args.push('--no-tools');
  } else if (params.tools) {
    args.push('--tools', params.tools.join(','));
  } else if (params.settings.toolMode === 'readonly') {
    args.push('--tools', READONLY_TOOLS);
  }

  const decodedModel = typeof params.model === 'string' ? decodeOmpModelId(params.model) : null;
  if (decodedModel) {
    args.push('--provider', decodedModel.provider, '--model', decodedModel.modelId);
  }

  const thinkingLevel = normalizeOmpThinkingLevel(params.thinkingLevel);
  if (thinkingLevel && thinkingLevel !== 'off') {
    args.push('--thinking', thinkingLevel);
  }

  return {
    args,
    command: params.command,
    cwd: params.cwd,
    env: params.env ?? process.env,
    launchKey: JSON.stringify({
      args,
      command: params.command,
      cwd: params.cwd,
      envText: params.envText ?? params.settings.environmentVariables,
    }),
  };
}
