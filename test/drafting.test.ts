import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateDraftQuality } from '../src/services/draftQuality.ts';
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
});
