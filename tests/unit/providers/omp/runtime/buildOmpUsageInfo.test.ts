import { buildOmpUsageInfo } from '@/providers/omp/runtime/buildOmpUsageInfo';

describe('buildOmpUsageInfo', () => {
  it('normalizes fractional provider percentages to whole context-meter percentages', () => {
    const usage = buildOmpUsageInfo({
      contextUsage: {
        contextTokens: 24_691,
        contextWindow: 200_000,
        inputTokens: 1200,
        percentage: 0.123456789,
      },
    }, 'omp:openai/gpt-5');

    expect(usage?.percentage).toBe(12);
  });

  it('preserves provider percentages that are already whole percent values', () => {
    const usage = buildOmpUsageInfo({
      context_usage: {
        context_tokens: 50_000,
        context_window: 200_000,
        input_tokens: 1200,
        percentage: 25,
      },
    }, null);

    expect(usage?.percentage).toBe(25);
  });

  it('rounds provider percentage decimals when they are already percent values', () => {
    const usage = buildOmpUsageInfo({
      contextUsage: {
        contextTokens: 24_691,
        contextWindow: 200_000,
        inputTokens: 1200,
        percentage: 12.3456789,
      },
    }, null);

    expect(usage?.percentage).toBe(12);
  });

  it('rounds derived percentages to match the shared context meter contract', () => {
    const usage = buildOmpUsageInfo({
      contextUsage: {
        contextTokens: 11_830,
        contextWindow: 200_000,
        inputTokens: 38,
      },
    }, null);

    expect(usage?.percentage).toBe(6);
  });

  it('uses a fallback context window without marking it provider-authoritative', () => {
    const usage = buildOmpUsageInfo({
      contextUsage: {
        contextTokens: 50_000,
        inputTokens: 1200,
      },
    }, 'omp:anthropic/claude-sonnet-4', 1_000_000);

    expect(usage).toMatchObject({
      contextWindow: 1_000_000,
      contextWindowIsAuthoritative: false,
      percentage: 5,
    });
  });
});
