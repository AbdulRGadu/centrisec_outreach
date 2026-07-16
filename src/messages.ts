import { recordEvent } from './db';
import type { Env } from './env';
import { HttpError, jsonResponse, normalizeMultiline, normalizeText } from './http';
import { getLead } from './leads';
import { processSend } from './sending';
import { isSuppressed } from './suppression';
import type { LeadRow, MessageRow } from './types';
import { normalizeEmailBody, validateDraftQuality } from './util/text';

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
              l.segment AS lead_segment, l.fit_score AS lead_fit_score
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
  const subject = typeof body.subject === 'string' ? normalizeText(body.subject, 150) : null;
  const newBody = typeof body.body === 'string' ? normalizeEmailBody(normalizeMultiline(body.body, 5000)) : null;
  if (subject === null && newBody === null) throw new HttpError(400, 'Provide subject and/or body');
  if (subject !== null && subject.length < 3) throw new HttpError(400, 'Subject is too short');
  if (newBody !== null && newBody.length < 40) throw new HttpError(400, 'Body is too short');

  const lead = message.lead_id ? await getLead(env, message.lead_id) : null;
  const finalSubject = subject ?? message.subject ?? '';
  const finalBody = newBody ?? message.body ?? '';
  const quality = lead
    ? validateDraftQuality(finalSubject, finalBody, lead)
    : { valid: false, warnings: ['Draft has no lead.'] };
  const nextStatus = quality.valid ? 'draft' : 'needs_review';
  const warning = quality.valid ? null : `Draft quality warning: ${quality.warnings.join(' ')}`.slice(0, 500);

  await env.DB
    .prepare(
      `UPDATE messages SET
         subject = COALESCE(?1, subject),
         body = COALESCE(?2, body),
         status = ?3,
         error = ?4,
         updated_at = datetime('now')
       WHERE id = ?5 AND status IN ('draft','needs_review')`
    )
    .bind(subject, newBody, nextStatus, warning, id)
    .run();
  if (message.lead_id) {
    await recordEvent(env.DB, message.lead_id, 'draft_edited', { message_id: id });
  }
  return jsonResponse({ ok: true, message: await getMessage(env, id) });
}

async function assertSendable(env: Env, message: MessageRow): Promise<LeadRow> {
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
      `SELECT id FROM messages
       WHERE lead_id = ?1 AND direction = 'outbound' AND id != ?2
         AND status IN ('approved','queued','sending','sent','send_unknown') LIMIT 1`
    )
    .bind(lead.id, message.id)
    .first();
  if (other) {
    throw new HttpError(409, 'One cold email per lead: another email is already queued or sent');
  }
  return lead;
}

export async function handleMessageApprove(id: string, env: Env): Promise<Response> {
  const message = await getMessage(env, id);
  if (!['draft', 'needs_review'].includes(message.status)) {
    throw new HttpError(409, `Cannot approve a message in status '${message.status}'`);
  }
  const lead = await assertSendable(env, message);

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
    .prepare(`UPDATE leads SET status = 'queued', updated_at = datetime('now') WHERE id = ?1`)
    .bind(lead.id)
    .run();
  return jsonResponse({ ok: true, queued });
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

/**
 * Synchronous send for testing and hands-on use: approve + attempt delivery now.
 * If a gate defers it (window/cap), the message is queued with a delay instead.
 */
export async function handleSendNow(id: string, env: Env): Promise<Response> {
  const message = await getMessage(env, id);
  if (!['draft', 'needs_review', 'approved', 'queued'].includes(message.status)) {
    throw new HttpError(409, `Cannot send a message in status '${message.status}'`);
  }
  const lead = await assertSendable(env, message);

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
      .prepare(`UPDATE leads SET status = 'queued', updated_at = datetime('now') WHERE id = ?1`)
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
