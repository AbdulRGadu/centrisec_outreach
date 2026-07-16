import type { Env } from '../env';
import { HttpError } from '../http';

const ACTIVE_MODEL_KEY = 'active_ai_model';

export function availableAiModels(env: Env): string[] {
  const configured = env.AVAILABLE_AI_MODELS.split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  const fallback = env.DEFAULT_AI_MODEL.trim();
  return [...new Set(fallback ? [fallback, ...configured] : configured)];
}

export async function activeAiModel(env: Env): Promise<string> {
  const available = availableAiModels(env);
  if (available.length === 0) throw new HttpError(500, 'No AI models are configured');

  const row = await env.DB.prepare('SELECT value FROM config WHERE key = ?1')
    .bind(ACTIVE_MODEL_KEY)
    .first<{ value: string }>();
  return row?.value && available.includes(row.value) ? row.value : available[0]!;
}

export async function setActiveAiModel(env: Env, model: string): Promise<void> {
  if (!availableAiModels(env).includes(model)) {
    throw new HttpError(400, 'Model is not in AVAILABLE_AI_MODELS');
  }
  await env.DB.prepare(
    `INSERT INTO config (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(ACTIVE_MODEL_KEY, model)
    .run();
}
