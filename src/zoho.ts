import type { Env } from './env';
import { isDryRun } from './env';

export type ZohoErrorKind = 'auth' | 'rate' | 'transient' | 'permanent';

export class ZohoError extends Error {
  kind: ZohoErrorKind;
  status: number;
  constructor(kind: ZohoErrorKind, status: number, message: string) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

// Per-isolate memo; D1 config row 'zoho_token' shares the cache across isolates.
let memo: CachedToken | null = null;

const REFRESH_MARGIN_MS = 120_000;

function tokenValid(t: CachedToken | null): t is CachedToken {
  return !!t && t.expiresAt - REFRESH_MARGIN_MS > Date.now();
}

async function refreshAccessToken(env: Env): Promise<CachedToken> {
  const body = new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN,
    grant_type: 'refresh_token',
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
  });
  const res = await fetch(`${env.ZOHO_ACCOUNTS_BASE}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => null)) as
    | { access_token?: string; expires_in?: number; error?: string }
    | null;
  if (!res.ok || !json?.access_token) {
    throw new ZohoError('auth', res.status, `Zoho token refresh failed: ${json?.error ?? res.status}`);
  }
  return {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

export async function getAccessToken(env: Env, force = false): Promise<string> {
  if (!force && tokenValid(memo)) return memo.token;

  if (!force) {
    const row = await env.DB
      .prepare(`SELECT value FROM config WHERE key = 'zoho_token'`)
      .first<{ value: string }>();
    if (row) {
      try {
        const cached = JSON.parse(row.value) as CachedToken;
        if (tokenValid(cached)) {
          memo = cached;
          return cached.token;
        }
      } catch {
        // fall through to refresh
      }
    }
  }

  const fresh = await refreshAccessToken(env);
  memo = fresh;
  await env.DB
    .prepare(
      `INSERT INTO config (key, value, updated_at) VALUES ('zoho_token', ?1, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(JSON.stringify(fresh))
    .run();
  return fresh.token;
}

function classifyStatus(status: number, zohoCode: string | number | undefined): ZohoErrorKind {
  if (status === 401 || zohoCode === 'INVALID_OAUTHTOKEN') return 'auth';
  if (status === 429) return 'rate';
  if (status >= 500) return 'transient';
  return 'permanent';
}

export interface SendMailResult {
  dryRun: boolean;
  providerMessageId: string | null;
  internetMessageId: string | null;
}

/**
 * Send one HTML email via the Zoho Mail API.
 * With DRY_RUN=true it logs and succeeds without touching the network -
 * used for local testing and safe production rehearsal.
 */
export async function sendMail(
  env: Env,
  args: { to: string; subject: string; content: string }
): Promise<SendMailResult> {
  if (isDryRun(env)) {
    const domain = args.to.slice(args.to.lastIndexOf('@'));
    console.log(`[dry-run] would send email to=***${domain} subject-length=${args.subject.length}`);
    return { dryRun: true, providerMessageId: null, internetMessageId: null };
  }

  const token = await getAccessToken(env);
  let res: Response;
  try {
    res = await fetch(`${env.ZOHO_MAIL_BASE}/api/accounts/${env.ZOHO_ACCOUNT_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fromAddress: env.FROM_EMAIL,
        toAddress: args.to,
        subject: args.subject,
        content: args.content,
        mailFormat: 'html',
        askReceipt: 'no',
      }),
    });
  } catch (err) {
    throw new ZohoError('transient', 0, `Zoho network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (res.ok) {
    const json = (await res.json().catch(() => null)) as
      | { data?: { messageId?: string | number; mailId?: string } }
      | null;
    return {
      dryRun: false,
      providerMessageId: json?.data?.messageId ? String(json.data.messageId) : null,
      internetMessageId: json?.data?.mailId ? String(json.data.mailId) : null,
    };
  }

  const json = (await res.json().catch(() => null)) as
    | { status?: { code?: number | string; description?: string }; data?: { errorCode?: string } }
    | null;
  const zohoCode = json?.data?.errorCode ?? json?.status?.code;
  const description = json?.status?.description ?? `HTTP ${res.status}`;
  throw new ZohoError(classifyStatus(res.status, zohoCode), res.status, `Zoho send failed: ${description}`);
}
