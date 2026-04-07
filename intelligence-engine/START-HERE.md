# START HERE

## Your Complete Execution Playbook

This is the only document you need open day-to-day. It tells you exactly what to do and in what order. When you want strategic context or deeper explanation, open `BUSINESS-OPERATIONS.md`. For **how the revenue tables are calculated, path conventions, and product/marketing caveats**, open `DOCUMENTATION-NOTES.md`. For **GTM details** (CLI flags, Instantly CSV vs API), open `gtm-engine/README.md`. For the current highest-odds validation path, open `VALIDATION-PLAYBOOK-SALES-TECH.md`.

---

## How the two systems work together

```
GTM ENGINE  (C:\mightx\gtm-engine)
    Purpose: finds and contacts prospects for YOU
    Apollo → Claude writes emails → Instantly sends → you get discovery calls

INTELLIGENCE ENGINE  (C:\mightx\intelligence-engine)
    Purpose: the service you sell to those clients
    n8n cron → scrape competitors → Claude analyses → HTML report emailed every Monday
```

You use the GTM Engine to fill your own pipeline.
You sell clients access to the Intelligence Engine.

---

## Before You Do Anything — Accounts Checklist

You need these active with API access before running either system:


| Account             | What for                                    | Get API key from                          |
| ------------------- | ------------------------------------------- | ----------------------------------------- |
| Anthropic           | Claude — powers all AI writing and analysis | console.anthropic.com → API Keys          |
| Apollo.io           | Lead sourcing for your outbound             | Apollo → Settings → Integrations → API    |
| Instantly           | Sending your cold emails                    | Instantly → Settings → Integrations → API |
| Gmail (or any SMTP) | Delivering client reports                   | Google Account → Security → App Passwords |
| n8n (self-hosted)   | Orchestration and cron scheduling           | Already have this                         |


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

Open `.env` and fill in: `ANTHROPIC_API_KEY`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`

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

**Concierge fulfillment — how to deliver the custom baseline you promised in cold email:**

1. Prospect replies with interest (their competitors were named in your CTA, or they confirm on reply).
2. Create a throwaway config: `config/clients/prospect-[name].json` with their 2-4 competitors (name, website, G2 slug if known).
3. Run: `node scripts/run-client.js prospect-[name] --no-email`
4. Review the HTML — manual QA is expected at this stage. Fix anything thin.
5. Send the HTML by Monday as promised. Time cost: ~30 min per prospect on your weekend.

This is concierge MVP: you do the work manually to deliver real value before you automate or buy premium tools. **Do not redirect prospects to a canned PDF or Gold Standard sample instead of the custom run you offered.** The Gold Standard demo is backup portfolio proof, not the default fulfillment.

**After first paying client:** Their retainer funds premium API access (Proxycurl for LinkedIn enrichment, BrightData for deeper scraping). This improves ongoing weekly quality but is not required to close the first deal.

More detail: `VALIDATION-PLAYBOOK-SALES-TECH.md`. GTM copy rules: `gtm-engine/prompts/personalization.txt`.

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

Do not pitch "competitive intelligence." Lead with a specific pain. **Do not** promise a generic “sample report for your category” (you cannot pre-build credible reports for every industry). The live pipeline uses Claude with rules in `gtm-engine/prompts/personalization.txt`: name **1–2 real competitors**, then close with a **custom weekend baseline** and Monday send, e.g.:

> I'm setting up my intelligence engine this week. If I configure a baseline capture on [Competitor A] and [Competitor B], would you be opposed to me sending over the findings next Monday?

When they reply with interest, **deliver that custom run** (same competitors you named, or confirm on email if you were wrong). Do not ask for a call first. The **custom** report is the pitch. Keep the two demo HTML files from Step 4 as **backup proof of format**, not the default fulfillment.

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
# If yes:
node scripts/run-client.js [client-id]
```

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
| Claude API rate limit             | Increase `DELAY` in `scripts/analyse.js` (line ~12)                      |
| Competitor website blocked scrape | Set that competitor's website to `null` temporarily in client config     |


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
node scripts/run-client.js [id]                          # Run full pipeline for one client
node scripts/run-client.js [id] --no-email               # Run but don't send email (review first)
node scripts/run-client.js [id] --dry-run                # Collect signals only, no analysis
npm run all-clients                                      # Run all active clients (same as n8n cron)
node scripts/generate-dashboard.js [id]                  # Regenerate dashboard for one client
node scripts/generate-dashboard.js --all                 # Regenerate dashboards for all clients
node scripts/generate-quarterly-summary.js [id]          # Generate Q summary (previous quarter)
node scripts/generate-quarterly-summary.js [id] --quarter Q2-2026   # Specific quarter
```

---

## File Locations

```
C:\mightx\
├── gtm-engine\                  ← Your outbound system (finds clients for you)
│   ├── README.md                ← GTM commands, CLI flags, Instantly CSV vs API push
│   ├── config\icp.json          ← Edit this to define who you're targeting
│   ├── scripts\                 ← Pipeline steps (incl. 6-export-copy-csv.js)
│   └── .env                     ← Your API keys (create from .env.example)
│
└── intelligence-engine\         ← The product you sell
    ├── START-HERE.md            ← This file
    ├── BUSINESS-OPERATIONS.md  ← Strategy, pricing, projections (read once)
    ├── DOCUMENTATION-NOTES.md  ← Projection conventions, paths, caveats
    ├── config\clients\          ← One JSON file per client
    ├── prompts\                 ← Claude prompt templates (customise per client)
    ├── data\                    ← All output (reports, dashboards, logs) — gitignored
    ├── scripts\                 ← All pipeline scripts
    └── .env                     ← Your API keys (create from .env.example)
```

---

## When You're Stuck


| Problem                                   | Where to look                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Business strategy, pricing, sales scripts | `BUSINESS-OPERATIONS.md` sections 3–4                                                          |
| Revenue projections and milestones        | `BUSINESS-OPERATIONS.md` section 7 + `DOCUMENTATION-NOTES.md`                                  |
| Retention tactics and churn prevention    | `BUSINESS-OPERATIONS.md` sections 8–9                                                          |
| Technical setup and commands              | This file (above); `**gtm-engine/README.md**` for GTM flags, CSV vs API                        |
| A specific script is broken               | Read the file — every script has usage comments at the top                                     |
| A client's report looks wrong             | Adjust their config in `config/clients/[id].json`, re-run with `--no-email`                    |
| n8n workflow not firing                   | Check n8n → Executions log. Most common: path in Execute Command node is wrong                 |
| No Instantly API (Starter plan)           | Use `**npm run export-copy-csv**` in `gtm-engine` → upload CSV; see `**gtm-engine/README.md**` |


