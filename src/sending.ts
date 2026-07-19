import { recordEvent } from './db';
import { intVar, type Env } from './env';
import { addSuppression, isSuppressed } from './suppression';
import type { LeadRow, MessageRow } from './types';
import { dayString, isInSendWindow, secondsToNextWindowOpen, weekStartString } from './util/time';
import { ensureFooter } from './util/text';
import { getAccessToken, sendMail, ZohoError } from './zoho';

export type SendOutcome =
  | { action: 'sent'; dryRun: boolean }
  | { action: 'ack'; reason: string }
  | { action: 'retry'; delaySeconds: number; reason: string };

// Queues cap delaySeconds at 12h/24h depending on plan; stay safely under.
const MAX_DELAY_SECONDS = 85_800;

function clampDelay(seconds: number): number {
  return Math.min(Math.max(seconds, 60), MAX_DELAY_SECONDS);
}

async function decrementCounter(env: Env, day: string): Promise<void> {
  await env.DB
    .prepare(`UPDATE send_counters SET count = count - 1 WHERE day = ?1 AND count > 0`)
    .bind(day)
    .run();
}

async function decrementDomainCounter(env: Env, weekStart: string, domain: string): Promise<void> {
  await env.DB
    .prepare(
      `UPDATE domain_send_counters SET count = count - 1
       WHERE week_start = ?1 AND domain = ?2 AND count > 0`
    )
    .bind(weekStart, domain)
    .run();
}

/** Atomically take one send slot for the day. Returns false when the cap is reached. */
async function takeDailySlot(env: Env, day: string, cap: number): Promise<boolean> {
  const attempt = () =>
    env.DB
      .prepare(`UPDATE send_counters SET count = count + 1 WHERE day = ?1 AND count < ?2`)
      .bind(day, cap)
      .run();
  let res = await attempt();
  if ((res.meta.changes ?? 0) > 0) return true;
  await env.DB.prepare(`INSERT OR IGNORE INTO send_counters (day, count) VALUES (?1, 0)`).bind(day).run();
  res = await attempt();
  return (res.meta.changes ?? 0) > 0;
}

/** Atomically reserve one weekly slot for a recipient domain. */
async function takeDomainSlot(env: Env, weekStart: string, domain: string, cap: number): Promise<boolean> {
  const attempt = () =>
    env.DB
      .prepare(
        `UPDATE domain_send_counters SET count = count + 1
         WHERE week_start = ?1 AND domain = ?2 AND count < ?3`
      )
      .bind(weekStart, domain, cap)
      .run();
  let res = await attempt();
  if ((res.meta.changes ?? 0) > 0) return true;
  await env.DB
    .prepare(`INSERT OR IGNORE INTO domain_send_counters (week_start, domain, count) VALUES (?1, ?2, 0)`)
    .bind(weekStart, domain)
    .run();
  res = await attempt();
  return (res.meta.changes ?? 0) > 0;
}

async function markFailed(env: Env, messageId: string, error: string): Promise<void> {
  await env.DB
    .prepare(`UPDATE messages SET status = 'failed', error = ?1, updated_at = datetime('now') WHERE id = ?2`)
    .bind(error.slice(0, 500), messageId)
    .run();
}

/** Undo a 'sending' claim so the message can be retried later. */
async function revertToQueued(env: Env, messageId: string, error: string): Promise<void> {
  await env.DB
    .prepare(
      `UPDATE messages SET status = 'queued', error = ?1, updated_at = datetime('now')
       WHERE id = ?2 AND status = 'sending'`
    )
    .bind(error.slice(0, 500), messageId)
    .run();
}

/**
 * The single send path - used by the queue consumer and by /send-now.
 * D1 is the source of truth; every gate is re-checked here at send time.
 */
export async function processSend(env: Env, messageId: string): Promise<SendOutcome> {
  const message = await env.DB
    .prepare(`SELECT * FROM messages WHERE id = ?1`)
    .bind(messageId)
    .first<MessageRow>();
  if (!message || message.direction !== 'outbound') return { action: 'ack', reason: 'message not found' };
  // Idempotency: duplicate queue delivery of an already-handled message is a no-op.
  if (message.status !== 'queued') return { action: 'ack', reason: `status is '${message.status}'` };

  if (!message.lead_id) {
    await markFailed(env, messageId, 'no lead attached');
    return { action: 'ack', reason: 'no lead' };
  }
  const lead = await env.DB
    .prepare(`SELECT * FROM leads WHERE id = ?1`)
    .bind(message.lead_id)
    .first<LeadRow>();
  if (!lead) {
    await markFailed(env, messageId, 'lead not found');
    return { action: 'ack', reason: 'lead not found' };
  }

  // Gate 1: suppression (final check - the list may have grown since approval).
  const suppressedReason = await isSuppressed(env.DB, lead.email, lead.domain);
  if (suppressedReason) {
    await markFailed(env, messageId, `suppressed: ${suppressedReason}`);
    const leadStatus = 'suppressed';
    await env.DB
      .prepare(
        `UPDATE leads SET status = ?1, sales_stage = 'do_not_contact',
           next_action = 'suppressed', updated_at = datetime('now') WHERE id = ?2`
      )
      .bind(leadStatus, lead.id)
      .run();
    await recordEvent(env.DB, lead.id, 'send_blocked', { message_id: messageId, reason: suppressedReason });
    return { action: 'ack', reason: 'suppressed' };
  }

  // Gate 2: one cold email per lead.
  const dupe = await env.DB
    .prepare(
      `SELECT id FROM messages
       WHERE lead_id = ?1 AND direction = 'outbound' AND id != ?2
         AND status IN ('sending','sent','send_unknown') LIMIT 1`
    )
    .bind(lead.id, messageId)
    .first();
  if (dupe) {
    await markFailed(env, messageId, 'another email was already sent to this lead');
    await recordEvent(env.DB, lead.id, 'send_blocked', { message_id: messageId, reason: 'one_email_rule' });
    return { action: 'ack', reason: 'one-email rule' };
  }

  // Gate 3: business-hours send window (Africa/Lagos by default).
  if (!isInSendWindow(env)) {
    const delay = clampDelay(secondsToNextWindowOpen(env));
    await recordEvent(env.DB, lead.id, 'send_deferred', { message_id: messageId, reason: 'window', delay });
    return { action: 'retry', delaySeconds: delay, reason: 'outside send window' };
  }

  // Gate 4: daily cap, taken atomically.
  const day = dayString(env.TIMEZONE);
  const cap = intVar(env.DAILY_SEND_CAP, 10);
  if (!(await takeDailySlot(env, day, cap))) {
    const delay = clampDelay(secondsToNextWindowOpen(env));
    await recordEvent(env.DB, lead.id, 'send_deferred', { message_id: messageId, reason: 'daily_cap', delay });
    return { action: 'retry', delaySeconds: delay, reason: 'daily cap reached' };
  }

  // Gate 5: per-domain courtesy cap (don't pile onto one company). The slot
  // is reserved atomically so concurrent queue consumers cannot exceed it.
  const domainCap = intVar(env.DOMAIN_WEEKLY_CAP, 2);
  const weekStart = weekStartString(env.TIMEZONE);
  if (!(await takeDomainSlot(env, weekStart, lead.domain, domainCap))) {
    await decrementCounter(env, day);
    await recordEvent(env.DB, lead.id, 'send_deferred', { message_id: messageId, reason: 'domain_cap' });
    return { action: 'retry', delaySeconds: clampDelay(86_400), reason: 'domain weekly cap' };
  }

  // Claim - the double-send guard. Only one consumer can flip queued -> sending.
  const claim = await env.DB
    .prepare(
      `UPDATE messages SET status = 'sending', attempts = attempts + 1, updated_at = datetime('now')
       WHERE id = ?1 AND status = 'queued'`
    )
    .bind(messageId)
    .run();
  if ((claim.meta.changes ?? 0) === 0) {
    await decrementCounter(env, day);
    await decrementDomainCounter(env, weekStart, lead.domain);
    return { action: 'ack', reason: 'claimed elsewhere' };
  }

  const finalBody = ensureFooter(message.body ?? '');
  const subject = message.subject ?? 'Centrisec';

  try {
    const sent = await trySendWithAuthRetry(env, lead.email, subject, finalBody);
    await env.DB
      .prepare(
        `UPDATE messages SET status = 'sent', body = ?1, zoho_message_id = COALESCE(?2, zoho_message_id), error = NULL,
           sent_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?3 AND status = 'sending'`
      )
      .bind(finalBody, sent.internetMessageId ?? sent.providerMessageId, messageId)
      .run();
    await env.DB
      .prepare(
        `UPDATE leads SET status = 'sent', sales_stage = 'awaiting_reply',
           next_action = 'wait_for_reply_no_auto_follow_up', updated_at = datetime('now') WHERE id = ?1`
      )
      .bind(lead.id)
      .run();
    await recordEvent(env.DB, lead.id, 'sent', { message_id: messageId, dry_run: sent.dryRun });
    return { action: 'sent', dryRun: sent.dryRun };
  } catch (err) {
    if (err instanceof ZohoError && err.kind === 'permanent') {
      await markFailed(env, messageId, err.message);
      await env.DB
        .prepare(
          `UPDATE leads SET status = 'failed', sales_stage = 'delivery_issue',
             next_action = 'manual_review', updated_at = datetime('now') WHERE id = ?1`
        )
        .bind(lead.id)
        .run();
      await addSuppression(env.DB, 'email', lead.email, 'hard_bounce', messageId);
      await decrementCounter(env, day);
      await decrementDomainCounter(env, weekStart, lead.domain);
      await recordEvent(env.DB, lead.id, 'send_failed', { message_id: messageId, kind: 'permanent' });
      return { action: 'ack', reason: 'permanent send failure' };
    }
    const kind = err instanceof ZohoError ? err.kind : 'unknown';
    const messageText = err instanceof Error ? err.message : String(err);
    await revertToQueued(env, messageId, messageText);
    await decrementCounter(env, day);
    await decrementDomainCounter(env, weekStart, lead.domain);
    await recordEvent(env.DB, lead.id, 'send_failed', { message_id: messageId, kind });
    const delay = kind === 'auth' ? 3600 : 900;
    return { action: 'retry', delaySeconds: clampDelay(delay), reason: `send error (${kind})` };
  }
}

async function trySendWithAuthRetry(
  env: Env,
  to: string,
  subject: string,
  content: string
): Promise<{ dryRun: boolean; providerMessageId: string | null; internetMessageId: string | null }> {
  try {
    return await sendMail(env, { to, subject, content });
  } catch (err) {
    if (err instanceof ZohoError && err.kind === 'auth') {
      await getAccessToken(env, true);
      return sendMail(env, { to, subject, content });
    }
    throw err;
  }
}
