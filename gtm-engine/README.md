# GTM Engine

Autonomous B2B outbound infrastructure. Pulls ICP-matched leads from Apollo, generates personalised cold email copy via Claude, pushes campaigns to Instantly, and classifies replies automatically via n8n.

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
4-push-instantly  — Leads + AI copy pushed to Instantly campaign
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
- Accounts with API access: Apollo.io, Anthropic, Instantly
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
| **`generate-copy`** | `--first N` | Generate copy for only the **first N** rows in the latest `enriched-*.json`. Overrides offset/limit. |
| | `--offset O` `--limit L` | Generate for a **slice** of the enriched file (0-based). Example: second batch of 500 → `--offset 500 --limit 500`. |
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
npm run push-instantly -- --file copy-2026-04-06T05-23-28.json
npm run push-instantly -- --file copy-2026-04-06T05-23-28.json --first 10
npm run push-instantly -- --offset 500 --limit 500
npm run export-copy-csv -- --file copy-2026-04-06T05-23-28.json
npm run export-copy-csv -- --first 500
npm run export-copy-csv -- --out data/batch-1.csv
```

Push logs in `data/push-log-*.json` record `copyFile` and `batch` when you use these options.

### Classify a reply manually (for testing)

```bash
echo "Thanks for reaching out, happy to chat next week" | npm run classify-reply
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

Each script reads the most recently dated file from the previous step, so you can re-run individual steps without re-processing the whole pipeline. **`push-instantly --file`** is the exception: it uses the path you pass instead of the latest `copy-*.json`.

---

## Customising the email prompt

The email generation prompt lives in `prompts/personalization.txt`. Edit it to:

- Change the tone or voice
- Add your specific service details and pricing
- Include new personalization variables (add the field in Step 2 first)
- Test different angles (pain-first vs outcome-first)

The reply classification prompt lives in `prompts/reply-classifier.txt`. Adjust classifications or next-action language to match your sales process.

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

1. Use an **API v2** key from [Integrations → API Keys](https://app.instantly.ai/app/settings/integrations) (v1 keys do not work with `api/v2`).
2. Paste **only** the key into `INSTANTLY_API_KEY` — no `Bearer ` prefix, no quotes unless your tooling requires them.
3. Confirm the key in the [API docs “Try it”](https://developer.instantly.ai) panel; if it fails there too, create a **new** key and revoke the old one.
4. Run commands from `gtm-engine` so `dotenv` loads `gtm-engine/.env`.

---

## Liability checklist

Before running outbound on behalf of a client, confirm:

- [ ] Sending domains are separate from the client's primary domain
- [ ] All sequences include a compliant unsubscribe option (Instantly handles this by default)
- [ ] Client has reviewed and approved the email copy before the push step
- [ ] Client's MSA includes a clause confirming they are the legal sender
- [ ] Sequences target business email addresses only (no personal Gmail/Yahoo)
- [ ] Daily send volume stays within Instantly's warmup guidelines
