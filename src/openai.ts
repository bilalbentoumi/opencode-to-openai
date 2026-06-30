import type { AssistantMessage, Part, TextPartInput } from '@opencode-ai/sdk';
import type {
  ChunkParams,
  CompletionParams,
  ExtractedParts,
  OpenAIMessage,
  OpenAIUsage,
  ParsedModel,
  PromptPayload,
} from './types.js';

export type { ChatCompletionRequest } from './types.js';

export function parseModel(model: string): ParsedModel {
  const idx = model.indexOf('/');
  if (idx === -1) return { providerID: 'opencode', modelID: model };
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}

function contentToText(content: OpenAIMessage['content']): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : typeof part.text === 'string'
            ? part.text
            : '',
      )
      .join('');
  }
  return '';
}

export function messagesToPrompt(messages: OpenAIMessage[]): PromptPayload {
  const systemChunks: string[] = [];
  const parts: TextPartInput[] = [];

  for (const message of messages) {
    const role = (message.role ?? 'user').toLowerCase();
    const text = contentToText(message.content);
    if (role === 'system' || role === 'developer') {
      if (text.trim()) systemChunks.push(text);
      continue;
    }
    if (!text.trim()) continue;
    const label = role.toUpperCase();
    const named = message.name ? `${label}(${message.name})` : label;
    parts.push({ type: 'text', text: `${named}: ${text}` });
  }

  return { system: systemChunks.join('\n\n'), parts };
}

export function extractParts(parts: Part[] | undefined): ExtractedParts {
  if (!Array.isArray(parts)) return { content: '', reasoning: '' };
  let content = '';
  let reasoning = '';
  for (const part of parts) {
    if (part.type === 'text') content += part.text;
    else if (part.type === 'reasoning') reasoning += part.text;
  }
  return { content, reasoning };
}

export function toUsage(info: AssistantMessage | undefined): OpenAIUsage {
  const tokens = info?.tokens;
  const prompt = tokens?.input ?? 0;
  const completion = (tokens?.output ?? 0) + (tokens?.reasoning ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

export function buildCompletion(opts: CompletionParams) {
  return {
    id: opts.id,
    object: 'chat.completion',
    created: nowSeconds(),
    model: opts.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: opts.content,
          ...(opts.reasoning ? { reasoning_content: opts.reasoning } : {}),
        },
        finish_reason: opts.finishReason,
      },
    ],
    usage: opts.usage,
  };
}

export function buildChunk(opts: ChunkParams) {
  return {
    id: opts.id,
    object: 'chat.completion.chunk',
    created: nowSeconds(),
    model: opts.model,
    choices: [
      { index: 0, delta: opts.delta, finish_reason: opts.finishReason },
    ],
  };
}
