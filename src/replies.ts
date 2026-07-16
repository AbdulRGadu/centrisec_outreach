import { runJson } from './ai/client';
import { activeAiModel } from './ai/models';
import { buildClassifyMessages, buildSuggestedReplyMessages, PROMPT_VERSION } from './ai/prompts';
import {
  classifyJsonSchema,
  classifyResult,
  POSITIVE_CLASSIFICATIONS,
  suggestedReplyJsonSchema,
  suggestedReplyResult,
} from './ai/schemas';
import { safeEqualStrings } from './auth';
import { recordEvent } from './db';
import type { Env } from './env';
import { HttpError, isValidEmail, jsonResponse, normalizeMultiline, normalizeText } from './http';
import { addSuppression, isSuppressed } from './suppression';
import type { LeadRow, MessageRow, ReplyMatchStatus } from './types';
import { detectReplyOptOut, domainOf, latestReplyText, looksLikeHardBounce, normalizeEmailBody } from './util/text';

type ReplyNextAction =
  | 'book_demo'
  | 'send_checklist'
  | 'send_info'
  | 'ask_availability'
  | 'create_new_referred_lead'
  | 'suppress'
  | 'ignore'
  | 'manual_review';

interface ReplyPayload {
  fromEmail: string;
  fromName: string;
  subject: string;
  body: string;
  receivedAt: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  rawPayload: unknown;
}

interface MatchResult {
  lead: LeadRow | null;
  outbound: MessageRow | null;
  status: ReplyMatchStatus;
}

export function nextActionFor(classification: string): ReplyNextAction {
  switch (classification) {
    case 'positive_interest': return 'send_checklist';
    case 'meeting_request': return 'ask_availability';
    case 'asks_for_more_info': return 'send_info';
    case 'referral_to_colleague': return 'create_new_referred_lead';
    case 'not_interested':
    case 'remove_me': return 'suppress';
    case 'not_now':
    case 'out_of_office':
    case 'bounce_or_auto_reply': return 'ignore';
    default: return 'manual_review';
  }
}

function parsePayload(body: Record<string, unknown>): ReplyPayload {
  const fromEmail = normalizeText(body.from_email ?? body.fromEmail, 180).toLowerCase();
  const replyBody = normalizeMultiline(body.body, 20_000);
  if (!fromEmail || !isValidEmail(fromEmail)) throw new HttpError(400, 'A valid from_email is required');
  if (!replyBody) throw new HttpError(400, 'body (the reply text) is required');
  return {
    fromEmail,
    fromName: normalizeText(body.from_name ?? body.fromName, 180),
    subject: normalizeText(body.subject, 300),
    body: replyBody,
    receivedAt: normalizeText(body.received_at ?? body.receivedAt, 80) || null,
    messageId: normalizeText(body.message_id ?? body.messageId ?? body.zohoMessageId, 500) || null,
    inReplyTo: normalizeText(body.in_reply_to ?? body.inReplyTo, 2000) || null,
    references: normalizeText(body.references, 4000) || null,
    rawPayload: body.raw_payload ?? body.rawPayload ?? body,
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 100_000);
  } catch {
    return '{"error":"payload could not be serialized"}';
  }
}

async function createIngestLog(
  env: Env,
  body: Record<string, unknown>,
  authStatus: 'authorized' | 'unauthorized'
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO reply_ingest_logs
       (id, from_email, message_id, in_reply_to, references_header, raw_payload, auth_status, classification_status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  ).bind(
    id,
    normalizeText(body.from_email ?? body.fromEmail, 180).toLowerCase() || null,
    normalizeText(body.message_id ?? body.messageId ?? body.zohoMessageId, 500) || null,
    normalizeText(body.in_reply_to ?? body.inReplyTo, 2000) || null,
    normalizeText(body.references, 4000) || null,
    safeJson(body.raw_payload ?? body.rawPayload ?? body),
    authStatus,
    authStatus === 'authorized' ? 'pending' : 'skipped'
  ).run();
  return id;
}

async function updateIngestLog(
  env: Env,
  id: string,
  values: {
    matchStatus?: ReplyMatchStatus;
    classificationStatus?: 'pending' | 'classified' | 'failed' | 'skipped';
    classification?: string;
    confidence?: number;
    leadId?: string | null;
    inboundMessageId?: string | null;
    error?: string | null;
  }
): Promise<void> {
  await env.DB.prepare(
    `UPDATE reply_ingest_logs SET
       match_status = COALESCE(?1, match_status),
       classification_status = COALESCE(?2, classification_status),
       classification = COALESCE(?3, classification),
       confidence = COALESCE(?4, confidence),
       lead_id = COALESCE(?5, lead_id),
       inbound_message_id = COALESCE(?6, inbound_message_id),
       error = ?7,
       updated_at = datetime('now')
     WHERE id = ?8`
  ).bind(
    values.matchStatus ?? null,
    values.classificationStatus ?? null,
    values.classification ?? null,
    values.confidence ?? null,
    values.leadId ?? null,
    values.inboundMessageId ?? null,
    values.error ?? null,
    id
  ).run();
}

function headerIds(value: string | null): string[] {
  if (!value) return [];
  const bracketed = [...value.matchAll(/<([^>]+)>/g)].map((match) => `<${match[1]}>`);
  const bare = value.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean);
  return [...new Set([...bracketed, ...bracketed.map((id) => id.slice(1, -1)), ...bare])].slice(0, 30);
}

async function outboundByProviderId(env: Env, ids: string[]): Promise<MessageRow | null> {
  if (ids.length === 0) return null;
  const placeholders = ids.map(() => '?').join(',');
  return env.DB.prepare(
    `SELECT * FROM messages
     WHERE direction = 'outbound' AND status = 'sent' AND zoho_message_id IN (${placeholders})
     ORDER BY sent_at DESC LIMIT 1`
  ).bind(...ids).first<MessageRow>();
}

async function leadForOutbound(env: Env, outbound: MessageRow | null): Promise<LeadRow | null> {
  if (!outbound?.lead_id) return null;
  return env.DB.prepare('SELECT * FROM leads WHERE id = ?1').bind(outbound.lead_id).first<LeadRow>();
}

async function matchReply(env: Env, payload: ReplyPayload): Promise<MatchResult> {
  let outbound = await outboundByProviderId(env, headerIds(payload.messageId));
  if (outbound) return { lead: await leadForOutbound(env, outbound), outbound, status: 'matched_by_message_id' };

  outbound = await outboundByProviderId(env, [
    ...headerIds(payload.inReplyTo),
    ...headerIds(payload.references),
  ]);
  if (outbound) return { lead: await leadForOutbound(env, outbound), outbound, status: 'matched_by_in_reply_to' };

  outbound = await env.DB.prepare(
    `SELECT m.* FROM messages m JOIN leads l ON l.id = m.lead_id
     WHERE m.direction = 'outbound' AND m.status = 'sent' AND l.email = ?1
     ORDER BY m.sent_at DESC LIMIT 1`
  ).bind(payload.fromEmail).first<MessageRow>();
  if (outbound) return { lead: await leadForOutbound(env, outbound), outbound, status: 'matched_by_sender_email' };

  outbound = await env.DB.prepare(
    `SELECT m.* FROM messages m JOIN leads l ON l.id = m.lead_id
     WHERE m.direction = 'outbound' AND m.status = 'sent' AND l.domain = ?1
     ORDER BY m.sent_at DESC LIMIT 1`
  ).bind(domainOf(payload.fromEmail)).first<MessageRow>();
  if (outbound) return { lead: await leadForOutbound(env, outbound), outbound, status: 'matched_by_sender_domain' };

  return { lead: null, outbound: null, status: 'unmatched' };
}

async function existingInbound(env: Env, messageId: string): Promise<MessageRow | null> {
  return env.DB.prepare(
    `SELECT * FROM messages WHERE direction = 'inbound' AND zoho_message_id = ?1`
  ).bind(messageId).first<MessageRow>();
}

function replyEnvelope(lead: LeadRow | null, message: MessageRow, duplicate: boolean, matchStatus: ReplyMatchStatus) {
  const classification = message.classification ?? 'unclear';
  return {
    ok: true,
    duplicate,
    matched: !!lead,
    match_status: matchStatus,
    leadId: lead?.id ?? null,
    company: lead?.company ?? null,
    contactName: lead ? [lead.first_name, lead.last_name].filter(Boolean).join(' ') || null : null,
    classification,
    confidence: message.confidence ?? 0,
    summary: message.summary ?? '',
    next_action: message.next_action ?? nextActionFor(classification),
    isPositive: POSITIVE_CLASSIFICATIONS.has(classification),
    suggested_reply: message.suggested_reply ?? null,
    suggestedReply: message.suggested_reply ?? null,
  };
}

/** Exact n8n ingress endpoint. It uses a dedicated secret, not the dashboard bearer token. */
export async function handleReplyIngest(request: Request, env: Env): Promise<Response> {
  const raw = await request.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : { raw_payload: raw };
  const supplied = request.headers.get('x-n8n-webhook-secret') ?? '';
  const authorized = !!env.N8N_WEBHOOK_SECRET && !!supplied && await safeEqualStrings(supplied, env.N8N_WEBHOOK_SECRET);
  const logId = await createIngestLog(env, body, authorized ? 'authorized' : 'unauthorized');
  if (!authorized) return jsonResponse({ ok: false, error: 'Unauthorized', ingest_id: logId }, 401);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    await updateIngestLog(env, logId, { classificationStatus: 'failed', error: 'Invalid JSON payload' });
    return jsonResponse({ ok: false, error: 'Invalid JSON payload', ingest_id: logId }, 400);
  }
  return processReply(body, env, logId);
}

/** Backward-compatible dashboard/API ingress. The /api route already checks its bearer token. */
export async function handleReplyPost(body: Record<string, unknown>, env: Env): Promise<Response> {
  const logId = await createIngestLog(env, body, 'authorized');
  return processReply(body, env, logId);
}

async function processReply(body: Record<string, unknown>, env: Env, logId: string): Promise<Response> {
  try {
    const payload = parsePayload(body);
    if (payload.messageId) {
      const duplicate = await existingInbound(env, payload.messageId);
      if (duplicate) {
        const lead = await leadForOutbound(env, duplicate);
        await updateIngestLog(env, logId, {
          matchStatus: lead ? 'matched_by_message_id' : 'unmatched',
          classificationStatus: 'skipped',
          classification: duplicate.classification ?? 'unclear',
          confidence: duplicate.confidence ?? 0,
          leadId: lead?.id ?? null,
          inboundMessageId: duplicate.id,
          error: 'Duplicate delivery',
        });
        return jsonResponse(replyEnvelope(lead, duplicate, true, lead ? 'matched_by_message_id' : 'unmatched'));
      }
    }

    const match = await matchReply(env, payload);
    const replyText = latestReplyText(payload.body) || payload.body;
    let classification = 'unclear';
    let confidence = 0;
    let summary = match.lead ? 'AI classification unavailable; review manually.' : 'Reply could not be matched; review manually.';
    let model = env.DEFAULT_AI_MODEL;
    let classificationError: string | null = null;
    const optOutEnabled = env.REPLY_BASED_OPT_OUT_ENABLED === 'true' || env.REPLY_BASED_OPT_OUT_ENABLED === '1';
    const optOut = optOutEnabled ? detectReplyOptOut(replyText) : null;

    if (optOut) {
      classification = optOut === 'not_interested' ? 'not_interested' : 'remove_me';
      confidence = 1;
      summary = optOut === 'complaint' ? 'Complaint or spam report; suppress immediately.' : 'Direct opt-out request.';
    } else {
      try {
        model = await activeAiModel(env);
        const result = await runJson(
          env,
          model,
          buildClassifyMessages({
            fromEmail: payload.fromEmail,
            replySubject: payload.subject,
            replyBody: replyText,
            ourSubject: match.outbound?.subject ?? null,
            ourBodyHead: match.outbound?.body?.slice(0, 300) ?? null,
          }),
          classifyJsonSchema,
          classifyResult
        );
        classification = result.classification;
        confidence = result.confidence;
        summary = result.summary;
      } catch (error) {
        classificationError = error instanceof Error ? error.message : String(error);
        if (match.lead) await recordEvent(env.DB, match.lead.id, 'ai_error', { stage: 'classify' });
      }
    }

    const nextAction = nextActionFor(classification);
    const inboundId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO messages
         (id, lead_id, direction, status, subject, body, from_email, to_email,
          classification, confidence, summary, ai_model, prompt_version, zoho_message_id,
          next_action, received_at, error)
       VALUES (?1, ?2, 'inbound', 'received', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`
    ).bind(
      inboundId,
      match.lead?.id ?? null,
      payload.subject || null,
      payload.body,
      payload.fromEmail,
      env.FROM_EMAIL,
      classification,
      confidence,
      summary,
      model,
      PROMPT_VERSION,
      payload.messageId,
      nextAction,
      payload.receivedAt,
      classificationError
    ).run();

    await updateIngestLog(env, logId, {
      matchStatus: match.status,
      classificationStatus: classificationError ? 'failed' : 'classified',
      classification,
      confidence,
      leadId: match.lead?.id ?? null,
      inboundMessageId: inboundId,
      error: classificationError,
    });

    if (match.lead) {
      await applyReplyOutcome(env, match.lead, inboundId, classification, nextAction, replyText, optOut);
      if (POSITIVE_CLASSIFICATIONS.has(classification)) {
        try {
          const suggestion = await runJson(
            env,
            model,
            buildSuggestedReplyMessages(env, { lead: match.lead, classification, replyBody: replyText }),
            suggestedReplyJsonSchema,
            suggestedReplyResult,
            { maxTokens: 800 }
          );
          const suggestedReply = normalizeEmailBody(suggestion.reply_body);
          await env.DB.prepare(
            `UPDATE messages SET suggested_reply = ?1, updated_at = datetime('now') WHERE id = ?2`
          ).bind(suggestedReply, inboundId).run();
        } catch (error) {
          await recordEvent(env.DB, match.lead.id, 'ai_error', { stage: 'suggest_reply' });
          await updateIngestLog(env, logId, {
            error: `Suggested reply failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
          });
        }
      }
    }

    const message = await env.DB.prepare('SELECT * FROM messages WHERE id = ?1').bind(inboundId).first<MessageRow>();
    if (!message) throw new HttpError(500, 'Reply insert failed');
    return jsonResponse(replyEnvelope(match.lead, message, false, match.status));
  } catch (error) {
    await updateIngestLog(env, logId, {
      classificationStatus: 'failed',
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    });
    throw error;
  }
}

async function applyReplyOutcome(
  env: Env,
  lead: LeadRow,
  messageId: string,
  classification: string,
  nextAction: ReplyNextAction,
  replyBody: string,
  optOut: ReturnType<typeof detectReplyOptOut>
): Promise<void> {
  await recordEvent(env.DB, lead.id, 'reply_received', { message_id: messageId });
  await recordEvent(env.DB, lead.id, 'classified', { message_id: messageId, classification, next_action: nextAction });

  let status: LeadRow['status'] = 'manual_review';
  let salesStage = 'manual_review';
  if (classification === 'remove_me' || classification === 'not_interested') {
    await addSuppression(
      env.DB,
      'email',
      lead.email,
      optOut === 'complaint' ? 'complaint' : classification,
      messageId
    );
    status = classification === 'not_interested' ? 'not_interested' : 'suppressed';
    salesStage = 'do_not_contact';
  } else if (classification === 'bounce_or_auto_reply' && looksLikeHardBounce(replyBody)) {
    await addSuppression(env.DB, 'email', lead.email, 'hard_bounce', messageId);
    status = 'failed';
    salesStage = 'invalid_email';
  } else if (classification === 'positive_interest') {
    status = 'replied_positive';
    salesStage = 'next_sales_step';
  } else if (classification === 'meeting_request') {
    status = 'meeting_requested';
    salesStage = 'meeting_requested';
  } else if (classification === 'asks_for_more_info') {
    status = 'asked_for_more_info';
    salesStage = 'more_info_requested';
  } else if (classification === 'referral_to_colleague') {
    status = 'referred';
    salesStage = 'referral_received';
    await createReferredLead(env, lead, replyBody, messageId);
  } else if (classification === 'not_now') {
    status = 'not_now';
    salesStage = 'nurture_later';
  } else if (classification === 'out_of_office' || classification === 'bounce_or_auto_reply') {
    status = 'sent';
    salesStage = 'auto_reply';
  }

  await env.DB.prepare(
    `UPDATE leads SET status = ?1, sales_stage = ?2, next_action = ?3,
       last_reply_classification = ?4, updated_at = datetime('now') WHERE id = ?5`
  ).bind(status, salesStage, nextAction, classification, lead.id).run();
  await recordEvent(env.DB, lead.id, 'status_changed', { to: status, sales_stage: salesStage, by: 'reply_classification' });
}

async function createReferredLead(env: Env, originalLead: LeadRow, replyBody: string, sourceMessageId: string): Promise<void> {
  const candidates = replyBody.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  const email = candidates.map((value) => value.toLowerCase()).find(
    (value) => value !== originalLead.email && value !== env.FROM_EMAIL.toLowerCase() && isValidEmail(value)
  );
  if (!email || await isSuppressed(env.DB, email, domainOf(email))) return;
  const id = crypto.randomUUID();
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO leads (id, email, domain, company, industry, source, status, notes)
     VALUES (?1, ?2, ?3, ?4, ?5, 'referral', 'new', ?6)`
  ).bind(id, email, domainOf(email), originalLead.company, originalLead.industry, `Referral from reply ${sourceMessageId}`).run();
  if ((result.meta.changes ?? 0) > 0) {
    await recordEvent(env.DB, id, 'created', { source: 'referral' });
    await recordEvent(env.DB, originalLead.id, 'referral_created', { referred_lead_id: id });
  }
}

export async function handleRepliesList(url: URL, env: Env): Promise<Response> {
  const classification = normalizeText(url.searchParams.get('classification'), 40);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
  const where = classification
    ? `WHERE m.direction = 'inbound' AND m.classification = ?1`
    : `WHERE m.direction = 'inbound'`;
  const binds = classification ? [classification, limit, offset] : [limit, offset];
  const rows = await env.DB.prepare(
    `SELECT m.*, l.company AS lead_company, l.first_name AS lead_first_name,
            l.last_name AS lead_last_name, l.email AS lead_email, l.segment AS lead_segment,
            l.sales_stage AS lead_sales_stage,
            log.match_status,
            original.subject AS original_subject, original.body AS original_body
     FROM messages m
     LEFT JOIN leads l ON l.id = m.lead_id
     LEFT JOIN reply_ingest_logs log ON log.inbound_message_id = m.id
     LEFT JOIN messages original ON original.id = (
       SELECT om.id FROM messages om
       WHERE om.lead_id = m.lead_id AND om.direction = 'outbound' AND om.status = 'sent'
       ORDER BY om.sent_at DESC LIMIT 1
     )
     ${where}
     ORDER BY COALESCE(m.received_at, m.created_at) DESC
     LIMIT ?${binds.length - 1} OFFSET ?${binds.length}`
  ).bind(...binds).all();
  return jsonResponse({ ok: true, replies: rows.results });
}

export async function handleRepliesDebug(env: Env): Promise<Response> {
  const attempts = await env.DB.prepare(
    `SELECT id, payload_received_at, from_email, message_id, in_reply_to,
            auth_status, match_status, classification_status, classification,
            confidence, lead_id, inbound_message_id, error
     FROM reply_ingest_logs ORDER BY payload_received_at DESC LIMIT 50`
  ).all();
  const latest = attempts.results[0] as Record<string, unknown> | undefined;
  return jsonResponse({
    ok: true,
    last_n8n_payload_timestamp: latest?.payload_received_at ?? null,
    last_match_result: latest?.match_status ?? null,
    last_classification_result: latest?.classification ?? null,
    last_error: latest?.error ?? null,
    attempts: attempts.results,
  });
}
