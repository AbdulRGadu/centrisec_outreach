import { intVar, type Env } from './env';
import { jsonResponse } from './http';
import { dayString } from './util/time';

const LEAD_STATUSES = [
  'new',
  'scored',
  'drafted',
  'approved',
  'queued',
  'sent',
  'replied',
  'bounced',
  'unsubscribed',
  'disqualified',
] as const;

export async function handleStats(env: Env): Promise<Response> {
  const pipeline: Record<string, number> = {};
  for (const s of LEAD_STATUSES) pipeline[s] = 0;
  const statusRows = await env.DB
    .prepare('SELECT status, COUNT(*) AS n FROM leads GROUP BY status')
    .all<{ status: string; n: number }>();
  for (const row of statusRows.results) pipeline[row.status] = row.n;

  const today = dayString(env.TIMEZONE);
  const counter = await env.DB
    .prepare('SELECT count FROM send_counters WHERE day = ?1')
    .bind(today)
    .first<{ count: number }>();

  const drafts = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM messages WHERE direction = 'outbound' AND status = 'draft'`)
    .first<{ n: number }>();

  const sendUnknown = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM messages WHERE direction = 'outbound' AND status = 'send_unknown'`)
    .first<{ n: number }>();

  const replies7 = await env.DB
    .prepare(
      `SELECT COALESCE(classification, 'unclear') AS classification, COUNT(*) AS n
       FROM messages
       WHERE direction = 'inbound' AND created_at > datetime('now','-7 days')
       GROUP BY classification`
    )
    .all<{ classification: string; n: number }>();
  const repliesLast7ByClass: Record<string, number> = {};
  for (const row of replies7.results) repliesLast7ByClass[row.classification] = row.n;

  const sent7 = await env.DB
    .prepare(
      `SELECT substr(sent_at, 1, 10) AS day, COUNT(*) AS n
       FROM messages
       WHERE direction = 'outbound' AND status = 'sent' AND sent_at > datetime('now','-7 days')
       GROUP BY day ORDER BY day`
    )
    .all<{ day: string; n: number }>();

  return jsonResponse({
    ok: true,
    pipeline,
    sendsToday: counter?.count ?? 0,
    dailyCap: intVar(env.DAILY_SEND_CAP, 10),
    draftsAwaiting: drafts?.n ?? 0,
    sendUnknown: sendUnknown?.n ?? 0,
    repliesLast7ByClass,
    sentLast7: sent7.results,
  });
}
