import type { LeadRow } from '../types';
import { normalizeEmailBody, normalizeInlineText } from '../util/text.ts';

const TRAILING_SIGNOFF = /(?:\n\s*)+(?:Best|Best regards|Regards|Kind regards|Thanks|Thank you),?\s*\n+Centrisec(?: Team)?(?:\s*\n+Centrisec)?\s*$/i;

export function expectedGreeting(lead: Pick<LeadRow, 'first_name'>): string {
  const firstName = normalizeInlineText(lead.first_name, 80);
  return firstName ? `Hi ${firstName},` : 'Hello,';
}

export function normalizeDraftSubject(subject: string): string {
  return subject.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** Apply mechanical formatting only; semantic failures are left for validation/repair. */
export function renderDraftEmail(body: string, lead: Pick<LeadRow, 'first_name'>): string {
  let normalized = normalizeEmailBody(body).replace(TRAILING_SIGNOFF, '').trim();
  const blocks = normalized.split(/\n\s*\n/).filter(Boolean);
  if (blocks[0] && /^(?:hi|hello|dear)\b[^\n]*[,!]$/i.test(blocks[0])) blocks.shift();
  normalized = [expectedGreeting(lead), ...blocks, 'Best,\nCentrisec Team'].join('\n\n');
  return normalizeEmailBody(normalized);
}
