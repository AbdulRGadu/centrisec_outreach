import type { D1Database } from '@cloudflare/workers-types';
import { HttpError, jsonResponse } from '../http.ts';
import { normalizeInlineText } from '../util/text.ts';

export interface OutreachSettings {
  greeting: string;
  fallbackGreeting: string;
  signoff: string;
  senderName: string;
  cta: string;
  footerHtml: string;
}

export const DEFAULT_OUTREACH_SETTINGS: OutreachSettings = {
  greeting: 'Hi',
  fallbackGreeting: 'Hello',
  signoff: 'Best regards',
  senderName: '',
  cta: 'Would it be useful if I sent it over?',
  footerHtml: '',
};

const KEYS = Object.keys(DEFAULT_OUTREACH_SETTINGS) as Array<keyof OutreachSettings>;

function clean(key: keyof OutreachSettings, value: unknown): string {
  if (key === 'footerHtml') return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim().slice(0, 10_000) : '';
  const max = key === 'cta' ? 220 : 80;
  const result = normalizeInlineText(value, max);
  if (key === 'senderName' && result.toLowerCase() === 'centrisec team') return '';
  if (!result && key !== 'senderName') throw new HttpError(400, `${key} cannot be empty`);
  if (key === 'cta' && (result.match(/\?/g) ?? []).length > 1) {
    throw new HttpError(400, 'cta must contain only one question');
  }
  return result;
}

export async function getOutreachSettings(db: D1Database): Promise<OutreachSettings> {
  const rows = await db.prepare(
    `SELECT key, value FROM config WHERE key IN (${KEYS.map((_, i) => `?${i + 1}`).join(', ')})`
  ).bind(...KEYS.map((key) => `outreach_${key}`)).all<{ key: string; value: string }>();
  const values = new Map(rows.results.map((row) => [row.key, row.value]));
  return Object.fromEntries(KEYS.map((key) => {
    const value = values.get(`outreach_${key}`) ?? DEFAULT_OUTREACH_SETTINGS[key];
    return [key, key === 'senderName' && value.trim().toLowerCase() === 'centrisec team' ? '' : value];
  })) as unknown as OutreachSettings;
}

export async function updateOutreachSettings(body: Record<string, unknown>, db: D1Database): Promise<OutreachSettings> {
  const current = await getOutreachSettings(db);
  const next = { ...current };
  for (const key of KEYS) {
    if (body[key] !== undefined) next[key] = clean(key, body[key]);
  }
  await db.batch(KEYS.map((key) => db.prepare(
    `INSERT INTO config (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(`outreach_${key}`, next[key])));
  return next;
}

export async function handleOutreachSettingsGet(db: D1Database): Promise<Response> {
  return jsonResponse({ ok: true, settings: await getOutreachSettings(db) });
}

export async function handleOutreachSettingsPost(body: Record<string, unknown>, db: D1Database): Promise<Response> {
  return jsonResponse({ ok: true, settings: await updateOutreachSettings(body, db) });
}
