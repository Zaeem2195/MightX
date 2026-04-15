# MightX Master Runbook

Single source of truth to understand, run, and operate the full project:

- `gtm-engine` (outbound lead gen + Instantly handoff)
- `brief-app` (hosted brief pages + tracked open alerts)
- `intelligence-engine` (weekly competitive intelligence product delivery)

## Role-Based Quick Index

- Founder / Operator:
  - Start with: `10) Day-1 Quickstart Checklist` (5-10 min)
  - Then use: `5) Core Execution Workflows` (15-20 min), `8) Operations Cadence` (10 min), `9) Troubleshooting Quick Reference` (10 min)
- Sales / GTM Execution:
  - Start with: `5A) Outbound Workflow (gtm-engine)` (15-25 min)
  - Then use: `4) Environment Variables` (10-15 min) and `7) Signed Tracking Contract (Important)` (5-10 min)
- Engineer / Technical Maintainer:
  - Start with: `1) System Overview` (10 min), `2) Repo Structure` (10 min), `6) Deployment Workflow` (15 min)
  - Then use: `11) Canonical Deep-Dive Docs` (30-60 min) for module-level implementation details

---

## 1) System Overview

```mermaid
flowchart LR
  subgraph gtm [gtm-engine]
    pull[Pull leads from Apollo]
    enrich[Enrich lead context]
    copy[Generate AI copy]
    push[Push to Instantly or export CSV]
  end

  subgraph email [Instantly]
    send[Send outbound emails]
    click[Prospect clicks CTA]
    reply[Prospect replies]
  end

  subgraph brief [brief-app on Vercel]
    open[Open brief URL]
    verify[Verify signed trk token]
    slack[Slack open alert with recipient email]
  end

  subgraph intel [intelligence-engine]
    collect[Collect competitor signals]
    analyze[Analyze with Claude]
    report[Generate HTML report]
    deliver[Deliver recurring client reports]
  end

  pull --> enrich --> copy --> push --> send
  click --> open --> verify --> slack
  reply -->|n8n webhook| gtm
  collect --> analyze --> report --> deliver
```

What each app is for:

- `gtm-engine`: fills your own pipeline (prospects and outbound).
- `brief-app`: landing destination from outbound links, with secure open tracking.
- `intelligence-engine`: the core client deliverable you sell.

---

## 2) Repo Structure

- `gtm-engine/README.md`: GTM commands, flags, Instantly API vs CSV path.
- `gtm-engine/docs/VERTICAL-BRIEF-AND-EMAIL.md`: vertical brief + CTA alignment.
- `brief-app/README.md`: tracking behavior, Vercel deploy, health endpoint.
- `intelligence-engine/START-HERE.md`: business + operational playbook.

Primary code hotspots:

- `gtm-engine/scripts/1-pull-leads.js`
- `gtm-engine/scripts/2-enrich-leads.js`
- `gtm-engine/scripts/3-generate-copy.js`
- `gtm-engine/scripts/4-push-instantly.js`
- `gtm-engine/scripts/6-export-copy-csv.js`
- `brief-app/proxy.ts`
- `brief-app/app/brief/page.tsx`
- `intelligence-engine/scripts/run-client.js`
- `intelligence-engine/scripts/generate-report.js`

---

## 3) Prerequisites

- Node.js 18+
- Accounts/API access:
  - Apollo
  - Anthropic
  - Instantly (API only if using push API path)
  - Slack incoming webhook (optional but recommended)
  - n8n for webhook/automation workflows
  - Vercel for `brief-app` hosting

---

## 4) Environment Variables

## `gtm-engine/.env`

Required:

- `APOLLO_API_KEY`
- `ANTHROPIC_API_KEY`
- `INSTANTLY_API_KEY` (if using API push)
- `INSTANTLY_CAMPAIGN_ID` (if using API push)

Recommended:

- `GTM_BRIEF_CTA_BASE_URL` (e.g. `https://yourdomain.com`)
- `GTM_BRIEF_HTML_FILENAME` (e.g. `elearning-brief.html`)
- `GTM_REPORT_COMPETITOR_A`
- `GTM_REPORT_COMPETITOR_B`

Tracking security:

- `TRACKING_SIGNING_SECRET` (required for signed links)
- `TRACKING_TOKEN_TTL_SECONDS` (optional; default is 14 days)

Other:

- `N8N_WEBHOOK_URL`
- `SLACK_WEBHOOK_URL` (for reply workflow notifications)

## `brief-app` env (`.env.local` locally, project env in Vercel)

- `SLACK_WEBHOOK_URL`
- `TRACKING_SIGNING_SECRET` (must exactly match `gtm-engine`)
- `ANTHROPIC_API_KEY` (only needed to run HTML brief generation script)

## `intelligence-engine/.env`

- `ANTHROPIC_API_KEY`
- SMTP settings for report email delivery (host/user/pass/port and sender vars)
- Any collector-specific keys in `intelligence-engine/.env.example`

---

## 5) Core Execution Workflows

## A. Outbound Workflow (`gtm-engine`)

From `gtm-engine`:

```bash
npm install
npm run pull-leads
npm run enrich
npm run generate-copy
# review output in data/copy-*.json
npm run push-instantly
# OR: npm run export-copy-csv
```

One-command path:

```bash
npm run pipeline
```

Batching examples:

```bash
npm run generate-copy -- --file data/processed-companyindustry-e-learning-equals-batch.json
npm run generate-copy -- --first 500
npm run push-instantly -- --offset 500 --limit 500
npm run export-copy-csv -- --out data/batch-1.csv
```

Outputs in `gtm-engine/data/`:

- `leads-*.json`
- `enriched-*.json`
- `copy-*.json`
- `copy-export-*.csv`
- `push-log-*.json`

## B. Click Tracking + Slack Alerts (`brief-app`)

Expected link shape in emails:

```txt
https://<host>/<vertical>-brief.html?id=<leadId>&trk=<signedToken>
```

Behavior in `brief-app/proxy.ts`:

- ignores bot/prefetch/HEAD traffic
- verifies `trk` signature + expiration
- sends Slack alert only on valid token
- includes recipient email in Slack payload
- skips Slack silently if token missing/invalid/expired

Health check:

```txt
GET /api/health/tracking
```

## C. Client Delivery Workflow (`intelligence-engine`)

Onboard new client:

```bash
cd intelligence-engine
npm install
npm run onboard
```

Generate/review/send:

```bash
node scripts/run-client.js <client-id> --no-email
node scripts/run-client.js <client-id>
```

Run all active clients:

```bash
npm run all-clients
```

Optional reporting extras:

```bash
node scripts/generate-dashboard.js <client-id>
node scripts/generate-quarterly-summary.js <client-id>
```

---

## 6) Deployment Workflow

## Deploy `brief-app` to Vercel

1. Ensure branch is pushed.
2. In Vercel, set project root to `brief-app`.
3. Set env vars:
   - `SLACK_WEBHOOK_URL`
   - `TRACKING_SIGNING_SECRET`
4. Deploy.
5. Verify:
   - `GET /api/health/tracking` works
   - valid tracked URL triggers Slack
   - direct URL without `trk` does not trigger Slack

Local deploy script path (if used):

```bash
cd brief-app
npm run deploy:vercel
```

## Deploy code updates

- push to `main` for auto-deploy flows, or trigger manual Vercel/GitHub workflow if configured.

---

## 7) Signed Tracking Contract (Important)

The system now relies on signed tracking URLs:

- `gtm-engine/scripts/4-push-instantly.js` signs per-recipient payload and injects final URL into `{{trackingUrl}}`.
- `brief-app/proxy.ts` validates token before Slack alert.

If secrets mismatch between `gtm-engine` and `brief-app`, Slack open alerts will be skipped.

---

## 8) Operations Cadence (Recommended)

Weekly:

- Run one outbound batch (`gtm-engine`).
- Monitor reply-classification notifications (n8n/Slack).
- Validate brief open alerts for active campaigns.
- Run `intelligence-engine` client jobs and review outputs.

Monthly:

- review deliverability + sequence performance
- tighten ICP filters in `gtm-engine/config/icp.json`
- review client configs and competitor lists in `intelligence-engine/config/clients`

---

## 9) Troubleshooting Quick Reference

## No Slack open alerts

- confirm `TRACKING_SIGNING_SECRET` matches in both apps
- confirm links contain `trk=...`
- test `GET /api/health/tracking`
- confirm `SLACK_WEBHOOK_URL` exists in deployed `brief-app`

## Instantly push 401

- use valid Instantly API v2 key
- ensure `INSTANTLY_API_KEY` is raw key (script adds Bearer header)
- confirm `INSTANTLY_CAMPAIGN_ID` and workspace alignment

## CTA opens but wrong brief content

- verify `id` normalization expectations
- verify brief data exists/mirrors for that lead id
- check `brief-app/lib/brief-loader.ts` inputs

## Reply workflow not classifying

- confirm n8n webhook setup
- confirm classifier service endpoint availability (`5-classify-replies.js --serve` when required)

---

## 10) Day-1 Quickstart Checklist

1. Configure all `.env` files (`gtm-engine`, `brief-app`, `intelligence-engine`).
2. Ensure `TRACKING_SIGNING_SECRET` is the same in `gtm-engine` and `brief-app`.
3. Run GTM dry path: `pull-leads -> enrich -> generate-copy`.
4. Spot-check `copy-*.json` quality.
5. Push to Instantly (or export CSV).
6. Open a real tracked link and confirm Slack open alert includes recipient email.
7. Run `intelligence-engine` for one demo/client with `--no-email`, review, then send.

---

## 11) Canonical Deep-Dive Docs

Use this file as the master map; use these for detailed implementation specifics:

- GTM details: `gtm-engine/README.md`
- Vertical CTA + brief alignment: `gtm-engine/docs/VERTICAL-BRIEF-AND-EMAIL.md`
- Brief hosting + tracking internals: `brief-app/README.md`
- Strategic + operational playbook: `intelligence-engine/START-HERE.md`

