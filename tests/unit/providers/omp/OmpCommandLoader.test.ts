import type { ProviderCommandLoaderContext } from '@/core/providers/types';
import { OmpCommandLoader } from '@/providers/omp/app/OmpCommandLoader';

function createContext(
  overrides: Partial<ProviderCommandLoaderContext> = {},
): ProviderCommandLoaderContext {
  return {
    allowIsolatedMetadataCreation: false,
    conversation: null,
    externalContextPaths: [],
    plugin: {
      app: { vault: { adapter: { basePath: '/vault' } } },
    } as any,
    ...overrides,
  };
}

describe('OmpCommandLoader', () => {
  it('uses a ready command snapshot without starting a metadata probe', async () => {
    const metadataProbe = { load: jest.fn() };
    const loader = new OmpCommandLoader(metadataProbe as any);

    await expect(loader.loadCommands(createContext({
      readyCommandSnapshot: [{
        content: '',
        id: 'omp:test',
        kind: 'command',
        name: 'test',
        source: 'sdk',
      }],
    }))).resolves.toMatchObject({
      items: [expect.objectContaining({ name: 'test' })],
      status: 'ready',
    });
    expect(metadataProbe.load).not.toHaveBeenCalled();
  });

  it('does not probe metadata unless isolated creation is allowed', async () => {
    const metadataProbe = { load: jest.fn() };
    const loader = new OmpCommandLoader(metadataProbe as any);

    await expect(loader.loadCommands(createContext())).resolves.toMatchObject({
      status: 'requires-session',
    });
    expect(metadataProbe.load).not.toHaveBeenCalled();
  });

  it('loads commands through a no-session metadata probe', async () => {
    const metadataProbe = {
      load: jest.fn().mockResolvedValue([{
        content: '',
        id: 'omp:skill',
        kind: 'skill',
        name: 'skill',
        source: 'sdk',
      }]),
    };
    const loader = new OmpCommandLoader(metadataProbe as any);

    await expect(loader.loadCommands(createContext({
      allowIsolatedMetadataCreation: true,
    }))).resolves.toMatchObject({
      items: [expect.objectContaining({ name: 'skill' })],
      status: 'ready',
    });
    expect(metadataProbe.load).toHaveBeenCalledWith('/vault', undefined);
  });
});
