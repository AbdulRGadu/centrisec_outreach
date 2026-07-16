import { runJson, type ChatMessage } from './ai/client';
import { buildDraftMessages, buildScoringMessages, PROMPT_VERSION } from './ai/prompts';
import { draftJsonSchema, draftResult, scoreJsonSchema, scoreResult } from './ai/schemas';
import { recordEvent } from './db';
import { intVar, type Env } from './env';
import { HttpError } from './http';
import { getLead } from './leads';
import { isSuppressed } from './suppression';
import type { LeadRow, MessageRow } from './types';
import { wordCount } from './util/text';

export async function scoreLead(env: Env, lead: LeadRow): Promise<LeadRow> {
  const result = await runJson(env, env.MODEL_FAST, buildScoringMessages(lead), scoreJsonSchema, scoreResult);
  const fitScore = Math.round(result.fit_score);
  await env.DB
    .prepare(
      `UPDATE leads SET segment = ?1, fit_score = ?2, fit_reason = ?3, pain_points = ?4,
         status = CASE WHEN status = 'new' THEN 'scored' ELSE status END,
         updated_at = datetime('now')
       WHERE id = ?5`
    )
    .bind(result.segment, fitScore, result.fit_reason, JSON.stringify(result.pain_points.slice(0, 3)), lead.id)
    .run();
  await recordEvent(env.DB, lead.id, 'scored', { segment: result.segment, fit_score: fitScore });
  return getLead(env, lead.id);
}

/**
 * Generate the one cold email draft for a lead.
 * Enforces the one-email rule: refuses when an outbound message already exists,
 * unless force is passed (which supersedes an existing draft, never a sent email's record).
 */
export async function draftLead(env: Env, lead: LeadRow, opts?: { force?: boolean }): Promise<MessageRow> {
  const force = opts?.force ?? false;

  const suppressedReason = await isSuppressed(env.DB, lead.email, lead.domain);
  if (suppressedReason) throw new HttpError(409, `Lead is suppressed (${suppressedReason})`);
  if (['unsubscribed', 'bounced', 'disqualified'].includes(lead.status)) {
    throw new HttpError(409, `Lead status is '${lead.status}' - reactivate it first if intentional`);
  }

  const existing = await env.DB
    .prepare(
      `SELECT id, status FROM messages
       WHERE lead_id = ?1 AND direction = 'outbound'
         AND status IN ('draft','approved','queued','sending','sent','send_unknown')`
    )
    .bind(lead.id)
    .all<{ id: string; status: string }>();
  const hardBlockers = existing.results.filter((m) => m.status !== 'draft');
  const openDrafts = existing.results.filter((m) => m.status === 'draft');
  if (hardBlockers.length > 0 && !force) {
    throw new HttpError(409, 'One cold email per lead: an email is already queued or sent. Pass force:true to override.');
  }
  if (openDrafts.length > 0 && !force) {
    throw new HttpError(409, 'A draft already exists for this lead. Edit it, or pass force:true to replace it.');
  }
  if (openDrafts.length > 0) {
    for (const d of openDrafts) {
      await env.DB
        .prepare(
          `UPDATE messages SET status = 'rejected', error = 'superseded by a new draft', updated_at = datetime('now')
           WHERE id = ?1 AND status = 'draft'`
        )
        .bind(d.id)
        .run();
    }
  }

  const baseMessages = buildDraftMessages(env, lead);
  let result = await runJson(env, env.MODEL_STRONG, baseMessages, draftJsonSchema, draftResult, {
    maxTokens: 1200,
  });
  const words = wordCount(result.body);
  if (words < 100 || words > 200) {
    const corrective: ChatMessage[] = [
      ...baseMessages,
      { role: 'assistant', content: JSON.stringify(result) },
      {
        role: 'user',
        content: `That body is ${words} words. Rewrite it to 120-180 words, keeping the guide's structure. Return ONLY the JSON object.`,
      },
    ];
    try {
      result = await runJson(env, env.MODEL_STRONG, corrective, draftJsonSchema, draftResult, {
        maxTokens: 1200,
      });
    } catch {
      // keep the first draft; the human reviewer sees the word count anyway
    }
  }

  const id = crypto.randomUUID();
  await env.DB
    .prepare(
      `INSERT INTO messages (id, lead_id, direction, status, subject, body, from_email, to_email, ai_model, prompt_version)
       VALUES (?1, ?2, 'outbound', 'draft', ?3, ?4, ?5, ?6, ?7, ?8)`
    )
    .bind(
      id,
      lead.id,
      result.subject.trim().slice(0, 150),
      result.body.trim(),
      env.FROM_EMAIL,
      lead.email,
      env.MODEL_STRONG,
      PROMPT_VERSION
    )
    .run();
  await env.DB
    .prepare(
      `UPDATE leads SET status = 'drafted', updated_at = datetime('now')
       WHERE id = ?1 AND status IN ('new','scored','drafted','sent','replied')`
    )
    .bind(lead.id)
    .run();
  await recordEvent(env.DB, lead.id, 'drafted', { message_id: id, words: wordCount(result.body) });

  const message = await env.DB.prepare('SELECT * FROM messages WHERE id = ?1').bind(id).first<MessageRow>();
  if (!message) throw new HttpError(500, 'Draft insert failed');
  return message;
}

/**
 * Cron-driven advancer. Scores a small batch of new leads, then drafts a small
 * batch of scored+fit leads. Batch sizes bound AI spend per run.
 */
export async function advancePipeline(
  env: Env,
  scoreLimit?: number,
  draftLimit?: number
): Promise<{ scored: number; drafted: number; errors: string[] }> {
  const sLimit = scoreLimit ?? intVar(env.SCORE_BATCH, 10);
  const dLimit = draftLimit ?? intVar(env.DRAFT_BATCH, 5);
  const threshold = intVar(env.FIT_THRESHOLD, 40);
  const errors: string[] = [];
  let scored = 0;
  let drafted = 0;

  const newLeads = await env.DB
    .prepare(`SELECT * FROM leads WHERE status = 'new' ORDER BY created_at ASC LIMIT ?1`)
    .bind(sLimit)
    .all<LeadRow>();
  for (const lead of newLeads.results) {
    try {
      await scoreLead(env, lead);
      scored++;
    } catch (err) {
      errors.push(`score ${lead.id}: ${err instanceof Error ? err.message : String(err)}`);
      await recordEvent(env.DB, lead.id, 'ai_error', { stage: 'score' });
    }
  }

  const candidates = await env.DB
    .prepare(
      `SELECT * FROM leads
       WHERE status = 'scored' AND fit_score >= ?1
         AND NOT EXISTS (
           SELECT 1 FROM messages m
           WHERE m.lead_id = leads.id AND m.direction = 'outbound'
             AND m.status IN ('draft','approved','queued','sending','sent','send_unknown')
         )
       ORDER BY fit_score DESC LIMIT ?2`
    )
    .bind(threshold, dLimit)
    .all<LeadRow>();
  for (const lead of candidates.results) {
    try {
      await draftLead(env, lead);
      drafted++;
    } catch (err) {
      errors.push(`draft ${lead.id}: ${err instanceof Error ? err.message : String(err)}`);
      await recordEvent(env.DB, lead.id, 'ai_error', { stage: 'draft' });
    }
  }

  return { scored, drafted, errors };
}
