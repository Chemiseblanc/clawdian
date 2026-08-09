import { CLAUDE_PROVIDER_CAPABILITIES } from '@/providers/claude/capabilities';

describe('CLAUDE_PROVIDER_CAPABILITIES', () => {
  it('advertises host-tool support independently from MCP configuration', () => {
    expect(CLAUDE_PROVIDER_CAPABILITIES.supportsHostTools).toBe(true);
    expect(CLAUDE_PROVIDER_CAPABILITIES.supportsMcpTools).toBe(true);
  });
});
