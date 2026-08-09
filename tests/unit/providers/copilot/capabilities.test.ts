import { COPILOT_PROVIDER_CAPABILITIES } from '@/providers/copilot/capabilities';

describe('COPILOT_PROVIDER_CAPABILITIES', () => {
  it('advertises host-tool support', () => {
    expect(COPILOT_PROVIDER_CAPABILITIES.supportsHostTools).toBe(true);
  });
});
