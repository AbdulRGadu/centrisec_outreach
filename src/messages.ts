import { recordEvent } from './db';
import type { Env } from './env';
import { HttpError, jsonResponse, normalizeMultiline, normalizeText } from './http';
import { getLead } from './leads';
import { autoRepairStoredDraft } from './pipeline';
import { processSend } from './sending';
import { deliveryTestEnabled, priorOutboundBlocksDelivery } from './services/deliveryTest';
import { validateDraftQuality } from './services/draftQuality';
import { normalizeDraftSubject, renderDraftEmail } from './services/emailRenderer';
import { buildPersonalizationPlan } from './services/personalization';
import { getOutreachSettings } from './services/outreachSettings';
import { isSuppressed } from './suppression';
import type { LeadRow, MessageRow } from './types';

export async function getMessage(env: Env, id: string): Promise<MessageRow> {
  const row = await env.DB.prepare('SELECT * FROM messages WHERE id = ?1').bind(id).first<MessageRow>();
  if (!row) throw new HttpError(404, 'Message not found');
  return row;
}

/** Message list with lead context - powers the dashboard's Drafts (and review) views. */
export async function handleMessagesList(url: URL, env: Env): Promise<Response> {
  const status = normalizeText(url.searchParams.get('status'), 30);
  const direction = normalizeText(url.searchParams.get('direction'), 10) === 'inbound' ? 'inbound' : 'outbound';
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);

  const where: string[] = ['m.direction = ?1'];
  const binds: unknown[] = [direction];
  if (status === 'review') {
    where.push(`m.status IN ('draft','needs_review')`);
  } else if (status) {
    where.push(`m.status = ?${binds.length + 1}`);
    binds.push(status);
  }
  const rows = await env.DB
    .prepare(
      `SELECT m.*, l.company AS lead_company, l.first_name AS lead_first_name,
              l.last_name AS lead_last_name, l.email AS lead_email,
              l.segment AS lead_segment, l.fit_score AS lead_fit_score,
              l.role AS lead_role, l.industry AS lead_industry,
              l.sub_industry AS lead_sub_industry
       FROM messages m LEFT JOIN leads l ON l.id = m.lead_id
       WHERE ${where.join(' AND ')}
       ORDER BY m.updated_at DESC
       LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`
    )
    .bind(...binds, limit, offset)
    .all();
  return jsonResponse({ ok: true, messages: rows.results });
}

export async function handleMessagePatch(id: string, body: Record<string, unknown>, env: Env): Promise<Response> {
  const message = await getMessage(env, id);
  if (message.direction !== 'outbound' || !['draft', 'needs_review'].includes(message.status)) {
    throw new HttpError(409, 'Only drafts can be edited');
  }
  const subject = typeof body.subject === 'string' ? normalizeDraftSubject(normalizeText(body.subject, 150)) : null;
  const lead = message.lead_id ? await getLead(env, message.lead_id) : null;
  const settings = lead ? await getOutreachSettings(env.DB) : null;
  const newBody = typeof body.body === 'string' && lead
    ? renderDraftEmail(normalizeMultiline(body.body, 5000), lead, settings ?? undefined)
    : typeof body.body === 'string' ? normalizeMultiline(body.body, 5000) : null;
  if (subject === null && newBody === null) throw new HttpError(400, 'Provide subject and/or body');
  if (subject !== null && subject.length < 3) throw new HttpError(400, 'Subject is too short');
  if (newBody !== null && newBody.length < 40) throw new HttpError(400, 'Body is too short');

  const finalSubject = subject ?? message.subject ?? '';
  const finalBody = newBody ?? message.body ?? '';
  const strategy = lead ? buildPersonalizationPlan(lead, settings ?? undefined).strategy : null;
  const quality = lead
    ? validateDraftQuality(
        finalSubject,
        finalBody,
        lead,
        strategy ?? undefined,
        typeof body.body === 'string' ? normalizeMultiline(body.body, 5000) : finalBody,
        settings ?? undefined
      )
    : { valid: false, status: 'needs_review' as const, warnings: ['Draft has no lead.'], word_count: 0, question_count: 0, checks: [] };
  const nextStatus = quality.valid ? 'draft' : 'needs_review';
  const warning = quality.valid ? null : `Draft quality warning: ${quality.warnings.join(' ')}`.slice(0, 500);
  let savedPlan: Record<string, unknown> = {};
  try {
    const parsed = message.next_step_plan ? JSON.parse(message.next_step_plan) as unknown : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      savedPlan = parsed as Record<string, unknown>;
    }
  } catch {
    // Replace malformed historical metadata with the current checklist.
  }
  const nextStepPlan = JSON.stringify({
    ...savedPlan,
    quality_checklist: quality.checks,
  });

  await env.DB
    .prepare(
      `UPDATE messages SET
         subject = COALESCE(?1, subject),
         body = COALESCE(?2, body),
         status = ?3,
         error = ?4,
         draft_quality_status = ?5,
         validation_warnings = ?6,
         next_step_plan = ?7,
         updated_at = datetime('now')
       WHERE id = ?8 AND status IN ('draft','needs_review')`
    )
    .bind(subject, newBody, nextStatus, warning, quality.status, JSON.stringify(quality.warnings), nextStepPlan, id)
    .run();
  if (message.lead_id) {
    await recordEvent(env.DB, message.lead_id, 'draft_edited', { message_id: id });
  }
  return jsonResponse({ ok: true, message: await getMessage(env, id) });
}

async function assertEligibleToSend(env: Env, message: MessageRow): Promise<LeadRow> {
  if (message.direction !== 'outbound') throw new HttpError(409, 'Not an outbound message');
  if (!message.lead_id) throw new HttpError(409, 'Message has no lead');
  const lead = await getLead(env, message.lead_id);
  const suppressedReason = await isSuppressed(env.DB, lead.email, lead.domain);
  if (suppressedReason) throw new HttpError(409, `Lead is suppressed (${suppressedReason})`);
  if (['suppressed', 'failed', 'not_interested'].includes(lead.status)) {
    throw new HttpError(409, `Lead status is '${lead.status}'`);
  }
  const other = await env.DB
    .prepare(
      `SELECT id, status FROM messages
       WHERE lead_id = ?1 AND direction = 'outbound' AND id != ?2
         AND status IN ('approved','queued','sending','sent','send_unknown')`
    )
    .bind(lead.id, message.id)
    .all<{ id: string; status: string }>();
  if (other.results.some((row) => priorOutboundBlocksDelivery(deliveryTestEnabled(lead), row.status))) {
    throw new HttpError(409, 'One cold email per lead: another email is already queued or sent');
  }
  return lead;
}

async function currentQuality(env: Env, message: MessageRow, lead: LeadRow) {
  const settings = await getOutreachSettings(env.DB);
  return validateDraftQuality(
    message.subject ?? '',
    message.body ?? '',
    lead,
    buildPersonalizationPlan(lead, settings).strategy,
    message.body ?? '',
    settings
  );
}

/**
 * A green quality result is the approval gate. Draft edits always recalculate
 * it, so later wording-setting changes cannot strand an already-passed draft.
 */
function requiresAutomatedRepair(message: MessageRow, quality: ReturnType<typeof validateDraftQuality>): boolean {
  if (message.draft_quality_status === 'passed') return false;
  return message.draft_quality_status === 'needs_review' || !quality.valid;
}

export async function handleMessageApprove(id: string, env: Env): Promise<Response> {
  const message = await getMessage(env, id);
  if (!['draft', 'needs_review'].includes(message.status)) {
    throw new HttpError(409, `Cannot approve a message in status '${message.status}'`);
  }
  const lead = await assertEligibleToSend(env, message);
  const quality = await currentQuality(env, message, lead);
  if (requiresAutomatedRepair(message, quality)) {
    const repaired = await autoRepairStoredDraft(env, message, lead);
    if (!repaired.automation.quality.valid) {
      throw new HttpError(
        409,
        `Automated repair could not pass quality review: ${repaired.automation.quality.warnings.join(' ')}`
      );
    }
    return jsonResponse({
      ok: true,
      repaired: true,
      approvalRequired: true,
      queued: false,
      message: repaired.message,
    });
  }

  const claim = await env.DB
    .prepare(
      `UPDATE messages SET status = 'approved', updated_at = datetime('now')
       WHERE id = ?1 AND status IN ('draft','needs_review')`
    )
    .bind(id)
    .run();
  if ((claim.meta.changes ?? 0) === 0) throw new HttpError(409, 'Draft changed concurrently');
  await recordEvent(env.DB, lead.id, 'approved', { message_id: id });

  let queued = false;
  try {
    await env.SEND_QUEUE.send({ type: 'send', messageId: id });
    await env.DB
      .prepare(`UPDATE messages SET status = 'queued', updated_at = datetime('now') WHERE id = ?1 AND status = 'approved'`)
      .bind(id)
      .run();
    queued = true;
    await recordEvent(env.DB, lead.id, 'enqueued', { message_id: id });
  } catch {
    // Stays 'approved'; the sweeper cron re-enqueues stragglers.
  }
  await env.DB
    .prepare(
      `UPDATE leads SET status = 'queued', sales_stage = 'approved_to_send',
         next_action = 'send_approved_email', updated_at = datetime('now') WHERE id = ?1`
    )
    .bind(lead.id)
    .run();
  return jsonResponse({ ok: true, queued });
}

function batchScheduleStart(value: unknown): Date {
  if (typeof value !== 'string' || !value.trim()) return new Date();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new HttpError(400, 'scheduledAt must be a valid date and time');
  if (parsed.getTime() < Date.now() - 60_000) throw new HttpError(400, 'scheduledAt cannot be in the past');
  if (parsed.getTime() > Date.now() + 31 * 86_400_000) throw new HttpError(400, 'scheduledAt must be within 31 days');
  return parsed;
}

/** Approve a visible batch and space the queue so messages do not burst together. */
export async function handleMessagesQueue(body: Record<string, unknown>, env: Env): Promise<Response> {
  const ids = Array.isArray(body.messageIds)
    ? [...new Set(body.messageIds.filter((id): id is string => typeof id === 'string' && id.length <= 80))].slice(0, 200)
    : [];
  if (!ids.length) throw new HttpError(400, 'Select at least one draft');
  const interval = Number(body.intervalMinutes ?? 2);
  if (!Number.isInteger(interval) || interval < 1 || interval > 60) throw new HttpError(400, 'intervalMinutes must be between 1 and 60');
  const dailyCap = Number(body.dailyCap ?? ids.length);
  if (!Number.isInteger(dailyCap) || dailyCap < 1 || dailyCap > 500) throw new HttpError(400, 'dailyCap must be between 1 and 500');
  const start = batchScheduleStart(body.scheduledAt);
  const queued: Array<{ id: string; scheduledAt: string }> = [];
  const blocked: Array<{ id: string; reason: string }> = [];

  for (const [index, id] of ids.entries()) {
    try {
      const message = await getMessage(env, id);
      if (!['draft', 'approved'].includes(message.status)) throw new HttpError(409, `Message is ${message.status}`);
      if (message.draft_quality_status !== 'passed') throw new HttpError(409, 'Draft needs review before it can enter the queue');
      const lead = await assertEligibleToSend(env, message);
      const scheduled = new Date(start.getTime() + index * interval * 60_000).toISOString();
      let snapshot: Record<string, unknown> = {};
      try {
        const parsed = message.settings_snapshot ? JSON.parse(message.settings_snapshot) as unknown : null;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) snapshot = parsed as Record<string, unknown>;
      } catch { /* Preserve delivery behavior with a fresh safe snapshot. */ }
      snapshot.batchDailyCap = dailyCap;
      const updated = await env.DB.prepare(
        `UPDATE messages SET status='queued', scheduled_at=?1, settings_snapshot=?2, updated_at=datetime('now')
         WHERE id=?3 AND status IN ('draft','approved')`
      ).bind(scheduled, JSON.stringify(snapshot), id).run();
      if ((updated.meta.changes ?? 0) === 0) throw new HttpError(409, 'Message changed while being queued');
      await env.DB.prepare(
        `UPDATE leads SET status='queued', sales_stage='approved_to_send', next_action='scheduled_send', updated_at=datetime('now') WHERE id=?1`
      ).bind(lead.id).run();
      await recordEvent(env.DB, lead.id, 'enqueued', { message_id: id, scheduled_at: scheduled, interval_minutes: interval });
      const delaySeconds = Math.min(Math.max(0, Math.ceil((new Date(scheduled).getTime() - Date.now()) / 1000)), 85_800);
      await env.SEND_QUEUE.send({ type: 'send', messageId: id }, delaySeconds > 0 ? { delaySeconds } : undefined);
      queued.push({ id, scheduledAt: scheduled });
    } catch (error) {
      blocked.push({ id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return jsonResponse({ ok: true, queued, blocked, intervalMinutes: interval, dailyCap });
}

export async function handleMessageReject(id: string, body: Record<string, unknown>, env: Env): Promise<Response> {
  const message = await getMessage(env, id);
  if (!['draft', 'needs_review'].includes(message.status)) {
    throw new HttpError(409, `Cannot reject a message in status '${message.status}'`);
  }
  const reason = normalizeText(body.reason, 300) || null;
  await env.DB
    .prepare(
      `UPDATE messages SET status = 'rejected', error = ?1, updated_at = datetime('now')
       WHERE id = ?2 AND status IN ('draft','needs_review')`
    )
    .bind(reason, id)
    .run();
  if (message.lead_id) {
    await env.DB
      .prepare(`UPDATE leads SET status = 'scored', updated_at = datetime('now') WHERE id = ?1 AND status = 'drafted'`)
      .bind(message.lead_id)
      .run();
    await recordEvent(env.DB, message.lead_id, 'rejected', { message_id: id });
  }
  return jsonResponse({ ok: true });
}

export async function handleMessageNeedsReview(id: string, env: Env): Promise<Response> {
  const message = await getMessage(env, id);
  if (!['draft', 'needs_review'].includes(message.status)) {
    throw new HttpError(409, `Cannot mark a message in status '${message.status}' for review`);
  }
  await env.DB.prepare(
    `UPDATE messages SET status = 'needs_review', draft_quality_status = 'needs_review',
       error = 'Marked for manual review', updated_at = datetime('now') WHERE id = ?1`
  ).bind(id).run();
  if (message.lead_id) {
    await recordEvent(env.DB, message.lead_id, 'draft_needs_review', { message_id: id, by: 'manual' });
  }
  return jsonResponse({ ok: true, message: await getMessage(env, id) });
}

/**
 * Synchronous send for testing and hands-on use: approve + attempt delivery now.
 * If a gate defers it (window/cap), the message is queued with a delay instead.
 */
export async function handleSendNow(id: string, env: Env): Promise<Response> {
  const message = await getMessage(env, id);
  if (!['draft', 'needs_review', 'approved', 'queued'].includes(message.status)) {
    throw new HttpError(409, `Cannot send a message in status '${message.status}'`);
  }
  const lead = await assertEligibleToSend(env, message);
  const quality = await currentQuality(env, message, lead);
  if (requiresAutomatedRepair(message, quality)) {
    if (!['draft', 'needs_review'].includes(message.status)) {
      throw new HttpError(409, `Approved draft no longer passes quality review: ${quality.warnings.join(' ')}`);
    }
    const repaired = await autoRepairStoredDraft(env, message, lead);
    if (!repaired.automation.quality.valid) {
      throw new HttpError(
        409,
        `Automated repair could not pass quality review: ${repaired.automation.quality.warnings.join(' ')}`
      );
    }
    return jsonResponse({
      ok: true,
      repaired: true,
      approvalRequired: true,
      sent: false,
      message: repaired.message,
    });
  }

  if (message.status !== 'queued') {
    const claim = await env.DB
      .prepare(
        `UPDATE messages SET status = 'queued', updated_at = datetime('now')
         WHERE id = ?1 AND status IN ('draft','needs_review','approved')`
      )
      .bind(id)
      .run();
    if ((claim.meta.changes ?? 0) === 0) throw new HttpError(409, 'Message changed concurrently');
    await env.DB
      .prepare(
        `UPDATE leads SET status = 'queued', sales_stage = 'approved_to_send',
           next_action = 'send_approved_email', updated_at = datetime('now') WHERE id = ?1`
      )
      .bind(lead.id)
      .run();
    await recordEvent(env.DB, lead.id, 'approved', { message_id: id, via: 'send_now' });
  }

  const outcome = await processSend(env, id);
  if (outcome.action === 'sent') {
    return jsonResponse({ ok: true, sent: true, dryRun: outcome.dryRun });
  }
  if (outcome.action === 'retry') {
    try {
      await env.SEND_QUEUE.send({ type: 'send', messageId: id }, { delaySeconds: outcome.delaySeconds });
    } catch {
      // sweeper will re-enqueue the queued row if this fails
    }
    return jsonResponse(
      { ok: false, deferred: true, reason: outcome.reason, retryInSeconds: outcome.delaySeconds },
      202
    );
  }
  return jsonResponse({ ok: false, error: outcome.reason }, 409);
}
