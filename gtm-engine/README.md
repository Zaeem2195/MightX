# GTM Engine

Autonomous B2B outbound infrastructure. Pulls ICP-matched leads from Apollo, generates personalised cold email copy via Claude, then either **pushes to Instantly via API** or **exports a CSV** for manual upload (e.g. Starter plan without API access). Reply classification runs via n8n.

Built to replace or augment SDR headcount for B2B SaaS sales teams.

---

## How it works

```
Apollo API
    ↓
1-pull-leads      — ICP-matched leads saved to data/
    ↓
2-enrich-leads    — Personalization variables computed from Apollo data
    ↓
3-generate-copy   — Claude writes subject line + email body per lead
    ↓
  REVIEW          — You spot-check the output before anything sends
    ↓
4a-push-instantly — API: leads + copy sent to Instantly (paid plans with API)
    OR
4b-export-copy-csv — CSV file for manual upload in Instantly (no API, e.g. Starter)
    ↓
Instantly         — Handles sending schedule, warmup, bounce, unsubscribe
    ↓
Reply received → n8n webhook → Claude classifies intent
    ↓
INTERESTED  → Slack alert (you take over)
QUESTION    → Slack alert (draft response)
OOO         → Wait 5 days, stays in sequence
REFERRAL    → Slack alert (find the referred contact)
```

---

## Prerequisites

- Node.js 18+
- Accounts with API access: **Apollo.io**, **Anthropic**
- **Instantly:** an account and a campaign with `{{ai_subject}}` / `{{ai_body}}` in the sequence. **API access** is only required if you use **`npm run push-instantly`**; **`npm run export-copy-csv`** needs no Instantly API key.
- n8n (self-hosted or cloud) for reply routing
- Slack incoming webhook (optional, for hot-lead alerts)

---

## Setup

### 1. Install dependencies

```bash
cd gtm-engine
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in:

| Variable | Where to find it |
|---|---|
| `APOLLO_API_KEY` | Apollo → Settings → Integrations → API |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `INSTANTLY_API_KEY` | Instantly **API v2** key (Bearer) — [Getting started](https://developer.instantly.ai/getting-started/getting-started) |
| `INSTANTLY_CAMPAIGN_ID` | Create a campaign in Instantly, copy the ID from the URL |
| `N8N_WEBHOOK_URL` | Generated after importing the n8n workflow (Step 5 below) |
| `SLACK_WEBHOOK_URL` | Slack → Apps → Incoming Webhooks (optional) |

**Optional — vertical campaigns (recommended when the CTA points at a static HTML brief on Vercel):** set `GTM_BRIEF_CTA_BASE_URL`, `GTM_BRIEF_HTML_FILENAME`, and **both** `GTM_REPORT_COMPETITOR_A` / `GTM_REPORT_COMPETITOR_B` in `.env` so email copy matches the hosted report. Details: [docs/VERTICAL-BRIEF-AND-EMAIL.md](docs/VERTICAL-BRIEF-AND-EMAIL.md).

### 3. Configure your ICP

Edit `config/icp.json` to define who you are targeting:

```json
{
  "titles": ["VP of Sales", "CRO", "Head of Sales"],
  "industries": ["Computer Software", "SaaS"],
  "employee_ranges": [{ "min": 50, "max": 200 }],
  "locations": ["United States"],
  "leadsPerRun": 50
}
```

Adjust `leadsPerRun` based on your Instantly inbox capacity. A safe starting point is 30–50 leads per run with 2–3 sending inboxes warmed up.

### 4. Set up your Instantly campaign

In Instantly, create a new campaign and set your sequence step body to use these variables:

```
Subject: {{ai_subject}}

{{ai_body}}
```

The pipeline injects AI-generated content into these placeholders for each lead.

### 5. Import the n8n reply-handling workflow

1. Open your n8n instance
2. Go to **Workflows → Import from file**
3. Upload `n8n/gtm-reply-handler.json`
4. Activate the workflow — copy the generated webhook URL
5. Paste that URL into your `.env` as `N8N_WEBHOOK_URL`
6. In Instantly → Settings → Integrations → Webhooks, set the reply webhook to your n8n URL
7. Set `SLACK_WEBHOOK_URL` in n8n's environment variables (Settings → Variables)

> The n8n workflow calls the reply classifier on `http://localhost:3001/classify`.
> If your n8n is hosted on a remote server, run `node scripts/5-classify-replies.js --serve`
> on that server and update the HTTP Request node URL accordingly.

---

## Running the pipeline

### Full pipeline (recommended)

```bash
npm run pipeline
```

Runs all four steps in sequence. Pauses before the Instantly push so you can review the generated copy. Type `yes` to confirm and send.

> **`npm run pipeline` always runs step 4 as `push-instantly` (API).** If you only use CSV import, run steps 1–3 manually (`pull-leads` → `enrich` → `generate-copy`), then **`npm run export-copy-csv`** instead of step 4.

To skip the review prompt (for scheduled/automated runs after you trust the output quality):

```bash
npm run pipeline -- --auto-approve
```

### Run individual steps

```bash
npm run pull-leads      # Step 1: Pull leads from Apollo
npm run enrich          # Step 2: Enrich with personalization variables
npm run generate-copy   # Step 3: Generate email copy via Claude
npm run push-instantly  # Step 4: Push to Instantly campaign (requires API — paid plans)
# OR, without API (e.g. Starter): export CSV and upload leads manually in Instantly
npm run export-copy-csv
```

Each step reads the latest output file from the previous step automatically (by filename sort), except **`push-instantly`** when you pass **`--file`** (see below).

### CLI flags (optional)

Pass flags after `npm run <script> --` so they reach the Node script.

| Script | Flags | What they do |
|--------|--------|----------------|
| **`pull-leads`** | `--max-leads N` | Pull at most **N** leads this run (overrides `leadsPerRun` in `config/icp.json`). |
| **`generate-copy`** | `--file <path>` | Load a specific enriched JSON (same `{ leads }` shape), e.g. `data/processed-companyindustry-e-learning-equals-batch.json`. Otherwise uses the latest `data/enriched-*.json` by filename. |
| | `--first N` | Generate copy for only the **first N** rows in the loaded enriched file. Overrides offset/limit. |
| | `--offset O` `--limit L` | Generate for a **slice** of the enriched file (0-based). Example: second batch of 500 → `--offset 500 --limit 500`. |
| | (env) `GTM_BRIEF_CTA_BASE_URL` | Optional. Replaces `https://yourdomain.com` in the prompt. No trailing slash. |
| | (env) `GTM_BRIEF_HTML_FILENAME` | Optional. Replaces `__BRIEF_HTML_FILENAME__` in the prompt (default `elearning-brief.html`). Example: `management-consulting-brief.html`. |
| | (env) `GTM_REPORT_COMPETITOR_A` / `GTM_REPORT_COMPETITOR_B` | **Recommended** for vertical batches: set **both** to the same two names as in your static HTML brief (`brief-app/public/…`) so the email’s competitor pair matches the page behind the link. If **either** is unset, the prompt uses **NO LOCK** and Claude may infer a different pair per lead (OK for tests; **not** aligned with a fixed report). See [docs/VERTICAL-BRIEF-AND-EMAIL.md](docs/VERTICAL-BRIEF-AND-EMAIL.md). |
| **`push-instantly`** | `--file <path>` | Load a **specific** copy file instead of the latest `copy-*.json`. Bare filename → `data/<filename>`. You can also pass `data/copy-….json` or an absolute path. |
| | `--first N` | Push only the **first N** entries from that copy file. |
| | `--offset O` `--limit L` | Push a **slice** of the copy file (same rules as `generate-copy`). |
| **`export-copy-csv`** | `--file`, `--first`, `--offset`, `--limit` | Same as above — writes **`data/copy-export-[timestamp].csv`** (UTF-8 with BOM) for **manual** Instantly CSV import when you do not have API access. |
| | `--out <path>` | Write CSV to a specific path (relative to `gtm-engine` or absolute). |

Examples:

```bash
npm run pull-leads -- --max-leads 500
npm run generate-copy -- --first 10
npm run generate-copy -- --first 500
npm run generate-copy -- --offset 10 --limit 500
npm run generate-copy -- --file data/processed-companyindustry-e-learning-equals-batch.json
npm run push-instantly -- --file copy-2026-04-06T05-23-28.json
npm run push-instantly -- --file copy-2026-04-06T05-23-28.json --first 10
npm run push-instantly -- --offset 500 --limit 500
npm run export-copy-csv -- --file copy-2026-04-06T05-23-28.json
npm run export-copy-csv -- --first 500
npm run export-copy-csv -- --out data/batch-1.csv
```

Push logs in `data/push-log-*.json` record `copyFile` and `batch` when you use these options.

### Vertical HTML briefs, CTAs, and competitor names

For **industry-specific** static briefs on Vercel (e.g. `elearning-brief.html`) and **Instantly** merge tags, read **[docs/VERTICAL-BRIEF-AND-EMAIL.md](docs/VERTICAL-BRIEF-AND-EMAIL.md)**. It explains `GTM_BRIEF_*` and `GTM_REPORT_COMPETITOR_*`, one batch per `.env` setup, and what can still go wrong (merge tag typos, Claude dropping `{{companyName}}`, etc.).

### Instantly without API — CSV import (e.g. Starter plan)

If your Instantly plan does **not** include API access, skip **`push-instantly`** and use **`export-copy-csv`** after **`generate-copy`**.

1. Generate the CSV (same batching flags as API push):

   ```bash
   npm run export-copy-csv
   npm run export-copy-csv -- --file copy-2026-04-06T05-23-28.json
   npm run export-copy-csv -- --first 500 --out data/batch-1.csv
   ```

2. Output: **`data/copy-export-[timestamp].csv`** (or **`--out`** path). Encoding: **UTF-8 with BOM** for Excel.

3. **Columns** (header row):

   | Column | Maps to in Instantly |
   |--------|----------------------|
   | `email` | Email |
   | `first_name` | First name |
   | `last_name` | Last name |
   | `company_name` | Company |
   | `ai_subject` | Sequence subject line variable `{{ai_subject}}` |
   | `ai_body` | Email body variable `{{ai_body}}` |
   | `title` | Optional extra variable `{{title}}` if you use it |

4. In Instantly: open your campaign → **Leads** → **Upload CSV** (or Import). Map each column to the matching lead field or **custom variable** so they align with your sequence — same `{{ai_subject}}` / `{{ai_body}}` placeholders as in **Step 4. Set up your Instantly campaign** above.

5. You do **not** need `INSTANTLY_API_KEY` or `INSTANTLY_CAMPAIGN_ID` in `.env` for this path (still set them when you upgrade and use **`push-instantly`**).

Implementation: `scripts/6-export-copy-csv.js`.

### Classify a reply manually (for testing)

```bash
echo "Thanks for reaching out, happy to chat next week" | npm run classify-reply
```

Or pass the text directly (also used by the MightX admin dashboard):

```bash
npm run classify-reply -- --reply-text "Thanks for reaching out, happy to chat next week"
```

### Start the reply classifier as a server (for n8n)

```bash
node scripts/5-classify-replies.js --serve
```

Listens on port 3001. n8n sends POST requests to `/classify` when Instantly fires a reply webhook.

---

## Output files

All output is saved to `data/` (gitignored):

| File | Contents |
|---|---|
| `leads-[timestamp].json` | Raw Apollo leads |
| `enriched-[timestamp].json` | Leads with personalization variables |
| `copy-[timestamp].json` | AI-generated subject lines and email bodies |
| `copy-export-[timestamp].csv` | CSV from **`export-copy-csv`** for manual Instantly upload (`ai_subject`, `ai_body`, `title` columns) |
| `push-log-[timestamp].json` | Instantly push results (success/failure per lead); includes `copyFile` / `batch` when flags were used |
| `processed-<field>-<value>-equals|contains-batch.json` | Optional: slice produced by **`scripts/extract-enriched-batch.mjs`** (override with `--batch-out`) |

Each script reads the most recently dated file from the previous step, so you can re-run individual steps without re-processing the whole pipeline. **`push-instantly --file`** is the exception: it uses the path you pass instead of the latest `copy-*.json`.

### Extract leads by field (Node)

Use **`scripts/extract-enriched-batch.mjs`** (or **`npm run extract-batch:dry-run`** / **`npm run extract-batch`**) to filter `enriched-*.json` by **`--field`** / **`--equals`** or **`--contains`**, write a batch JSON, and update the master file in place. It does **not** call Instantly.

**After extract:** run **`npm run generate-copy -- --file data/<your-batch>.json`**, then **`npm run push-instantly -- --file data/copy-….json`** (or export CSV).

```bash
cd gtm-engine
# Default: companyIndustry equals e-learning
npm run extract-batch:dry-run
npm run extract-batch

# Another industry (auto batch filename from field + value)
node scripts/extract-enriched-batch.mjs --equals "Computer Software" --no-instantly

# Substring on title, custom batch filename
node scripts/extract-enriched-batch.mjs --field title --contains "Chief Revenue" --batch-out processed-cro-title-batch.json --dry-run
```

**Flags:** `--field` (default `companyIndustry`), **`--equals`** (default `e-learning` when `--contains` is not used), **`--contains`** (substring; do not pass `--equals` with it), **`--source`**, **`--batch-out`**, **`--dry-run`**, **`--no-instantly`** (required to write; omit for dry-run only).

Prints **before/after counts** and aborts if `remaining + extracted ≠ original`.

---

## Customising the email prompt

The email generation prompt lives in `prompts/personalization.txt`. **`scripts/3-generate-copy.js`** substitutes placeholders before Claude runs: `https://yourdomain.com` → `GTM_BRIEF_CTA_BASE_URL`, `__BRIEF_HTML_FILENAME__` → `GTM_BRIEF_HTML_FILENAME`, and **`{{INJECTED_CAMPAIGN_CONTEXT}}`** with either **REPORT-LOCKED** (when both competitor env vars are set) or **NO LOCK**. Prefer env vars + the committed prompt over hand-editing URLs per vertical.

You can still edit `personalization.txt` to:

- Change the tone or voice
- Add your specific service details and pricing
- Include new personalization variables (add the field in Step 2 first)
- Test different angles (pain-first vs outcome-first)

The reply classification prompt lives in `prompts/reply-classifier.txt`. Adjust classifications or next-action language to match your sales process.

---

## Cold Email Framework (Current)

`scripts/3-generate-copy.js` loads `prompts/personalization.txt`, applies **env substitutions** (host, brief HTML filename, injected campaign context), then sends the result to Claude Sonnet for each lead.

The current framework is now:

- **Prospect-first opener** (real, verifiable detail about the lead/company)
- **Abstracted Authority sentence** in sentence 2 or 3:
  - "My background is in engineering secure, enterprise-grade architectures for tier-1 financial institutions, but my team recently built an automated competitive intelligence engine specifically for the SaaS market."
- **Exactly 2 competitors in the baseline sentence** — **recommended:** set `GTM_REPORT_COMPETITOR_A` and `GTM_REPORT_COMPETITOR_B` to match the pair in your **static HTML brief** (same names as on the Vercel page). The prompt then uses **REPORT-LOCKED** and those names only. If those env vars are **not** both set, the prompt uses **NO LOCK** and Claude may infer two competitors per lead (not guaranteed to match a fixed report).
- **Delivery-assuming CTA** (no permission-asking): baseline capture + Rep Talk Tracks framing, then link on its own line. The URL shape is built from env (see [docs/VERTICAL-BRIEF-AND-EMAIL.md](docs/VERTICAL-BRIEF-AND-EMAIL.md)), e.g. `https://<your-host>/<vertical>-brief.html?id={{companyName}}` after substitution — not a hardcoded `/brief` path unless your prompt says so.
- **Literal Instantly token required**:
  - `{{companyName}}` must remain literal in output so Instantly injects the value at send time
- **Word budget**: under 140 words

### Why `{{companyName}}` matters

The generated email body intentionally contains a literal merge token in the link query string, for example:

```txt
https://intel.nextbuildtech.com/elearning-brief.html?id={{companyName}}
```

(Actual host and path come from `GTM_BRIEF_CTA_BASE_URL` + `GTM_BRIEF_HTML_FILENAME` and `personalization.txt`.)

At send time, Instantly replaces `{{companyName}}` with each lead’s value so tracking links stay per-lead without changing generation code.

---

## Scaling tips

**Sending volume:** Instantly recommends max 40–50 emails/inbox/day. With 3 warmed inboxes across 2 sending domains, you can safely send 120–150 emails/day without reputation risk. Run the pipeline 3x per week targeting ~50 leads each run.

**Domain setup:** Use separate domains for outbound (e.g. `trymightx.com`, `getmightx.io`). Never send cold outbound from your primary domain. Set up SPF, DKIM, and DMARC on each sending domain before warming.

**Warmup:** Let Instantly warm new inboxes for 3–4 weeks before adding them to a campaign. Enable Warmup in Instantly → Accounts for each inbox.

**Reply SLA:** When n8n fires a hot-lead Slack alert, respond within 2 hours. Response speed is the single biggest factor in converting interested replies into booked calls.

---

## Clay enrichment (optional upgrade)

This system runs fully without Clay. Apollo provides enough data — tech stack, company size, industry, title, LinkedIn URL — to generate high-quality personalised emails.

Clay adds a meaningful quality layer when you upgrade to a paid plan ($149+/month):

- **Waterfall email finding** — fills gaps where Apollo has no verified email
- **LinkedIn profile scraping** — recent posts, job changes, shared connections
- **Intent signals** — G2 reviews, hiring patterns, funding events
- **Custom enrichment logic** — multi-source waterfalls with conditional branching

If you are closing your first 2–3 clients and running your own outbound, the Apollo-only version is sufficient. Add Clay when you are managing multiple client pipelines and need higher personalisation quality at scale.

---

## Cost per pipeline run (50 leads)

| Item | Estimated cost |
|---|---|
| Apollo API (50 leads) | ~$0 (included in subscription) |
| Claude Sonnet (50 emails) | ~$0.02–0.05 |
| Instantly (sending) | ~$0 (included in subscription) |
| **Total per run** | **< $0.10** |

---

## Troubleshooting

### `push-instantly` returns `401` / `Invalid API key`

Instantly’s support checklist (and what this repo does):

| Check | Details |
|--------|---------|
| **Header** | Send the key as **`Authorization: Bearer YOUR_API_KEY`** — header name exactly `Authorization`, single space after `Bearer`, no extra spaces inside the key. |
| **HTTPS** | All requests use `https://api.instantly.ai` (the script uses `fetch` over HTTPS). |
| **Key state** | Key must be **active**, not revoked; even with `all:all`, recreate the key if unsure. |
| **Endpoint** | This project calls the documented v2 route: **`POST https://api.instantly.ai/api/v2/leads`** with JSON body including **`campaign`** (your campaign UUID). Some support examples show URLs like `.../v1/leads` without the **`/api/`** segment — follow **[developer.instantly.ai](https://developer.instantly.ai)** OpenAPI for the exact path your key expects. |

Additional steps:

1. Create an **API v2** key under [Integrations → API Keys](https://app.instantly.ai/app/settings/integrations) with scopes that include lead creation (e.g. `leads:create` or `all:all`).
2. Put **only** the raw key in `INSTANTLY_API_KEY` in **`gtm-engine/.env`** (no `Bearer ` prefix in the file; the script adds it).
3. Test the same key in the [API docs “Try it”](https://developer.instantly.ai) panel for **`POST /api/v2/leads`**. If it fails there, the key or workspace is wrong — not this repo.
4. Run `npm run push-instantly` from **`gtm-engine`** so `.env` loads.

**Manual test:** In [developer.instantly.ai](https://developer.instantly.ai) open **`POST /api/v2/leads`**, paste your key in the auth panel, send a minimal body with `campaign`, `email`, `first_name`, `last_name`, `company_name`. If that succeeds, the same key + campaign ID in `gtm-engine/.env` will work for `push-instantly`.

---

## Liability checklist

Before running outbound on behalf of a client, confirm:

- [ ] Sending domains are separate from the client's primary domain
- [ ] All sequences include a compliant unsubscribe option (Instantly handles this by default)
- [ ] Client has reviewed and approved the email copy before the push step
- [ ] Client's MSA includes a clause confirming they are the legal sender
- [ ] Sequences target business email addresses only (no personal Gmail/Yahoo)
- [ ] Daily send volume stays within Instantly's warmup guidelines
