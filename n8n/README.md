# n8n reply monitor

n8n transports inbox data and notifications. The Worker remains the database of truth and owns matching, classification, suppression, lead status, approval, and sending.

## Zoho inbox polling workflow

1. Create an n8n credential named `n8n webhook secret` with header name `x-n8n-webhook-secret` and the same value as the Worker's `N8N_WEBHOOK_SECRET` secret.
2. Poll only the Centrisec inbox `INBOX` for unread messages every 2-5 minutes. Exclude `admin@centrisec.com`, delivery folders, and messages already carrying your `centrisec-processed` label. Fetch plain text plus `Message-ID`, `In-Reply-To`, and `References` headers.
3. POST each message to `https://<worker>/replies/ingest` using the payload below. Treat only an HTTP 2xx response with `ok: true` as success.
4. After that successful response, mark the Zoho message read and apply a `centrisec-processed` label. Never mark it processed before the Worker confirms storage.
5. Branch on the returned `classification` and `isPositive`. Notify the team for positive replies and `manual_review`; never send the suggested reply automatically.

```json
{
  "from_email": "prospect@example.com",
  "from_name": "Prospect Name",
  "subject": "Re: Security readiness checklist",
  "body": "Plain-text reply",
  "received_at": "2026-07-16T09:15:00Z",
  "message_id": "<unique-inbound-message-id@example.com>",
  "in_reply_to": "<outbound-message-id@centrisec.com>",
  "references": "<outbound-message-id@centrisec.com>",
  "raw_payload": {}
}
```

## Avoiding old-message loops

Use all three guards: unread-only polling, the `centrisec-processed` label, and the stable `message_id`. The Worker deduplicates `message_id`, so a retried delivery returns `duplicate: true` without creating a second reply.

For the bundled IMAP workflow, keep `postProcessAction` set to `nothing`. Add a final Zoho Mail node/API call after `POST /replies/ingest` to mark the message read. If your n8n version cannot defer IMAP read state, use a Schedule Trigger plus Zoho Mail API list/search nodes instead of the IMAP trigger.

## Retry and alerts

- Configure the ingest HTTP node for 5 attempts with a 5-second wait. Route its error output to an admin alert containing the Zoho message ID and n8n execution URL.
- Leave the message unread/unlabelled after the final failure. The next poll will retry it, and the Worker debug screen will show any request that reached the endpoint.
- For `positive_interest`, `meeting_request`, `asks_for_more_info`, or `referral_to_colleague`, alert the team with company, summary, recommended `next_action`, and a dashboard link.
- For `remove_me` or `not_interested`, do not send a follow-up; the Worker suppresses the address immediately.

## One-reply test

1. Send one approved test email to an address you control, then reply from that same address with: `Yes, please send the checklist.`
2. Run the n8n workflow once and confirm its ingest node returns `matched: true`, `classification`, `next_action`, and `duplicate: false`.
3. Open **Replies > Reply ingestion debug** in the dashboard. Confirm the attempt is authorized and matched, then confirm the reply appears under **Next Step**.
4. Run the same n8n item again. Confirm `duplicate: true` and only one dashboard reply remains.
