import type { Env } from '../env';
import type { LeadRow } from '../types';

const SYSTEM_FOOTER_HEADING = 'Centrisec | Managed Cybersecurity';
const REPLY_OPT_OUT = 'If this is not relevant, reply \u201cno\u201d and we will not contact you again.';
const SIGNOFF_PATTERN = /^(best|best regards|regards|kind regards|thanks|thank you),?$/i;
const GREETING_PATTERN = /^(hi|hello|dear)\b[^\n]*[,!]$/i;

export interface DraftQualityResult {
  valid: boolean;
  warnings: string[];
}

export function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : '';
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function unsubscribeUrl(env: Env, leadId: string, token: string): string {
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  return `${base}/unsubscribe?l=${encodeURIComponent(leadId)}&t=${encodeURIComponent(token)}`;
}

export function visibleUnsubscribeUrlEnabled(env: Env): boolean {
  return env.VISIBLE_UNSUBSCRIBE_URL_ENABLED === 'true' || env.VISIBLE_UNSUBSCRIBE_URL_ENABLED === '1';
}

function stripSystemFooter(text: string): string {
  const index = text.toLowerCase().indexOf(SYSTEM_FOOTER_HEADING.toLowerCase());
  return index >= 0 ? text.slice(0, index).trimEnd() : text;
}

function removeVisibleUnsubscribeLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const value = line.trim();
      if (/https?:\/\/\S*(?:unsubscribe|opt[-_]?out)\S*/i.test(value)) return false;
      if (/opt out here\s*:/i.test(value)) return false;
      if (/if you(?:'|\u2019)d rather not receive emails/i.test(value)) return false;
      return true;
    })
    .join('\n');
}

function paragraphizeBlob(text: string): string {
  if (text.includes('\n\n')) return text;
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length > 2) return lines.join('\n\n');

  const source = lines.join(' ');
  const greeting = source.match(/^((?:hi|hello|dear)\b.*?[,!])\s+/i)?.[1] ?? '';
  let remainder = greeting ? source.slice(greeting.length).trim() : source;
  const signoffMatch = remainder.match(
    /\s+((?:Best|Best regards|Regards|Kind regards|Thanks|Thank you)),?\s+(.+)$/i
  );
  const signoff = signoffMatch ? `${signoffMatch[1]},\n${signoffMatch[2]}` : '';
  if (signoffMatch?.index !== undefined) remainder = remainder.slice(0, signoffMatch.index).trim();

  const sentences = remainder.match(/[^.!?]+[.!?]+(?:[\u201d\"])?|[^.!?]+$/g)?.map((s) => s.trim()) ?? [remainder];
  const paragraphs: string[] = [];
  for (let i = 0; i < sentences.length; i += 2) {
    paragraphs.push(sentences.slice(i, i + 2).join(' '));
  }
  return [greeting, ...paragraphs, signoff].filter(Boolean).join('\n\n');
}

/** Normalize a plain-text email before it is saved or sent. */
export function normalizeEmailBody(body: string): string {
  let text = body.replace(/\r\n?/g, '\n').trim();
  text = stripSystemFooter(text);
  text = removeVisibleUnsubscribeLines(text);
  text = text
    .split('\n')
    .filter((line) => !/^\s*(?:\u2014|--|___|\*\*\*)\s*$/.test(line))
    .join('\n');
  text = paragraphizeBlob(text);

  const rawLines = text.split('\n').map((line) => line.trimEnd());
  const output: string[] = [];
  let centrisecSignoffSeen = false;
  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line) {
      if (output.length && output[output.length - 1] !== '') output.push('');
      continue;
    }
    if (/^Centrisec(?: Team)?$/i.test(line)) {
      if (centrisecSignoffSeen) continue;
      centrisecSignoffSeen = true;
    }
    if ((GREETING_PATTERN.test(line) || SIGNOFF_PATTERN.test(line)) && output.length && output[output.length - 1] !== '') {
      output.push('');
    }
    output.push(line);
    if (GREETING_PATTERN.test(line) && output[output.length - 1] !== '') output.push('');
  }

  let normalized = output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const ctaMatch = normalized.match(/([^.!?\n]*\?)(?=\s*(?:\n|$))/g);
  if (ctaMatch?.length === 1) {
    const cta = ctaMatch[0]!.trim();
    normalized = normalized.replace(ctaMatch[0]!, `\n\n${cta}\n\n`).replace(/\n{3,}/g, '\n\n').trim();
  }
  return normalized;
}

export function buildFooter(env: Env, unsubUrl?: string): string {
  const lines = [SYSTEM_FOOTER_HEADING, env.PHYSICAL_ADDRESS, '', REPLY_OPT_OUT];
  if (visibleUnsubscribeUrlEnabled(env) && unsubUrl) lines.push('', `Opt out: ${unsubUrl}`);
  return lines.join('\n');
}

/** Replace any old/generated footer with the single system footer. */
export function ensureFooter(env: Env, body: string, unsubUrl?: string): string {
  const normalized = normalizeEmailBody(body);
  return `${normalized}\n\n${buildFooter(env, unsubUrl)}\n`;
}

function countCtas(body: string): number {
  const questions = (body.match(/\?/g) ?? []).length;
  const nonQuestionAsks = body
    .split(/\n+/)
    .filter((line) => /\b(?:let me know|reply if|schedule a|book a|send me)\b/i.test(line) && !line.includes('?')).length;
  return questions + nonQuestionAsks;
}

export function validateDraftQuality(subject: string, body: string, lead: LeadRow): DraftQualityResult {
  const warnings: string[] = [];
  const normalized = body.replace(/\r\n?/g, '\n').trim();
  const companyIsCentrisec = /^centrisec(?:\s|$)/i.test(lead.company ?? '');
  const hasVerifiedEvidence = /verified (?:scan|evidence)|scan evidence|confirmed finding/i.test(lead.notes ?? '');

  if (wordCount(subject) > 8) warnings.push('Subject is longer than 8 words.');
  if (/since Centrisec operates/i.test(normalized) && !companyIsCentrisec) {
    warnings.push('Centrisec is incorrectly described as the prospect.');
  }
  if (/https?:\/\/\S*(?:unsubscribe|opt[-_]?out)\S*/i.test(normalized)) {
    warnings.push('A visible unsubscribe URL is present.');
  }
  if (/^\s*(?:\u2014|--|___|\*\*\*)\s*$/m.test(normalized)) warnings.push('A standalone separator is present.');
  const paragraphs = normalized.split(/\n\s*\n/).filter(Boolean);
  if (paragraphs.length === 1 && wordCount(normalized) > 45) {
    warnings.push('The body is one large paragraph.');
  }
  if (wordCount(normalized) + 17 > 180) warnings.push('The body and system footer exceed 180 words.');
  if (countCtas(normalized) > 1) warnings.push('The body contains more than one CTA.');
  if (!hasVerifiedEvidence && /\b(?:you have|your company has|we found|we detected|is vulnerable|security gap at)\b/i.test(normalized)) {
    warnings.push('The body claims an unverified vulnerability or finding.');
  }
  if (/\b(?:guaranteed|limited time|act now|urgent(?:ly)?|final chance|immediately|before it(?:'|\u2019)s too late|costly incident)\b/i.test(normalized)) {
    warnings.push('The body contains fake urgency or spammy phrasing.');
  }
  const signoffs = normalized.split('\n').filter((line) => SIGNOFF_PATTERN.test(line.trim())).length;
  if (signoffs > 1) warnings.push('The body signs off more than once.');
  const centrisecBlocks = (normalized.match(/^Centrisec(?: Team)?$|^Centrisec \| Managed Cybersecurity$/gim) ?? []).length;
  if (centrisecBlocks > 1) warnings.push('The body includes multiple Centrisec signature or footer blocks.');

  return { valid: warnings.length === 0, warnings };
}

/** Keep only the newly written portion of a reply, excluding common quoted-history markers. */
export function latestReplyText(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const value = line.trim();
    if (/^On .+wrote:$/i.test(value)) break;
    if (/^-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}$/i.test(value)) break;
    if (/^From:\s+.+@.+$/i.test(value) && kept.some((item) => item.trim())) break;
    if (/^>/.test(value)) continue;
    kept.push(line);
  }
  return stripSystemFooter(kept.join('\n')).trim();
}

export function detectReplyOptOut(body: string): 'remove_me' | 'not_interested' | 'complaint' | null {
  const text = body.replace(/\s+/g, ' ').trim().toLowerCase();
  if (/\b(?:spam|report(?:ing)? you|complaint)\b/.test(text)) return 'complaint';
  if (/\b(?:not interested|no interest|isn['\u2019]?t relevant|not relevant)\b/.test(text)) return 'not_interested';
  if (/\b(?:remove me|unsubscribe me|stop emailing|stop contacting|do not (?:contact|email)|don['\u2019]?t (?:contact|email)|take me off)\b/.test(text)) {
    return 'remove_me';
  }
  if (/^(?:no(?:,?\s*(?:thanks|thank you))?|(?:please\s+)?stop(?:\s+please)?|unsubscribe)[.!\s]*$/.test(text)) return 'remove_me';
  return null;
}

export function looksLikeHardBounce(body: string): boolean {
  return /\b(?:mailer-daemon|delivery status notification|undeliverable|address not found|recipient rejected|user unknown|mailbox unavailable)\b/i.test(body);
}
