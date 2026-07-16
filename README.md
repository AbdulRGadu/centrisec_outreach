# Centrisec Outreach

AI-assisted outbound prospecting and reply qualification for Centrisec. Not bulk email:
the system finds the right leads, writes **one** relevant, personalized first email per
lead, understands replies, and moves warm prospects toward a sales/demo conversation.

```
n8n (intake, reply monitor, alerts)
   │  POST /api/leads            POST /api/replies
   ▼                                   ▲
Cloudflare Worker ── Workers AI (via AI Gateway): scoring · drafting · classification
   │        │                          │
   D1       Cloudflare Queue ──► Zoho Mail API (send from admin@centrisec.com)
 (truth)      (paced sending)          │
   ▲                                   ▼
 Admin dashboard (/admin)        Replies land in Zoho inbox → n8n
```

## How it works

1. **Intake** — n8n (Google Sheets) or the dashboard POSTs leads. The Worker lowercases,
   validates, dedupes by email (same-domain contacts are allowed but flagged), and
   drops anything on the suppression list.
2. **Scoring** — a cron scores new leads with Workers AI against Centrisec's ICP:
   segment (fintech/healthcare/school/logistics/saas/enterprise/sme/other), fit 0-100,
   pain points. Low-fit leads stay put for human judgment.
3. **Drafting** — fit leads get one AI-drafted email following `context/email-guide.md`:
   industry-bridged, one differentiator, 120-180 words, plain text, no links.
4. **Human approval** — every email is reviewed in the dashboard (edit → approve).
   Nothing sends without a human clicking Approve. No exceptions.
5. **Sending** — approved emails go through a Cloudflare Queue. At send time the Worker
   re-checks suppression, the one-email-per-lead rule, the business-hours window
   (Mon-Fri 09-17 Lagos), the daily cap, and a per-domain weekly cap - then sends via
   the Zoho Mail API from a real mailbox.
6. **Replies** — n8n watches the Zoho inbox and POSTs replies back. AI classifies them
   (interested / wants_demo / more_info / referral / not_now / not_interested /
   remove_me / out_of_office / bounce / unclear); remove-me and bounces auto-suppress;
   positive replies get a suggested response (never auto-sent) and a Telegram alert.
7. **No auto follow-ups** — non-repliers stay inactive unless manually reactivated.

## The AI's knowledge lives in `context/*.md`

`company.md` (who Centrisec is + "Why Centrisec" differentiators + tone rules),
`services.md`, `segments.md` (per-industry systems, gaps, angles), `email-guide.md`
(the approved email structure and reference example).

These files are **bundled into the Worker at deploy** (see `rules` in `wrangler.jsonc`),
so the project is fully self-contained — copy this folder anywhere and it still works.
To change how emails read: edit the markdown, `pnpm deploy`. No code changes.
`pnpm context:pull` fetches the live site's `llms.txt` into `context/website-snapshot.md`
as editing reference (never read at runtime).

## Setup

Prereqs: Node ≥ 20, pnpm, a Cloudflare account (free plan works), Zoho Mail admin
access, and an n8n instance (only needed for intake/replies — the core works without it).

```powershell
pnpm install

# 1. Cloudflare resources
wrangler login
wrangler d1 create outreach-db          # paste database_id into wrangler.jsonc
wrangler queues create outreach-send
wrangler queues create outreach-send-dlq

# 2. AI Gateway (dashboard → AI → AI Gateway → Create): name it `outreach`
#    (or change AI_GATEWAY_ID). Create an API token with permissions
#    Account → Workers AI → Read + Edit. `wrangler whoami` shows the account id
#    for CF_ACCOUNT_ID in wrangler.jsonc.

# 3. Zoho OAuth - follow docs/zoho-oauth-setup.md, then set ZOHO_ACCOUNT_ID in wrangler.jsonc.

# 4. Secrets
wrangler secret put API_KEY             # long random string; used by dashboard + n8n
wrangler secret put CF_AI_TOKEN
wrangler secret put ZOHO_CLIENT_ID
wrangler secret put ZOHO_CLIENT_SECRET
wrangler secret put ZOHO_REFRESH_TOKEN
wrangler secret put UNSUB_SECRET        # e.g. openssl rand -hex 32

# 5. Fill remaining vars in wrangler.jsonc:
#    FROM_NAME (how you sign emails), PHYSICAL_ADDRESS (footer), PUBLIC_BASE_URL
#    (the worker's URL - update after first deploy), DAILY_SEND_CAP (start 10).

# 6. Database + deploy
pnpm db:migrate:remote
pnpm deploy
```

Open `<PUBLIC_BASE_URL>/admin`, enter the API key, add a test lead (your own address),
Score → Draft → review → Send now.

### n8n

Import the three files in `n8n/`. Create credentials: **Outreach API** (Header Auth:
name `Authorization`, value `Bearer <API_KEY>`), **Zoho IMAP** (see
`docs/zoho-oauth-setup.md` §5), **Telegram Bot**. Replace `OUTREACH_BASE_URL` and
`TELEGRAM_CHAT_ID` placeholders inside the workflows, then activate.

## Local development

```powershell
Copy-Item .dev.vars.example .dev.vars   # then edit
pnpm db:migrate:local
pnpm dev                                # http://127.0.0.1:8788/admin
```

`.dev.vars.example` defaults to `DRY_RUN=true`: the full pipeline runs (including queue
consumer and crons) but `sendMail` logs instead of emailing — safe end-to-end testing.
Real AI calls need a real `CF_AI_TOKEN` even locally (Workers AI is a REST call).
Trigger crons locally: `curl "http://127.0.0.1:8788/cdn-cgi/handler/scheduled?cron=*/15+*+*+*+*"`
(wrangler dev exposes scheduled handlers; alternatively POST /api/pipeline/advance).

## API (all `/api/*` need `Authorization: Bearer <API_KEY>`)

| Endpoint | Purpose |
|---|---|
| `POST /api/leads` | Batch intake `{leads:[{email, firstName?, lastName?, role?, company?, companyWebsite?, industry?, source?, notes?}]}` → per-row `inserted\|duplicate_email\|suppressed\|invalid` |
| `GET /api/leads?status=&segment=&q=&limit=&offset=` | Pipeline list |
| `GET /api/leads/:id` · `PATCH /api/leads/:id` | Detail (+messages/events/footer) · notes / `{action:'disqualify'\|'reactivate'}` |
| `POST /api/leads/:id/score` · `POST /api/leads/:id/draft` | Manual AI triggers (`{force:true}` overrides one-email rule) |
| `POST /api/pipeline/advance` | Run scoring+drafting batches now |
| `GET /api/messages?status=draft` | Review queue |
| `PATCH /api/messages/:id` | Edit draft |
| `POST /api/messages/:id/approve` / `reject` / `send-now` | Review actions |
| `POST /api/replies` | Reply ingest (n8n) → returns classification for alert routing |
| `GET /api/replies?classification=` | Replies list |
| `GET /api/stats` | Dashboard/digest numbers |
| `GET/POST/DELETE /api/suppression` | Opt-out list management |
| `GET /unsubscribe?l=&t=` | **Public** one-click opt-out (HMAC token) |
| `GET /health` | **Public** liveness |

## Compliance & deliverability (read before the first real batch)

- **Consent hygiene**: every email carries Centrisec's identity, a physical address,
  and a working unsubscribe link. Opt-outs, "remove me" replies, and bounces are
  suppressed immediately and permanently. `lead_events` is the audit trail. This is
  designed for NDPA-2023-conscious, CAN-SPAM-style B2B outreach: business addresses,
  relevant messaging, low volume.
- **Warm-up**: keep `DAILY_SEND_CAP=10` for the first ~2 weeks, then raise to 20.
  High relevance + low volume is the whole strategy.
- **DNS**: centrisec.com already sends via Zoho, so SPF/DKIM should exist. Verify
  DMARC before the first batch: `Resolve-DnsName -Type TXT _dmarc.centrisec.com`.
- **Zoho limits**: the Mail API has per-plan daily limits (hundreds/day — far above the
  cap here). Keep cold volume conservative; the value is in relevance, not reach.

## Operations notes

- **D1 is the source of truth; the queue is only a delivery kick.** Consumers re-check
  every gate at send time; a conditional `queued→sending` claim makes double-sends
  impossible; a 15-minute sweeper cron recovers stuck/lost work.
- **`send_unknown`** (yellow warning in the dashboard): a send crashed mid-flight and
  the outcome is unknown. Check the Zoho Sent folder, then either mark it resolved by
  suppressing/disqualifying, or reject-and-redraft. It is never retried automatically.
- **Queue fallback**: if Queues ever misbehaves, the sweeper + `send-now` path can run
  the whole flow without it (cron-drained outbox) — see `src/schedule.ts`.
- **Cost**: Workers AI at this volume is pennies; watch usage in the AI Gateway
  dashboard (gateway id `outreach`).
