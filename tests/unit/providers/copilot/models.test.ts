import {
  decodeCopilotModelId,
  encodeCopilotModelId,
  normalizeCopilotDiscoveredModels,
} from '@/providers/copilot/models';

describe('Copilot model identity', () => {
  it('round-trips raw ACP model ids through the Copilot namespace', () => {
    expect(encodeCopilotModelId(' claude-sonnet-4 ')).toBe('copilot/claude-sonnet-4');
    expect(encodeCopilotModelId('copilot/claude-sonnet-4')).toBe('copilot/claude-sonnet-4');
    expect(decodeCopilotModelId(' copilot/claude-sonnet-4 ')).toBe('claude-sonnet-4');
  });

  it('rejects empty and unqualified model selections', () => {
    expect(encodeCopilotModelId('')).toBe('');
    expect(encodeCopilotModelId('copilot/')).toBe('');
    expect(decodeCopilotModelId('claude-sonnet-4')).toBeNull();
    expect(decodeCopilotModelId('copilot')).toBeNull();
    expect(decodeCopilotModelId('copilot/')).toBeNull();
  });
});

describe('Copilot ACP model normalization', () => {
  it('normalizes ACP model/config records and only persists advertised reasoning options', () => {
    expect(normalizeCopilotDiscoveredModels({
      configOptions: [{
        category: 'reasoning_effort',
        currentValue: 'high',
        id: 'reasoning_effort',
        name: 'Reasoning effort',
        options: [
          { name: 'Low', value: 'low' },
          { name: 'Medium', value: 'medium' },
          { name: 'High', value: 'high' },
        ],
        type: 'select',
      }],
      models: {
        availableModels: [
          {
            description: ' Fast coding model ',
            modelId: ' gpt-5 ',
            name: ' GPT-5 ',
          },
          {
            id: 'legacy-model',
            name: 'Legacy model',
          },
          {
            modelId: 'gpt-5',
            name: 'Duplicate model',
          },
          {
            name: 'Missing id',
          },
        ],
      },
    })).toEqual([
      {
        defaultReasoningEffort: 'high',
        description: 'Fast coding model',
        displayName: 'Duplicate model',
        rawId: 'gpt-5',
        reasoningEfforts: [
          { label: 'Low', value: 'low' },
          { label: 'Medium', value: 'medium' },
          { label: 'High', value: 'high' },
        ],
        supportsReasoning: true,
      },
      {
        defaultReasoningEffort: 'high',
        displayName: 'Legacy model',
        rawId: 'legacy-model',
        reasoningEfforts: [
          { label: 'Low', value: 'low' },
          { label: 'Medium', value: 'medium' },
          { label: 'High', value: 'high' },
        ],
        supportsReasoning: true,
      },
    ]);
  });

  it('normalizes explicit model metadata without inventing an empty fallback model', () => {
    expect(normalizeCopilotDiscoveredModels([{
      modelId: 'reasoner',
      name: 'Reasoner',
      reasoningEfforts: [
        { label: 'Low', value: 'low' },
        { label: 'High', value: 'high' },
      ],
      supportsReasoning: true,
    }])).toEqual([{
      displayName: 'Reasoner',
      rawId: 'reasoner',
      reasoningEfforts: [
        { label: 'Low', value: 'low' },
        { label: 'High', value: 'high' },
      ],
      supportsReasoning: true,
    }]);
    expect(normalizeCopilotDiscoveredModels([])).toEqual([]);
    expect(normalizeCopilotDiscoveredModels(null)).toEqual([]);
  });
});
