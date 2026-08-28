import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { z } from 'zod';
import { runJson } from '../src/ai/client.ts';
import type { Env } from '../src/env.ts';
import { formatD1ExecScript } from '../src/util/sql.ts';
import { extractEmailAddresses } from '../src/util/emailExtraction.ts';
import { parseLeadTable } from '../src/util/leadImport.ts';
import { validateDraftQuality } from '../src/services/draftQuality.ts';
import { buildSafeFallbackDraft, improveDraftUntilSendable } from '../src/services/draftAutomation.ts';
import { deliveryTestEnabled, priorOutboundBlocksDelivery } from '../src/services/deliveryTest.ts';
import { renderDraftEmail } from '../src/services/emailRenderer.ts';
import { buildPersonalizationPlan } from '../src/services/personalization.ts';
import type { LeadRow } from '../src/types.ts';
import { DEFAULT_OUTREACH_SETTINGS } from '../src/services/outreachSettings.ts';
import { isAuthorized } from '../src/auth.ts';

function lead(values: Partial<LeadRow> = {}): LeadRow {
  return {
    id: 'lead-1', email: 'ada@ledger.example', domain: 'ledger.example', first_name: 'Ada',
    last_name: null, role: 'CTO', company: 'Ledger House', company_website: 'https://ledger.example',
    industry: 'Digital payments', sub_industry: 'Payment processing', segment: null, fit_score: 82,
    fit_reason: null, pain_points: null, source: 'manual', status: 'scored',
    last_reply_classification: null, notes: null, country: 'Nigeria', company_size: null,
    contact_profile_url: null, source_url: null, structured_notes: null, discovery_score: null,
    data_confidence: null, last_verified_at: null, sales_stage: 'prospecting', next_action: null,
    delivery_test: 0,
    created_at: '', updated_at: '',
    ...values,
  };
}

const validBody = `Hi Mr. Ada,

I’m reaching out from Centrisec.

We help teams review access control and incident readiness in a practical way, so account permissions, response responsibilities, and useful next steps are easier to understand before any deeper assessment.

For fintech teams, these checks are relevant because customer data, transaction workflows, access control, and incident readiness all contribute to dependable service and customer trust.

I can send a short access control and incident readiness checklist that your team can review internally.

Would it be useful if I sent over the checklist for your team to review?

Best regards,`;

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

test('confirmed delivery tests bypass only prior sent history', () => {
  const row = lead({ delivery_test: 1 });
  assert.equal(deliveryTestEnabled(row), true);
  assert.equal(priorOutboundBlocksDelivery(true, 'sent'), false);
  assert.equal(priorOutboundBlocksDelivery(true, 'sending'), true);
  assert.equal(priorOutboundBlocksDelivery(true, 'send_unknown'), true);
  assert.equal(priorOutboundBlocksDelivery(false, 'sent'), true);
});

test('dashboard accepts the six-digit PIN without exposing API-key wording', async () => {
  const env = { API_KEY: 'machine-only-key' } as Env;
  const pinRequest = new Request('https://example.test/api/stats', {
    headers: { Authorization: 'Bearer 123419' },
  });
  const apiKeyRequest = new Request('https://example.test/api/stats', {
    headers: { Authorization: 'Bearer machine-only-key' },
  });
  assert.equal(await isAuthorized(pinRequest, env), true);
  assert.equal(await isAuthorized(apiKeyRequest, env), true);
  const dashboard = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.match(dashboard, /6-digit PIN/);
  assert.doesNotMatch(dashboard, /Enter the API key|placeholder="API key"/i);
});

test('public landing page is informational and does not collect credentials', () => {
  const landing = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(landing, /Centrisec Campaign Console/);
  assert.match(landing, /Open internal console/);
  assert.doesNotMatch(landing, /input|password|API key|PIN/i);
});

test('bulk lead text extraction keeps only unique email addresses', () => {
  const text = 'Abdul, abdul@example.com; Notes: Onome <ONOME@example.com>, invalid@, and abdul@example.com. Kelvin kelvin+test@sub.example.co.uk.';
  assert.deepEqual(extractEmailAddresses(text), [
    'abdul@example.com',
    'onome@example.com',
    'kelvin+test@sub.example.co.uk',
  ]);
});

test('structured TSV lead import preserves prospect fields and maps fit notes', () => {
  const table = [
    'first_name\tlast_name\tcompany\tcompany_domain\tposition\temail\tphone\tlocation\tlinkedin\tfit_note',
    'Mojisola\tOloge\tHydrogen\thydrogenpay.com\tChief Risk Officer\tologemo@hydrogenpay.com\t+234 802\tNigeria\t[LinkedIn](https://linkedin.com/in/mojisola)\tSenior risk leader at a Nigerian fintech',
  ].join('\n');
  assert.deepEqual(parseLeadTable(table), [{
    email: 'ologemo@hydrogenpay.com', firstName: 'Mojisola', lastName: 'Ologe', company: 'Hydrogen',
    companyWebsite: 'https://hydrogenpay.com', role: 'Chief Risk Officer', country: 'Nigeria',
    contactProfileUrl: 'https://linkedin.com/in/mojisola', notes: 'Phone: +234 802\nSenior risk leader at a Nigerian fintech',
  }]);
});

test('renderer fixes greeting and signoff without rewriting the message', () => {
  const rendered = renderDraftEmail(
    validBody.replace('Hi Mr. Ada,', 'Dear Ada,').replace('Best regards,', 'Regards,'),
    lead()
  );
  assert.match(rendered, /^Hi Mr. Ada,\n\n/);
  assert.match(rendered, /\n\nBest regards,$/);
  assert.equal((rendered.match(/^Centrisec Team$/gm) ?? []).length, 0);
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
  assert.match(schema, /delivery_test: 'delivery_test INTEGER NOT NULL DEFAULT 0/);
  assert.match(schema, /reply_ingest_logs/);
  assert.match(migration, /'replied_positive'/);
  assert.match(migration, /'needs_review'/);
  assert.match(migration, /messages_v7_backup/);
  const executable = formatD1ExecScript(migration);
  assert.ok(executable.split('\n').every((statement) => statement.endsWith(';')));
  assert.doesNotMatch(executable, /--/);
  assert.doesNotMatch(executable, /CREATE TABLE leads_v7 \(\n/);
});

test('draft page supports filtered selection and bulk approval sending', () => {
  const dashboard = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.match(dashboard, /draft-filter-company/);
  assert.match(dashboard, /draft-filter-industry/);
  assert.match(dashboard, /draft-filter-segment/);
  assert.match(dashboard, /draft-send-amount/);
  assert.match(dashboard, /Approve &amp; send selected/);
  assert.match(dashboard, /sendSelectedDrafts/);
  assert.match(dashboard, /\/messages\/\' \+ id \+ \'\/send-now/);
  assert.match(dashboard, /drafts-regenerate-all/);
  assert.match(dashboard, /draft-date-from/);
  assert.match(dashboard, /draft-view/);
  assert.match(dashboard, /allowDuplicates/);
});

test('custom email wording flows into the rendered draft and CTA strategy', () => {
  const settings = { ...DEFAULT_OUTREACH_SETTINGS, greeting: 'Goodday', fallbackGreeting: 'Goodday', signoff: 'Best regards', senderName: 'Gadu Abdul', cta: 'Can I send a proposal for your review?' };
  const prospect = lead();
  const plan = buildPersonalizationPlan(prospect, settings);
  const draft = buildSafeFallbackDraft(prospect, plan);
  assert.match(draft.body, /^Goodday Mr. Ada,/);
  assert.match(draft.body, /Can I send a proposal for your review\?/);
  assert.match(draft.body, /Best regards,\nGadu Abdul$/);
  assert.equal(validateDraftQuality(draft.subject, draft.body, prospect, plan.strategy, draft.body, settings).valid, true);
});

test('approving a green draft respects saved wording and does not re-block it after settings change', () => {
  const messages = readFileSync(new URL('../src/messages.ts', import.meta.url), 'utf8');
  assert.match(messages, /getOutreachSettings\(env\.DB\)/);
  assert.match(messages, /renderDraftEmail\(normalizeMultiline\(body\.body, 5000\), lead, settings/);
  assert.match(messages, /buildPersonalizationPlan\(lead, settings\)\.strategy/);
  assert.match(messages, /if \(message\.draft_quality_status === 'passed'\) return false/);
  assert.match(messages, /if \(requiresAutomatedRepair\(message, quality\)\)/);
});

test('outbound outreach copies the configured Centrisec inbox without changing the prospect recipient', () => {
  const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const sender = readFileSync(new URL('../src/sending.ts', import.meta.url), 'utf8');
  const provider = readFileSync(new URL('../src/zoho.ts', import.meta.url), 'utf8');
  assert.match(config, /"FROM_EMAIL": "info@centrisec\.com"/);
  assert.match(config, /"OUTREACH_CC_EMAIL": "info@centrisec\.com"/);
  assert.match(sender, /: env\.OUTREACH_CC_EMAIL;/);
  assert.match(sender, /effectiveSenderEmail\(settings, env\)/);
  assert.match(provider, /ccAddress: args\.cc\.trim\(\)/);
  assert.match(provider, /fromAddress: args\.from\?\.trim\(\) \|\| env\.FROM_EMAIL/);
  assert.match(provider, /toAddress: args\.to/);
});

test('settings expose a configurable sender and render the HTML footer inside a sandboxed preview', () => {
  const settings = readFileSync(new URL('../src/services/outreachSettings.ts', import.meta.url), 'utf8');
  const dashboard = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.match(settings, /senderEmail: string/);
  assert.match(settings, /senderEmail must be a valid email address/);
  assert.match(dashboard, /id="outreach-sender-email"/);
  assert.match(dashboard, /id="outreach-footer-preview"/);
  assert.match(dashboard, /sandbox=""/);
  assert.match(dashboard, /updateFooterPreview/);
});
