# MightX — Founder Operating Manual

**Read this first.** It explains, in plain language, what MightX is, what the three flows are, and what to type when you want to run them. Every other doc in this repo is a deeper reference — this one is the only one you *have* to know.

---

## 1. What MightX is (30-second version)

MightX is three small apps that share one goal: **turn competitive intelligence into paying clients.**

| App | What it does for your business | Who uses the output |
|---|---|---|
| `intelligence-engine` | Writes the **weekly competitive briefing** that clients pay you for. Runs every Monday morning, fully automated. | Paying clients |
| `brief-app` | Hosts the **public sample brief** prospects land on when they click a link in your cold email. Also tracks who opened it and generates personalised follow-up emails. | Prospects (cold outbound) |
| `gtm-engine` | Your **outbound machine**. Pulls leads from Apollo, writes cold-email copy in bulk, and pushes them into Instantly. | Prospects (cold outbound) |

Put another way:

- **`gtm-engine` fills the pipeline.**
- **`brief-app` converts the pipeline.**
- **`intelligence-engine` is what the clients actually buy.**

---

## 2. The three flows you will actually run

You only ever run three workflows. Learn these and you're done.

### Flow A — Generate and deploy a vertical sample brief (for cold outbound)

**When to run it:** Whenever you start a new vertical (e.g. Cybersecurity, Sales Tech, HR Tech) or refresh a live one.

**What it does:** Collects real-world signals about two named competitors, asks Claude to write an editorial competitive brief, renders it as a polished HTML page, and deploys it to your live domain. The finished page is the "proof of quality" asset you link to in cold emails.

**Commands (in order):**

```powershell
# 1. Collect live signals for the two competitors.
#    Claude auto-looks-up their website, G2 slug, and SEC ticker.
#    First run per vendor takes ~60s; repeat runs are instant (cached).
cd C:\MightX\intelligence-engine
node scripts/collect-for-brief.js "Cybersecurity" "CrowdStrike" "SentinelOne"

# 2. Turn those signals into a polished HTML brief.
cd C:\MightX\brief-app
npm run generate-html-brief -- "Cybersecurity" "CrowdStrike" "SentinelOne"

# 3. Deploy to your live domain.
npm run deploy:vercel
```

**Where the brief ends up:**

- Local file: `brief-app/public/cybersecurity-brief.html`
- Live URL: `https://intel.nextbuildtech.com/cybersecurity-brief.html?id=<CompanyName>`

If the vertical name has a hyphen (like `E-Learning`), the generator writes **two copies** of the file — one with the hyphen (`e-learning-brief.html`) and one without (`elearning-brief.html`) — so both URL styles resolve. This keeps older cold emails in Instantly working when the URL style shifts.

### Flow B — Bulk cold-email generation (fill the top of the funnel)

**When to run it:** When you want to send 500 cold emails to a fresh batch of Apollo leads.

**What it does:** Pulls leads → enriches them → asks **Claude Sonnet** to write one short cold-email body per lead (cheap, fast, at scale) → pushes them to Instantly (or exports a CSV).

**Command:**

```powershell
cd C:\MightX\gtm-engine
# The exact step-by-step commands live in gtm-engine/README.md.
# Typical order: 1-pull-leads.js → 2-enrich-leads.js → 3-generate-copy.js → 4-push-instantly.js
```

**Why this is a separate tool from Flow C:** This runs over hundreds or thousands of leads. You pay for it per row, so it uses the cheaper **Sonnet** model and a shorter template. The cold-email body always references the vertical sample brief from Flow A.

### Flow C — One-off personalised email to a specific prospect (ABM / reply)

**When to run it:** A prospect replied to a cold email. Or a VP-of-Sales at a target account just showed up in Sales Navigator and you want one custom outreach to them specifically.

**What it does:** Reads the brief JSON from Flow A, picks the sharpest signal about the specific competitor the prospect fears, and asks **Claude Opus** to write **three** hand-crafted email variants (pattern-interrupt, helpful-frame, peer-reference). You pick the best one and paste it in.

**Command:**

```powershell
cd C:\MightX\brief-app
npm run generate-cold-email -- `
  --industry "Cybersecurity" `
  --prospect-name "Jane Smith" `
  --prospect-company "Acme Corp" `
  --competitor "CrowdStrike"
```

Output lands in `brief-app/data/cold-emails/cybersecurity--acme-corp.md` (gitignored) and also prints to the terminal.

**The easy rule of thumb:**

| How many emails? | Which flow? | Which Claude model? |
|---|---|---|
| Hundreds, bulk outbound | Flow B (`gtm-engine`) | Sonnet 4 |
| One-off to a specific person | Flow C (`brief-app/generate-cold-email`) | Opus 4.7 |

### Flow D — Run the weekly client deliverable

**When to run it:** Every Monday (but **n8n already runs it automatically** — you only do this by hand when onboarding, testing, or debugging).

**What it does:** For each configured client, collects their competitors' signals, scores how "loud" the week was, picks the right artifact (weekly briefing on normal weeks, single-topic deep-dive on silent weeks), generates the HTML report, validates it, and emails it.

**Commands:**

```powershell
cd C:\MightX\intelligence-engine
npm run onboard                     # First time only — add a new client
node scripts/run-client.js <id>     # Run the full pipeline for one client
npm run all-clients                 # Run all active clients (same as n8n cron)
```

The pipeline self-validates before sending. If the report is too thin or contains an unfilled placeholder, it **blocks the send**, keeps the HTML on disk, and (if configured) pings you on Slack.

---

## 3. The three URLs you need to remember

| URL | What it is | When it matters |
|---|---|---|
| `https://intel.nextbuildtech.com/<vertical>-brief.html?id=<Company>` | The **static vertical sample** for cold outbound. This is the URL Instantly links to. | Every cold email body |
| `https://intel.nextbuildtech.com/brief?id=<LeadId>&trk=<SignedToken>` | The **dynamic per-lead page** with signed open-tracking. Sends a Slack alert the moment a prospect opens it. | Instantly campaigns that use tracked CTAs (see `gtm-engine/docs/VERTICAL-BRIEF-AND-EMAIL.md`) |
| `https://might-x.vercel.app` | The **raw Vercel project URL**. Same content as `intel.nextbuildtech.com` — just the fallback host. | Only when the custom domain is down |

All three point to the same Vercel project. `intel.nextbuildtech.com` is the production domain you want in client-facing copy.

---

## 4. Environment variables (the short list)

Defaults live in each package's `.env.example`. Copy it to `.env.local` (for `brief-app`) or `.env` (for the others) and fill in your keys. **Never commit the filled-in file.**

The ones you will actually touch:

| Variable | Where | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | all three packages | Required for any Claude call (report writer, brief, cold email, vendor resolver). |
| `BRIEF_URL_BASE` | `brief-app/.env.local` | Production URL the cold-email generator builds links from. Defaults to `https://intel.nextbuildtech.com`. |
| `BRIEF_AUTHOR_NAME` + `TITLE` / `CREDENTIAL` / `LINKEDIN` / `AVATAR_URL` | `brief-app/.env.local` | Enables the **founder byline** on the vertical brief (trust boost). Leave `BRIEF_AUTHOR_NAME` blank to hide the whole block. |
| `TRACKING_SIGNING_SECRET` | `gtm-engine/.env` **and** `brief-app/.env.local` | Must match exactly. Signs the `trk` token in tracked brief links. |
| `SLACK_WEBHOOK_URL` | `brief-app/.env.local` | Where open-tracking alerts are posted. |
| `REPORT_MODEL` / `ANALYSIS_MODEL` / `QUARTERLY_SUMMARY_MODEL` | `intelligence-engine/.env` | Override the Claude model (default is `claude-opus-4-7`). |
| Email delivery (`EMAIL_DRIVER` + Resend or SMTP keys) | `intelligence-engine/.env` | Required for the weekly Monday email to actually send. |

The full lists — including every tuning knob for each collector — are in:

- `gtm-engine/.env.example`
- `brief-app/.env.example`
- `intelligence-engine/.env.example`

---

## 5. Glossary (terms that may confuse you)

- **Vertical sample** — the static HTML page at `intel.nextbuildtech.com/<vertical>-brief.html`. Public. Used as proof-of-quality in cold emails.
- **Weekly briefing** — the HTML email the paying client receives every Monday. Private. Generated by `intelligence-engine`.
- **Deep-dive** — the silent-week replacement for the weekly briefing. A single-topic analytical memo (positioning teardown, pricing forensics, etc.). Rotates through 5 topics per client.
- **Signal** — a single dated observation about a competitor (a news article, a job post, a G2 review, a sitemap change). The raw material every artifact is built from.
- **Collector** — a small script that pulls one type of signal (news-monitor, jobs-monitor, sitemap-monitor, etc.). Nine of them run in parallel.
- **Signal richness** — a numeric score (`silent` / `normal` / `rich`) that decides whether this week ships a weekly briefing or a deep-dive.
- **Trigger event** — a single high-importance signal that gets surfaced at the very top of the weekly briefing (e.g. "competitor hit 52-week stock low").
- **`id=` parameter** — appended to every brief URL. It's the prospect's company name, URL-encoded (e.g. `?id=Salesoft`). Drives the "Prepared for Salesoft" header inside the brief.
- **`trk=` parameter** — appended to the dynamic `/brief` URL only. A signed, short-lived token that authorises open tracking. Unsigned or tampered tokens are ignored.

---

## 6. When something breaks — first-check table

| Symptom | First thing to check |
|---|---|
| I generated a brief and the link in my email shows old content | You deployed, but Vercel is caching the old version. Hard-refresh the browser. If still stale, run `npm run deploy:vercel` again — the script verifies the new content after deploy. |
| `collect-for-brief` says "ANTHROPIC_API_KEY not set" | `intelligence-engine/.env` is missing or the key isn't named exactly `ANTHROPIC_API_KEY`. |
| Cold email variants all reference an empty brief | You ran `generate-cold-email` before running `generate-html-brief`. The `public/<slug>-brief.json` file doesn't exist yet. Do Flow A first. |
| Slack never pings me when a prospect opens the brief | `TRACKING_SIGNING_SECRET` does not match across `gtm-engine` and `brief-app`. The proxy silently drops unsigned opens (by design). |
| Monday client email didn't send | Check `intelligence-engine/data/<client>/reports/<timestamp>/validation-*.json`. The validation gate probably blocked it. Also check `OPS_SLACK_WEBHOOK_URL`. |
| Weekly briefing is "too thin" | Signal richness was low that week → the pipeline should have shipped a deep-dive instead. If it shipped a thin weekly, check `signal-richness.js` thresholds in the client config. |
| Live domain `intel.nextbuildtech.com` is 404-ing | DNS. The domain is a custom alias on the `might-x` Vercel project. Check Vercel → project → Domains. `might-x.vercel.app` should still work. |

---

## 7. Deeper docs (reach for these second)

Once you know the above, each of the other docs has a narrow job:

- `MASTER-RUNBOOK.md` — technical runbook: every CLI command, every env var, troubleshooting for engineers.
- `intelligence-engine/BUSINESS-OPERATIONS.md` — strategy, pricing, ICP, projections, retention narrative. **Read once.**
- `intelligence-engine/START-HERE.md` — day-1 onboarding playbook for adding a new client.
- `intelligence-engine/docs/CLIENT-SLACK-CONNECT-PLAYBOOK.md` — the Slack Connect cadence you post each Monday.
- `brief-app/README.md` — Vercel deploy mechanics + tracking behaviour.
- `gtm-engine/README.md` — Apollo → Instantly pipeline commands.
- `gtm-engine/docs/VERTICAL-BRIEF-AND-EMAIL.md` — how the bulk cold-email copy references the vertical brief.
- `admin-dashboard/README.md` — optional internal RevOps dashboard (dark UI + allowlisted `npm run` via server actions). Run locally only; does not deploy to production serverless.

If anything in those docs contradicts this README, **this README wins** — the others are technical appendices and may lag behind when scripts change.
