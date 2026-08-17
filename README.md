# Smart 1 Ads

Google Ads campaign operations, an AI campaign generator, an approval hub and
client-ready proposals — in one Node app that deploys to Render with no build step.

Microsoft Advertising (Bing) is **phase two**. Its routes are stubbed and clearly
marked so it slots in later without touching anything that already works.

---

## What it does today

| Area | Status |
|---|---|
| Google Ads OAuth (connect once, token persists) | Live |
| Account picker across your MCC | Live |
| Campaign list with spend, clicks, CTR, CPC, conversions, CPA | Live |
| Pause / enable / delete campaigns | Live |
| Drill into ad groups and keywords | Live |
| AI campaign generator (2–3 ad groups, 20–50 keywords each) | Live |
| Budget slider with sector CPC viability warnings | Live |
| Approval hub with comments and status workflow | Live |
| **Deploy an approved proposal into Google Ads** (budget, campaign, ad groups, keywords, RSAs, sitelinks, callouts, snippets, negatives) | Live — always created **PAUSED** |
| Dry run against Google's validator before deploying | Live |
| Client PDF proposal with match types hidden | Live |
| Audit log | Live |
| Smart 1 Team (Knack) client + budget sync | Live |
| Microsoft Advertising (Bing) | Phase 2 |

### Safety rails

- Everything deployed is created **paused**. Nothing this app writes can spend money
  until a human enables it.
- Deployment is one atomic `googleAds:mutate`. If any operation fails, Google rolls
  the whole thing back — you never get a half-built campaign.
- Only proposals marked **Approved** can deploy. Dry run works at any status.
- Enabling or deleting a campaign asks for confirmation and names the daily budget.
- The whole dashboard sits behind `APP_PASSWORD`. If you leave it blank the app runs
  open and shows a red warning banner on every screen.

---

## Local setup

```bash
npm install
cp .env.example .env      # then fill it in
npm start                 # http://localhost:3000
```

Two test commands, no live credentials needed:

```bash
npm run smoke             # 42 API assertions
npm i -D playwright && node scripts/ui-check.js   # headless walkthrough of every screen -> ./shots
```

---

## Environment variables

Set these in **Render → your service → Environment**.

| Variable | Where it comes from |
|---|---|
| `APP_PASSWORD` | You choose it. Everyone on the team types this to get in. |
| `SESSION_SECRET` | Any long random string. Render can generate it. |
| `OPENAI_API_KEY` | platform.openai.com → API keys |
| `OPENAI_MODEL` | Optional, defaults to `gpt-4o-mini` |
| `GOOGLE_CLIENT_ID` | Google Cloud Console → Credentials → OAuth client |
| `GOOGLE_CLIENT_SECRET` | Same screen |
| `GOOGLE_DEVELOPER_TOKEN` | Google Ads **manager** account → Tools → API Center |
| `GOOGLE_LOGIN_CUSTOMER_ID` | Your MCC id, digits only, no dashes |
| `GOOGLE_REDIRECT_URI` | `https://adbuilder.onrender.com/auth/google/callback` |
| `GOOGLE_REFRESH_TOKEN` | The app shows you this after you connect once — paste it back here |
| `GOOGLE_ADS_API_VERSION` | Defaults to `v25` (current as of Aug 2026) |
| `SMART1_TEAM_APP_ID` | Knack → Settings → API |
| `SMART1_TEAM_API_KEY` | Same screen |
| `SMART1_TEAM_OBJECT` | The Knack object holding client records, e.g. `object_3` |

Optional Knack field pinning if the auto-detection guesses wrong:
`SMART1_TEAM_FIELD_NAME`, `SMART1_TEAM_FIELD_BUDGET`, `SMART1_TEAM_FIELD_CUSTOMER_ID`.

---

## Google Cloud Console checklist

1. **APIs & Services → Library** → enable **Google Ads API**.
2. **APIs & Services → Credentials** → your OAuth 2.0 Client ID (type: Web application):
   - Authorised JavaScript origins: `https://adbuilder.onrender.com`
   - Authorised redirect URIs: `https://adbuilder.onrender.com/auth/google/callback`

   This must match `GOOGLE_REDIRECT_URI` character for character, trailing slash included.
3. **OAuth consent screen** → add your own Google account under **Test users** while the
   app is in Testing, or publish it. Scope needed: `https://www.googleapis.com/auth/adwords`.

---

## First run

1. Deploy to Render, set the env vars above (`GOOGLE_REFRESH_TOKEN` blank for now).
2. Open the app, sign in with `APP_PASSWORD`.
3. **Settings → Connect Google Ads.** Approve the Google consent screen.
4. The callback page shows your refresh token. Copy it into Render as
   `GOOGLE_REFRESH_TOKEN` and redeploy. This is what makes the connection survive restarts.
5. **Live campaigns** should now list real campaigns. If it does, the API path works
   end to end.
6. **Campaign generator** → build a proposal → **Approval hub** → review → Approve →
   **Dry run** → **Deploy**.

---

## The refresh-token thing (read this once)

Render's filesystem is wiped on every deploy and restart. The app writes the refresh
token to `./data/tokens.json` so it works immediately, but that file does not survive.
`GOOGLE_REFRESH_TOKEN` in the environment always wins over the file — set it and the
connection is permanent.

The same applies to proposals and audit logs: they live in `./data/*.json` and reset on
deploy. Attach a **Render Disk** mounted at `/opt/render/project/src/data` (and set
`DATA_DIR` to match) when you want them to stick, or swap `lib/store.js` for Postgres.

---

## Errors you will probably hit first

| Message | Fix |
|---|---|
| `redirect_uri_mismatch` | `GOOGLE_REDIRECT_URI` and the Cloud Console entry are not identical. |
| `DEVELOPER_TOKEN_NOT_APPROVED` | Token still in test mode — it only works against test accounts. |
| `USER_PERMISSION_DENIED` | The Google account you authorised has no access to that customer id, or `GOOGLE_LOGIN_CUSTOMER_ID` is not the manager above it. |
| `CUSTOMER_NOT_ENABLED` | Account is cancelled or not fully set up (no billing). |
| Google did not return a refresh token | That Google account already granted access. Revoke at `myaccount.google.com/permissions`, then connect again. |
| Blank campaign list, no error | Right account, no campaigns. Check the account picker. |

Every Google error is surfaced with its error code and the exact field path that
failed, so you can search the Google Ads API docs directly.

---

## Layout

```
server.js               Express app: auth gate, routes, error handling
lib/google-ads.js       OAuth, REST client, reads, status changes, full deploy
lib/campaign-ai.js      OpenAI generator + sector CPC viability engine
lib/knack.js            Smart 1 Team bridge
lib/store.js            JSON file persistence (tokens, proposals, audit)
public/index.html       Shell + import map
public/app.js           Preact dashboard - all screens
public/ui.js            Shared components, API client, formatters
public/styles.css       Theme
scripts/smoke.js        API test suite
scripts/ui-check.js     Headless browser walkthrough + screenshots
render.yaml             Render blueprint
```

No build step. Preact and htm are served straight out of `node_modules` through an
import map, so `npm install && node server.js` is the whole pipeline.

---

## Adding Bing later

The proposal format is platform-neutral, so phase two is two files:

1. `lib/bing-ads.js` — OAuth against `login.microsoftonline.com` with scope
   `https://ads.microsoft.com/msads.manage offline_access`, then the Campaign Management
   service (`AddCampaigns`, `AddAdGroups`, `AddKeywords`).
2. Swap the `/api/bing/*` 501 stub in `server.js` for real handlers.

The generator, approval hub, client proposal and audit log need no changes.
