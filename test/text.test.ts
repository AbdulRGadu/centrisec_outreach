import assert from 'node:assert/strict';
import test from 'node:test';
import type { LeadRow } from '../src/types.ts';
import { validateDraftQuality } from '../src/services/draftQuality.ts';
import {
  buildFooter,
  detectReplyOptOut,
  ensureFooter,
  latestReplyText,
  normalizeEmailBody,
} from '../src/util/text.ts';

const lead = { company: 'Prospect Limited', notes: null } as LeadRow;

test('normalizes a blob into readable plain-text paragraphs', () => {
  const result = normalizeEmailBody(
    'Hi Kelvin, I am reaching out from Centrisec. We help fintech teams review practical security controls. Would it be useful if I sent the checklist? Best, Centrisec Team'
  );
  assert.match(result, /^Hi Kelvin,\n\n/);
  assert.match(result, /\n\nWould it be useful if I sent the checklist\?\n\nBest,\nCentrisec Team$/);
});

test('signature is appended as HTML and the body is HTML-escaped', () => {
  const result = ensureFooter('Hi Ada,\n\nWould <a checklist> help?');
  assert.match(result, /<table cellpadding="0"/);
  assert.match(result, /centrisec_fulllogo\.png/);
  assert.match(result, /Gadu Abdul/);
  assert.match(result, /CEO \| Centrisec Ltd/);
  assert.match(result, /Would &lt;a checklist&gt; help\?/);
  assert.equal(result.includes('Centrisec | Managed Cybersecurity'), false);
});

test('removes old footers and visible unsubscribe URLs before signing', () => {
  const result = ensureFooter(
    'Hi Ada,\n\nA short note.\n\nBest,\nCentrisec Team\n\nCentrisec | Managed Cybersecurity\nLagos, Nigeria\nOpt out here: https://example.com/unsubscribe?x=1'
  );
  assert.equal(result.includes('Opt out here'), false);
  assert.equal(result.includes('https://example.com/unsubscribe'), false);
  assert.equal((result.match(/centrisec_fulllogo\.png/g) ?? []).length, 1);
});

test('removes every supported standalone separator', () => {
  const result = normalizeEmailBody('Hi Ada,\n\n\u2014\n--\n___\n***\nA useful note.\n\nBest,\nCentrisec Team');
  assert.doesNotMatch(result, /^(?:\u2014|--|___|\*\*\*)$/m);
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
  const reply = latestReplyText('Yes, please send the checklist.\n\nOn Thu, 16 Jul 2026 at 10:00, Centrisec wrote:\n> If this is not relevant, reply \u201cno\u201d.');
  assert.equal(reply, 'Yes, please send the checklist.');
  assert.equal(detectReplyOptOut(reply), null);
});

test('signature markup is available for preview', () => {
  assert.match(buildFooter(), /abdul\.gadu@centrisec\.com/);
});
