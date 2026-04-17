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
    collect["Collect competitor signals (web, news, G2, jobs, Wayback pricing, SEC 8-K, sitemap diff, Reddit, HN)"]
    analyze[Analyze with Claude + fact-check]
    score["Score signal richness (silent / normal / rich)"]
    select["Pick artifact: weekly-news (default) or deep-dive rotation (silent week)"]
    report["Generate HTML report (week-over-week diff + rolling 30-day momentum)"]
    validate[Pre-send validation gate]
    deliver["Deliver via Resend or SMTP"]
  end

  pull --> enrich --> copy --> push --> send
  click --> open --> verify --> slack
  reply -->|n8n webhook| gtm
  collect --> analyze --> score --> select --> report --> validate --> deliver
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
- `brief-app/scripts/generate-html-brief.js` — vertical-sample regenerator (signal-grounded). Renders a skim-path TOC in the header and the env-configurable analyst byline in the trust block near the footer. Also writes a mirror copy without hyphens (e.g. `elearning-brief.html` in addition to `e-learning-brief.html`) so cold-email URLs using either style resolve. The in-page "Book a Call" CTA is currently disabled — outbound asks live in the email body instead.
- `brief-app/scripts/generate-cold-email.js` — per-prospect cold-email generator: reads `public/<slug>-brief.json`, selects the sharpest signal matching the prospect's named competitor, drafts 3 variants (pattern-interrupt / helpful-frame / peer-reference) with a personalised brief URL, writes to `data/cold-emails/<industry>--<company>.md` (gitignored) and stdout
- `intelligence-engine/scripts/run-client.js` — orchestrator: collect → analyse → score richness → pick artifact → generate → validate → deliver
- `intelligence-engine/scripts/generate-report.js` — branches on artifact type: weekly briefing *or* silent-week deep-dive
- `intelligence-engine/scripts/signal-richness.js` — deterministic scoring that labels each week `silent` / `normal` / `rich`
- `intelligence-engine/scripts/artifact-selector.js` — picks `weekly-news` vs a rotating deep-dive topic; maintains `data/<client>/artifact-history.json`
- `intelligence-engine/scripts/collectors/reddit-monitor.js` — Reddit public JSON search (silent-week filler)
- `intelligence-engine/scripts/collectors/hackernews-monitor.js` — Hacker News via Algolia (silent-week filler)
- `intelligence-engine/scripts/collectors/sitemap-monitor.js` — weekly `/sitemap.xml` diff (silent-week filler, always produces something)
- `intelligence-engine/prompts/deep-dive-writer.txt` + `templates/report-deep-dive.html` — the silent-week artifact
- `intelligence-engine/scripts/collect-for-brief.js` — bridge helper that feeds the vertical-sample generator

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
- `ANTHROPIC_API_KEY` (needed by both the HTML brief generator and the per-prospect cold-email generator)

**Brief conversion surface (optional but recommended — full list in `brief-app/.env.example`):**

- `BRIEF_URL_BASE` — base URL the cold-email generator uses to build `?id=<company>` links. Defaults to `https://intel.nextbuildtech.com` (the production custom domain on the `might-x` Vercel project).
- `BRIEF_BRAND_NAME` — brand label shown in the colophon (default `MightX Competitive Intelligence`).
- `BRIEF_CTA_URL` — reserved for when the in-page "Book a Call" block is re-enabled. Currently unused by the renderer; setting it is harmless.
- `BRIEF_AUTHOR_NAME` / `BRIEF_AUTHOR_TITLE` / `BRIEF_AUTHOR_CREDENTIAL` / `BRIEF_AUTHOR_LINKEDIN` / `BRIEF_AUTHOR_AVATAR_URL` — named-analyst byline rendered in the trust block at the bottom of every brief. The whole block is suppressed if `BRIEF_AUTHOR_NAME` is blank. Setting these moves the brief from "anonymous AI tool" to "research note from a named operator" and is the single largest trust delta on cold-outbound conversion.

## `intelligence-engine/.env`

Required:

- `ANTHROPIC_API_KEY`

Email delivery — pick one driver (see `intelligence-engine/scripts/deliver.js`):

- Preferred (production past ~10 clients): `EMAIL_DRIVER=resend`, `RESEND_API_KEY`, `EMAIL_FROM` (verified domain), optional `EMAIL_FROM_NAME`, `EMAIL_REPLY_TO`.
- Fallback / local dev: `EMAIL_DRIVER=smtp` + `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_NAME`, `SMTP_FROM_EMAIL`.
- If `EMAIL_DRIVER` is unset, the driver auto-selects `resend` when `RESEND_API_KEY` is present, otherwise `smtp`.

Optional:

- `OPS_SLACK_WEBHOOK_URL` — if set, the pre-send validation gate (`scripts/validate-report.js`) posts a blocked-delivery alert here instead of failing silently.
- `SEC_EDGAR_USER_AGENT` — required by the SEC 8-K collector (SEC requires a descriptive UA). Only needed when any competitor has `secCik` or `secTicker` configured.
- `REDDIT_USER_AGENT` — descriptive UA for the Reddit JSON search collector (defaults to a generic MightX UA; override to silence abuse-detection rate-limits).
- `ROLLING_HISTORY_WEEKS` — how many prior `report-content-*.json` files to load for the 30-day momentum section. Default 8.
- `APIFY_API_TOKEN` — premium collectors (news full-text, LinkedIn, Glassdoor, etc.).
- Collector-specific keys and tuning knobs documented in `intelligence-engine/.env.example`.

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

### Vertical-sample brief generation (signal-grounded)

`brief-app/public/<vertical>-brief.html` is the top-of-funnel proof artifact referenced in cold outbound. It is regenerated from LIVE `intelligence-engine` collector output so every insight carries a dated source URL — prospects must be able to tell at a glance that the artifact is not a ChatGPT essay.

Two-step workflow:

1. From `intelligence-engine/`, run the bridge helper to collect fresh signals for the two vertical competitors:

```bash
cd intelligence-engine
npm run collect-for-brief -- "E-Learning" "Docebo" "Absorb LMS"
# writes → intelligence-engine/data/brief-signals/<industry-slug>.json
```

By default the script asks Claude to auto-resolve each competitor's website, G2 slug, and SEC ticker/CIK, then runs the nine free collectors (website, news, G2, jobs, Wayback pricing archive, sitemap, Hacker News, Reddit) plus the SEC 8-K collector when a ticker/CIK was resolved. Vendor profiles are cached to `data/_cache/vendor-profiles.json` so each vendor is only resolved once. Use `--no-auto` to skip the resolver entirely, or override a single field with `--a-website / --a-g2 / --a-ticker / --a-cik` (same pattern for `--b-*`). Uses a separate `brief-sample` client scope so it does not pollute real client snapshot state.

2. From `brief-app/`, regenerate the HTML. The generator auto-loads the matching signals JSON:

```bash
cd brief-app
npm run generate-html-brief -- "E-Learning" "Docebo" "Absorb LMS"
# writes → brief-app/public/<industry-slug>-brief.html (+ .json sidecar for debugging)
```

If the signals JSON is missing, the generator still runs but labels the output as SAMPLE mode (amber freshness strip). Always run the collector first before publishing.

The generator:

- asks Claude for structured JSON (not HTML) and renders it locally so the design is owned by the script;
- enforces at least one fully-worked talk track (no `[your X]` placeholders) so prospects see finished quality;
- emits a single confidence legend at the top and a full-phrase confidence label per insight ("High confidence" / "Medium confidence" / "Low confidence") — no repeated confidence paragraphs and no unexplained abbreviations for the reader;
- renders a "This Week's Signals", "Pricing Intelligence" (Wayback Machine diff), "SEC 8-K Filings" (EDGAR), comparison matrix, "Watch Next Week", and "Evidence Index" block.

Shortcut for the default pair (Docebo vs Absorb):

```bash
cd brief-app
npm run generate-html-brief:fresh
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

Validate a generated report without sending (the pipeline already calls this automatically before email; use standalone when debugging):

```bash
npm run validate <client-id>
npm run validate <client-id> <timestamp>   # e.g. 2026-04-14T06-00-00
```

Validation gate rules (hard failures block delivery):

For **weekly-news** artifacts (the default):

- `weekSummary` shorter than 40 characters
- zero competitor sections with `hasFindings: true`
- unfilled `{{PLACEHOLDER}}` tokens remaining in the final HTML
- final HTML shorter than 3,000 characters
- ≥ 50% of signals returned `fact_check_failed`

For **deep-dive** artifacts (silent-week fallback):

- `headlineQuestion` shorter than 30 characters
- `executiveAnswer` shorter than 60 characters
- fewer than 2 usable analysis sections (title present + body ≥ 100 chars)
- unfilled `{{PLACEHOLDER}}` tokens, or HTML shorter than 3,500 characters
- ≥ 50% of signals returned `fact_check_failed`

On a blocked report, `run-client.js` exits non-zero, keeps the HTML on disk, and (if `OPS_SLACK_WEBHOOK_URL` is set) posts an ops alert.

### Report continuity & 30-day momentum

Every Monday the generator auto-loads two things from `data/<client>/`:

1. **Most recent prior `report-content-*.json`** → Claude emits a "What Changed Since Last Week" section (`changesSinceLastWeek`), rendered just above the rolling momentum block.
2. **Rolling history** of the last `ROLLING_HISTORY_WEEKS` (default 8) prior reports → fed to Claude for a "30-Day Momentum" section (`rollingHistory`) covering recurring themes, momentum shifts, and competitors that were loud and have since gone silent.

The rolling-history block is backed by a deterministic local scan (`computeLocalPatterns` in `generate-report.js`) — counts of recurring competitor headlines and silent-week detection are computed in JS before the prompt, so the client-visible claims have verifiable provenance.

### Silent-week handling (signal richness → artifact switch)

Core idea: a quiet week should not produce a thin "not much happened" email. Instead the pipeline runs a deterministic richness score after analysis and, on silent weeks, swaps the weekly briefing for a **deep-dive** artifact grounded in the last 30-90 days of data.

Steps (implemented in `scripts/run-client.js`):

1. After `runAnalysis`, call `scoreSignalRichness(analyses)` from `scripts/signal-richness.js`. It labels the week as:
    - `rich`  — at least one trigger event, or score ≥ 14
    - `normal` — between 6 and 14
    - `silent` — score < 6 AND no trigger events
2. Call `selectArtifactType({ clientId, dataDir, richness, clientConfig })` from `scripts/artifact-selector.js`. This decides between:
    - `weekly-news` (default) — the full briefing
    - `deep-dive`              — a single-topic memo, rotated through a list so the client never sees the same deep-dive two silent weeks in a row
3. `generateReport(clientId, analyses, clientConfig, { artifactType, deepDiveTopic, richness })` either produces the standard report or uses `prompts/deep-dive-writer.txt` + `templates/report-deep-dive.html` to ship a deliberately different-looking artifact (dark indigo header, topic badge, amber "silent-week" strip note).

Deep-dive topics (rotated via `data/<client>/artifact-history.json`, override with `reportPreferences.deepDiveRotation` or pin with `reportPreferences.deepDiveFocus` in the client config):

- `positioning-teardown` — dissect one competitor's homepage, pricing, messaging from the collected evidence
- `pricing-forensics`    — 60-90 day Wayback + sitemap reconstruction of pricing moves
- `hiring-signals`       — jobs data synthesised into a roadmap read-through
- `scenario-essay`       — "if competitor X does Y in the next 90 days, how should sales respond"
- `meta-analysis`        — cross-competitor trends the client can cite on calls

Operator overrides in `config/clients/<slug>.json`:

```json
"reportPreferences": {
  "richnessThresholds": { "silent": 6, "normal": 14 },
  "forceArtifact":      "weekly-news",
  "deepDiveRotation":   ["positioning-teardown", "pricing-forensics", "meta-analysis"],
  "deepDiveFocus":      "positioning-teardown"
}
```

Artifact history for a client is kept in `data/<client>/artifact-history.json` (last 52 entries, one per run). The CLI console prints the tier, the richness reasons, and the chosen artifact every Monday.

### Signal collectors

**Always on, no API keys** (default for every client; opt-out via `additionalCollectors.<name>: false`):

- `website-monitor` — live homepage + key pages
- `news-monitor` — Google News RSS
- `g2-monitor` — G2 public search + listing pages
- `jobs-monitor` — careers pages
- `pricing-archive-monitor` — Internet Archive (Wayback Machine) CDX for `/pricing` + `/plans` over the last 90 days; diffs price tokens and plan names
- `sitemap-monitor` — `/sitemap.xml` (+ robots.txt + sitemap indexes); week-over-week URL diff grouped by top-level path. Almost always produces something even on silent weeks (new customers, blog posts, product pages).
- `hackernews-monitor` — Algolia HN Search API; last 30 days of stories about the competitor, score + comment floor
- `reddit-monitor` — Reddit public JSON search; last 30 days of posts about the competitor across all subs, ranked by score + comments

**Opt-in** (require configuration):

- `linkedin-monitor`, `glassdoor-monitor`, `github-monitor`, `crunchbase-monitor` — enabled via `additionalCollectors.<name>: true` on the client config
- `sec-filings-monitor` — enable with `additionalCollectors.secFilings: true`, add `secCik` (preferred) or `secTicker` on any public competitor; requires `SEC_EDGAR_USER_AGENT` in `.env`

Collectors write per-run snapshots into `data/<clientId>/snapshots/` so diffing (pricing pages, sitemaps, SEC filings, websites) is genuinely week-over-week, not a re-summary of identical data.

Client-facing retention surface (no code — see `intelligence-engine/docs/CLIENT-SLACK-CONNECT-PLAYBOOK.md`):

- Create a Slack Connect channel per client (`client-<slug>`) on signup.
- Post the Monday briefing summary in the channel in addition to email.
- Record the channel id in `config/clients/<slug>.json` under `slackConnect.channelId`.

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
- Check `OPS_SLACK_WEBHOOK_URL` channel for any validation-gate blocks; fix and re-run before the client notices.
- Post Monday briefing summaries into each Slack Connect channel (see `intelligence-engine/docs/CLIENT-SLACK-CONNECT-PLAYBOOK.md`) and triage inbound client asks by Friday.

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

## Intelligence report blocked by validation gate

- `run-client.js` exits non-zero and prints the failing check ids
- run `npm run validate <client-id>` to see the full check report against the last generated artifact
- common fixes: re-run after transient analysis failures; raise competitor count; expand `newsKeywords` so the analyst finds material; for unfilled `{{PLACEHOLDER}}` errors, it is a template bug — check `scripts/generate-report.js` `buildHTML()` wiring
- if the report is acceptable as-is, send manually via `node scripts/deliver.js` (or `npm run deliver`) after reviewing the HTML in `data/<client-id>/`

## Resend email delivery failed

- check `EMAIL_DRIVER` resolves correctly (`resend` only when `RESEND_API_KEY` is set, else `smtp`)
- verify `EMAIL_FROM` is on a domain you've verified in the Resend dashboard
- check Resend dashboard for per-message failures (bounces, reputation)
- fallback: set `EMAIL_DRIVER=smtp` temporarily to confirm the report itself is healthy

## Vertical-sample brief looks thin or says "Sample content"

- the amber freshness strip and "Sample content" label mean the generator did not find a matching signals JSON — you skipped step 1 (`collect-for-brief`)
- confirm `intelligence-engine/data/brief-signals/<industry-slug>.json` exists and was generated recently; slug is derived from the industry name, e.g. `E-Learning` → `e-learning.json`
- the generator also writes a `brief-app/public/<slug>-brief.json` sidecar — inspect it to see the exact JSON Claude returned and which sections were thin
- if sources arrays are empty, the Claude response did not cite the signal data; re-run once, or increase the max_tokens if you hit a truncation warning
- for public competitors, the Claude auto-resolver usually supplies `secTicker` / `secCik` automatically; if it missed one, pass `--a-ticker` / `--b-ticker` explicitly to force SEC 8-K collection

## Wayback Machine / SEC collector timing out

- both collectors fail soft — a failure returns a human-readable "could not check archive" / "EDGAR HTTP 5xx" row so the analyst still sees the attempt
- Wayback outages are common; if sustained, disable with `additionalCollectors.pricingArchive: false` until recovered
- SEC requires a descriptive `SEC_EDGAR_USER_AGENT` — bare browser UAs can be rate-limited

## Deep-dive artifact shipped when I expected a weekly briefing

- the pipeline prints the richness tier and reasons on every run; re-read the CLI output for the `Richness tier:` line
- if the week genuinely had thin signal (score < 6 with no trigger events), the deep-dive is the correct deliverable — do not roll back without a reason
- to force a weekly briefing even on a quiet week, set `"reportPreferences": { "forceArtifact": "weekly-news" }` in `config/clients/<slug>.json`; to force a deep-dive, set `forceArtifact: "deep-dive"`
- richness thresholds are tunable per client: `reportPreferences.richnessThresholds = { silent, normal }`
- deep-dive topic cycles through a rotation stored in `data/<client>/artifact-history.json` — pin a topic with `reportPreferences.deepDiveFocus` or customise the rotation with `reportPreferences.deepDiveRotation`

## Reddit / Hacker News collectors returning nothing

- both are free public APIs with no auth; empty results most often mean the competitor genuinely has no recent chatter (common for enterprise-only / unsexy B2B)
- Reddit 429s under load — the collector fails soft and the raw signal data string will say `Reddit returned N/M blocked or empty responses`; set `REDDIT_USER_AGENT` in `.env` to a more descriptive string to reduce rate-limits
- Hacker News (Algolia) is very reliable; if it returns `http_` errors, it is usually a transient Algolia blip

## Sitemap diff showing "first snapshot — no diff available yet"

- expected on week 1 of a client run; the collector writes `data/<client>/snapshots/<slug>-sitemap.json` so week 2 onwards produces a real added/removed URL diff
- if still empty on week 2+, the competitor's `/sitemap.xml` was unreachable — look for the `Attempts:` line in the raw signal data; the collector also tries `/sitemap_index.xml` and any `Sitemap:` entries in `/robots.txt`

---

## 10) Day-1 Quickstart Checklist

1. Configure all `.env` files (`gtm-engine`, `brief-app`, `intelligence-engine`).
2. Ensure `TRACKING_SIGNING_SECRET` is the same in `gtm-engine` and `brief-app`.
3. In `intelligence-engine/.env`, pick an email driver: either set `RESEND_API_KEY` + `EMAIL_FROM` (verified in Resend), or keep the SMTP_* block for Gmail/SMTP.
4. Optionally set `OPS_SLACK_WEBHOOK_URL` so validation-gate blocks reach you in real time.
5. Run GTM dry path: `pull-leads -> enrich -> generate-copy`.
6. Spot-check `copy-*.json` quality.
7. Push to Instantly (or export CSV).
8. Open a real tracked link and confirm Slack open alert includes recipient email.
9. Run `intelligence-engine` for one demo/client with `--no-email`. After two runs, confirm the "What Changed Since Last Week" section appears. After ~4 runs, confirm the "30-Day Momentum" section appears. If a run prints `Richness tier: silent`, verify the pipeline shipped a deep-dive artifact (dark indigo header + topic badge) rather than a thin weekly briefing, then send.
10. For any paying client, create a Slack Connect channel and follow `intelligence-engine/docs/CLIENT-SLACK-CONNECT-PLAYBOOK.md`.

---

## 11) Canonical Deep-Dive Docs

Use this file as the master map; use these for detailed implementation specifics:

- GTM details: `gtm-engine/README.md`
- Vertical CTA + brief alignment: `gtm-engine/docs/VERTICAL-BRIEF-AND-EMAIL.md`
- Brief hosting + tracking internals: `brief-app/README.md`
- Strategic + operational playbook: `intelligence-engine/START-HERE.md`
- Client Slack Connect workflow (Tier 1 retention lever): `intelligence-engine/docs/CLIENT-SLACK-CONNECT-PLAYBOOK.md`

