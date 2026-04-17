# START HERE

## Your Complete Execution Playbook

> **New to the repo?** Open the top-level `../README.md` (MightX Founder Operating Manual) first — it's the one-page plain-language overview of what each app does, the three flows you actually run, and the URLs you need to remember. Come back here for the full client-onboarding and day-2 execution playbook.

This is the day-to-day execution guide for the `intelligence-engine` product (the weekly client deliverable). It tells you exactly what to do and in what order. When you want strategic context or deeper explanation, open `BUSINESS-OPERATIONS.md`. For **how the revenue tables are calculated, path conventions, and product/marketing caveats**, open `DOCUMENTATION-NOTES.md`. For **GTM details** (CLI flags, Instantly CSV vs API, cold-email prompt rules), open `gtm-engine/README.md`. For **hosted briefs, link tracking, and Slack alerts**, open `brief-app/README.md`. For the current highest-odds validation path, open `VALIDATION-PLAYBOOK-SALES-TECH.md`. For the **client Slack Connect retention surface** (the Tier 1 upgrade that makes month-3 renewals much easier), open `docs/CLIENT-SLACK-CONNECT-PLAYBOOK.md`.

---

## How the systems work together

```
GTM ENGINE  (C:\mightx\gtm-engine)
    Purpose: finds and contacts prospects for YOU
    Apollo → enrich → Claude writes cold email copy → Instantly sends → replies / discovery calls

BRIEF APP  (C:\mightx\brief-app)
    Purpose: hosted HTML brief + server-side open tracking for outbound CTAs
    Next.js on Vercel → /brief?id=… (and optional static HTML in public/) → proxy logs opens + Slack webhook
    Reads mirrored report JSON from brief-app/data/demo-* (written by intelligence-engine generate-report; see brief-app/README.md)

INTELLIGENCE ENGINE  (C:\mightx\intelligence-engine)
    Purpose: the service you sell to those clients
    n8n cron → scrape competitors → Claude analyses → HTML report emailed every Monday
    Outputs report-content-*.json + report-*.html under data/<client-or-demo-id>/
```

You use the GTM Engine to fill your own pipeline.
You use the Brief App so prospects can open a tracked sample brief (aligned with your cold-email CTA).
You sell clients access to the Intelligence Engine.

---

## Before You Do Anything — Accounts Checklist

You need these active with API access before running either system:


| Account             | What for                                    | Get API key from                          |
| ------------------- | ------------------------------------------- | ----------------------------------------- |
| Anthropic           | Claude — powers all AI writing and analysis | console.anthropic.com → API Keys          |
| Apollo.io           | Lead sourcing for your outbound             | Apollo → Settings → Integrations → API    |
| Instantly           | Sending your cold emails                    | Instantly → Settings → Integrations → API |
| Resend (recommended) | Deliverable client-report email past ~10 clients; per-client from-domain branding | resend.com → API Keys (free tier: 100/day, 3k/mo) |
| Gmail (or any SMTP) | Fallback report delivery for local dev / first clients | Google Account → Security → App Passwords |
| n8n (self-hosted)   | Orchestration and cron scheduling           | Already have this                         |
| Vercel (optional)   | Host `brief-app` (tracked `/brief` links)   | vercel.com — connect GitHub repo          |
| Slack Incoming Webhook — client brief opens (optional) | Brief open alerts from `brief-app` | Slack → Apps → Incoming Webhooks |
| Slack Incoming Webhook — ops alerts (optional) | `OPS_SLACK_WEBHOOK_URL` receives validation-gate blocks so bad reports never auto-send | Slack → Apps → Incoming Webhooks |
| Slack Connect (once you sign a client) | Two-way client delivery channel; pairs with the Monday email to create the "month-3 renewal" retention surface | Slack → Channel → Connect this channel |


Clay free account has no API — used manually for research only until upgraded.

---

## Phase 1 — Setup (Days 1–14)

### Step 1: Configure the GTM Engine (your outbound, to find clients)

```bash
cd C:\mightx\gtm-engine
cp .env.example .env
```

Open `.env` and fill in: `APOLLO_API_KEY`, `ANTHROPIC_API_KEY`, `INSTANTLY_API_KEY` (Instantly **API v2**), `INSTANTLY_CAMPAIGN_ID`

Edit `config/icp.json` — set your target buyers:

```json
{
  "titles": ["VP of Sales", "CRO", "Head of Sales Enablement", "VP of Product Marketing"],
  "employee_ranges": [{ "min": 50, "max": 300 }],
  "keywords": ["SaaS", "B2B"],
  "locations": ["United States"],
  "leadsPerRun": 50
}
```

### Step 2: Configure the Intelligence Engine (the product you sell)

```bash
cd C:\mightx\intelligence-engine
cp .env.example .env
```

Open `.env` and fill in:

- `ANTHROPIC_API_KEY` (required)
- **Email delivery — pick one driver:**
  - Resend (recommended past ~10 clients): `EMAIL_DRIVER=resend`, `RESEND_API_KEY`, `EMAIL_FROM` (must match a domain you've verified in Resend), optional `EMAIL_FROM_NAME`, `EMAIL_REPLY_TO`.
  - SMTP (local dev / first client): leave `EMAIL_DRIVER` blank and fill `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_NAME`, `SMTP_FROM_EMAIL`.
  - Auto-select: if `RESEND_API_KEY` is set the pipeline uses Resend; otherwise it uses SMTP. No code change needed when switching.
- Optional: `OPS_SLACK_WEBHOOK_URL` — if a report fails the pre-send validation gate, you get a Slack ping instead of a silent "client didn't get Monday email."
- Optional: `SEC_EDGAR_USER_AGENT` — only used when a public-company competitor is configured with `secCik` or `secTicker`.
- Optional: `APIFY_API_TOKEN` — activates premium collectors (news full-text, LinkedIn posts, Glassdoor). Everything else works free.

Per-client branding — if a client asks for a branded from-address, add to their `config/clients/<id>.json`:

```json
"email": {
  "fromName":  "Acme CI Brief",
  "fromEmail": "ci@acmecorp-brief.com",
  "replyTo":   "success@yourdomain.com"
}
```

### Step 3: Set up your sending domains (do this now — warmup takes 3–4 weeks)

- Buy 2 domains in Namecheap or Cloudflare (e.g. `trymightx.com`, `mightxhq.io`) — ~$24 total
- Add them to Instantly → Accounts → Add Sending Account
- Enable Instantly Warmup on both inboxes immediately
- Set up SPF, DKIM, DMARC on each domain (Instantly provides the DNS records)
- **Do not send cold email from these inboxes for 3–4 weeks**

### Step 4: Build the "Gold Standard" demo report + concierge fulfillment plan

Generate **one flawless demo report** for a well-known SaaS rivalry (`demo-salesloft` — Outreach vs Salesloft vs Gong vs Clari). This single HTML is your **core portfolio collateral**: use it on calls, in Looms, on LinkedIn, and in DMs. Invest time making it perfect — this artifact earns trust before anyone pays you.

```bash
cd C:\mightx\intelligence-engine

# Generate the Gold Standard
node scripts/run-client.js demo-salesloft --no-email

# Open and review — every finding must be defensible
# data/demo-salesloft/report-*.html
```

**Quality bar:** Review every finding. If anything reads like a generic AI summary or cites something you cannot verify, re-run or manually edit the HTML. This report represents the $2,500/month quality your service delivers.

**Zero premium API spend until first paying client.** The current free collectors (Google News RSS, careers pages, G2 search snippets, Crunchbase public data) already produce the quality shown in this report. Do **not** buy Proxycurl, BrightData, Exa, or any premium scraping API until revenue covers it.

**Concierge fulfillment — custom runs vs hosted sample brief**

Current outbound copy (`gtm-engine/prompts/personalization.txt`) uses a **delivery-assuming CTA** with a link like `https://yourdomain.com/brief?id={{companyName}}` (Instantly injects `{{companyName}}` per lead). That link hits **Brief App** (`brief-app`): server-side logging, optional Slack alert, and a page that reads the latest mirrored `report-content-*.json` from **`brief-app/data/demo-*`** when the `id` matches your folder naming convention (mirrors are written whenever `intelligence-engine/scripts/generate-report.js` runs — see `brief-app/README.md`).

1. **If they only clicked the link** (no reply yet): you already have an open signal in Slack / logs — follow up in sequence or manually.
2. **If they reply with interest** (or you promised a deeper custom run): create `config/clients/prospect-[name].json` with their 2–4 competitors (name, website, G2 slug if known).
3. Run: `node scripts/run-client.js prospect-[name] --no-email`
4. Review the HTML — manual QA is expected at this stage. Fix anything thin.
5. Send the HTML by Monday as promised (or attach / host as agreed). Time cost: ~30 min per prospect on your weekend.

The Gold Standard demo (`demo-salesloft`) remains **portfolio proof** and can power the **hosted** brief experience when IDs align; for a named prospect, still prefer a **custom** `run-client` output when you promised bespoke work.

**Vertical sample HTML (recommended before outbound):** Regenerate the public vertical-sample brief so it carries dated, sourced signals instead of reading like a ChatGPT essay. Two steps:

1. From `intelligence-engine/`: `npm run collect-for-brief -- "<Industry>" "<Competitor A>" "<Competitor B>" [--a-ticker SYM]` — runs the free collectors (website, news, G2, jobs, Wayback pricing, SEC 8-K if ticker/CIK provided) for an ad-hoc pair and writes `data/brief-signals/<slug>.json`. Uses a `brief-sample` scope so it does not pollute real client snapshot state.
2. From `brief-app/`: `npm run generate-html-brief -- "<Industry>" "<Competitor A>" "<Competitor B>"` — auto-loads the matching signals JSON and writes `public/<slug>-brief.html` plus a `public/<slug>-brief.json` sidecar. Shortcut for the default pair (Docebo vs Absorb): `npm run generate-html-brief:fresh`.

If step 1 is skipped the generator still runs but labels the artifact as "Sample content" in an amber freshness strip — do NOT link sample-mode briefs from cold outbound. Full runbook: `C:\MightX\MASTER-RUNBOOK.md` → *Vertical-sample brief generation*.

**After first paying client:** Their retainer funds premium API access (Proxycurl for LinkedIn enrichment, BrightData for deeper scraping). This improves ongoing weekly quality but is not required to close the first deal.

More detail: `VALIDATION-PLAYBOOK-SALES-TECH.md`. GTM copy rules: `gtm-engine/prompts/personalization.txt`. Brief hosting + tracking: `brief-app/README.md`.

### Step 5: Import n8n workflows

In your n8n instance:

1. Import `C:\mightx\intelligence-engine\n8n\intelligence-cron.json`
  - Update the Execute Command node path to your actual server path
  - Activate the workflow (fires every Monday 6am)
2. Import `C:\mightx\gtm-engine\n8n\gtm-reply-handler.json`
  - Set `SLACK_WEBHOOK_URL` in n8n environment variables
  - Activate

---

## Phase 2 — First Outbound (Days 14–30)

Your inboxes are now warm enough to start sending. Run your first outbound batch.

### Run the GTM Engine pipeline

```bash
cd C:\mightx\gtm-engine

# Pull 50 ICP-matched leads from Apollo
npm run pull-leads

# Enrich with personalization variables
npm run enrich

# Generate personalised copy with Claude (review before sending)
npm run generate-copy

# Open data/copy-*.json — spot check 5–10 emails for quality
# Then either push via API OR export CSV for manual Instantly upload:
npm run push-instantly
# — or, if you do not have Instantly API access (e.g. Starter plan):
npm run export-copy-csv
```

**Instantly Starter / no API:** use `**npm run export-copy-csv`** instead of `**push-instantly**`. It writes a UTF-8 CSV (`data/copy-export-*.csv`) with `email`, names, company, `ai_subject`, `ai_body`, `title` — upload that file under your campaign → Leads. Full steps and column mapping: `**gtm-engine/README.md**` → section *Instantly without API — CSV import*.

Optional **batching** (same flags as `gtm-engine/README.md`): e.g. `npm run generate-copy -- --first 500`, `npm run push-instantly` / `export-copy-csv` with `--file`, `--first`, `--offset` / `--limit`. Use `--max-leads` on `pull-leads` for large Apollo pulls.

Or run all steps at once (pauses for your review before sending):

```bash
npm run pipeline
```

Repeat every Wednesday. Target: 50 new leads per week, ~150 in the Instantly sequence at any time.

### Cold email angle that works

Do not pitch "competitive intelligence" as an abstract category. Lead with a specific pain. The live pipeline uses Claude with rules in `gtm-engine/prompts/personalization.txt`:

- **Prospect-first opener** (one verifiable detail — never invent facts).
- **Abstracted Authority** line after the opener (tier-1 engineering background + automated competitive intelligence engine for SaaS).
- Exactly **two real competitors** named in the body.
- **Delivery-assuming CTA** (no permission-then-link contradiction): baseline capture on those two ecosystems + Rep Talk Tracks framing, then the hosted link on its own line:
  - `https://yourdomain.com/brief?id={{companyName}}`
- **`{{companyName}}` must stay literal** in generated copy so Instantly merges it at send time (underscores/spaces per your Instantly variable setup).

**Deliverability:** Putting a URL in email 1 can hurt placement for some domains; many operators put the first link in step 2–3 of the Instantly sequence. See `gtm-engine/README.md` (*Cold Email Framework*) for the full prompt contract.

When they reply with interest (or you promised a bespoke run), **deliver that custom run** via `run-client.js` for the same competitors you named (or confirm on email if you were wrong). The hosted `/brief` link is for **tracked sample opens** and optional report-backed rendering — the **custom** HTML from the Intelligence Engine is still your deepest proof for serious buyers.

---

## Phase 3 — First Client (Days 30–60)

### Discovery call (15–30 min)

Goal: confirm pain, not pitch the service. Ask these four questions:

1. "When a competitor announces something, how does your team find out?"
2. "Have reps been caught off-guard by a competitor on a call recently?"
3. "Does anyone own competitive tracking consistently, or is it ad hoc?"
4. "If you knew every Monday what your top 5 competitors did last week — how would that change prep?"

Yes to #2 and no to #3 = buyer. Send proposal within 4 hours.

### Proposal email

Send a one-page email with:

- The custom report you sent them after their reply (or attach a fresh run for their exact competitors if the first was a quick portfolio demo)
- Tier options — **three price anchors** on the page keeps decisions simple: **Starter $800 | Growth $2,500 | Strategic $4,000** (mention **Standard $1,500** in one line if they are between Starter and Growth — full matrix is in `BUSINESS-OPERATIONS.md` Section 3)
- Annual option (15% off, e.g. "Growth annual = $2,125/mo")
- 30-day satisfaction guarantee

If they stall: generate a second live report for that Monday covering their actual competitors. Send it unsolicited. Closes 60–70% of stalled deals.

### Onboard the client (2 hours total)

```bash
cd C:\mightx\intelligence-engine

# Interactive onboarding — walks you through everything
npm run onboard

# It will ask:
# - Client name, email, tier, billing cycle
# - Their product description and ICP
# - Competitors (name, website, G2 slug, LinkedIn slug)
# - Report tone preference
# Then writes the config file and optionally runs first report
```

After onboarding, manually review the first report before it sends:

```bash
node scripts/run-client.js [client-id] --no-email
# Open data/[client-id]/report-*.html in browser
# Growth tier: same run also refreshes data/[client-id]/dashboard.html when includeDashboard is true
# Check: are findings relevant? are competitor names right? does tone fit?
# Second week onward, verify the "What Changed Since Last Week" section references real prior items.
# Week 4+: verify the "30-Day Momentum" section calls out recurring themes / quiet competitors that are only visible across weeks.
# Also watch the console for `Richness tier:` — on silent weeks (score < 6 with no trigger events) the pipeline produces a DEEP-DIVE artifact (dark indigo header, topic badge) instead of a weekly briefing. This is the correct behaviour; sample HTML lives in data/[client-id]/report-*.html like any other run.
# If all looks good:
node scripts/run-client.js [client-id]
```

Every run now passes through three automatic gates:

1. **Signal-richness scoring** (`scripts/signal-richness.js`) labels the week `silent` / `normal` / `rich` using trigger events, verified findings, breadth across competitors and signal types, with penalties for pipeline fallbacks / fact-check failures.
2. **Artifact selection** (`scripts/artifact-selector.js`) picks `weekly-news` (normal/rich weeks) or `deep-dive` (silent weeks), rotating through deep-dive topics via `data/<client>/artifact-history.json`.
3. **Pre-send validation gate** (`scripts/validate-report.js`) applies per-artifact-type rules. Weekly-news requires a non-trivial `weekSummary`, ≥ 1 competitor section with findings, HTML ≥ 3kB, no unfilled `{{PLACEHOLDER}}`, fact-check failure rate < 50%. Deep-dive requires `headlineQuestion` ≥ 30 chars, `executiveAnswer` ≥ 60 chars, ≥ 2 usable analysis sections, HTML ≥ 3.5kB. Blocking fails on either stops delivery, keeps the HTML on disk, and — if `OPS_SLACK_WEBHOOK_URL` is set — posts an ops alert.

Operator overrides live in `config/clients/<slug>.json` under `reportPreferences`:

```json
"reportPreferences": {
  "richnessThresholds": { "silent": 6, "normal": 14 },
  "forceArtifact":      "weekly-news",
  "deepDiveRotation":   ["positioning-teardown", "pricing-forensics", "meta-analysis"],
  "deepDiveFocus":      "positioning-teardown"
}
```

To inspect a blocked report manually or re-validate without re-running the full pipeline:

```bash
npm run validate [client-id]               # validates the most recent report
npm run validate [client-id] 2026-04-14T06-00-00   # validates a specific timestamp
```

**Slack Connect per client.** Once the first report is sent and the client is live, follow `docs/CLIENT-SLACK-CONNECT-PLAYBOOK.md` to create a shared `client-<slug>` channel. This is the Tier 1 retention upgrade from the productization plan — without it, month-3 feels like month-1 and churn risk spikes. Record the channel id in the config's `slackConnect.channelId` field.

The client is now live. The n8n cron handles every Monday from here.

---

## Phase 4 — Ongoing Operations (Every Week)

### Your weekly schedule


| When                    | What                                                                         | Time     |
| ----------------------- | ---------------------------------------------------------------------------- | -------- |
| **Monday morning**      | Check Slack — confirm n8n reports sent, no errors                            | 10 min   |
| **Monday (if trigger)** | Send personal 3-line email to client flagging the trigger event              | 5 min    |
| **Tuesday**             | Post one LinkedIn competitive intelligence insight (anonymised from reports) | 20 min   |
| **Wednesday**           | Run GTM Engine batch — 50 new leads                                          | 20 min   |
| **Thursday**            | Discovery calls, proposal follow-ups                                         | Variable |
| **Friday**              | Onboard new clients, review pipeline                                         | 0–2 hrs  |


**Total at 4 clients: ~4–5 hours/week.**

### When n8n reports an error

Check Slack. Common fixes:


| Error                             | Fix                                                                      |
| --------------------------------- | ------------------------------------------------------------------------ |
| G2 scraper returned empty         | G2 changed HTML — update selectors in `scripts/collectors/g2-monitor.js` |
| SMTP auth failed                  | Regenerate Gmail App Password → update `.env`                            |
| Resend API error                  | Confirm `EMAIL_FROM` matches a verified domain in Resend; check the Resend dashboard for per-message bounces |
| Validation gate blocked delivery  | `run-client.js` exits non-zero; run `npm run validate [client-id]` to see failing checks. Fix + re-run, or send manually via `npm run deliver` |
| Claude API rate limit             | Increase `DELAY` in `scripts/analyse.js` (line ~12)                      |
| Competitor website blocked scrape | Set that competitor's website to `null` temporarily in client config     |
| Wayback CDX timeout               | Transient; retries next week. To disable, set `additionalCollectors.pricingArchive: false` in the client config |
| SEC EDGAR HTTP error / rate limit | Set `SEC_EDGAR_USER_AGENT` with your real org + email; SEC rejects bare browser UAs |
| Reddit 429 / blocked              | Reddit rate-limits aggressive UAs. Set `REDDIT_USER_AGENT` in `.env` to a descriptive string; failing soft is fine, the richness scorer still has news / G2 / jobs / sitemap to work with |
| Deep-dive shipped on a week you expected a briefing | Check `Richness tier:` in the console — if the week genuinely had score < 6 with no triggers, deep-dive is correct. Override with `"reportPreferences": { "forceArtifact": "weekly-news" }` in the client config if you need to ship a weekly briefing anyway |
| Sitemap diff says "first snapshot" | Expected on week 1 of a client. Week 2 onwards produces a real added/removed URL diff grouped by top-level path |


---

## Phase 5 — Retention (Every Month/Quarter)

### Monthly (for Growth/Strategic clients)

Generate and attach the dashboard to each Monday email:

```bash
node scripts/generate-dashboard.js [client-id]
# Output: data/[client-id]/dashboard.html
# Host on Vercel or attach as link in Monday email
```

### Quarterly (all clients)

```bash
node scripts/generate-quarterly-summary.js [client-id]
# Defaults to previous quarter
# For a specific quarter:
node scripts/generate-quarterly-summary.js [client-id] --quarter Q1-2026
# Output: data/[client-id]/quarterly-summary-Q1-2026.html
```

Send the quarterly summary with a short personal note:

> "Here's everything we caught for you in Q1. If any of these influenced a deal outcome, I'd love to know — it helps me sharpen the system."

### Log win stories

When a client tells you the report helped close or protect a deal, open their config and add it:

```json
"retention": {
  "winStories": [
    "March 2026: Outreach pricing alert helped close $85k deal with Acme Corp"
  ]
}
```

Reference these at renewal time. One win story eliminates every renewal objection.

### Ask for referrals (month 4+)

> "Is there anyone in your network running a sales team in a competitive space who'd benefit from this? I'll run their first two weekly captures for free if they come through you."

Every referred client closes 3x faster and churns half as often.

---

## Revenue Milestones — What to Hit and When

These targets assume the **moderate** execution path in `BUSINESS-OPERATIONS.md` Section 7 (active outbound, referrals, annual contracts). The **conservative** scenario is slower — both are valid; see `DOCUMENTATION-NOTES.md` if you want to compare.


| Milestone             | Target month | How                                              |
| --------------------- | ------------ | ------------------------------------------------ |
| First paying client   | Month 2–3    | Outbound + custom baseline proof close           |
| ~$5,000 forward MRR   | Month 5–6    | e.g. 2× Growth + 1× Standard, or 3× blended tier |
| First annual contract | Month 4–6    | Offer 15% discount at proposal                   |
| ~$10,000 forward MRR  | Month 7–9    | ~4–5 clients at mixed tiers (not all Growth)     |
| First referral client | Month 4–5    | Ask every happy client at month 3                |
| ~$20,000 forward MRR  | Month 12–14  | 8–10 clients, referral flywheel running          |


---

## Key Commands Reference

### GTM Engine (`C:\mightx\gtm-engine`)

```bash
npm run pipeline          # Full outbound pipeline (pull → enrich → copy → push)
npm run pull-leads        # Step 1: Apollo lead pull only
npm run enrich            # Step 2: Enrich leads only
npm run generate-copy     # Step 3: Claude copy generation only
npm run push-instantly    # Step 4: Push to Instantly only (API; paid plans)
npm run export-copy-csv   # CSV for manual Instantly upload if you have no API (e.g. Starter)
npm run classify-reply    # Classify a reply (pipe text in)
```

Optional flags (pass after `--`; full table: `**gtm-engine/README.md**` → *CLI flags*):

```bash
npm run pull-leads -- --max-leads 500
npm run generate-copy -- --first 10
npm run generate-copy -- --offset 500 --limit 500
npm run push-instantly -- --file copy-2026-04-06T05-23-28.json
npm run push-instantly -- --first 10
npm run push-instantly -- --offset 10 --limit 500
npm run export-copy-csv -- --file copy-2026-04-06T05-23-28.json
npm run export-copy-csv -- --first 500 --out data/batch-1.csv
```

### Intelligence Engine (`C:\mightx\intelligence-engine`)

```bash
npm run onboard                                          # Onboard a new client interactively
node scripts/run-client.js [id]                          # Run full pipeline for one client (validates before sending)
node scripts/run-client.js [id] --no-email               # Run but don't send email (review first)
node scripts/run-client.js [id] --dry-run                # Collect signals only, no analysis
npm run all-clients                                      # Run all active clients (same as n8n cron)
npm run validate [id]                                    # Re-run the pre-send validation gate against the latest report
npm run validate [id] <timestamp>                        # Validate a specific report by timestamp
npm run deliver                                          # Send the latest report manually (after a validation block, when you've reviewed)
node scripts/generate-dashboard.js [id]                  # Regenerate dashboard for one client
node scripts/generate-dashboard.js --all                 # Regenerate dashboards for all clients
node scripts/generate-quarterly-summary.js [id]          # Generate Q summary (previous quarter)
node scripts/generate-quarterly-summary.js [id] --quarter Q2-2026   # Specific quarter
npm run collect-for-brief -- "<Industry>" "<A>" "<B>"                   # Signals bundle for the brief-app vertical sample. Claude auto-resolves website/G2 slug/SEC ticker (cached in data/_cache/vendor-profiles.json). Add --no-auto to skip the resolver; add --a-website / --a-g2 / --a-ticker / --a-cik (or --b-*) to override a single field. Writes → data/brief-signals/<slug>.json
```

### Brief App (`C:\mightx\brief-app`)

```bash
cd C:\mightx\brief-app
npm install
npm run dev                                              # Local Next.js — test /brief?id=…
npm run lint                                             # ESLint
npm run generate-html-brief -- "<Industry>" "<A>" "<B>"  # Renders public/<slug>-brief.html from signals JSON at ../intelligence-engine/data/brief-signals/<slug>.json (run `collect-for-brief` in intelligence-engine first). Falls back to sample mode (amber banner) if no signals are found.
npm run generate-html-brief:fresh                        # Shortcut: collect-for-brief + generate for the default E-Learning / Docebo vs Absorb pair
npm run generate-cold-email -- --industry "<Industry>" --prospect-name "<Name>" --prospect-company "<Company>" --competitor "<Competitor they fear>"
                                                         # Reads public/<slug>-brief.json, picks the sharpest matching signal,
                                                         # writes 3 cold-email variants to data/cold-emails/<industry>--<company>.md
                                                         # and prints them to stdout. Optional: --prospect-role, --brief-base, --sender-name.
```

**Production (Vercel):** step-by-step import, **Root Directory = `brief-app`**, env vars, post-deploy checks, and the report-data caveat are in **`brief-app/README.md`** → section *Deployment (Vercel)*. Set `SLACK_WEBHOOK_URL` in Vercel project settings. **Local:** `brief-app/.env.local` (gitignored) with `ANTHROPIC_API_KEY` for the HTML generator and `SLACK_WEBHOOK_URL` for open alerts.

**Brief conversion surface (set in `brief-app/.env.local`; see `brief-app/.env.example` for the full list):**
- `BRIEF_URL_BASE` — base URL the cold-email generator uses to build `?id=<company>` links (default `https://intel.nextbuildtech.com`).
- `BRIEF_BRAND_NAME` — brand shown in the colophon (default `MightX Competitive Intelligence`).
- `BRIEF_CTA_URL` — reserved for when the in-page "Book a Call" block is re-enabled. Currently unused by the renderer; outbound asks live in the email body, not on the brief page.
- `BRIEF_AUTHOR_NAME` — enables the named-analyst byline in the trust block at the bottom of the brief. **Leave blank to suppress the byline entirely.**
- `BRIEF_AUTHOR_TITLE` — role/affiliation shown next to the name (e.g. `Founder · MightX`).
- `BRIEF_AUTHOR_CREDENTIAL` — single serif-italic sentence of credibility proof.
- `BRIEF_AUTHOR_LINKEDIN` — absolute LinkedIn URL rendered as `Verify on LinkedIn →`.
- `BRIEF_AUTHOR_AVATAR_URL` — optional square headshot URL; falls back to a monogram of the initials.

Every brief also renders a small-caps table of contents in the header (`§ Sections`) with anchors to only the sections that actually exist for that run — no dead links on thin weeks.

**Observability:** `GET /api/health/tracking` — posts a test message to Slack and returns JSON status (see `brief-app/README.md`).

**Open tracking:** Requests to `/brief` run through `brief-app/proxy.ts` — logs `[ASSET OPENED] Lead ID: {id} at {timestamp}` and sends a formatted Slack message; bot/prefetch/HEAD traffic is filtered to reduce noise; short dedupe window per `id` + UTM keys.

---

## File Locations

```
C:\mightx\
├── gtm-engine\                  ← Your outbound system (finds clients for you)
│   ├── README.md                ← GTM commands, CLI flags, Instantly CSV vs API push
│   ├── prompts\personalization.txt  ← Claude cold-email rules (CTA, {{companyName}}, competitors)
│   ├── config\icp.json          ← Edit this to define who you're targeting
│   ├── scripts\                 ← Pipeline steps (incl. 6-export-copy-csv.js)
│   └── .env                     ← Your API keys (create from .env.example)
│
├── brief-app\                   ← Hosted briefs + link open tracking (Next.js / Vercel)
│   ├── README.md                ← /brief, proxy, Slack, report-backed rendering, health check
│   ├── proxy.ts                 ← Edge: log + Slack on /brief (filters + dedupe)
│   ├── app\brief\page.tsx       ← Dynamic brief UI by ?id=
│   ├── lib\brief-loader.ts      ← Loads latest report-content-*.json from data/demo-* (mirrored by IE generate-report)
│   ├── data\demo-*\             ← Mirrored JSON for /brief (written by intelligence-engine generate-report)
│   ├── public\*-report-*.html   ← Mirrored weekly HTML (same source; optional to link in email)
│   ├── scripts\generate-html-brief.js  ← Claude JSON → public/<slug>-brief.html (loads intelligence-engine/data/brief-signals/<slug>.json; sample mode if missing)
│   ├── public\                  ← Static assets + generated *-brief.html files
│   └── .env.local               ← ANTHROPIC_API_KEY, SLACK_WEBHOOK_URL (not committed)
│
└── intelligence-engine\         ← The product you sell
    ├── START-HERE.md            ← This file
    ├── BUSINESS-OPERATIONS.md   ← Strategy, pricing, projections (read once)
    ├── DOCUMENTATION-NOTES.md   ← Projection conventions, paths, caveats
    ├── docs\
    │   └── CLIENT-SLACK-CONNECT-PLAYBOOK.md  ← Per-client retention surface (Tier 1)
    ├── config\clients\          ← One JSON file per client (plus slackConnect + optional email/reportPreferences blocks)
    ├── prompts\
    │   ├── report-writer.txt    ← Weekly briefing prompt (emits changesSinceLastWeek + rollingHistory)
    │   └── deep-dive-writer.txt ← Silent-week deep-dive prompt (topic rotation)
    ├── templates\
    │   ├── report.html          ← Weekly briefing skeleton (incl. {{CHANGES_SINCE_LAST_WEEK_SECTION}}, {{ROLLING_HISTORY_SECTION}})
    │   └── report-deep-dive.html ← Deep-dive artifact skeleton (indigo header + topic badge)
    ├── data\                    ← Reports, dashboards, snapshots, artifact-history — gitignored
    ├── scripts\
    │   ├── run-client.js        ← Orchestrator (collect → analyse → score richness → pick artifact → generate → validate → deliver)
    │   ├── signal-richness.js   ← Deterministic silent/normal/rich scorer
    │   ├── artifact-selector.js ← Picks weekly-news vs deep-dive rotation; writes data/<id>/artifact-history.json
    │   ├── generate-report.js   ← Branches on artifactType; loads rolling history + computes local patterns
    │   ├── validate-report.js   ← Pre-send validation gate (per-artifact rules)
    │   ├── deliver.js           ← Dual-driver email (Resend preferred, SMTP fallback)
    │   ├── collect-for-brief.js ← ESM bridge: collectors → data/brief-signals/<slug>.json for brief-app
    │   └── collectors\
    │       ├── website-monitor.js          ← Live page diff vs local snapshot (free) / Apify (premium)
    │       ├── news-monitor.js             ← Google News RSS (free) / Apify full-text (premium)
    │       ├── g2-monitor.js                ← G2 public pages
    │       ├── jobs-monitor.js              ← Careers pages / ATS
    │       ├── linkedin-monitor.js          ← Apify-only
    │       ├── github-monitor.js            ← Public releases / commits
    │       ├── crunchbase-monitor.js        ← Public Crunchbase
    │       ├── glassdoor-monitor.js         ← Apify-only
    │       ├── pricing-archive-monitor.js   ← Wayback Machine pricing history (free, defaults on)
    │       ├── sitemap-monitor.js           ← /sitemap.xml week-over-week diff (free, defaults on — silent-week workhorse)
    │       ├── hackernews-monitor.js        ← Algolia HN search (free, defaults on)
    │       ├── reddit-monitor.js            ← Reddit public JSON search (free, defaults on)
    │       └── sec-filings-monitor.js       ← SEC EDGAR 8-K for public competitors (free, opt-in)
    └── .env                     ← Your API keys (create from .env.example)
```

---

## When You're Stuck


| Problem                                   | Where to look                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Business strategy, pricing, sales scripts | `BUSINESS-OPERATIONS.md` sections 3–4                                                          |
| Revenue projections and milestones        | `BUSINESS-OPERATIONS.md` section 7 + `DOCUMENTATION-NOTES.md`                                  |
| Retention tactics and churn prevention    | `BUSINESS-OPERATIONS.md` sections 8–9 + `docs/CLIENT-SLACK-CONNECT-PLAYBOOK.md` (Tier 1 lever) |
| Technical setup and commands              | This file (above); `**gtm-engine/README.md**` for GTM flags, CSV vs API                        |
| A specific script is broken               | Read the file — every script has usage comments at the top                                     |
| A client's report looks wrong             | Adjust their config in `config/clients/[id].json`, re-run with `--no-email`                    |
| "What Changed Since Last Week" is empty   | Expected on the first run for a client (no prior report). Confirm `data/[id]/report-content-*.json` exists from a previous run before expecting continuity |
| "30-Day Momentum" section missing         | Needs ≥ 2 prior `report-content-*.json` files on disk for this client. Tune `ROLLING_HISTORY_WEEKS` in `.env` (default 8) to widen or narrow the window |
| Pipeline shipped a deep-dive unexpectedly | Silent weeks trigger the artifact switch by design. CLI prints the `Richness tier:` and reasons. Override with `reportPreferences.forceArtifact = "weekly-news"` in the client config or tune `reportPreferences.richnessThresholds` |
| Report blocked by validation gate         | `npm run validate [id]` shows the failing checks; see runbook §9 for remediation                |
| Resend delivery errors                    | `EMAIL_FROM` must match a verified domain on Resend. Fall back with `EMAIL_DRIVER=smtp` to isolate |
| Wayback pricing collector empty           | Competitor may have no archived pricing page, or CDX timed out. Also try overriding `pricingUrls` per competitor (e.g. `/enterprise`, `/plans`) |
| SEC collector skipped                     | Collector only runs when `additionalCollectors.secFilings: true` AND the competitor has `secCik` or `secTicker`. Private companies are skipped |
| n8n workflow not firing                   | Check n8n → Executions log. Most common: path in Execute Command node is wrong                 |
| No Instantly API (Starter plan)           | Use `**npm run export-copy-csv**` in `gtm-engine` → upload CSV; see `**gtm-engine/README.md**` |
| Brief link opens not in Slack / wrong id  | Confirm `SLACK_WEBHOOK_URL` on Vercel; test `GET /api/health/tracking` on deployed `brief-app`; verify Instantly replaces `{{companyName}}` to match `brief-app` id mapping (`demo-salesloft` → `salesloft`) |
| `/brief` shows fallback not report data   | Run `run-client` (or any flow that calls `generate-report`) so JSON mirrors into **`brief-app/data/demo-<slug>/`**, commit if deploying to Vercel; ensure `?id=` matches slug rule in `brief-app/README.md` |


