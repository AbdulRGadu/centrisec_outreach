import assert from 'node:assert/strict';
import test from 'node:test';
import { nextActionFor, planReply, suggestedReplyFor } from '../src/services/nextStepPlanner.ts';
import type { LeadRow } from '../src/types.ts';

const lead = { first_name: 'Ada' } as LeadRow;

test('positive interest produces a checklist next step and review-only reply', () => {
  const plan = planReply({
    classification: 'positive_interest', confidence: 0.94,
    summary: 'Asked for the checklist.', lead,
  });
  assert.equal(plan.next_action, 'send_checklist_or_offer_walkthrough');
  assert.equal(plan.sales_stage, 'engaged');
  assert.match(plan.suggested_reply, /^Hi Ada,/);
  assert.match(plan.suggested_reply, /15-minute walkthrough/);
  assert.match(plan.suggested_reply, /Best,\nCentrisec Team$/);
});

test('more-info reply contains three useful bullets and one soft CTA', () => {
  const reply = suggestedReplyFor('asks_for_more_info', lead);
  assert.equal((reply.match(/^- /gm) ?? []).length, 3);
  assert.equal((reply.match(/\?/g) ?? []).length, 1);
  assert.match(reply, /send the checklist first/);
});

test('negative and automated classes produce safe deterministic actions', () => {
  assert.equal(nextActionFor('not_now'), 'nurture_later');
  assert.equal(nextActionFor('not_interested'), 'do_not_contact');
  assert.equal(nextActionFor('remove_me'), 'suppress_immediately');
  assert.equal(nextActionFor('out_of_office'), 'no_action');
  assert.equal(nextActionFor('bounce_or_auto_reply'), 'update_email_status');
  assert.equal(nextActionFor('unclear'), 'manual_review');
});
