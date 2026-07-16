import { recordEvent } from './db';
import type { Env } from './env';
import { advancePipeline } from './pipeline';

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
        `UPDATE messages SET status = 'send_unknown', updated_at = datetime('now')
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
          `UPDATE messages SET status = 'failed', error = 'gave up after 20 attempts', updated_at = datetime('now')
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
