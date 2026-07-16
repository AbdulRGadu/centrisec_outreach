import type { z } from 'zod';
import type { Env } from '../env';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class AiError extends Error {
  stage: string;
  constructor(stage: string, message: string) {
    super(message);
    this.stage = stage;
  }
}

interface WorkersAiEnvelope {
  success?: boolean;
  result?: { response?: unknown } | null;
  errors?: Array<{ code?: number; message?: string }>;
}

async function callModel(
  env: Env,
  model: string,
  messages: ChatMessage[],
  jsonSchema: unknown,
  maxTokens: number,
  useGateway: boolean
): Promise<unknown> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${model}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.CF_AI_TOKEN}`,
    'Content-Type': 'application/json',
  };
  // Routing through AI Gateway gives logging/analytics; a plain Workers AI
  // call is the fallback if the gateway itself has trouble.
  if (useGateway && env.AI_GATEWAY_ID) headers['cf-aig-gateway-id'] = env.AI_GATEWAY_ID;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      messages,
      max_tokens: maxTokens,
      response_format: { type: 'json_schema', json_schema: jsonSchema },
    }),
  });

  if (res.status >= 500 && useGateway) {
    return callModel(env, model, messages, jsonSchema, maxTokens, false);
  }
  const envelope = (await res.json().catch(() => null)) as WorkersAiEnvelope | null;
  if (!res.ok || !envelope || envelope.success === false) {
    const detail = envelope?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    throw new AiError('call', `Workers AI request failed: ${detail}`);
  }
  return envelope.result?.response;
}

function parseMaybeJson(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return value;
  const cleaned = value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}

/**
 * Run a model expecting structured JSON. Validates with zod; on invalid output
 * retries once with a corrective nudge, then throws AiError.
 */
export async function runJson<T>(
  env: Env,
  model: string,
  messages: ChatMessage[],
  jsonSchema: unknown,
  schema: z.ZodType<T>,
  opts?: { maxTokens?: number }
): Promise<T> {
  const maxTokens = opts?.maxTokens ?? 900;
  if (!env.CF_AI_TOKEN || env.CF_AI_TOKEN === 'replace-me') {
    throw new AiError('config', 'CF_AI_TOKEN is not configured');
  }

  let lastIssue = '';
  let attemptMessages = messages;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callModel(env, model, attemptMessages, jsonSchema, maxTokens, true);
    const parsed = parseMaybeJson(raw);
    const check = schema.safeParse(parsed);
    if (check.success) return check.data;
    lastIssue = check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    attemptMessages = [
      ...messages,
      {
        role: 'user',
        content:
          'Your previous output was invalid (' +
          lastIssue.slice(0, 300) +
          '). Return ONLY a valid JSON object matching the required schema. No prose, no code fences.',
      },
    ];
  }
  throw new AiError('validate', `Model output failed validation: ${lastIssue.slice(0, 300)}`);
}
