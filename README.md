# Centrisec Outreach

A controlled cold outbound prospecting system for Centrisec. It creates one personalized,
human-approved email per lead. It is not a newsletter, drip campaign, or automated follow-up system.

```text
gather leads
→ store leads in D1
→ score and personalize one email per lead
→ human review and approval
→ queue and send through Zoho
→ monitor replies through n8n
→ classify replies in the Worker
→ move positive replies into the next sales step
→ leave non-replies alone unless manually selected later
```

## Architecture

```text
n8n (lead intake, Zoho inbox monitor, team alerts, optional CRM sync)
   │  POST /api/leads                    POST /replies/ingest
   ▼                                             ▲
Cloudflare Worker + admin dashboard ── AI Gateway / Workers AI
   │                     │                    scoring, drafting,
   │                     │                    reply classification
   ▼                     ▼
  D1                Cloudflare Queue ──► Zoho Mail API
(source of truth)       (paced sending)      (approved mail only)
```

D1 owns leads, messages, model settings, reply/sales state, suppression, events, and counters.
The queue only performs approved delivery. n8n never owns lead state, sending limits, approval,
or suppression and never sends cold email directly.

## System flow

1. Lead intake validates and deduplicates business addresses, while allowing multiple contacts
   at one domain. Suppressed contacts are rejected immediately.
2. Deterministic segmentation assigns the prospect segment, buyer persona, likely security context,
   recommended offer, and one CTA before the AI is called. AI scoring records fit separately.
3. Drafting receives that structured strategy and writes exactly seven plain-text blocks: greeting,
   sender line, practical help, sector relevance, offer, one CTA, and the exact Centrisec signoff.
4. The Worker normalizes formatting and enforces an 80–140-word quality gate. One strict repair is
   attempted. A second failure is saved as `needs_review` with every warning visible in the dashboard.
5. A person edits and approves every email. Approved messages enter the queue; send-time gates
   re-check suppression, one-email-per-lead, time window, daily cap, and domain cap.
6. n8n watches Zoho and posts inbound replies to the Worker. The Worker applies deterministic
   opt-outs, classifies other replies, updates the next sales step, and creates reply drafts only.
7. Non-replies receive no automatic follow-up. Manual reactivation is the only way back into drafting.

## AI model selection

The dashboard **Settings** tab shows the provider, active model, fallback model, and configured choices.
The selection is stored in D1 under `config.active_ai_model` and is used for future lead scoring,
draft generation, and reply classification. Suggested replies are deterministic, review-only drafts.

```jsonc
"AI_PROVIDER": "cloudflare_ai_gateway",
"DEFAULT_AI_MODEL": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
"AVAILABLE_AI_MODELS": "@cf/meta/llama-3.3-70b-instruct-fp8-fast,@cf/meta/llama-3.1-8b-instruct-fast"
```

If the D1 selection is missing or no longer allowed, `DEFAULT_AI_MODEL` is used safely.

## Draft formatting and quality

`normalizeEmailBody()` in `src/util/text.ts` runs before drafts are saved and again before sending.
It normalizes line endings, creates readable paragraph breaks, separates greetings/CTA/signoff,
removes duplicate Centrisec signoffs, strips standalone em-dash separators, removes generated
footers, and removes visible unsubscribe URLs.

Draft validation rejects or regenerates bodies outside 80–140 words, missing paragraph structure,
multiple CTAs, sender/prospect confusion, unsupported startup/SaaS claims, unverified findings,
premature proposals, vague filler, duplicate signoffs, generated footers, standalone em dashes,
and unsubscribe URLs. Approval and send-now re-run the gate, so a failing draft cannot be sent.

The system appends the Centrisec HTML signature exactly once at send time. The signed HMAC
`/unsubscribe` endpoint and suppression logic remain available internally.

## Reply classification and next steps

The reply taxonomy is:

`positive_interest`, `meeting_request`, `asks_for_more_info`, `referral_to_colleague`, `not_now`,
`not_interested`, `remove_me`, `out_of_office`, `bounce_or_auto_reply`, and `unclear`.

Lead workflow statuses are `new`, `scored`, `drafted`, `approved`, `queued`, `sent`,
`replied_positive`, `meeting_requested`, `asked_for_more_info`, `referred`, `not_now`,
`not_interested`, `suppressed`, `unmatched_reply`, `manual_review`, and `failed`.

- Positive interest moves to `engaged`; meeting requests move to `meeting_requested`.
- More-info replies create a review-only reply draft and admin next action. Nothing auto-sends.
- Referrals create a potential lead when a valid, unsuppressed email address is present.
- `not_now` becomes `nurture_later`; no automatic follow-up is scheduled.
- `not_interested` becomes do-not-contact; `remove_me` suppresses immediately; hard bounces are suppressed.
- Out-of-office/automated replies take no action; unclear replies move to manual review.

When `REPLY_BASED_OPT_OUT_ENABLED=true`, direct phrases such as “no”, “not interested”, “remove me”,
“stop”, and “don’t contact me” are classified deterministically before AI. Removal requests and
complaints suppress immediately; not-interested replies enter a blocked do-not-contact status.

## n8n role

n8n imports leads from Sheets/forms/CSV, monitors the Zoho inbox, posts replies to the Worker,
notifies the team about positive replies, and can sync warm leads to a CRM. It must not send cold
emails, bypass approval/suppression, own lead state, or own sending limits.

Import the workflows in `n8n/`. Lead intake uses `Authorization: Bearer <API_KEY>`; reply ingest uses
`x-n8n-webhook-secret: <N8N_WEBHOOK_SECRET>`. Configure Zoho and team alerts, then replace the
workflow placeholders. See `n8n/README.md` for polling, retry, processed-message, and test steps.

## Setup

Prerequisites: Node 20+, pnpm, Cloudflare, Zoho Mail admin access, and optionally n8n.

```powershell
pnpm install
wrangler login
wrangler d1 create outreach-db
wrangler queues create outreach-send
wrangler queues create outreach-send-dlq

wrangler secret put API_KEY
wrangler secret put CF_AI_TOKEN
wrangler secret put ZOHO_CLIENT_ID
wrangler secret put ZOHO_CLIENT_SECRET
wrangler secret put ZOHO_REFRESH_TOKEN
wrangler secret put N8N_WEBHOOK_SECRET
wrangler secret put UNSUB_SECRET

pnpm db:migrate:remote
pnpm deploy
```

Set the Cloudflare resource IDs and non-secret vars in `wrangler.jsonc`. Follow
`docs/zoho-oauth-setup.md` for Zoho OAuth. Open `<PUBLIC_BASE_URL>/admin`, enter the API key,
and test with an address you control.

## Local development and verification

```powershell
Copy-Item .dev.vars.example .dev.vars
pnpm db:migrate:local
pnpm test
pnpm check
pnpm dev
```

Use `DRY_RUN=true` locally to exercise the full pipeline without sending real mail. Real AI calls
still need `CF_AI_TOKEN`.

## API

All admin/API routes require `Authorization: Bearer <API_KEY>` unless marked public. The dedicated
n8n endpoint uses `x-n8n-webhook-secret` instead.

| Endpoint | Purpose |
|---|---|
| `POST /api/leads` | Batch lead intake |
| `GET /api/leads` · `GET/PATCH /api/leads/:id` | Pipeline list and lead detail/actions |
| `POST /api/leads/:id/score` · `POST /api/leads/:id/draft` | Manual AI actions |
| `POST /api/pipeline/advance` | Run bounded score/draft batches |
| `GET /api/messages?status=review` | Human review queue, including `needs_review` |
| `PATCH /api/messages/:id` | Normalize and save an edited draft |
| `POST /api/messages/:id/approve` · `needs-review` · `reject` · `send-now` | Human review actions |
| `POST /replies/ingest` | n8n reply ingest; dedicated webhook-secret auth |
| `GET /api/replies` | Stored matched and unmatched replies |
| `GET /admin/replies/debug` · `GET /api/admin/replies/debug` | Recent ingest, matching, classification, and errors |
| `GET /api/admin/ai/models` · `POST /api/admin/ai/model` | Read/select the active AI model |
| `GET /admin/ai/models` · `POST /admin/ai/model` | Exact non-API aliases for model settings |
| `GET/POST/DELETE /api/suppression` | Suppression management |
| `GET /unsubscribe?l=&t=` | Public signed HMAC opt-out endpoint; not visible by default |
| `GET /health` | Public liveness check |

## Operations

- D1 is the source of truth; queue delivery is idempotent and re-checks every safety gate.
- `send_unknown` is never retried automatically. Confirm the Zoho Sent folder manually.
- A 15-minute sweeper recovers approved/queued work without bypassing controls.
- Keep initial volume conservative (`DAILY_SEND_CAP=10`) and verify SPF, DKIM, and DMARC.
