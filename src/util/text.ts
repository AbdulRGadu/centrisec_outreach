import type { Env } from '../env';

const SYSTEM_FOOTER_HEADING = 'Centrisec | Managed Cybersecurity';
const SIGNOFF_PATTERN = /^(best|best regards|regards|kind regards|thanks|thank you),?$/i;
const GREETING_PATTERN = /^(hi|hello|dear)\b[^\n]*[,!]$/i;

const EMAIL_SIGNATURE_HTML = `<table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial, Helvetica, sans-serif; color:rgb(7, 21, 39); font-size:14px; line-height:1.5">
    <tbody>
        <tr>
            <td style="padding-right:18px; vertical-align:middle; border-right:2px solid rgb(242, 178, 26)">
                <img src="https://centrisec.com/assets/centrisec_fulllogo.png" alt="Centrisec" width="150" style="display:block; width:150px; height:auto; border:0">
            </td>
            <td style="padding-left:18px; vertical-align:top">
                <div style="font-size:16px; font-weight:700; color:rgb(6, 27, 58)">Gadu Abdul<br></div>
                <div style="color:rgb(102, 112, 133); margin-bottom:6px">CEO | Centrisec Ltd<br></div>
                <div style="font-size:13px; color:rgb(6, 27, 58); margin-bottom:8px">Cybersecurity &amp; Human Risk Management&nbsp;<br></div>
                <div><a href="tel:+2349079887201" style="color:rgb(7, 21, 39); text-decoration:none" target="_blank">+234 907 988 7201</a><br></div>
                <div><a href="mailto:abdul.gadu@centrisec.com" style="color:rgb(7, 21, 39); text-decoration:none" target="_blank">abdul.gadu@centrisec.com</a><br></div>
                <div><a href="https://centrisec.com" style="color:rgb(6, 27, 58); text-decoration:none; font-weight:600" target="_blank">centrisec.com</a><br></div>
            </td>
        </tr>
    </tbody>
</table>
<div><br></div>`;

export function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : '';
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function normalizeInlineText(value: unknown, maxLength = 500): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function normalizeMultilineText(value: unknown, maxLength = 2_000): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim().slice(0, maxLength);
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

export function buildFooter(): string {
  return EMAIL_SIGNATURE_HTML;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!);
}

/** Convert the approved plain-text body into HTML and append the email signature. */
export function ensureFooter(body: string): string {
  const normalized = normalizeEmailBody(body);
  const htmlBody = escapeHtml(normalized).replace(/\n\n/g, '</p><p style="margin:0 0 16px">').replace(/\n/g, '<br>');
  return `<div style="font-family:Arial, Helvetica, sans-serif; font-size:14px; line-height:1.5; color:rgb(7, 21, 39)"><p style="margin:0 0 16px">${htmlBody}</p></div><br>${buildFooter()}`;
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
