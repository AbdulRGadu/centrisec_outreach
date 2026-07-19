import assert from 'node:assert/strict';
import test from 'node:test';
import { segmentLead } from '../src/services/leadSegmentation.ts';

test('segments a fintech technical buyer and selects a technical checklist', () => {
  const result = segmentLead({ industry: 'Fintech payments', contactRole: 'Chief Technology Officer' });
  assert.equal(result.segment, 'fintech');
  assert.equal(result.buyer_persona, 'cto');
  assert.equal(result.recommended_offer, 'access control and incident readiness checklist');
  assert.equal(result.recommended_cta, 'Would it be useful if I sent over the checklist for your team to review?');
  assert.ok(result.do_not_say.includes('SaaS company'));
});

test('uses founder CTA for SaaS without escalating to a meeting', () => {
  const result = segmentLead({ subIndustry: 'Software as a service', contactRole: 'Co-founder', source: 'manual' });
  assert.equal(result.segment, 'saas');
  assert.equal(result.buyer_persona, 'founder');
  assert.equal(result.recommended_cta, 'Would a short checklist like that be useful for your team?');
  assert.notEqual(result.recommended_offer, '15-minute security readiness walkthrough');
});

test('uses a walkthrough only when lead data indicates warm intent', () => {
  const result = segmentLead({ industry: 'Healthcare', contactRole: 'CEO', source: 'referral' });
  assert.equal(result.segment, 'healthcare');
  assert.equal(result.recommended_offer, '15-minute security readiness walkthrough');
  assert.equal(result.recommended_cta, 'Would a quick 15-minute walkthrough be useful?');
});

test('keeps a healthcare CEO offer consistent with the checklist CTA', () => {
  const result = segmentLead({ industry: 'Private hospital', contactRole: 'CEO', source: 'manual' });
  assert.equal(result.recommended_offer, 'patient data and staff access checklist');
  assert.match(result.recommended_cta, /short checklist/);
});

test('falls back safely for unknown industry and role', () => {
  const result = segmentLead({ companyName: 'Northpoint Limited' });
  assert.equal(result.segment, 'general_business');
  assert.equal(result.buyer_persona, 'unknown');
  assert.equal(result.recommended_offer, 'general security readiness checklist');
  assert.match(result.likely_security_context, /For growing teams/);
});
