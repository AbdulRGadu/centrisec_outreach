import { runJson } from './ai/client';
import { buildClassifyMessages, buildSuggestedReplyMessages, PROMPT_VERSION } from './ai/prompts';
import {
  classifyJsonSchema,
  classifyResult,
  POSITIVE_CLASSIFICATIONS,
  suggestedReplyJsonSchema,
  suggestedReplyResult,
} from './ai/schemas';
import { recordEvent } from './db';
import type { Env } from './env';
import { HttpError, isValidEmail, jsonResponse, normalizeMultiline, normalizeText } from './http';
import { addSuppression } from './suppression';
import type { LeadRow, MessageRow } from './types';
import { domainOf } from './util/text';

function replyEnvelope(lead: LeadRow | null, message: MessageRow, duplicate: boolean) {
  const classification = message.classification ?? 'unclear';
  return {
    ok: true,
    duplicate,
    matched: !!lead,
    leadId: lead?.id ?? null,
    company: lead?.company ?? null,
    contactName: lead ? [lead.first_name, lead.last_name].filter(Boolean).join(' ') || null : null,
    classification,
    confidence: message.confidence ?? 0,
    summary: message.summary ?? '',
    isPositive: POSITIVE_CLASSIFICATIONS.has(classification),
    suggestedReply: message.suggested_reply ?? null,
  };
}

async function findLeadFor(env: Env, fromEmail: string): Promise<LeadRow | null> {
  const byEmail = await env.DB.prepare('SELECT * FROM leads WHERE email = ?1').bind(fromEmail).first<LeadRow>();
  if (byEmail) return byEmail;
  // Fallback: someone else at the same company replied (forward/delegate).
  return env.DB
    .prepare('SELECT * FROM leads WHERE domain = ?1 ORDER BY updated_at DESC LIMIT 1')
    .bind(domainOf(fromEmail))
    .first<LeadRow>();
}

async function findExistingInbound(env: Env, zohoMessageId: string): Promise<MessageRow | null> {
  return env.DB
    .prepare(`SELECT * FROM messages WHERE direction = 'inbound' AND zoho_message_id = ?1`)
    .bind(zohoMessageId)
    .first<MessageRow>();
}

/**
 * Inbound reply from n8n. Classifies, applies side effects (suppression, lead
 * status), drafts a suggested reply for positive classes, and returns the
 * classification so n8n can branch its alerts.
 */
export async function handleReplyPost(body: Record<string, unknown>, env: Env): Promise<Response> {
  const fromEmail = normalizeText(body.fromEmail, 180).toLowerCase();
  const subject = normalizeText(body.subject, 300);
  const replyBody = normalizeMultiline(body.body, 20000);
  const zohoMessageId = normalizeText(body.zohoMessageId, 300) || null;
  if (!fromEmail || !isValidEmail(fromEmail)) throw new HttpError(400, 'A valid fromEmail is required');
  if (!replyBody) throw new HttpError(400, 'body (the reply text) is required');

  if (zohoMessageId) {
    const existing = await findExistingInbound(env, zohoMessageId);
    if (existing) {
      const lead = existing.lead_id
        ? await env.DB.prepare('SELECT * FROM leads WHERE id = ?1').bind(existing.lead_id).first<LeadRow>()
        : null;
      return jsonResponse(replyEnvelope(lead ?? null, existing, true));
    }
  }

  const lead = await findLeadFor(env, fromEmail);

  let ourSubject: string | null = null;
  let ourBodyHead: string | null = null;
  if (lead) {
    const original = await env.DB
      .prepare(
        `SELECT subject, body FROM messages
         WHERE lead_id = ?1 AND direction = 'outbound' AND status = 'sent'
         ORDER BY sent_at DESC LIMIT 1`
      )
      .bind(lead.id)
      .first<{ subject: string | null; body: string | null }>();
    ourSubject = original?.subject ?? null;
    ourBodyHead = original?.body?.slice(0, 200) ?? null;
  }

  let classification = 'unclear';
  let confidence = 0;
  let summary = 'AI classification unavailable - review manually';
  try {
    const result = await runJson(
      env,
      env.MODEL_FAST,
      buildClassifyMessages({ fromEmail, replySubject: subject, replyBody, ourSubject, ourBodyHead }),
      classifyJsonSchema,
      classifyResult
    );
    classification = result.classification;
    confidence = result.confidence;
    summary = result.summary;
  } catch {
    if (lead) await recordEvent(env.DB, lead.id, 'ai_error', { stage: 'classify' });
  }

  const messageId = crypto.randomUUID();
  try {
    await env.DB
      .prepare(
        `INSERT INTO messages (id, lead_id, direction, status, subject, body, from_email, to_email,
           classification, confidence, summary, ai_model, prompt_version, zoho_message_id)
         VALUES (?1, ?2, 'inbound', 'received', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
      )
      .bind(
        messageId,
        lead?.id ?? null,
        subject || null,
        replyBody,
        fromEmail,
        env.FROM_EMAIL,
        classification,
        confidence,
        summary,
        env.MODEL_FAST,
        PROMPT_VERSION,
        zohoMessageId
      )
      .run();
  } catch (err) {
    // Unique index on zoho_message_id: a concurrent duplicate delivery lost the race.
    if (zohoMessageId) {
      const existing = await findExistingInbound(env, zohoMessageId);
      if (existing) {
        const dupLead = existing.lead_id
          ? await env.DB.prepare('SELECT * FROM leads WHERE id = ?1').bind(existing.lead_id).first<LeadRow>()
          : null;
        return jsonResponse(replyEnvelope(dupLead ?? null, existing, true));
      }
    }
    throw err;
  }

  let suggestedReply: string | null = null;
  if (lead) {
    await recordEvent(env.DB, lead.id, 'reply_received', { message_id: messageId });
    await recordEvent(env.DB, lead.id, 'classified', { message_id: messageId, classification, confidence });

    if (classification === 'remove_me') {
      await addSuppression(env.DB, 'email', lead.email, 'remove_me', messageId);
      await setLeadStatus(env, lead.id, 'unsubscribed');
    } else if (classification === 'not_interested') {
      await addSuppression(env.DB, 'email', lead.email, 'not_interested', messageId);
      await setLeadStatus(env, lead.id, 'disqualified');
    } else if (classification === 'bounce') {
      await addSuppression(env.DB, 'email', lead.email, 'bounce', messageId);
      await setLeadStatus(env, lead.id, 'bounced');
    } else if (POSITIVE_CLASSIFICATIONS.has(classification)) {
      await setLeadStatus(env, lead.id, 'replied');
    }
    await env.DB
      .prepare(`UPDATE leads SET last_reply_classification = ?1, updated_at = datetime('now') WHERE id = ?2`)
      .bind(classification, lead.id)
      .run();

    if (POSITIVE_CLASSIFICATIONS.has(classification)) {
      try {
        const suggestion = await runJson(
          env,
          env.MODEL_STRONG,
          buildSuggestedReplyMessages(env, { lead, classification, replyBody }),
          suggestedReplyJsonSchema,
          suggestedReplyResult,
          { maxTokens: 800 }
        );
        suggestedReply = suggestion.reply_body;
        await env.DB
          .prepare(`UPDATE messages SET suggested_reply = ?1, updated_at = datetime('now') WHERE id = ?2`)
          .bind(suggestedReply, messageId)
          .run();
      } catch {
        await recordEvent(env.DB, lead.id, 'ai_error', { stage: 'suggest_reply' });
      }
    }
  }

  const message = await env.DB.prepare('SELECT * FROM messages WHERE id = ?1').bind(messageId).first<MessageRow>();
  return jsonResponse(replyEnvelope(lead, message as MessageRow, false));
}

async function setLeadStatus(env: Env, leadId: string, status: string): Promise<void> {
  await env.DB
    .prepare(`UPDATE leads SET status = ?1, updated_at = datetime('now') WHERE id = ?2`)
    .bind(status, leadId)
    .run();
  await recordEvent(env.DB, leadId, 'status_changed', { to: status, by: 'reply_classification' });
}

export async function handleRepliesList(url: URL, env: Env): Promise<Response> {
  const classification = normalizeText(url.searchParams.get('classification'), 40);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);

  const where = classification
    ? `WHERE m.direction = 'inbound' AND m.classification = ?1`
    : `WHERE m.direction = 'inbound'`;
  const binds = classification ? [classification, limit, offset] : [limit, offset];
  const rows = await env.DB
    .prepare(
      `SELECT m.*, l.company AS lead_company, l.first_name AS lead_first_name,
              l.last_name AS lead_last_name, l.email AS lead_email, l.segment AS lead_segment
       FROM messages m LEFT JOIN leads l ON l.id = m.lead_id
       ${where}
       ORDER BY m.created_at DESC
       LIMIT ?${binds.length - 1} OFFSET ?${binds.length}`
    )
    .bind(...binds)
    .all();
  return jsonResponse({ ok: true, replies: rows.results });
}
