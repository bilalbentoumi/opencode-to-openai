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

export type Config = {
  port: number;
  host: string;
  requestTimeoutMs: number;
  opencodeServerUrl: string;
  opencodePort: number;
  forwardAuth: boolean;
};
