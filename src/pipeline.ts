import { runJson } from './ai/client';
import { activeAiModel } from './ai/models';
import { buildDraftMessages, buildDraftRepairMessages, buildScoringMessages, PROMPT_VERSION } from './ai/prompts';
import { draftJsonSchema, draftResult, scoreJsonSchema, scoreResult } from './ai/schemas';
import { recordEvent } from './db';
import { intVar, type Env } from './env';
import { HttpError } from './http';
import { getLead } from './leads';
import { improveDraftUntilSendable, type DraftAutomationResult } from './services/draftAutomation';
import { segmentLeadRow } from './services/leadSegmentation';
import { planInitialNextStep } from './services/nextStepPlanner';
import { buildPersonalizationPlan } from './services/personalization';
import { compatibleLeadSegment } from './schema';
import { isSuppressed } from './suppression';
import type { LeadRow, MessageRow } from './types';
import { wordCount } from './util/text';

function nextStepWithQuality(
  nextStepPlan: ReturnType<typeof planInitialNextStep>,
  automation: DraftAutomationResult
): Record<string, unknown> {
  return {
    ...nextStepPlan,
    draft_automation: {
      auto_repaired: automation.auto_repaired,
      repair_attempts: automation.repair_attempts,
      repair_failures: automation.repair_failures,
      used_fallback: automation.used_fallback,
    },
    quality_checklist: automation.quality.checks,
  };
}

export async function scoreLead(env: Env, lead: LeadRow): Promise<LeadRow> {
  const deterministicStrategy = segmentLeadRow(lead);
  const storedSegment = await compatibleLeadSegment(env.DB, deterministicStrategy.segment);
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
    .bind(storedSegment, fitScore, result.fit_reason, JSON.stringify(result.pain_points.slice(0, 3)), lead.id)
    .run();
  await recordEvent(env.DB, lead.id, 'scored', { segment: deterministicStrategy.segment, fit_score: fitScore });
  return getLead(env, lead.id);
}

/**
 * Generate the one cold email draft for a lead.
 * Enforces the one-email rule. Repeated requests return the current open draft;
 * force supersedes an open draft, but never an approved, queued, or sent email.
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
    const current = await env.DB
      .prepare('SELECT * FROM messages WHERE id = ?1')
      .bind(openDrafts[0]?.id)
      .first<MessageRow>();
    if (current) return current;
  }
  const plan = buildPersonalizationPlan(lead);
  const nextStepPlan = planInitialNextStep(plan.strategy);
  const storedSegment = await compatibleLeadSegment(env.DB, plan.strategy.segment);
  await env.DB.prepare(
    `UPDATE leads SET segment = ?1, updated_at = datetime('now') WHERE id = ?2`
  ).bind(storedSegment, lead.id).run();

  const baseMessages = buildDraftMessages(plan);
  const model = await activeAiModel(env);
  let initialDraft = { subject: '', body: '' };
  try {
    initialDraft = await runJson(env, model, baseMessages, draftJsonSchema, draftResult, {
      maxTokens: 1200,
    });
  } catch {
    // The bounded repair flow retries the model, then produces a validated safe fallback.
  }
  const automation = await improveDraftUntilSendable({
    lead,
    plan,
    initialDraft,
    repair: async ({ failedDraft, warnings, attempt }) => {
      const corrective = buildDraftRepairMessages({
        baseMessages,
        failedDraft,
        warnings,
        plan,
        attempt,
      });
      return runJson(env, model, corrective, draftJsonSchema, draftResult, { maxTokens: 1200 });
    },
  });
  const normalizedSubject = automation.subject;
  const normalizedBody = automation.body;
  const quality = automation.quality;
  const savedNextStepPlan = nextStepWithQuality(nextStepPlan, automation);

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
      JSON.stringify(savedNextStepPlan)
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
    auto_repaired: automation.auto_repaired,
    repair_attempts: automation.repair_attempts,
    repair_failures: automation.repair_failures,
    used_fallback: automation.used_fallback,
  });

  const message = await env.DB.prepare('SELECT * FROM messages WHERE id = ?1').bind(id).first<MessageRow>();
  if (!message) throw new HttpError(500, 'Draft insert failed');
  return message;
}

export async function autoRepairStoredDraft(
  env: Env,
  message: MessageRow,
  lead: LeadRow
): Promise<{ message: MessageRow; automation: DraftAutomationResult }> {
  const plan = buildPersonalizationPlan(lead);
  const nextStepPlan = planInitialNextStep(plan.strategy);
  const baseMessages = buildDraftMessages(plan);
  const model = await activeAiModel(env);
  const automation = await improveDraftUntilSendable({
    lead,
    plan,
    initialDraft: { subject: message.subject ?? '', body: message.body ?? '' },
    repair: async ({ failedDraft, warnings, attempt }) => {
      const corrective = buildDraftRepairMessages({
        baseMessages,
        failedDraft,
        warnings,
        plan,
        attempt,
      });
      return runJson(env, model, corrective, draftJsonSchema, draftResult, { maxTokens: 1200 });
    },
  });
  const status = automation.quality.valid ? 'draft' : 'needs_review';
  const warning = automation.quality.valid
    ? null
    : `Draft quality warning: ${automation.quality.warnings.join(' ')}`.slice(0, 500);

  const update = await env.DB.prepare(
    `UPDATE messages SET
       status = ?1, subject = ?2, body = ?3, ai_model = ?4, prompt_version = ?5,
       error = ?6, next_action = ?7, buyer_persona = ?8, security_context = ?9,
       recommended_offer = ?10, recommended_cta = ?11, draft_quality_status = ?12,
       validation_warnings = ?13, next_step_plan = ?14, updated_at = datetime('now')
     WHERE id = ?15 AND status IN ('draft','needs_review')`
  ).bind(
    status,
    automation.subject,
    automation.body,
    model,
    PROMPT_VERSION,
    warning,
    nextStepPlan.on_positive_reply,
    plan.strategy.buyer_persona,
    plan.strategy.likely_security_context,
    plan.strategy.recommended_offer,
    plan.strategy.recommended_cta,
    automation.quality.status,
    JSON.stringify(automation.quality.warnings),
    JSON.stringify(nextStepWithQuality(nextStepPlan, automation)),
    message.id
  ).run();
  if ((update.meta.changes ?? 0) === 0) {
    throw new HttpError(409, 'Draft changed while it was being repaired');
  }
  await recordEvent(env.DB, lead.id, 'draft_auto_repaired', {
    message_id: message.id,
    passed: automation.quality.valid,
    repair_attempts: automation.repair_attempts,
    repair_failures: automation.repair_failures,
    used_fallback: automation.used_fallback,
    initial_warnings: automation.initial_warnings,
  });
  const updated = await env.DB.prepare('SELECT * FROM messages WHERE id = ?1')
    .bind(message.id)
    .first<MessageRow>();
  if (!updated) throw new HttpError(500, 'Repaired draft could not be loaded');
  return { message: updated, automation };
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
