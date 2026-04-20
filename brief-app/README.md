# Brief App

Next.js app that hosts the HTML competitive brief used in cold-email CTAs.

Primary tracked URL format:

```txt
/brief?id={{leadId}}&trk={{signedTrackingToken}}
```

This app is designed to:

- Track link opens server-side
- Alert Slack in real time
- Render brief content by lead/company ID

The site root `/` redirects to the newest mirrored full report in `public/` (files named like `demo-salesloft-report-<timestamp>.html`). If none exist, it redirects to `/brief?id=salesloft`.

---

## Implemented Features

### 1) `/brief` tracking proxy (Next.js 16)

File: `proxy.ts`

- Intercepts requests to `/brief` and to static vertical briefs at `/<slug>-brief.html` (files from `npm run generate-html-brief`, e.g. `/elearning-brief.html`)
- `/elearning-brief/brief` (wrong but common) redirects to `/elearning-brief.html`, preserving query params (e.g. `?id=salesloft`).
- Requires valid `trk` token before Slack alerting (direct `?id=` hits are ignored for Slack)
- Logs:
  - `[ASSET OPENED] Lead ID: {id} at {timestamp}`
- Sends the same message to Slack via webhook (non-blocking)
- Slack payload includes the decoded recipient email from the token
- Appends source metadata when available (`utm_source`, `utm_campaign`)
- Suppresses duplicate events for the same `id+source+campaign` within 60 seconds
- Skips noisy non-human events (`HEAD`, prefetch headers, common bot user-agents)
- Returns `NextResponse.next()` so the page loads normally

**Slack is not proof the recipient clicked.** The signed `trk` token only encodes which *campaign email address* the link was generated for. Anyone who loads that URL (you QA-testing, a colleague, a forward, some inbox clients prefetching links) can trigger the same Slack event. Optional mitigations in `proxy.ts`:

- `TRACKING_SLACK_SKIP_RECIPIENTS` — comma-separated emails (same addresses as in the token). Those opens still log `[ASSET OPENED]` but do not post to Slack (use for test inboxes).
- `sq` query param — HMAC of the full `trk` value; generate with `node brief-app/scripts/print-slack-suppress-sig.mjs "<trk>"` and append `&sq=<output>` to preview without Slack noise.
- `TRACKING_SLACK_ATTRIBUTION_NOTE` — optional override for the disclaimer line appended to every Slack open message.

### 2) Real-time Slack alerting

Environment variable:

```txt
SLACK_WEBHOOK_URL=...
```

Proxy uses `event.waitUntil(...)` to avoid delaying page render.

### 3) Dynamic brief rendering

File: `app/brief/page.tsx`

- Normalizes incoming lead IDs (lowercase, spaces -> underscores)
- Loads all available report-backed briefs
- Falls back to seed data in `data/briefs.json`
- Falls back again to a safe placeholder view if no brief exists

### 4) Report-backed content loader

File: `lib/brief-loader.ts`

- Reads from `../intelligence-engine/data`
- Scans `demo-*` directories
- Loads latest `report-content-*.json` in each directory
- Maps data into brief UI fields:
  - `weekSummary`
  - `topAlert`
  - top 2 competitor summaries
  - recommended actions (from `enablementUpdate`, with fallback)

### 5) Vercel Web Analytics

The app includes `@vercel/analytics` on Next.js routes (for example `/`, `/brief`). Enable **Web Analytics** for the project in the Vercel dashboard to see aggregate visitors and pages.

**Exclude your own clicks (this browser only):** open your production site once with  
`?brief_analytics_opt_out=1` on any URL (for example  
`https://your-domain/brief?id=test&brief_analytics_opt_out=1`). That sets `localStorage` so the analytics script never loads on future visits from that browser.  
Alternatively in DevTools console:  
`localStorage.setItem('brief_analytics_opt_out','1'); location.reload()`.

Set `NEXT_PUBLIC_DISABLE_VERCEL_ANALYTICS=1` in Vercel to turn off analytics for all visitors.  
Analytics is disabled on `localhost` in the wrapper so local dev does not noise the project.

Plain static files under `public/` (for example `/cybersecurity-brief.html` served as a static asset without the Next.js shell) do not load this component; use the `/brief` flow or aggregate Vercel **edge** logs for those if needed.

Per-lead identification (who opened a tracked CTA link) continues to rely on the existing **Slack + signed `trk`** path in `proxy.ts`, not Vercel Analytics.

---

## Local Development

Install and run:

```bash
cd brief-app
npm install
npm run dev
```

### Generate a vertical static HTML brief (Claude)

From `brief-app`, with `ANTHROPIC_API_KEY` in `.env.local` or `.env`:

```bash
# Defaults: E-Learning, Docebo vs Absorb LMS → public/elearning-brief.html
npm run generate-html-brief

# Custom vertical + two competitors (slug = industry, e.g. cybersecurity-brief.html)
node scripts/generate-html-brief.js "Cybersecurity" "CrowdStrike" "SentinelOne"
npm run generate-html-brief -- "Cybersecurity" "CrowdStrike" "SentinelOne"
```

Requires **exactly three** quoted arguments for a custom run; otherwise the script prints usage and exits. From the repo root you can run: `node brief-app/scripts/generate-html-brief.js "Cybersecurity" "CrowdStrike" "SentinelOne"` (still uses `brief-app/.env` paths via `__dirname`).

Open:

- [http://localhost:3000/](http://localhost:3000/) — redirects to the latest `*-report-*.html` or `/brief?id=salesloft`
- [http://localhost:3000/brief?id=salesloft](http://localhost:3000/brief?id=salesloft)
- [http://localhost:3000/brief?id=apollo_io](http://localhost:3000/brief?id=apollo_io)
- [http://localhost:3000/brief?id=unknown_company](http://localhost:3000/brief?id=unknown_company)

---

## Data Sources and ID Mapping

### Preferred source: Intelligence reports

The loader maps folders to lead IDs:

- `intelligence-engine/data/demo-salesloft` -> `salesloft`
- `intelligence-engine/data/demo-acme-co` -> `acme_co`

Each folder contributes the newest `report-content-*.json`.

### Secondary source: Seed briefs

Static fallback data lives in:

- `data/briefs.json`

Useful for testing IDs that do not yet have report folders.

---

## Environment Variables

Create `brief-app/.env.local`:

```txt
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
TRACKING_SIGNING_SECRET=replace_with_shared_secret_used_in_gtm-engine

# Optional — comma-separated; opens for these recipient emails skip Slack (test leads)
# TRACKING_SLACK_SKIP_RECIPIENTS=you@company.com,qa@company.com

# Optional — custom disclaimer line in Slack (default is set in proxy.ts)
# TRACKING_SLACK_ATTRIBUTION_NOTE=Your note here
```

For production, set the same variable in Vercel project settings.

---

## Verify Tracking

1. Start dev server (`npm run dev`)
2. Open `/brief?id=test_lead`
3. Check server logs for:

```txt
[ASSET OPENED] Lead ID: test_lead at 2026-...
```

4. Confirm matching message appears in Slack

---

## Health Check Endpoint

Route:

- `/api/health/tracking`

Purpose:

- Sends a test tracking message to your Slack webhook
- Returns JSON with `ok`, `sentToSlack`, `status`, and the emitted message

Example:

- [http://localhost:3000/api/health/tracking](http://localhost:3000/api/health/tracking)

---

## Deployment (Vercel)

Yes — deploy `brief-app` as a normal Next.js app on Vercel so leads hit your production URL (e.g. `https://yourdomain.com/brief?id={{leadId}}&trk={{signedTrackingToken}}` or `https://yourdomain.com/elearning-brief.html?id=...&trk=...`). Open tracking runs in `proxy.ts` on the Edge: logs + Slack only when a valid tracking token is present and the request is not filtered as bot/prefetch.

### One-time setup

1. Push this repo to GitHub (already done if you use the same remote).
2. In [Vercel](https://vercel.com) → **Add New Project** → import the **MightX** repo.
3. Set **Root Directory** to `brief-app` (monorepo — do not leave blank or it will not find `package.json`).
4. Framework: **Next.js** (auto-detected). Build: default `next build`, Output: default.
5. **Environment variables** (Project → Settings → Environment Variables), at least for **Production**:
  - `SLACK_WEBHOOK_URL` — required for Slack alerts on opens.
  - `TRACKING_SIGNING_SECRET` — required to verify tracked links and decode recipient email for Slack.
  - `ANTHROPIC_API_KEY` — only if you ever run `generate-html-brief` from CI on Vercel (optional; most people run that script locally and commit `public/*-brief.html`).
6. **Deploy**. Note the production URL (e.g. `https://might-x.vercel.app`) or attach a **custom domain** (Project → Settings → Domains).

### Option B — Deploy from GitHub Actions (no local CLI login)

This repo includes `.github/workflows/deploy-brief-app.yml` (repo root). It runs on pushes to `main` that touch `brief-app/**` (and on **manual** *Run workflow*).

Add these **repository secrets** (GitHub → *Settings* → *Secrets and variables* → *Actions*):


| Secret              | Where to get it                                                            |
| ------------------- | -------------------------------------------------------------------------- |
| `VERCEL_TOKEN`      | [vercel.com/account/tokens](https://vercel.com/account/tokens)             |
| `VERCEL_ORG_ID`     | Vercel → Team → **Settings** → **General** → *Team ID*                     |
| `VERCEL_PROJECT_ID` | Vercel → **brief-app** project → **Settings** → **General** → *Project ID* |


Create the Vercel project once using **Option A** (dashboard, root `brief-app`) so a project exists to copy IDs from. After secrets are set, push to `main` or run the workflow manually — production deploy uses `vercel pull` → `vercel build` → `vercel deploy --prebuilt`.

> I cannot run interactive `vercel login` from this environment. If you prefer CLI-only: from `brief-app`, run `npx vercel login` once on your machine, then `npx vercel link` and `npx vercel --prod`.

### Deploy from this machine (script)

1. Add `VERCEL_TOKEN` to `brief-app/.env.local` ([create token](https://vercel.com/account/tokens)).
2. One-time: `cd brief-app` → `npx vercel link` (creates `.vercel/project.json`).
3. Deploy:

```bash
cd brief-app
npm run deploy:vercel
```

Preview (not production alias):

```bash
npm run deploy:vercel -- --preview
```

The script runs `npx vercel@latest deploy --prod --yes` with your env so it is non-interactive after link + token are set.

**If deploy says “Missing VERCEL_TOKEN” but you added it:** a root `brief-app/.env` file may have been loaded after `.env.local` and cleared the value. The script now loads `.env` first, then `.env.local` with override. Also use the exact name `VERCEL_TOKEN` (or `VERCEL_ACCESS_TOKEN`). Check for UTF-8 BOM or stray spaces around `=`.

**If you see `invalid-token-value` / “Must not contain `-`, `.`”:** you probably put `VERCEL_OIDC_TOKEN` (a JWT for GitHub Actions) into `VERCEL_TOKEN`. For local deploy, create a **Personal Access Token** at [vercel.com/account/tokens](https://vercel.com/account/tokens) and set `VERCEL_TOKEN=vcp_...` separately. Keep OIDC for Actions only.

**If you see `brief-app\\brief-app` / “path does not exist”:** the Vercel project’s **Root Directory** is set to `brief-app` (correct for GitHub on a monorepo). The CLI was resolving that on top of your current folder. The deploy script detects the Git repo root, writes a minimal `<repo>/.vercel/project.json`, and runs `vercel deploy` from the repo root. `/.vercel/` at the repo root is gitignored.

### After deploy — verify tracking

1. Open: `https://<your-deployment>/api/health/tracking` — JSON should show `sentToSlack: true` and a message should appear in Slack.
2. Open: `https://<your-deployment>/brief?id=test_deploy_lead` — check **Vercel** → project → **Logs** (filter runtime) for `[ASSET OPENED]` and confirm Slack.
3. If you use static vertical briefs: `https://<your-deployment>/elearning-brief.html?id=test_static` — same expectation (proxy matcher includes `*-brief.html`).

### Cold email links

Replace placeholder `https://yourdomain.com` in `gtm-engine/prompts/personalization.txt` with your **real** production origin (or the domain you attach in Vercel). The final per-recipient tracked URL is injected during `push-instantly` via `{{trackingUrl}}`.

### Report-backed `/brief` content (production)

`lib/brief-loader.ts` reads the latest `report-content-*.json` from `brief-app/data/<demo-folder>/` for each directory whose name starts with `demo-` (e.g. `data/demo-salesloft/`). That data is **mirrored automatically** whenever the Intelligence Engine runs `scripts/generate-report.js` (same run that writes `intelligence-engine/data/<clientId>/…`).

**Workflow for Vercel:**

1. On your machine (monorepo): run `node scripts/run-client.js demo-salesloft --no-email` (or any client id) from `intelligence-engine` — or any path that calls `generateReport`.
2. Commit the new files under `brief-app/data/<clientId>/` and `brief-app/public/<clientId>-report-*.html` if you want them deployed (or rely on CI that runs the pipeline and commits).
3. Deploy `brief-app` — `/brief?id=salesloft` resolves using `demo-salesloft` → lead id `salesloft`.

**Tracking UI** still renders for `?id=` even when no JSON matches (fallback UI), but Slack alerts now require a valid `trk` token.
