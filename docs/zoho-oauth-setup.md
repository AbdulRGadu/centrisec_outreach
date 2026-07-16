# Zoho Mail API setup (one time)

The Worker sends cold emails from a real mailbox (`admin@centrisec.com`) through the
Zoho Mail API. That requires a Zoho OAuth "Self Client" and a refresh token. Budget
~10 minutes.

> Data centers: these instructions assume the mailbox lives on `zoho.com` (normal for
> Nigerian accounts — check the URL you use for webmail). If it's `zoho.eu` / `zoho.in`,
> use the matching `accounts.zoho.eu` / `mail.zoho.eu` etc., and update the
> `ZOHO_ACCOUNTS_BASE` / `ZOHO_MAIL_BASE` vars in `wrangler.jsonc`.

## 1. Create a Self Client

1. Log in to Zoho as the mailbox owner and open <https://api-console.zoho.com>.
2. Click **Get Started / Add Client** → choose **Self Client** → **Create**.
3. Copy the **Client ID** and **Client Secret**.

## 2. Generate a grant code and exchange it

1. In the Self Client screen, open the **Generate Code** tab.
2. Scope (exactly, comma-separated):
   `ZohoMail.messages.CREATE,ZohoMail.accounts.READ`
3. Time duration: 10 minutes. Description: `centrisec-outreach`. Click **Create** and
   copy the code — it expires quickly, do step 4 immediately.
4. Exchange the code for tokens (PowerShell):

   ```powershell
   $r = Invoke-RestMethod -Method Post -Uri "https://accounts.zoho.com/oauth/v2/token" -Body @{
     grant_type    = "authorization_code"
     code          = "<GRANT_CODE>"
     client_id     = "<CLIENT_ID>"
     client_secret = "<CLIENT_SECRET>"
   }
   $r
   ```

5. Save the `refresh_token` from the response somewhere safe. **It is shown only
   once** and does not expire unless revoked (Zoho caps ~20 refresh tokens per client —
   don't regenerate casually).

## 3. Find the mail account id

Using the `access_token` from the same response:

```powershell
Invoke-RestMethod -Uri "https://mail.zoho.com/api/accounts" -Headers @{
  Authorization = "Zoho-oauthtoken <ACCESS_TOKEN>"
} | ConvertTo-Json -Depth 5
```

Copy `data[0].accountId` → paste it into `ZOHO_ACCOUNT_ID` in `wrangler.jsonc`.

## 4. Store the secrets

```powershell
wrangler secret put ZOHO_CLIENT_ID
wrangler secret put ZOHO_CLIENT_SECRET
wrangler secret put ZOHO_REFRESH_TOKEN
```

For local testing, mirror the same three values in `.dev.vars` (and set `DRY_RUN=false`
only when you actually want local runs to send real email).

## 5. Prepare the inbox for n8n reply monitoring

1. Zoho Mail → **Settings → Mail Accounts → IMAP** → enable IMAP access.
2. Zoho **My Account → Security → App Passwords** → generate one named `n8n`.
3. In n8n, create an IMAP credential: host `imap.zoho.com`, port `993`, SSL on,
   user `admin@centrisec.com`, password = the app password.

## Troubleshooting

- `INVALID_OAUTHTOKEN` on every send → the refresh token was revoked or the scopes are
  wrong; redo steps 2-4.
- `Invalid Input` / 404 on send → wrong `ZOHO_ACCOUNT_ID` or wrong data-center base URL.
- Sends work but land in spam → check SPF/DKIM/DMARC for centrisec.com (see README
  "Deliverability") and keep the daily cap low while the domain warms up.
