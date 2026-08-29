import { recordEvent } from './db';
import type { Env } from './env';
import { advancePipeline } from './pipeline';
import { getCampaign, getSenderProfile, recordSequenceEvent, renderCampaignTemplate, senderProfileSettings } from './services/campaigns';
import { isSuppressed } from './suppression';
import { safeSenderDisplayName } from './services/outreachSettings';
import type { LeadRow, MessageRow } from './types';
import { businessDaysElapsed } from './util/time';

const ADVANCER_CRON = '0 7-15/2 * * 1-5';

export async function runScheduled(controller: ScheduledController, env: Env): Promise<void> {
  if (controller.cron === ADVANCER_CRON) {
    const result = await advancePipeline(env);
    if (result.scored || result.drafted || result.errors.length) {
      console.log(
        `pipeline advance: scored=${result.scored} drafted=${result.drafted} errors=${result.errors.length}`
      );
    }
    return;
  }
  await sweep(env);
}

/**
 * Safety-net sweeper (every 15 min). D1 is the source of truth; this recovers
 * anything the queue lost or a crash left behind.
 */
async function sweep(env: Env): Promise<void> {
  await queueDueFollowUps(env);
  // 1. A send that claimed 'sending' but never resolved (crash mid-send).
  //    Park it for MANUAL review - auto-resending an unknown is how double-sends happen.
  const stuck = await env.DB
    .prepare(
      `SELECT id, lead_id FROM messages
       WHERE direction = 'outbound' AND status = 'sending'
         AND updated_at < datetime('now','-15 minutes')`
    )
    .all<{ id: string; lead_id: string | null }>();
  for (const row of stuck.results) {
    await env.DB
      .prepare(
        `UPDATE messages SET status = 'send_unknown', sendability_status = 'blocked',
            status_reason = 'Send outcome is unknown; review before retrying',
            next_action = 'manual_review', updated_at = datetime('now')
         WHERE id = ?1 AND status = 'sending'`
      )
      .bind(row.id)
      .run();
    if (row.lead_id) {
      await recordEvent(env.DB, row.lead_id, 'status_changed', { message_id: row.id, to: 'send_unknown' });
    }
  }

  // 2. Approved but never enqueued (queue send failed during approve).
  const stragglers = await env.DB
    .prepare(
      `SELECT id FROM messages
       WHERE direction = 'outbound' AND status = 'approved'
         AND updated_at < datetime('now','-10 minutes')`
    )
    .all<{ id: string }>();
  for (const row of stragglers.results) {
    try {
      await env.SEND_QUEUE.send({ type: 'send', messageId: row.id });
      await env.DB
        .prepare(
          `UPDATE messages SET status = 'queued', updated_at = datetime('now')
           WHERE id = ?1 AND status = 'approved'`
        )
        .bind(row.id)
        .run();
    } catch {
      // try again next sweep
    }
  }

  // 3. Queued rows the queue apparently dropped (free-plan 24h retention, DLQ).
  //    Re-enqueue while attempts allow; give up into 'failed' after that.
  const stale = await env.DB
    .prepare(
      `SELECT id, attempts, lead_id FROM messages
       WHERE direction = 'outbound' AND status = 'queued'
         AND updated_at < datetime('now','-26 hours')`
    )
    .all<{ id: string; attempts: number; lead_id: string | null }>();
  for (const row of stale.results) {
    if (row.attempts < 20) {
      try {
        await env.SEND_QUEUE.send({ type: 'send', messageId: row.id });
        await env.DB
          .prepare(`UPDATE messages SET updated_at = datetime('now') WHERE id = ?1 AND status = 'queued'`)
          .bind(row.id)
          .run();
      } catch {
        // try again next sweep
      }
    } else {
      await env.DB
        .prepare(
          `UPDATE messages SET status = 'failed', sendability_status = 'blocked', status_reason = 'Queue retry limit reached; review provider status',
              error = 'gave up after 20 attempts', next_action = 'manual_review', updated_at = datetime('now')
           WHERE id = ?1 AND status = 'queued'`
        )
        .bind(row.id)
        .run();
      if (row.lead_id) {
        await recordEvent(env.DB, row.lead_id, 'send_failed', { message_id: row.id, kind: 'gave_up' });
      }
    }
  }
}

function defaultFollowUp(lead: LeadRow, greeting: string, fallback: string, signoff: string, senderName: string, cta: string): string {
  const name = lead.first_name?.trim();
  const hello = name ? `${greeting} ${name},` : `${fallback},`;
  return [
    hello,
    'I wanted to follow up on my earlier note from Centrisec.',
    'I can send a short practical checklist covering access control, staff awareness, incident readiness, and protection of sensitive business data.',
    cta || 'Would it be useful if I sent it over?',
    `${signoff},`,
    senderName,
  ].filter(Boolean).join('\n\n');
}

/** Queue exactly one campaign follow-up after the configured number of business days. */
async function queueDueFollowUps(env: Env): Promise<void> {
  const candidates = await env.DB.prepare(
    `SELECT m.*,
      m.id AS initial_message_id, m.sent_at AS initial_sent_at,
      c.id AS campaign_id_value
     FROM messages m
     JOIN leads l ON l.id = m.lead_id
     JOIN campaigns c ON c.id = m.campaign_id
     JOIN campaign_leads cl ON cl.campaign_id = c.id AND cl.lead_id = l.id
     WHERE m.direction = 'outbound' AND m.status = 'sent' AND m.sequence_step = 1
       AND c.status = 'active' AND c.follow_up_enabled = 1 AND cl.status = 'sent'
       AND NOT EXISTS (
         SELECT 1 FROM messages f WHERE f.lead_id = m.lead_id AND f.campaign_id = m.campaign_id
         AND f.direction = 'outbound' AND f.sequence_step = 2
       )
       AND NOT EXISTS (
         SELECT 1 FROM messages r WHERE r.lead_id = m.lead_id AND r.direction = 'inbound' AND r.status = 'received'
       )
     ORDER BY m.sent_at ASC LIMIT 100`
  ).all<(MessageRow & { initial_message_id: string; initial_sent_at: string; campaign_id_value: string })>();

  for (const row of candidates.results) {
    const campaign = await getCampaign(env, row.campaign_id_value);
    if (!row.initial_sent_at || businessDaysElapsed(row.initial_sent_at, campaign.timezone) < campaign.follow_up_delay_business_days) continue;
    const lead = await env.DB.prepare('SELECT * FROM leads WHERE id=?1').bind(row.lead_id).first<LeadRow>();
    if (!lead) continue;
    if (await isSuppressed(env.DB, lead.email, lead.domain)) continue;
    const profile = campaign.sender_profile_id ? await getSenderProfile(env, campaign.sender_profile_id) : null;
    if (!profile?.is_verified || !profile.is_active) {
      await recordSequenceEvent(env, campaign.id, lead.id, row.initial_message_id, 'follow_up_blocked', { reason: 'sender_profile' });
      continue;
    }
    const settings = senderProfileSettings(profile, campaign);
    const body = campaign.follow_up_template
      ? renderCampaignTemplate(campaign.follow_up_template, lead)
      : defaultFollowUp(lead, settings.greeting, settings.fallbackGreeting, settings.signoff, settings.senderName, settings.cta);
    const id = crypto.randomUUID();
    const snapshot = row.settings_snapshot || JSON.stringify({
      senderEmail: profile.sender_email,
      senderDisplayName: safeSenderDisplayName(profile.display_name),
      replyEmail: profile.reply_email,
      ccEmail: profile.cc_email,
      bccEmail: profile.bcc_email,
      footerHtml: settings.footerHtml,
      campaignId: campaign.id,
    });
    await env.DB.prepare(
      `INSERT INTO messages (id,lead_id,direction,status,subject,body,from_email,to_email,campaign_id,sender_profile_id,sequence_step,settings_snapshot,quality_snapshot,next_action,sendability_status,status_reason,sender_display_name)
       VALUES (?1,?2,'outbound','queued',?3,?4,?5,?6,?7,?8,2,?9,?10,'wait_for_reply','sendable','Scheduled follow-up',?11)`
    ).bind(
      id, lead.id, `Following up: ${row.subject || 'Centrisec'}`, body, profile.sender_email, lead.email,
      campaign.id, profile.id, snapshot, JSON.stringify({ status: 'sendable', source: 'approved_follow_up_template' }), safeSenderDisplayName(profile.display_name)
    ).run();
    await env.SEND_QUEUE.send({ type: 'send', messageId: id });
    await env.DB.prepare(`UPDATE campaign_leads SET status='queued',status_reason='Scheduled follow-up',updated_at=datetime('now') WHERE campaign_id=?1 AND lead_id=?2`).bind(campaign.id, lead.id).run();
    await recordEvent(env.DB, lead.id, 'follow_up_queued', { message_id: id, campaign_id: campaign.id });
    await recordSequenceEvent(env, campaign.id, lead.id, id, 'follow_up_queued', { after_business_days: campaign.follow_up_delay_business_days });
  }
}
