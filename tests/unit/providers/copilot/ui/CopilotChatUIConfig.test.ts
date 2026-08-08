import { copilotProviderRegistration } from '@/providers/copilot/registration';
import { getCopilotProviderSettings } from '@/providers/copilot/settings';
import { copilotChatUIConfig } from '@/providers/copilot/ui/CopilotChatUIConfig';

const catalog = {
  defaultModelId: 'gpt-5',
  fingerprint: 'copilot-ui-catalog',
  models: [
    {
      contextWindow: 400_000,
      defaultReasoningEffort: 'high',
      description: 'OpenAI coding model through Copilot',
      displayName: 'GPT-5',
      rawId: 'gpt-5',
      reasoningEfforts: [
        { label: 'Low', value: 'low' },
        { label: 'High', value: 'high' },
      ],
      supportsReasoning: true,
    },
    {
      description: 'Anthropic coding model through Copilot',
      displayName: 'Claude Sonnet 4',
      rawId: 'claude-sonnet-4',
      reasoningEfforts: [],
      supportsReasoning: false,
    },
  ],
  refreshedAt: 100,
};

function makeSettings(
  copilotOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    providerConfigs: {
      copilot: {
        catalogsByHost: { 'device:current': catalog },
        modelAliases: { 'gpt-5': 'Fast GPT' },
        preferredReasoningByModel: { 'gpt-5': 'high' },
        visibleModels: null,
        ...copilotOverrides,
      },
    },
  };
}

jest.mock('@/utils/env', () => ({
  ...jest.requireActual('@/utils/env'),
  getHostnameKey: () => 'device:current',
}));

describe('CopilotChatUIConfig', () => {
  it('is the chat config registered by Copilot and exposes discovered models in reverse order', () => {
    expect(copilotProviderRegistration.chatUIConfig).toBe(copilotChatUIConfig);

    const settings = makeSettings();
    expect(copilotChatUIConfig.getModelOptions(settings)).toEqual([
      expect.objectContaining({
        description: 'Anthropic coding model through Copilot',
        label: 'Claude Sonnet 4',
        value: 'copilot/claude-sonnet-4',
      }),
      expect.objectContaining({
        description: 'OpenAI coding model through Copilot',
        label: 'Fast GPT',
        value: 'copilot/gpt-5',
      }),
    ]);
    expect(copilotChatUIConfig.getDefaultModel?.(settings)).toBe('copilot/gpt-5');
    expect(copilotChatUIConfig.ownsModel('copilot/gpt-5', settings)).toBe(true);
    expect(copilotChatUIConfig.ownsModel('gpt-5', settings)).toBe(false);
  });

  it('does not invent a model or default before ACP discovery', () => {
    const settings = {
      providerConfigs: { copilot: { enabled: true } },
    };

    expect(copilotChatUIConfig.getModelOptions(settings)).toEqual([]);
    expect(copilotChatUIConfig.getDefaultModel?.(settings)).toBeNull();
  });

  it('projects advertised reasoning efforts and persists selections by raw model id', () => {
    const settings = makeSettings();

    expect(copilotChatUIConfig.isAdaptiveReasoningModel('copilot/gpt-5', settings)).toBe(true);
    expect(copilotChatUIConfig.getReasoningOptions('copilot/gpt-5', settings)).toEqual([
      { label: 'Low', value: 'low' },
      { label: 'High', value: 'high' },
    ]);
    expect(copilotChatUIConfig.getDefaultReasoningValue('copilot/gpt-5', settings)).toBe('high');
    expect(copilotChatUIConfig.getReasoningOptions('copilot/claude-sonnet-4', settings)).toEqual([]);
    expect(copilotChatUIConfig.getDefaultReasoningValue('copilot/claude-sonnet-4', settings)).toBe('');

    copilotChatUIConfig.applyReasoningSelection?.('copilot/gpt-5', 'low', settings);
    expect(getCopilotProviderSettings(settings).preferredReasoningByModel).toEqual({
      'gpt-5': 'low',
    });

    copilotChatUIConfig.applyModelDefaults('copilot/gpt-5', settings);
    expect(settings.model).toBe('copilot/gpt-5');
    expect(settings.effortLevel).toBe('low');

    settings.effortLevel = 'high';
    copilotChatUIConfig.applyModelProjectionDefaults?.('copilot/gpt-5', settings);
    expect(settings.effortLevel).toBe('low');
  });

  it('maps Safe, YOLO, and PLAN permission modes synchronously', () => {
    const settings: Record<string, unknown> = {};
    expect(copilotChatUIConfig.getPermissionModeToggle?.()).toEqual({
      inactiveValue: 'normal',
      inactiveLabel: 'Safe',
      activeValue: 'yolo',
      activeLabel: 'YOLO',
      planValue: 'plan',
      planLabel: 'PLAN',
    });

    expect(copilotChatUIConfig.resolvePermissionMode?.(settings)).toBe('normal');
    copilotChatUIConfig.applyPermissionMode?.('plan', settings);
    expect(copilotChatUIConfig.resolvePermissionMode?.(settings)).toBe('plan');
    copilotChatUIConfig.applyPermissionMode?.('yolo', settings);
    expect(copilotChatUIConfig.resolvePermissionMode?.(settings)).toBe('yolo');
    copilotChatUIConfig.applyPermissionMode?.('normal', settings);
    expect(copilotChatUIConfig.resolvePermissionMode?.(settings)).toBe('normal');
    expect(copilotChatUIConfig.getModeSelector?.(settings)).toBeNull();
  });

  it('prefers discovered context windows and uses the shared fallback otherwise', () => {
    const settings = makeSettings();

    expect(copilotChatUIConfig.getContextWindowSize(
      'copilot/gpt-5',
      { 'copilot/gpt-5': 123_000 },
      settings,
    )).toBe(400_000);
    expect(copilotChatUIConfig.getContextWindowSize(
      'copilot/missing',
      { 'copilot/missing': 123_000 },
      settings,
    )).toBe(123_000);
    expect(copilotChatUIConfig.getContextWindowSize('copilot/missing', undefined, settings))
      .toBe(200_000);
  });
});
