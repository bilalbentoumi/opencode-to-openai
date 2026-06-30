import type {
  OpencodeClient,
  SessionPromptData,
  TextPartInput,
} from '@opencode-ai/sdk';

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
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenAIModel {
  id: string;
  owned_by: string;
  name: string;
}

export interface ParsedModel {
  providerID: string;
  modelID: string;
}

export interface PromptPayload {
  system: string;
  parts: TextPartInput[];
}

export interface ExtractedParts {
  content: string;
  reasoning: string;
}

export interface CompletionParams {
  id: string;
  model: string;
  content: string;
  reasoning: string;
  usage: OpenAIUsage;
  finishReason: string;
}

export interface ChunkParams {
  id: string;
  model: string;
  delta: Record<string, unknown>;
  finishReason: string | null;
}

export interface NonStreamContext {
  id: string;
  model: string;
  promptParams: PromptArgs;
}

export interface StreamContext {
  id: string;
  model: string;
  sessionId: string;
  promptParams: PromptArgs;
}

export type Config = {
  port: number;
  host: string;
  requestTimeoutMs: number;
  opencodeServerUrl: string;
  opencodePort: number;
  forwardAuth: boolean;
};

export interface Instance {
  pid: number;
  port: number;
  host: string;
  startedAt: string;
  logFile: string;
}

export interface StartOptions {
  port?: number;
  host?: string;
  opencodeUrl?: string;
  opencodePort?: number;
  requestTimeoutMs?: number;
  foreground?: boolean;
}

export type PromptArgs = Omit<SessionPromptData, 'url'>;

export interface Backend {
  client: OpencodeClient;
  url: string;
  close: () => Promise<void>;
}
