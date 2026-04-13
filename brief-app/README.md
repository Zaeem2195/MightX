# Brief App

Next.js app that hosts the HTML competitive brief used in cold-email CTAs.

Primary URL format:

```txt
/brief?id={{companyName}}
```

This app is designed to:

- Track link opens server-side
- Alert Slack in real time
- Render brief content by lead/company ID

---

## Implemented Features

### 1) `/brief` tracking proxy (Next.js 16)

File: `proxy.ts`

- Intercepts requests to `/brief` and to static vertical briefs at `/<slug>-brief.html` (files from `npm run generate-html-brief`, e.g. `/elearning-brief.html`)
- Reads `id` from query params
- Logs:
  - `[ASSET OPENED] Lead ID: {id} at {timestamp}`
- Sends the same message to Slack via webhook (non-blocking)
- Appends source metadata when available (`utm_source`, `utm_campaign`)
- Suppresses duplicate events for the same `id+source+campaign` within 60 seconds
- Skips noisy non-human events (`HEAD`, prefetch headers, common bot user-agents)
- Returns `NextResponse.next()` so the page loads normally

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

---

## Local Development

Install and run:

```bash
cd brief-app
npm install
npm run dev
```

Open:

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

## Deployment

Deploy on Vercel as a standard Next.js app.

Important:

- Ensure `SLACK_WEBHOOK_URL` is configured in Vercel
- Confirm proxy executes on `/brief`
- Validate logs and Slack alerts after deployment
