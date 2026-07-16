import type { Env } from '../env';

export function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : '';
}

export function wordCount(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

export function unsubscribeUrl(env: Env, leadId: string, token: string): string {
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  return `${base}/unsubscribe?l=${encodeURIComponent(leadId)}&t=${encodeURIComponent(token)}`;
}

const FOOTER_MARKER = '/unsubscribe?';

export function buildFooter(env: Env, unsubUrl: string): string {
  return [
    '--',
    'Centrisec | Managed Cybersecurity',
    env.PHYSICAL_ADDRESS,
    `If you'd rather not receive emails from us, opt out here: ${unsubUrl}`,
  ].join('\n');
}

/** Append the compliance footer unless one is already present. */
export function ensureFooter(env: Env, body: string, unsubUrl: string): string {
  if (body.includes(FOOTER_MARKER)) return body;
  return `${body.trimEnd()}\n\n${buildFooter(env, unsubUrl)}\n`;
}
