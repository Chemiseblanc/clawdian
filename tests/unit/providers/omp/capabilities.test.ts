import { OMP_PROVIDER_CAPABILITIES } from '@/providers/omp/capabilities';

describe('OMP_PROVIDER_CAPABILITIES', () => {
  it('exposes the Omp capability contract', () => {
    expect(OMP_PROVIDER_CAPABILITIES).toEqual({
      providerId: 'omp',
      supportsNativeHistory: true,
      supportsPlanMode: false,
      supportsRewind: false,
      supportsFork: true,
      supportsProviderCommands: true,
      supportsImageAttachments: true,
      supportsInstructionMode: true,
      supportsHostTools: true,
      supportsMcpTools: false,
      supportsTurnSteer: true,
      reasoningControl: 'effort',
    });
  });
});
