import type {
  AssistantMessage,
  Part,
  SessionPromptData,
} from '@opencode-ai/sdk';
import cors from 'cors';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';

import { runWithForwardedAuth } from './auth-context.js';
import type { Backend } from './backend.js';
import {
  buildChunk,
  buildCompletion,
  extractParts,
  messagesToPrompt,
  parseModel,
  toUsage,
} from './openai.js';
import type { ChatCompletionRequest, Config } from './types.js';

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function mapFinishReason(finish: string | undefined): string {
  switch (finish) {
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'tool_calls':
    case 'tool-calls':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as {
      data?: { message?: string };
      message?: string;
      name?: string;
    };
    return e.data?.message ?? e.message ?? e.name ?? 'OpenCode error';
  }
  return String(error);
}

class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

const writeSse = (res: Response, payload: unknown) =>
  res.write(`data: ${JSON.stringify(payload)}\n\n`);

type PromptArgs = Omit<SessionPromptData, 'url'>;

export function createApp(config: Config, backend: Backend): Express {
  const { client } = backend;
  const app = express();

  app.use(
    cors({
      origin: '*',
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  );
  app.use(express.json({ limit: '50mb' }));

  app.use((req: Request, _res: Response, next: NextFunction) => {
    runWithForwardedAuth(
      config.forwardAuth ? req.headers.authorization : undefined,
      next,
    );
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'OPTIONS' || req.path === '/health' || req.path === '/')
      return next();
    if (/^Bearer\s+\S/.test(req.headers.authorization ?? '')) return next();
    res.status(401).json({
      error: {
        message: "Missing API key. Send 'Authorization: Bearer <key>'.",
        type: 'invalid_request_error',
      },
    });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', backend: backend.url });
  });

  const MODEL_CACHE_MS = 60_000;
  let modelCache: {
    models: Array<{ id: string; owned_by: string; name: string }>;
    at: number;
  } | null = null;

  async function listModels() {
    if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS)
      return modelCache.models;
    const result = await client.config.providers();

    if (result.error)
      throw new UpstreamError(
        errorMessage(result.error),
        result.response?.status ?? 502,
      );
    const raw = result.data?.providers ?? [];
    const providers = Array.isArray(raw)
      ? raw
      : Object.entries(raw).map(([id, p]) => ({ ...(p as object), id }));

    const models: Array<{ id: string; owned_by: string; name: string }> = [];
    for (const provider of providers as Array<{
      id: string;
      models?: Record<string, { name?: string }>;
    }>) {
      for (const [modelId, model] of Object.entries(provider.models ?? {})) {
        models.push({
          id: `${provider.id}/${modelId}`,
          owned_by: provider.id,
          name: model.name ?? modelId,
        });
      }
    }
    modelCache = { models, at: Date.now() };
    return models;
  }

  app.get('/v1/models', async (_req, res) => {
    try {
      const models = await listModels();
      res.json({
        object: 'list',
        data: models.map((m) => ({
          id: m.id,
          object: 'model',
          created: 0,
          owned_by: m.owned_by,
          name: m.name,
        })),
      });
    } catch (err) {
      console.error(`[models] ${(err as Error).message}`);
      const status = err instanceof UpstreamError ? err.status : 502;
      res.status(status).json({
        error: { message: errorMessage(err), type: 'upstream_error' },
      });
    }
  });

  app.post('/v1/chat/completions', async (req: Request, res: Response) => {
    const body = req.body as ChatCompletionRequest;
    if (!Array.isArray(body?.messages) || body.messages.length === 0) {
      res.status(400).json({
        error: {
          message: '`messages` must be a non-empty array',
          type: 'invalid_request_error',
        },
      });
      return;
    }

    const modelName = body.model;
    const { providerID, modelID } = parseModel(modelName);
    const { system, parts } = messagesToPrompt(body.messages);
    if (parts.length === 0) {
      res.status(400).json({
        error: {
          message: 'No user/assistant content to send',
          type: 'invalid_request_error',
        },
      });
      return;
    }

    const fullModelId = `${providerID}/${modelID}`;
    const known = await listModels().catch(() => null);
    if (known && !known.some((m) => m.id === fullModelId)) {
      res.status(404).json({
        error: {
          message: `The model '${modelName}' does not exist or is not available. See GET /v1/models for the list.`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      });
      return;
    }

    const id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    let sessionId: string | undefined;

    try {
      const session = await client.session.create();
      sessionId = session.data?.id;
      if (!sessionId) throw new Error('Failed to create OpenCode session');

      const promptParams = {
        path: { id: sessionId },
        body: {
          model: { providerID, modelID },
          ...(system ? { system } : {}),
          parts,
        },
      };

      if (body.stream) {
        await handleStream(res, {
          id,
          model: modelName,
          promptParams,
          sessionId,
        });
      } else {
        await handleNonStream(res, { id, model: modelName, promptParams });
      }
    } catch (err) {
      console.error(`[chat] ${(err as Error).message}`);
      const message = (err as Error).message;
      const status =
        err instanceof UpstreamError
          ? err.status
          : message.includes('timed out')
            ? 504
            : 500;
      if (!res.headersSent) {
        res.status(status).json({ error: { message, type: 'proxy_error' } });
      } else {
        writeSse(
          res,
          buildChunk({
            id,
            model: modelName,
            delta: { content: `\n[proxy error] ${message}` },
            finishReason: 'stop',
          }),
        );
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } finally {
      if (sessionId) {
        client.session.delete({ path: { id: sessionId } }).catch((e: Error) => {
          console.error(`[chat] session cleanup failed: ${e.message}`);
        });
      }
    }
  });

  async function handleNonStream(
    res: Response,
    ctx: { id: string; model: string; promptParams: PromptArgs },
  ) {
    const result = await withTimeout(
      client.session.prompt(ctx.promptParams),
      config.requestTimeoutMs,
      'prompt',
    );
    if (result.error)
      throw new UpstreamError(
        errorMessage(result.error),
        result.response?.status ?? 502,
      );

    const info = result.data?.info;
    const { content, reasoning } = extractParts(result.data?.parts);

    if (info?.error && !content && !reasoning) {
      res.status(502).json({
        error: {
          message: errorMessage(info.error),
          type: info.error.name ?? 'upstream_error',
        },
      });
      return;
    }

    res.json(
      buildCompletion({
        id: ctx.id,
        model: ctx.model,
        content,
        reasoning,
        usage: toUsage(info),
        finishReason: mapFinishReason(info?.finish),
      }),
    );
  }

  async function handleStream(
    res: Response,
    ctx: {
      id: string;
      model: string;
      sessionId: string;
      promptParams: PromptArgs;
    },
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    writeSse(
      res,
      buildChunk({
        id: ctx.id,
        model: ctx.model,
        delta: { role: 'assistant' },
        finishReason: null,
      }),
    );

    const controller = new AbortController();
    let sentContent = '';
    let sentReasoning = '';

    const subscription = await client.event.subscribe({
      signal: controller.signal,
    });
    const consume = (async () => {
      try {
        for await (const event of subscription.stream) {
          if (event.type !== 'message.part.updated') continue;
          const { part, delta } = event.properties;
          if (!delta) continue;
          if (part.type === 'reasoning' && part.sessionID === ctx.sessionId) {
            sentReasoning += delta;
            writeSse(
              res,
              buildChunk({
                id: ctx.id,
                model: ctx.model,
                delta: { reasoning_content: delta },
                finishReason: null,
              }),
            );
          } else if (part.type === 'text' && part.sessionID === ctx.sessionId) {
            sentContent += delta;
            writeSse(
              res,
              buildChunk({
                id: ctx.id,
                model: ctx.model,
                delta: { content: delta },
                finishReason: null,
              }),
            );
          }
        }
      } catch {
        // stream aborted once the prompt resolves — expected.
      }
    })();

    let info: AssistantMessage | undefined;
    let parts: Part[] | undefined;
    try {
      const result = await withTimeout(
        client.session.prompt(ctx.promptParams),
        config.requestTimeoutMs,
        'prompt',
      );
      if (result.error)
        throw new UpstreamError(
          errorMessage(result.error),
          result.response?.status ?? 502,
        );
      info = result.data?.info;
      parts = result.data?.parts;
    } finally {
      controller.abort();
    }
    await consume;

    const { content, reasoning } = extractParts(parts);
    const remainderReasoning = reasoning.startsWith(sentReasoning)
      ? reasoning.slice(sentReasoning.length)
      : '';
    if (remainderReasoning) {
      writeSse(
        res,
        buildChunk({
          id: ctx.id,
          model: ctx.model,
          delta: { reasoning_content: remainderReasoning },
          finishReason: null,
        }),
      );
    }
    const remainderContent = content.startsWith(sentContent)
      ? content.slice(sentContent.length)
      : '';
    if (remainderContent) {
      writeSse(
        res,
        buildChunk({
          id: ctx.id,
          model: ctx.model,
          delta: { content: remainderContent },
          finishReason: null,
        }),
      );
    }

    writeSse(
      res,
      buildChunk({
        id: ctx.id,
        model: ctx.model,
        delta: {},
        finishReason: mapFinishReason(info?.finish),
      }),
    );
    res.write('data: [DONE]\n\n');
    res.end();
  }

  return app;
}
