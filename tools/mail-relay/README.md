# Mail relay (Apps Script)

Sends the results emails for the Cloudflare backend. Separate from the exam `Code.gs`, which is not touched.

## Setup (once)

1. Sign in to Google with the account that sent the old results emails (so the sender address stays the same) and open https://script.google.com -> **New project**. Name it `exam-mail-relay`.
2. Replace the content of `Code.gs` with `tools/mail-relay/Code.gs` from this repo.
3. Choose a key: `openssl rand -hex 24` (keep the output, you need it twice).
4. In the project: **Project Settings** (gear) -> **Script Properties** -> **Add script property**: name `MAIL_RELAY_KEY`, value the key from step 3.
5. **Deploy** -> **New deployment** -> type **Web app**: *Execute as* **Me**, *Who has access* **Anyone**. Authorize when asked (it needs permission to send email). Copy the **Web app URL** (ends in `/exec`).
   - "Anyone" is required because the Worker has no Google identity. The key and the domain check are what protect it.
6. Open the `/exec` URL in a browser: it must answer `{"success":true,"service":"exam mail relay","remaining":...}`.

## Connect the Worker

From `cloudflare-backend/`:

```bash
# paste the SAME key as step 3 when prompted (it is not echoed)
npx wrangler secret put MAIL_RELAY_KEY
```

Then set `MAIL_RELAY_URL = "<the /exec URL>"` in `cloudflare-backend/wrangler.toml` and run `npx wrangler deploy`.

## Notes

- Quota: `MailApp` allows 100 recipients/day on a consumer Google account and 1,500 on Workspace. The exam never waits for email; when the quota runs out the attempts are marked `failed` and **Tools -> Resend result emails** sends them again after the quota resets.
- Emails are sent only after each student's exam deadline, a few per minute.
- Changing the script later: **Deploy -> Manage deployments -> edit -> New version**. Creating a new deployment changes the URL.
