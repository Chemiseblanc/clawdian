import { parseSDKMessageToChat } from '@/providers/claude/history/sdkMessageParsing';

describe('parseSDKMessageToChat', () => {
  it('canonicalizes replayed host-tool calls without invoking them', () => {
    const message = parseSDKMessageToChat({
      type: 'assistant',
      uuid: 'assistant-1',
      timestamp: '2026-08-09T00:00:00.000Z',
      message: {
        content: [{
          type: 'tool_use',
          id: 'host-1',
          name: 'mcp__claudian__periodic_job_list',
          input: {},
        }],
      },
    } as Parameters<typeof parseSDKMessageToChat>[0]);

    expect(message?.toolCalls).toEqual([
      expect.objectContaining({
        id: 'host-1',
        name: 'claudian.periodic_job.list',
      }),
    ]);
  });
});
