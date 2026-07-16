import { inPlaceholders, recordEvent, recordEventStmt } from './db';
import type { Env } from './env';
import { HttpError, isValidEmail, jsonResponse, normalizeMultiline, normalizeText } from './http';
import { loadSuppressedKeys, suppressionKeyHit, unsubTokenFor } from './suppression';
import type { LeadRow, MessageRow } from './types';
import { buildFooter, domainOf, unsubscribeUrl } from './util/text';

const SOURCES = new Set(['csv', 'sheets', 'form', 'directory', 'linkedin', 'referral', 'manual']);

interface PreparedLead {
  email: string;
  valid: boolean;
  firstName: string | null;
  lastName: string | null;
  role: string | null;
  company: string | null;
  companyWebsite: string | null;
  industry: string | null;
  source: string;
  notes: string | null;
}

function prepareLead(raw: unknown): PreparedLead {
  const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const email = normalizeText(rec.email, 180).toLowerCase();
  const source = normalizeText(rec.source, 40).toLowerCase();
  return {
    email,
    valid: !!email && isValidEmail(email),
    firstName: normalizeText(rec.firstName, 80) || null,
    lastName: normalizeText(rec.lastName, 80) || null,
    role: normalizeText(rec.role, 120) || null,
    company: normalizeText(rec.company, 160) || null,
    companyWebsite: normalizeText(rec.companyWebsite, 200) || null,
    industry: normalizeText(rec.industry, 120) || null,
    source: SOURCES.has(source) ? source : 'manual',
    notes: normalizeMultiline(rec.notes, 2000) || null,
  };
}

export async function handleLeadsPost(body: Record<string, unknown>, env: Env): Promise<Response> {
  const rawLeads = body.leads;
  if (!Array.isArray(rawLeads) || rawLeads.length === 0) {
    throw new HttpError(400, 'Provide a non-empty leads array');
  }
  if (rawLeads.length > 100) {
    throw new HttpError(400, 'Max 100 leads per batch');
  }

  const prepared = rawLeads.map(prepareLead);
  const validEmails = [...new Set(prepared.filter((p) => p.valid).map((p) => p.email))];
  const validDomains = [...new Set(validEmails.map(domainOf))];

  const suppressed = await loadSuppressedKeys(env.DB, validEmails, validDomains);

  const existingEmails = new Set<string>();
  if (validEmails.length > 0) {
    const rows = await env.DB
      .prepare(`SELECT email FROM leads WHERE email IN (${inPlaceholders(validEmails.length)})`)
      .bind(...validEmails)
      .all<{ email: string }>();
    for (const r of rows.results) existingEmails.add(r.email);
  }
  const existingDomains = new Set<string>();
  if (validDomains.length > 0) {
    const rows = await env.DB
      .prepare(`SELECT DISTINCT domain FROM leads WHERE domain IN (${inPlaceholders(validDomains.length)})`)
      .bind(...validDomains)
      .all<{ domain: string }>();
    for (const r of rows.results) existingDomains.add(r.domain);
  }

  const results: Array<Record<string, unknown>> = [];
  const stmts: D1PreparedStatement[] = [];
  const seenInBatch = new Set<string>();

  for (const p of prepared) {
    if (!p.valid) {
      results.push({ email: p.email || null, result: 'invalid' });
      continue;
    }
    if (suppressionKeyHit(suppressed, p.email)) {
      results.push({ email: p.email, result: 'suppressed' });
      continue;
    }
    if (existingEmails.has(p.email) || seenInBatch.has(p.email)) {
      results.push({ email: p.email, result: 'duplicate_email' });
      continue;
    }
    seenInBatch.add(p.email);
    const id = crypto.randomUUID();
    const domain = domainOf(p.email);
    stmts.push(
      env.DB
        .prepare(
          `INSERT INTO leads (id, email, domain, first_name, last_name, role, company, company_website, industry, source, notes)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
        )
        .bind(
          id,
          p.email,
          domain,
          p.firstName,
          p.lastName,
          p.role,
          p.company,
          p.companyWebsite,
          p.industry,
          p.source,
          p.notes
        )
    );
    stmts.push(recordEventStmt(env.DB, id, 'created', { source: p.source }));
    results.push({
      email: p.email,
      result: 'inserted',
      id,
      ...(existingDomains.has(domain) ? { domainExists: true } : {}),
    });
    existingDomains.add(domain);
  }

  if (stmts.length > 0) await env.DB.batch(stmts);
  return jsonResponse({ ok: true, results });
}

export async function handleLeadsList(url: URL, env: Env): Promise<Response> {
  const status = normalizeText(url.searchParams.get('status'), 30);
  const segment = normalizeText(url.searchParams.get('segment'), 30);
  const q = normalizeText(url.searchParams.get('q'), 100);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);

  const where: string[] = [];
  const binds: unknown[] = [];
  if (status) {
    where.push(`status = ?${binds.length + 1}`);
    binds.push(status);
  }
  if (segment) {
    where.push(`segment = ?${binds.length + 1}`);
    binds.push(segment);
  }
  if (q) {
    const like = `%${q}%`;
    where.push(
      `(email LIKE ?${binds.length + 1} OR company LIKE ?${binds.length + 2} OR first_name LIKE ?${binds.length + 3} OR last_name LIKE ?${binds.length + 4})`
    );
    binds.push(like, like, like, like);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM leads ${whereSql}`)
    .bind(...binds)
    .first<{ n: number }>();
  const rows = await env.DB
    .prepare(
      `SELECT * FROM leads ${whereSql} ORDER BY updated_at DESC LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`
    )
    .bind(...binds, limit, offset)
    .all<LeadRow>();

  return jsonResponse({ ok: true, total: totalRow?.n ?? 0, leads: rows.results });
}

export async function getLead(env: Env, id: string): Promise<LeadRow> {
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?1').bind(id).first<LeadRow>();
  if (!lead) throw new HttpError(404, 'Lead not found');
  return lead;
}

export async function handleLeadGet(id: string, env: Env): Promise<Response> {
  const lead = await getLead(env, id);
  const messages = await env.DB
    .prepare('SELECT * FROM messages WHERE lead_id = ?1 ORDER BY created_at ASC')
    .bind(id)
    .all<MessageRow>();
  const events = await env.DB
    .prepare('SELECT event, detail, created_at FROM lead_events WHERE lead_id = ?1 ORDER BY id DESC LIMIT 100')
    .bind(id)
    .all();
  const token = await unsubTokenFor(env, lead.id);
  const footerPreview = buildFooter(env, unsubscribeUrl(env, lead.id, token));
  return jsonResponse({
    ok: true,
    lead,
    messages: messages.results,
    events: events.results,
    footerPreview,
  });
}

export async function handleLeadPatch(id: string, body: Record<string, unknown>, env: Env): Promise<Response> {
  const lead = await getLead(env, id);

  if (typeof body.notes === 'string') {
    await env.DB
      .prepare(`UPDATE leads SET notes = ?1, updated_at = datetime('now') WHERE id = ?2`)
      .bind(normalizeMultiline(body.notes, 2000) || null, id)
      .run();
  }

  const action = typeof body.action === 'string' ? body.action : '';
  if (action === 'disqualify') {
    if (lead.status === 'unsubscribed') throw new HttpError(409, 'Lead already unsubscribed');
    await env.DB
      .prepare(`UPDATE leads SET status = 'disqualified', updated_at = datetime('now') WHERE id = ?1`)
      .bind(id)
      .run();
    await recordEvent(env.DB, id, 'status_changed', { to: 'disqualified', by: 'manual' });
  } else if (action === 'reactivate') {
    // The only way a non-replier re-enters the pipeline (no automatic follow-ups).
    if (!['sent', 'replied', 'disqualified'].includes(lead.status)) {
      throw new HttpError(409, `Cannot reactivate a lead in status '${lead.status}'`);
    }
    await env.DB
      .prepare(`UPDATE leads SET status = 'scored', updated_at = datetime('now') WHERE id = ?1`)
      .bind(id)
      .run();
    await recordEvent(env.DB, id, 'status_changed', { to: 'scored', by: 'manual_reactivate' });
  } else if (action) {
    throw new HttpError(400, `Unknown action '${action}'`);
  }

  return jsonResponse({ ok: true, lead: await getLead(env, id) });
}
