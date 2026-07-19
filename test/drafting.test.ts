import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { z } from 'zod';
import { runJson } from '../src/ai/client.ts';
import type { Env } from '../src/env.ts';
import { formatD1ExecScript } from '../src/util/sql.ts';
import { validateDraftQuality } from '../src/services/draftQuality.ts';
import { buildSafeFallbackDraft, improveDraftUntilSendable } from '../src/services/draftAutomation.ts';
import { renderDraftEmail } from '../src/services/emailRenderer.ts';
import { buildPersonalizationPlan } from '../src/services/personalization.ts';
import type { LeadRow } from '../src/types.ts';

function lead(values: Partial<LeadRow> = {}): LeadRow {
  return {
    id: 'lead-1', email: 'ada@ledger.example', domain: 'ledger.example', first_name: 'Ada',
    last_name: null, role: 'CTO', company: 'Ledger House', company_website: 'https://ledger.example',
    industry: 'Digital payments', sub_industry: 'Payment processing', segment: null, fit_score: 82,
    fit_reason: null, pain_points: null, source: 'manual', status: 'scored',
    last_reply_classification: null, notes: null, country: 'Nigeria', company_size: null,
    contact_profile_url: null, source_url: null, structured_notes: null, discovery_score: null,
    data_confidence: null, last_verified_at: null, sales_stage: 'prospecting', next_action: null,
    created_at: '', updated_at: '',
    ...values,
  };
}

const validBody = `Hi Ada,

I’m reaching out from Centrisec.

We help teams review access control and incident readiness in a practical way, so account permissions, response responsibilities, and useful next steps are easier to understand before any deeper assessment.

For fintech teams, these checks are relevant because customer data, transaction workflows, access control, and incident readiness all contribute to dependable service and customer trust.

I can send a short access control and incident readiness checklist that your team can review internally.

Would it be useful if I sent over the checklist for your team to review?

Best,
Centrisec Team`;

test('a complete fintech draft passes the conversion quality gate', () => {
  const row = lead();
  const strategy = buildPersonalizationPlan(row).strategy;
  const quality = validateDraftQuality('Practical fintech security checklist', validBody, row, strategy);
  assert.equal(quality.valid, true, quality.warnings.join('\n'));
  assert.ok(quality.word_count >= 80 && quality.word_count <= 140);
  assert.equal(quality.question_count, 1);
  assert.equal(quality.checks.length, 9);
  assert.ok(quality.checks.every((check) => check.passed));
});

test('safe automated fallback is sendable across every supported segment', () => {
  const cases = [
    ['Digital payments', 'CTO'],
    ['Healthcare clinic', 'CEO'],
    ['Education school', 'Administrator'],
    ['Logistics delivery', 'Operations Manager'],
    ['SaaS software platform', 'Founder'],
    ['Ecommerce marketplace', 'IT Manager'],
    ['Professional services consulting', 'Managing Director'],
    ['Manufacturing', 'Office Manager'],
  ] as const;
  for (const [industry, role] of cases) {
    const row = lead({ industry, sub_industry: null, role });
    const plan = buildPersonalizationPlan(row);
    const draft = buildSafeFallbackDraft(row, plan);
    const quality = validateDraftQuality(draft.subject, draft.body, row, plan.strategy);
    assert.equal(quality.valid, true, `${plan.strategy.segment}: ${quality.warnings.join(' ')}`);
    assert.equal(quality.question_count, 1);
  }
});

test('weak AI copy is repaired against its failed checklist', async () => {
  const row = lead();
  const plan = buildPersonalizationPlan(row);
  const result = await improveDraftUntilSendable({
    lead: row,
    plan,
    initialDraft: { subject: 'Security', body: 'Hi Ada,\n\nWe help companies reduce risk.' },
    repair: async ({ warnings, attempt }) => {
      assert.equal(attempt, 1);
      assert.ok(warnings.length > 0);
      return { subject: 'Practical fintech security checklist', body: validBody };
    },
  });
  assert.equal(result.quality.valid, true);
  assert.equal(result.auto_repaired, true);
  assert.equal(result.repair_attempts, 1);
  assert.equal(result.used_fallback, false);
});

test('persistent AI failures use a validated fallback after two bounded attempts', async () => {
  const row = lead({ industry: 'Business services', sub_industry: null, role: 'Office Manager' });
  const plan = buildPersonalizationPlan(row);
  const result = await improveDraftUntilSendable({
    lead: row,
    plan,
    initialDraft: { subject: '', body: '' },
    repair: async () => { throw new Error('model unavailable'); },
  });
  assert.equal(result.quality.valid, true, result.quality.warnings.join(' '));
  assert.equal(result.repair_attempts, 2);
  assert.equal(result.repair_failures, 2);
  assert.equal(result.used_fallback, true);
});

test('renderer fixes greeting and signoff without rewriting the message', () => {
  const rendered = renderDraftEmail(
    validBody.replace('Hi Ada,', 'Dear Ada,').replace('Best,\nCentrisec Team', 'Regards,\nCentrisec'),
    lead()
  );
  assert.match(rendered, /^Hi Ada,\n\n/);
  assert.match(rendered, /\n\nBest,\nCentrisec Team$/);
  assert.equal((rendered.match(/^Centrisec Team$/gm) ?? []).length, 1);
});

test('quality gate rejects thin copy, multiple questions, and unsupported sector claims', () => {
  const row = lead({ industry: 'Business services', sub_industry: null, role: 'Office Manager' });
  const strategy = buildPersonalizationPlan(row).strategy;
  const body = `Hi Ada,

I’m reaching out from Centrisec.

We help companies reduce risk.

For a SaaS company like yours, security can be useful.

I can send a proposal.

Can we book a demo? Should I send details?

Best,
Centrisec Team`;
  const quality = validateDraftQuality('Security solutions for your growing company', body, row, strategy);
  assert.equal(quality.valid, false);
  assert.match(quality.warnings.join(' '), /shorter than 80 words/);
  assert.match(quality.warnings.join(' '), /exactly one CTA/);
  assert.match(quality.warnings.join(' '), /SaaS company/);
  assert.match(quality.warnings.join(' '), /proposal/);
  assert.match(quality.warnings.join(' '), /vague filler/);
});

test('quality gate detects forbidden raw footer content even after normalization removes it', () => {
  const row = lead();
  const strategy = buildPersonalizationPlan(row).strategy;
  const raw = `${validBody}\n\n—\n\nCentrisec | Managed Cybersecurity\nOpt out: https://example.test/unsubscribe`;
  const rendered = renderDraftEmail(raw, row);
  assert.equal(rendered.includes('Opt out'), false);
  const quality = validateDraftQuality('Practical fintech security checklist', rendered, row, strategy, raw);
  assert.equal(quality.valid, false);
  assert.match(quality.warnings.join(' '), /unsubscribe URL/);
  assert.match(quality.warnings.join(' '), /system footer/);
  assert.match(quality.warnings.join(' '), /standalone em dash/);
});

test('draft prompt source carries structured strategy and strict repair requirements', () => {
  const plan = buildPersonalizationPlan(lead());
  assert.equal(plan.prospect.segment, 'fintech');
  assert.equal(plan.strategy.buyer_persona, 'cto');
  const promptSource = readFileSync(new URL('../src/ai/prompts.ts', import.meta.url), 'utf8');
  assert.match(promptSource, /exactly seven paragraph blocks/);
  assert.match(promptSource, /Never write the footer/);
  assert.match(promptSource, /failed mandatory quality checks/);
  assert.match(promptSource, /exact CTA/);
  assert.match(promptSource, /v4-auto-repair-drafting/);
  assert.match(promptSource, /Repair pass/);
});

test('dashboard reopens automatically repaired drafts with a sendability checklist', () => {
  const dashboard = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.match(dashboard, /if \(result\.repaired\)/);
  assert.match(dashboard, /Sendability checklist/);
  assert.match(dashboard, /Review the updated copy, then approve again/);
});

test('Gemini is the default and model calls stay on the named AI Gateway', () => {
  const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../src/ai/client.ts', import.meta.url), 'utf8');
  assert.match(config, /"DEFAULT_AI_MODEL": "google\/gemini-3\.5-flash"/);
  assert.match(config, /"AI_GATEWAY_ID": "outreach"/);
  assert.match(client, /ai\/v1\/chat\/completions/);
  assert.match(client, /cf-aig-gateway-id/);
  assert.match(client, /max_completion_tokens: completionBudget/);
  assert.match(client, /envelope\.result\?\.choices/);
  assert.doesNotMatch(client, /callModel\(env, model, messages, jsonSchema, maxTokens, false\)/);
});

test('Gemini calls unwrap the Cloudflare result envelope and reserve reasoning headroom', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      state: 'Completed',
      result: {
        choices: [{ message: { content: '{"value":"complete"}' }, finish_reason: 'stop' }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await runJson(
      {
        CF_ACCOUNT_ID: 'account',
        CF_AI_TOKEN: 'token',
        AI_GATEWAY_ID: 'outreach',
      } as Env,
      'google/gemini-3.5-flash',
      [{ role: 'user', content: 'Return JSON.' }],
      { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      z.object({ value: z.string() }),
      { maxTokens: 900 }
    );
    assert.deepEqual(result, { value: 'complete' });
    assert.equal(requestBody?.max_completion_tokens, 4096);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runtime schema convergence covers imported lead and reply fields', () => {
  const schema = readFileSync(new URL('../src/schema.ts', import.meta.url), 'utf8');
  const migration = readFileSync(
    new URL('../migrations/0007_production_schema_convergence.sql', import.meta.url),
    'utf8'
  );
  assert.match(schema, /country: 'country TEXT'/);
  assert.match(schema, /reply_ingest_logs/);
  assert.match(migration, /'replied_positive'/);
  assert.match(migration, /'needs_review'/);
  assert.match(migration, /messages_v7_backup/);
  const executable = formatD1ExecScript(migration);
  assert.ok(executable.split('\n').every((statement) => statement.endsWith(';')));
  assert.doesNotMatch(executable, /--/);
  assert.doesNotMatch(executable, /CREATE TABLE leads_v7 \(\n/);
});
