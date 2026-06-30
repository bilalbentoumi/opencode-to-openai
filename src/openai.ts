import type { AssistantMessage, Part, TextPartInput } from '@opencode-ai/sdk';

// --- OpenAI-compatible wire types (the subset we support) ---

export interface OpenAIContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface OpenAIMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string | OpenAIContentPart[] | null;
  name?: string;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Split an OpenAI `provider/model` id into OpenCode's provider + model ids. */
export function parseModel(model: string): { providerID: string; modelID: string } {
  const idx = model.indexOf('/');
  if (idx === -1) return { providerID: 'opencode', modelID: model };
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}

/** Flatten OpenAI message content (string or content-part array) to plain text. */
function contentToText(content: OpenAIMessage['content']): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : typeof part.text === 'string' ? part.text : ''))
      .join('');
  }
  return '';
}

/**
 * Convert an OpenAI chat history into an OpenCode prompt.
 *
 * OpenAI is stateless — every request carries the full transcript — while each
 * OpenCode session is fresh, so we fold the history into labeled text parts and
 * hoist system/developer messages into the dedicated `system` field.
 */
export function messagesToPrompt(messages: OpenAIMessage[]): {
  system: string;
  parts: TextPartInput[];
} {
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

/** Pull assistant text + reasoning out of OpenCode message parts. */
export function extractParts(parts: Part[] | undefined): { content: string; reasoning: string } {
  if (!Array.isArray(parts)) return { content: '', reasoning: '' };
  let content = '';
  let reasoning = '';
  for (const part of parts) {
    if (part.type === 'text') content += part.text;
    else if (part.type === 'reasoning') reasoning += part.text;
  }
  return { content, reasoning };
}

/** Map OpenCode token accounting onto OpenAI's usage shape. */
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

/** Build a non-streaming `chat.completion` response object. */
export function buildCompletion(opts: {
  id: string;
  model: string;
  content: string;
  reasoning: string;
  usage: OpenAIUsage;
  finishReason: string;
}) {
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

/** Build a single streaming `chat.completion.chunk`. */
export function buildChunk(opts: {
  id: string;
  model: string;
  delta: Record<string, unknown>;
  finishReason: string | null;
}) {
  return {
    id: opts.id,
    object: 'chat.completion.chunk',
    created: nowSeconds(),
    model: opts.model,
    choices: [{ index: 0, delta: opts.delta, finish_reason: opts.finishReason }],
  };
}
