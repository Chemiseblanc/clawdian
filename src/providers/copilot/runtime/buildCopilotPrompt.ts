import type { ChatMessage, ImageAttachment } from '@/core/types';
import type { AcpContentBlock } from '@/providers/acp';
import {
  appendBrowserContext,
  type BrowserSelectionContext,
} from '@/utils/browser';
import {
  appendCanvasContext,
  type CanvasSelectionContext,
} from '@/utils/canvas';
import {
  appendCurrentNote,
  appendCurrentNoteContent,
} from '@/utils/context';
import {
  appendEditorContext,
  type EditorSelectionContext,
} from '@/utils/editor';
import { buildContextFromHistory, buildPromptWithHistoryContext } from '@/utils/session';

export interface CopilotPromptRequest {
  readonly text: string;
  readonly images?: readonly ImageAttachment[];
  readonly currentNotePath?: string;
  readonly currentNoteContent?: string;
  readonly editorSelection?: EditorSelectionContext | null;
  readonly browserSelection?: BrowserSelectionContext | null;
  readonly canvasSelection?: CanvasSelectionContext | null;
  readonly externalContextPaths?: readonly string[];
}

export function buildCopilotPromptText(
  request: CopilotPromptRequest,
  conversationHistory: readonly ChatMessage[] = [],
): string {
  let prompt = request.text;

  if (request.currentNotePath) {
    prompt = request.currentNoteContent === undefined
      ? appendCurrentNote(prompt, request.currentNotePath)
      : appendCurrentNoteContent(
        prompt,
        request.currentNotePath,
        request.currentNoteContent,
      );
  }

  if (request.editorSelection && request.editorSelection.mode !== 'none') {
    prompt = appendEditorContext(prompt, request.editorSelection);
  }
  if (request.browserSelection) {
    prompt = appendBrowserContext(prompt, request.browserSelection);
  }
  if (request.canvasSelection) {
    prompt = appendCanvasContext(prompt, request.canvasSelection);
  }

  if (request.externalContextPaths && request.externalContextPaths.length > 0) {
    const paths = request.externalContextPaths.filter(path => path.trim().length > 0);
    if (paths.length > 0) {
      prompt += `\n\nExternal context files:\n${paths.map(path => `- ${path}`).join('\n')}`;
    }
  }

  if (conversationHistory.length > 0) {
    const historyContext = buildContextFromHistory([...conversationHistory]);
    prompt = buildPromptWithHistoryContext(
      historyContext,
      prompt,
      prompt,
      [...conversationHistory],
    );
  }

  return prompt;
}

export function buildCopilotPromptBlocks(
  request: CopilotPromptRequest,
  conversationHistory: readonly ChatMessage[] = [],
): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = [
    {
      text: buildCopilotPromptText(request, conversationHistory),
      type: 'text',
    },
  ];

  for (const image of request.images ?? []) {
    if (!image.data) continue;
    blocks.push({
      data: image.data,
      mimeType: image.mediaType,
      type: 'image',
    });
  }

  return blocks;
}
