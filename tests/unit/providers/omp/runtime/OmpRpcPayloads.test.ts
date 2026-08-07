import { buildOmpSetModelPayload } from '@/providers/omp/runtime/OmpRpcPayloads';

describe('Omp RPC payload builders', () => {
  it('uses Omp RPC modelId field for set_model payloads', () => {
    expect(buildOmpSetModelPayload('omp:openai-codex/gpt-5.2')).toEqual({
      modelId: 'gpt-5.2',
      provider: 'openai-codex',
    });
  });

  it('rejects invalid Omp model ids', () => {
    expect(buildOmpSetModelPayload('openai-codex/gpt-5.2')).toBeNull();
    expect(buildOmpSetModelPayload('omp:openai-codex')).toBeNull();
  });
});
