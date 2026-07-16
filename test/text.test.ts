import assert from 'node:assert/strict';
import test from 'node:test';
import type { Env } from '../src/env.ts';
import type { LeadRow } from '../src/types.ts';
import {
  buildFooter,
  detectReplyOptOut,
  ensureFooter,
  latestReplyText,
  normalizeEmailBody,
  validateDraftQuality,
} from '../src/util/text.ts';

const env = {
  PHYSICAL_ADDRESS: 'Lagos, Nigeria',
  VISIBLE_UNSUBSCRIBE_URL_ENABLED: 'false',
} as Env;

const lead = {
  company: 'Prospect Limited',
  notes: null,
} as LeadRow;

test('normalizes a blob into readable plain-text paragraphs', () => {
  const result = normalizeEmailBody(
    'Hi Kelvin, I am reaching out from Centrisec. We help fintech teams review practical security controls. Would it be useful if I sent the checklist? Best, Centrisec Team'
  );
  assert.match(result, /^Hi Kelvin,\n\n/);
  assert.match(result, /\n\nWould it be useful if I sent the checklist\?\n\nBest,\nCentrisec Team$/);
});

test('removes em-dash separators, old footers, URLs, and duplicate signoffs', () => {
  const result = ensureFooter(
    env,
    'Hi Ada,\n\nA short note.\n\nWould a checklist help?\n\nBest,\nCentrisec Team\nCentrisec\n\n—\nCentrisec | Managed Cybersecurity\nLagos, Nigeria\nOpt out here: https://example.com/unsubscribe?x=1',
    'https://example.com/unsubscribe?x=1'
  );
  assert.equal((result.match(/Centrisec \| Managed Cybersecurity/g) ?? []).length, 1);
  assert.equal((result.match(/^—$/gm) ?? []).length, 0);
  assert.equal(result.includes('https://'), false);
  assert.match(result, /reply “no” and we will not contact you again\./);
});

test('removes every supported standalone separator', () => {
  const result = normalizeEmailBody('Hi Ada,\n\n—\n--\n___\n***\nA useful note.\n\nBest,\nCentrisec Team');
  assert.doesNotMatch(result, /^(?:—|--|___|\*\*\*)$/m);
});

test('visible URL is disabled by default', () => {
  assert.equal(buildFooter(env, 'https://example.com/unsubscribe?x=1').includes('https://'), false);
});

test('quality checks catch sender/prospect confusion and spam patterns', () => {
  const quality = validateDraftQuality(
    'An excessively long subject for a prospect email today',
    'Hi Ada,\n\nSince Centrisec operates in fintech, we found your company has a security gap. Act now.\n\nCan we call? Would you reply?\n\nBest,\nCentrisec Team',
    lead
  );
  assert.equal(quality.valid, false);
  assert.ok(quality.warnings.length >= 4);
});

test('reply opt-out detection is deterministic but avoids broad no matches', () => {
  assert.equal(detectReplyOptOut('No'), 'remove_me');
  assert.equal(detectReplyOptOut('No, thanks.'), 'remove_me');
  assert.equal(detectReplyOptOut('Please remove me from your list'), 'remove_me');
  assert.equal(detectReplyOptOut('Not interested, thanks'), 'not_interested');
  assert.equal(detectReplyOptOut('No problem, please send the checklist'), null);
});

test('quoted system footer cannot create a false opt-out', () => {
  const reply = latestReplyText(
    'Yes, please send the checklist.\n\nOn Thu, 16 Jul 2026 at 10:00, Centrisec wrote:\n> If this is not relevant, reply “no”.'
  );
  assert.equal(reply, 'Yes, please send the checklist.');
  assert.equal(detectReplyOptOut(reply), null);
});
