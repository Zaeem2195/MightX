# MightX Operating Playbook

This is the only human-facing doc you should follow day to day.

MightX is a managed competitive intelligence service for B2B SaaS sales teams. The product is a weekly Monday briefing that tells a client what their competitors changed, why it matters in active deals, and what their reps should say this week.

## The Strategy

The current best strategy is:

1. Pick one narrow wedge.
2. Send signal-first cold email.
3. Use a hosted brief as proof of quality and tracked engagement.
4. When a prospect replies, run a custom report on their actual competitors.
5. Sell a small paid pilot.
6. Convert useful pilots into monthly retainers.

Do not pitch "AI competitive intelligence" as an abstract service. Pitch the outcome:

> Your competitors move every week. We make sure your sales team knows before they walk into a call blind.

## What To Focus On Right Now

Default wedge: **sales tech / RevOps / revenue enablement**.

Why:

- The buyer is already VP Sales, CRO, VP Revenue, Head of Sales Enablement, or Product Marketing.
- The pain is easy to explain: reps get compared against visible competitors constantly.
- The demo ecosystem already fits sales tech: Outreach, Salesloft, Apollo, Gong, Clari.

Cybersecurity is also viable if you are intentionally running a CrowdStrike vs SentinelOne campaign, but do not mix a cybersecurity brief with a sales-tech ICP. Every campaign must align:

- target buyer
- target vertical
- named competitors
- hosted brief
- email copy

If those five do not match, pause before sending.

## The Three Apps

| App | Job | Used For |
| --- | --- | --- |
| `gtm-engine` | Pulls leads, enriches them, writes cold emails, pushes to Instantly or exports CSV | Finding prospects |
| `brief-app` | Hosts public vertical sample briefs and tracks signed opens | Proof artifact and engagement signal |
| `intelligence-engine` | Generates the weekly paid client report | Client delivery |
| `admin-dashboard` | Local-only control panel for allowed scripts across the three apps | Operator convenience |

Simple mental model:

- `gtm-engine` fills the pipeline.
- `brief-app` proves quality.
- `intelligence-engine` is what clients buy.
- `admin-dashboard` is optional; it makes local operations easier but is not part of the client-facing product.

## The Offer

Lead with:

> A weekly competitive intelligence briefing for sales leaders. We track competitor launches, pricing changes, G2 review trends, hiring signals, funding moves, website changes, SEC filings, Reddit/HN chatter, and sitemap diffs, then turn it into a Monday briefing your reps can use in call prep and objection handling.

The paid product is not news monitoring. It is sales enablement powered by competitive intelligence.

Every paid weekly report should include:

- Monday Action Plan
- Objection Handling
- Account Targeting Angles
- Sales Play
- Enablement Update
- What Changed Since Last Week
- 30-Day Momentum once enough history exists
- source-backed competitor activity

## Pricing

| Tier | Setup Fee | Monthly | Best Fit |
| --- | ---: | ---: | --- |
| Starter | $1,000 | $800 | 2 competitors, weekly email only |
| Standard | $2,000 | $1,500 | 3 competitors, weekly briefing, monthly digest |
| Growth | $2,500 | $2,500 | 6 competitors, Slack delivery, alerts, dashboard |
| Strategic | $3,500 | $4,000 | 10 competitors, monthly strategy call, quarterly summary |

Default pitch: anchor on **Growth at $2,500/month**, but offer Starter when the buyer has budget friction.

Use the paid pilot before asking for a full retainer:

> I will monitor your top 3 competitors for 2 weeks and send two Monday battle briefings: what changed, what objections reps should expect, and what to say in live deals. The pilot is $750, credited toward the first month if you keep it weekly.

Pilot rules:

- 2 weeks
- 3 named competitors
- 2 Monday reports
- weekly briefing only
- manual QA before delivery
- no dashboard
- no Slack Connect unless needed to close
- no unlimited free reports

Free reports prove quality. Paid pilots prove buying intent.

## Client Acquisition Motion

### Step 1: Build the wedge

Pick one vertical and two competitors for the hosted proof brief.

Recommended first wedge:

- vertical: sales tech / RevOps
- buyers: VP Sales, CRO, VP Revenue, Head of Sales Enablement, VP Product Marketing
- company size: 50-300 employees first, then 201-500 once the message works
- examples: sales engagement, revenue intelligence, conversation intelligence, enablement, GTM tooling

### Step 2: Generate a fresh vertical brief

From `intelligence-engine`:

```powershell
cd C:\MightX\intelligence-engine
npm run collect-for-brief -- "Sales Tech" "Outreach" "Salesloft"
```

From `brief-app`:

```powershell
cd C:\MightX\brief-app
npm run generate-html-brief -- "Sales Tech" "Outreach" "Salesloft"
npm run deploy:vercel
```

For the current cybersecurity example:

```powershell
cd C:\MightX\intelligence-engine
npm run collect-for-brief -- "Cybersecurity" "CrowdStrike" "SentinelOne"

cd C:\MightX\brief-app
npm run generate-html-brief -- "Cybersecurity" "CrowdStrike" "SentinelOne"
npm run deploy:vercel
```

Production brief URL shape:

```txt
https://intel.nextbuildtech.com/<vertical>-brief.html?id=<CompanyName>
```

Tracked links generated by `gtm-engine` include a signed `trk` token:

```txt
https://intel.nextbuildtech.com/<vertical>-brief.html?id=<leadId>&trk=<signedToken>
```

### Step 3: Send the first email

Best current deliverability posture: **do not put the brief link in email 1 unless you are deliberately testing link-first outreach.**

Use email 1 to lead with one dated signal and a low-friction ask.

Example:

```txt
Subject: Outreach vs Salesloft

Saw one thing your reps may care about: Salesloft just shifted its messaging around [specific dated signal].

My background is in engineering secure, enterprise-grade systems for tier-1 financial institutions, and I recently built a competitive intelligence engine for SaaS revenue teams.

I am running a baseline on Outreach vs Salesloft this week to pull rep-ready talk tracks from live signals.

Worth sending you the Monday version if it is useful?
```

Then use step 2 or a manual reply to deliver the tracked brief link.

If you do use the current delivery-assuming CTA in the first touch, spot-check deliverability carefully and keep volume low.

### Step 4: Use the brief as proof, not the product

The hosted brief is for:

- proof of quality
- tracking engagement
- giving the buyer something concrete to inspect
- follow-up prioritization

It is not a substitute for a custom report once the buyer replies.

Tracked opens are useful, but they are not validation by themselves. Stronger signals:

- reply asking for their competitor set
- repeat opens from the same account
- request for a custom run
- discovery call booked
- willingness to pay for a pilot

### Step 5: Run a custom report for serious prospects

If they reply with interest:

1. Create a prospect config in `intelligence-engine/config/clients/prospect-<slug>.json`.
2. Add their 2-4 actual competitors.
3. Run the report without email.
4. Review the HTML manually.
5. Send it by the promised date.
6. Ask: "Would something like this be useful for your team every Monday?"

Command:

```powershell
cd C:\MightX\intelligence-engine
node scripts/run-client.js prospect-<slug> --no-email
```

Manual QA is expected. If the report reads generic, rerun or tune the config before sending.

### Step 6: Discovery call

Goal: confirm pain, not pitch software.

Ask:

1. When a competitor announces something, how does your team find out?
2. Have reps been caught off guard by a competitor on a call recently?
3. Does anyone own competitive tracking consistently, or is it ad hoc?
4. If you knew every Monday what your top competitors did last week, how would that change prep?

Yes to question 2 and no to question 3 usually means buyer.

### Step 7: Paid pilot

If there is real interest, offer the pilot the same day.

Use:

> Rather than asking you to commit to the full retainer now, let's run a 2-week pilot. You get two Monday battle briefings on your actual competitors. If your team would not use it, we stop there.

After the second pilot report, ask:

> Was this useful enough to keep weekly?

## Cold Email Rules

Must-have:

- one real, verifiable opener
- no invented company facts
- one specific competitor signal
- plain text
- under 140 words for bulk
- no generic "AI" lead
- no "quick question" subject
- no attachments
- no images
- no URL shorteners
- no primary-domain cold sending

Recommended sequence:

1. Email 1: signal-first, no link.
2. Email 2: brief link if no reply.
3. Email 3: one concrete implication for their reps.
4. Manual reply: custom run offer.

If using the bulk prompt, set these in `gtm-engine/.env` before generating copy:

```txt
GTM_BRIEF_CTA_BASE_URL=https://intel.nextbuildtech.com
GTM_BRIEF_HTML_FILENAME=<vertical>-brief.html
GTM_REPORT_COMPETITOR_A=<Competitor A exactly as in brief>
GTM_REPORT_COMPETITOR_B=<Competitor B exactly as in brief>
TRACKING_SIGNING_SECRET=<same secret as brief-app>
```

Email 2 must preserve:

```txt
{{trackingUrl}}
```

`scripts/4-push-instantly.js` replaces it with a signed per-lead URL. `scripts/6-export-copy-csv.js` does the same for manual CSV exports when `TRACKING_SIGNING_SECRET` and `GTM_BRIEF_CTA_BASE_URL` are set.

## Running The GTM Pipeline

From `gtm-engine`:

```powershell
cd C:\MightX\gtm-engine
npm install
npm run pull-leads
npm run enrich
npm run generate-copy
```

Review `gtm-engine/data/copy-*.json` before sending.

If Instantly API is available:

```powershell
npm run push-instantly
```

If Instantly API is not available:

```powershell
npm run export-copy-csv
```

Upload the CSV to Instantly and map:

- `email`
- `first_name`
- `last_name`
- `company_name`
- `ai_subject`
- `ai_body`
- `email_1_subject`
- `email_1_body`
- `email_2_subject`
- `email_2_body`
- `email_3_subject`
- `email_3_body`
- `trackingUrl`
- `title`

Use the sequence fields in Instantly:

```txt
Email 1 subject: {{email_1_subject}}
Email 1 body:    {{email_1_body}}

Email 2 subject: {{email_2_subject}}
Email 2 body:    {{email_2_body}}

Email 3 subject: {{email_3_subject}}
Email 3 body:    {{email_3_body}}
```

`ai_subject` and `ai_body` remain aliases for Email 1 so old single-email campaign templates do not break, but the recommended campaign uses the three explicit sequence steps.

Batch examples:

```powershell
npm run pull-leads -- --max-leads 500
npm run generate-copy -- --first 50
npm run generate-copy -- --file data/processed-companyindustry-e-learning-equals-batch.json
npm run push-instantly -- --first 50
npm run export-copy-csv -- --first 500 --out data/batch-1.csv
```

## One-Off ABM Email

Use this when a prospect replies or when you want one high-quality hand-written email for a named account.

From `brief-app`:

```powershell
cd C:\MightX\brief-app
npm run generate-cold-email -- `
  --industry "Cybersecurity" `
  --prospect-name "Jane Smith" `
  --prospect-company "Acme Corp" `
  --prospect-role "VP Sales" `
  --competitor "CrowdStrike"
```

This reads `public/<industry>-brief.json`, picks the strongest matching signal, and writes three variants to `brief-app/data/cold-emails/`.

## Optional Admin Dashboard

The `admin-dashboard` app is a local-only Next.js control plane. Use it when you want buttons for the same scripts instead of typing commands.

Run it locally:

```powershell
cd C:\MightX\admin-dashboard
npm install
npm run dev
```

Open:

```txt
http://localhost:3000
```

Useful pages:

- `/briefs`: collect signals, generate vertical HTML briefs, deploy, generate one-off cold emails
- `/gtm`: set vertical brief env, generate copy, push to Instantly, inspect output
- `/intelligence`: run client reports and collect-for-brief workflows

Security model:

- only allowlisted npm scripts can run
- arguments are validated before execution
- script execution is local-only and disabled in Vercel/serverless
- `DASHBOARD_SCRIPT_SECRET` protects `POST /api/run-script` when configured

The dashboard is operator convenience. The root playbook and package scripts remain the source of truth.

## Client Delivery

Onboard a client:

```powershell
cd C:\MightX\intelligence-engine
npm run onboard
```

Run without sending:

```powershell
node scripts/run-client.js <client-id> --no-email
```

Run and send:

```powershell
node scripts/run-client.js <client-id>
```

Run all active clients:

```powershell
npm run all-clients
```

Validate latest report:

```powershell
npm run validate <client-id>
```

Generate dashboard:

```powershell
node scripts/generate-dashboard.js <client-id>
```

Generate quarterly summary:

```powershell
node scripts/generate-quarterly-summary.js <client-id>
```

## Report Quality Gates

Before sending any prospect or client report, check:

- findings are specific, not generic AI filler
- at least one item a VP Sales would forward internally
- sources are dated and defensible
- competitor names are correct
- no obvious false positives
- Monday Action Plan is concrete
- Objection Handling is rep-ready
- Account Targeting Angles are useful
- no unfilled placeholders
- report is not thin on a quiet week

The pipeline has automatic validation.

Weekly report blocks delivery if:

- `weekSummary` is too short
- zero competitors have findings
- final HTML is too short
- placeholders remain
- 50% or more of signals failed fact checks

Deep-dive blocks delivery if:

- headline question is too short
- executive answer is too short
- fewer than 2 usable sections exist
- HTML is too short
- placeholders remain
- 50% or more of signals failed fact checks

If validation blocks:

```powershell
cd C:\MightX\intelligence-engine
npm run validate <client-id>
node scripts/run-client.js <client-id> --no-email
```

Review the HTML before sending manually.

## Brief Quality Gates

The public vertical brief is the most scrutinized surface in the funnel.

Before sending traffic to it:

- it must be generated from live signals, not sample mode
- `BRIEF_STRICT_VALIDATION=1` should be on for production runs
- at least 3 talk tracks must be fully worked examples
- at least 2 talk tracks can be templates
- every factual source must have a URL
- no single signal should be repeated everywhere
- pricing section should not look empty
- named analyst byline should be enabled
- CTA should live in the email, not distract from the brief

If the generator fails strict validation, rerun until it passes before launching a campaign.

## Silent Weeks

Quiet weeks should not produce a thin "nothing happened" email.

The intelligence engine scores signal richness:

- `rich`: strong trigger event or high score
- `normal`: enough useful signal for weekly briefing
- `silent`: low score and no trigger event

On silent weeks, the system should send a deep-dive artifact instead of a thin weekly report.

Deep-dive topics include:

- positioning teardown
- pricing forensics
- hiring signals
- scenario essay
- meta-analysis

This protects retention because clients still receive useful analysis when the news cycle is quiet.

## Client Onboarding Checklist

For each new client:

1. Confirm buyer, company, tier, billing, and contact email.
2. Add 3-10 competitors.
3. Add website, G2 slug, SEC ticker/CIK if relevant.
4. Add client product description and ICP.
5. Add known strengths and weaknesses.
6. Run first report with `--no-email`.
7. Review the HTML manually.
8. Fix config issues.
9. Run final delivery.
10. Confirm the client received the report.
11. Create Slack Connect if Growth or Strategic.

Growth tier acceptance checklist:

- full run completes with no fatal errors
- dashboard exists if `includeDashboard` is true
- coverage and data gaps are honest
- at least one sharp forwardable insight exists
- assets match the pitch
- you can explain what was monitored and what was blocked

## Slack Connect Retention

For Growth and Strategic clients, create a shared Slack channel named:

```txt
client-<slug>
```

Pin this expectation:

> This is your direct line to your competitive intelligence analyst. Monday briefing summaries go here, plus ad-hoc requests like "dig deeper on Competitor X", "ignore topic Y", or "add Competitor Z".

Monday post template:

```txt
Your week in 30 seconds, <Client Name>:

Top alert: <headline or no urgent triggers>

What changed since last week: <2-3 bullets>

Sales play for this week: <one sentence>

Full report: <link or attached HTML>

Reply in-thread with anything you want me to dig into before next Monday.
```

Retention signals:

- silence for 3+ weeks means renewal risk
- "add competitor" means expansion signal
- long threads mean the report is becoming workflow
- forwarding to more teammates means multi-seat or portal readiness

## Weekly Operating Rhythm

Monday:

- confirm client jobs ran
- review validation blocks
- post Slack Connect summaries
- send personal trigger-event notes

Tuesday:

- publish one anonymized LinkedIn insight
- follow up on trigger events

Wednesday:

- run one outbound batch
- review copy before send
- monitor reply alerts

Thursday:

- discovery calls
- proposal follow-ups

Friday:

- onboard signed clients
- review pipeline
- clear Slack Connect threads
- update at-risk notes

At 4 clients, expect roughly 4-6 hours per week. At 8 clients, expect roughly 6-10 hours per week.

## Retention Mechanics

Clients stay when the report becomes part of their Monday operating rhythm.

Use:

- Slack Connect for visibility
- trigger-event personal notes
- dashboard for Growth and Strategic clients
- quarterly impact summaries
- win story tracking
- annual contracts with 10-15% discount

When a client tells you the report helped a deal, log it in their config:

```json
"retention": {
  "winStories": [
    "March 2026: pricing alert helped close an $85k deal"
  ]
}
```

One documented win can justify years of subscription cost.

## Revenue Model

Conservative expectation:

- first paying client around month 2-3
- 7 active retainer clients by month 18
- roughly $12.6k forward MRR by month 18
- roughly $133k cumulative revenue over 18 months

Active execution expectation:

- 1 new client per month once motion works
- referrals start around month 4-8
- blended retainer approaches $2k/month
- roughly $36k forward MRR by month 18

Assumptions:

- close rate around 15% from qualified cold-outbound opportunities
- sales cycle 30-45 days
- blended retainer around $1.8k-$2k/month
- churn exists, especially months 2-4
- annual contracts reduce churn

Costs:

- Apollo for outbound
- Instantly for outbound
- domains and hosting
- Anthropic usage
- Resend or SMTP for delivery
- premium scraping APIs only after first paying client

Do not buy Proxycurl, BrightData, Exa, or other premium APIs before the first paying client. The free collectors are enough to validate.

## Environment Variables

Common:

```txt
ANTHROPIC_API_KEY=
```

`gtm-engine/.env`:

```txt
APOLLO_API_KEY=
INSTANTLY_API_KEY=
INSTANTLY_CAMPAIGN_ID=
GTM_BRIEF_CTA_BASE_URL=https://intel.nextbuildtech.com
GTM_BRIEF_HTML_FILENAME=<vertical>-brief.html
GTM_REPORT_COMPETITOR_A=
GTM_REPORT_COMPETITOR_B=
TRACKING_SIGNING_SECRET=
N8N_WEBHOOK_URL=
SLACK_WEBHOOK_URL=
```

`brief-app/.env.local`:

```txt
SLACK_WEBHOOK_URL=
TRACKING_SIGNING_SECRET=
ANTHROPIC_API_KEY=
BRIEF_STRICT_VALIDATION=1
BRIEF_AUTHOR_NAME=
BRIEF_AUTHOR_TITLE=
BRIEF_AUTHOR_CREDENTIAL=
BRIEF_AUTHOR_LINKEDIN=
BRIEF_AUTHOR_AVATAR_URL=
```

`intelligence-engine/.env`:

```txt
ANTHROPIC_API_KEY=
EMAIL_DRIVER=resend
RESEND_API_KEY=
EMAIL_FROM=
EMAIL_FROM_NAME=
EMAIL_REPLY_TO=
OPS_SLACK_WEBHOOK_URL=
SEC_EDGAR_USER_AGENT=
REDDIT_USER_AGENT=
APIFY_API_TOKEN=
```

Email delivery can use Resend or SMTP. Resend is preferred once you have more clients or need cleaner operational delivery.

## Data Sources

Default/free collectors:

- website monitor
- Google News RSS
- G2 public pages
- jobs monitor
- Wayback pricing archive
- pricing buyer-chatter mining
- sitemap diff
- Hacker News
- Reddit
- SEC EDGAR 8-K for public companies when configured

Optional/premium collectors:

- LinkedIn
- Glassdoor
- GitHub
- Crunchbase
- richer full-text scraping via Apify or similar providers

Be honest in sales copy. Do not claim full LinkedIn API enrichment unless that premium collector is actually enabled.

## Troubleshooting

| Problem | First Check |
| --- | --- |
| No Slack open alerts | `TRACKING_SIGNING_SECRET` must match in `gtm-engine` and `brief-app` |
| Brief link 404s | `GTM_BRIEF_HTML_FILENAME` must match a deployed file |
| Email names wrong competitors | Set `GTM_REPORT_COMPETITOR_A/B` to match the brief |
| Brief is in sample mode | Run `collect-for-brief` before `generate-html-brief` |
| Strict brief generation failed | Rerun generator until quality gates pass |
| Instantly API fails | Use `npm run export-copy-csv` and upload manually |
| Report blocked | Run `npm run validate <client-id>` |
| Weekly report too thin | Confirm silent-week deep-dive selection |
| Resend fails | Verify `EMAIL_FROM` domain in Resend |
| SEC collector skipped | Add `secTicker` or `secCik` and `SEC_EDGAR_USER_AGENT` |
| Reddit blocked | Set a descriptive `REDDIT_USER_AGENT` |
| First sitemap diff empty | Expected on first snapshot |

## The 30-Day Plan

Week 1:

- pick one wedge
- regenerate one fresh strict-validated vertical brief
- deploy `brief-app`
- verify tracking health
- generate Gold Standard demo report
- set up domains, SPF, DKIM, DMARC

Week 2:

- build 30-account validation list
- identify 2-3 competitors for each account
- write/send low-volume signal-first outreach
- do not scale until replies indicate the message works

Week 3:

- deliver custom reports to interested prospects
- book discovery calls
- offer paid pilot

Week 4:

- close 1 paid or discounted pilot
- fulfill first Monday report
- collect feedback
- tighten ICP and copy

Validation goal:

- 2 buyers who move past polite interest
- 1 discovery call
- 1 paid or discounted pilot

If you hit that, keep going. If you get opens but no replies, adjust copy or wedge. If people like the report but will not pay for a pilot, reposition the offer.

## File Map

The repo should be understood through code and this playbook:

```txt
C:\MightX
├── README.md                         # this playbook
├── admin-dashboard                    # optional local control plane
├── gtm-engine                        # outbound pipeline
│   ├── config\icp.json
│   ├── prompts\personalization.txt
│   └── scripts
├── brief-app                         # hosted sample briefs and tracking
│   ├── public
│   ├── proxy.ts
│   ├── app\brief\page.tsx
│   └── scripts\generate-html-brief.js
└── intelligence-engine               # paid client delivery
    ├── config\clients
    ├── prompts
    ├── templates
    ├── scripts\run-client.js
    ├── scripts\generate-report.js
    ├── scripts\validate-report.js
    └── scripts\collectors
```

Policy: this `README.md` is the operating source of truth. Keep future strategy changes here instead of creating new playbook docs.
