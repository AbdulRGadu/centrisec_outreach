import { runJson } from './ai/client';
import { activeAiModel } from './ai/models';
import { buildDraftMessages, buildDraftRepairMessages, buildScoringMessages, PROMPT_VERSION } from './ai/prompts';
import { draftJsonSchema, draftResult, scoreJsonSchema, scoreResult } from './ai/schemas';
import { recordEvent } from './db';
import { intVar, type Env } from './env';
import { HttpError } from './http';
import { getLead } from './leads';
import { validateDraftQuality } from './services/draftQuality';
import { normalizeDraftSubject, renderDraftEmail } from './services/emailRenderer';
import { segmentLeadRow } from './services/leadSegmentation';
import { planInitialNextStep } from './services/nextStepPlanner';
import { buildPersonalizationPlan } from './services/personalization';
import { isSuppressed } from './suppression';
import type { LeadRow, MessageRow } from './types';
import { wordCount } from './util/text';

export async function scoreLead(env: Env, lead: LeadRow): Promise<LeadRow> {
  const deterministicStrategy = segmentLeadRow(lead);
  const model = await activeAiModel(env);
  const result = await runJson(env, model, buildScoringMessages(lead), scoreJsonSchema, scoreResult);
  const fitScore = Math.round(result.fit_score);
  await env.DB
    .prepare(
      `UPDATE leads SET segment = ?1, fit_score = ?2, fit_reason = ?3, pain_points = ?4,
         status = CASE WHEN status = 'new' THEN 'scored' ELSE status END,
         updated_at = datetime('now')
       WHERE id = ?5`
    )
    .bind(deterministicStrategy.segment, fitScore, result.fit_reason, JSON.stringify(result.pain_points.slice(0, 3)), lead.id)
    .run();
  await recordEvent(env.DB, lead.id, 'scored', { segment: deterministicStrategy.segment, fit_score: fitScore });
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
  if (['suppressed', 'failed', 'not_interested'].includes(lead.status)) {
    throw new HttpError(409, `Lead status is '${lead.status}' - reactivate it first if intentional`);
  }

  const existing = await env.DB
    .prepare(
      `SELECT id, status FROM messages
       WHERE lead_id = ?1 AND direction = 'outbound'
         AND status IN ('draft','needs_review','approved','queued','sending','sent','send_unknown')`
    )
    .bind(lead.id)
    .all<{ id: string; status: string }>();
  const hardBlockers = existing.results.filter((m) => !['draft', 'needs_review'].includes(m.status));
  const openDrafts = existing.results.filter((m) => ['draft', 'needs_review'].includes(m.status));
  if (hardBlockers.length > 0) {
    throw new HttpError(409, 'One cold email per lead: an email is already approved, queued, or sent.');
  }
  if (openDrafts.length > 0 && !force) {
    throw new HttpError(409, 'A draft already exists for this lead. Edit it, or pass force:true to replace it.');
  }
  const plan = buildPersonalizationPlan(lead);
  const nextStepPlan = planInitialNextStep(plan.strategy);
  await env.DB.prepare(
    `UPDATE leads SET segment = ?1, updated_at = datetime('now') WHERE id = ?2`
  ).bind(plan.strategy.segment, lead.id).run();

  const baseMessages = buildDraftMessages(plan);
  const model = await activeAiModel(env);
  let result = await runJson(env, model, baseMessages, draftJsonSchema, draftResult, {
    maxTokens: 1200,
  });
  let normalizedSubject = normalizeDraftSubject(result.subject);
  let normalizedBody = renderDraftEmail(result.body, lead);
  let quality = validateDraftQuality(normalizedSubject, normalizedBody, lead, plan.strategy, result.body);
  if (!quality.valid) {
    const corrective = buildDraftRepairMessages({
      baseMessages,
      failedDraft: { subject: normalizedSubject, body: normalizedBody },
      warnings: quality.warnings,
      plan,
    });
    try {
      result = await runJson(env, model, corrective, draftJsonSchema, draftResult, {
        maxTokens: 1200,
      });
      normalizedSubject = normalizeDraftSubject(result.subject);
      normalizedBody = renderDraftEmail(result.body, lead);
      quality = validateDraftQuality(normalizedSubject, normalizedBody, lead, plan.strategy, result.body);
    } catch {
      // Keep the first result as needs_review; a human can safely edit or reject it.
    }
  }

  const status = quality.valid ? 'draft' : 'needs_review';
  const warning = quality.valid ? null : `Draft quality warning: ${quality.warnings.join(' ')}`.slice(0, 500);

  if (openDrafts.length > 0) {
    for (const draft of openDrafts) {
      await env.DB.prepare(
        `UPDATE messages SET status = 'rejected', error = 'superseded by a new draft', updated_at = datetime('now')
         WHERE id = ?1 AND status IN ('draft','needs_review')`
      ).bind(draft.id).run();
    }
  }

  const id = crypto.randomUUID();
  await env.DB
    .prepare(
      `INSERT INTO messages (
         id, lead_id, direction, status, subject, body, from_email, to_email,
         ai_model, prompt_version, error, next_action, buyer_persona, security_context,
         recommended_offer, recommended_cta, draft_quality_status,
         validation_warnings, next_step_plan
       ) VALUES (
         ?1, ?2, 'outbound', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
         ?13, ?14, ?15, ?16, ?17, ?18
       )`
    )
    .bind(
      id,
      lead.id,
      status,
      normalizedSubject,
      normalizedBody,
      env.FROM_EMAIL,
      lead.email,
      model,
      PROMPT_VERSION,
      warning,
      nextStepPlan.on_positive_reply,
      plan.strategy.buyer_persona,
      plan.strategy.likely_security_context,
      plan.strategy.recommended_offer,
      plan.strategy.recommended_cta,
      quality.status,
      JSON.stringify(quality.warnings),
      JSON.stringify(nextStepPlan)
    )
    .run();
  await env.DB
    .prepare(
      `UPDATE leads SET status = 'drafted', sales_stage = 'first_touch_review',
         next_action = 'review_and_approve_draft', updated_at = datetime('now')
       WHERE id = ?1 AND status IN ('new','scored','drafted','sent','manual_review','not_now')`
    )
    .bind(lead.id)
    .run();
  await recordEvent(env.DB, lead.id, 'drafted', {
    message_id: id,
    words: wordCount(normalizedBody),
    review: status === 'needs_review',
    segment: plan.strategy.segment,
    buyer_persona: plan.strategy.buyer_persona,
    recommended_offer: plan.strategy.recommended_offer,
    quality_warnings: quality.warnings.length,
  });

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
             AND m.status IN ('draft','needs_review','approved','queued','sending','sent','send_unknown')
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
