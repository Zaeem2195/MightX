# Business Operations Guide
## Autonomous B2B Competitive Intelligence Service

---

> **Looking for what to do right now?** Open `START-HERE.md` — it is the step-by-step execution guide. This document is the strategic reference. Read it once, then operate from `START-HERE.md`. For **projection math, path notes, and caveats**, see `DOCUMENTATION-NOTES.md`.

---

## 1. What This Business Is

You run a weekly competitive intelligence briefing service for B2B SaaS companies. Every Monday morning, your clients receive a professionally formatted email report that tells them exactly what their competitors did the previous week — website changes, product announcements, press coverage, G2 review trends, hiring signals — and what it means for their sales pipeline.

You do not write the reports. Claude does.
You do not collect the data. The system does.
You do not send the emails. Resend (or SMTP as a fallback) sends them; n8n triggers the Monday cron.

Your job is to close clients, configure their setup, and collect the retainer.

**What the system monitors autonomously per competitor:**
- Competitor websites — homepage, /pricing, /features diffed weekly against last snapshot
- **Pricing archaeology** — the Wayback Machine (Internet Archive) is queried for `/pricing` and `/plans` snapshots over the last 90 days; the collector extracts price tokens and plan/tier mentions and diffs earliest vs latest. Free, always on. A proprietary signal most prospects cannot replicate with ChatGPT.
- Google News RSS — free, no API key, covers press releases and announcements
- G2 public review pages — recent reviews, aggregate ratings, trending complaints
- Job postings — careers page scraped and categorised by AI/ML, enterprise, sales, product roles
- LinkedIn company pages — announcements and activity (enabled per client config)
- GitHub org activity — public releases, changelog commits (for devtool competitors)
- Funding & corporate signals — rounds, acquisitions, layoffs (news-based; align sales claims with `DOCUMENTATION-NOTES.md`)
- **SEC EDGAR 8-K filings** — for public-company competitors only (configure `secCik` or `secTicker` and set `additionalCollectors.secFilings: true`). 8-K is the legal requirement to disclose material events within 4 business days. Unimpeachable, zero-cost, and faster than Google News for material changes.
- **Sitemap diff** — `/sitemap.xml` (plus `/robots.txt` + sitemap indexes) is fetched weekly and diffed against the prior snapshot. Net-new URLs are grouped by top-level path (`/customers`, `/product`, `/pricing`, `/blog`, …). This is the silent-week workhorse: even on weeks where nothing makes the news, the sitemap almost always has net-new pages worth commenting on.
- **Hacker News (Algolia)** — last 30 days of stories about the competitor with a score + comment floor. Leading indicator for infra / dev-tool / product launches.
- **Reddit public search** — last 30 days of posts about the competitor across all subs, ranked by score + comment count. Often surfaces pricing + rollout + churn discussion before it hits G2.

**Weekly continuity — "What Changed Since Last Week":**
The report writer auto-loads the client's most recent prior report and emits a `changesSinceLastWeek` block (progressed / stillWatching / newThisWeek). This directly addresses the "month 3 feels like month 1" churn risk — the report explicitly shows each week what has moved, what is still open, and what is genuinely new.

**Rolling 30-day momentum — "30-Day Momentum":**
From week 2 onwards, the writer also loads the last 4–8 `report-content-*.json` files for the client and emits a `rollingHistory` block (recurring themes, momentum shifts, and competitors who were loud and have since gone silent). A deterministic local scan (`computeLocalPatterns` in `generate-report.js`) backs the claims with counts across weeks — the pattern section is not model-hallucinated summary, it is computed before the prompt.

**Silent-week handling — deep-dive artifact switch:**
Every run scores signal richness (trigger events, verified findings, breadth across competitors and signal types). On silent weeks (score < 6, no trigger events), the pipeline automatically ships a different deliverable: a single-topic `deep-dive` memo grounded in the rolling 30–90 days of archived data, with a dark indigo header, a topic badge, and an amber "silent-week" strip. Topics rotate through five playbooks (positioning-teardown, pricing-forensics, hiring-signals, scenario-essay, meta-analysis) tracked in `data/<client>/artifact-history.json` so the client never sees the same deep-dive twice in a row. Tunable per-client via `reportPreferences.richnessThresholds`, `forceArtifact`, `deepDiveRotation`, `deepDiveFocus`.

**Pre-send validation gate:**
Every artifact passes through `scripts/validate-report.js` before email. Hard failures block delivery, keep the HTML on disk, and (if `OPS_SLACK_WEBHOOK_URL` is set) ping you on Slack. Weekly-news requires a non-trivial `weekSummary`, ≥1 competitor section with findings, HTML ≥3 kB, no unfilled `{{PLACEHOLDER}}`, fact-check failure rate <50%. Deep-dive requires `headlineQuestion` ≥30 chars, `executiveAnswer` ≥60 chars, ≥2 usable analysis sections, HTML ≥3.5 kB. No degenerate Monday email ever reaches a client without your review.

**Conversion surface — prospect-facing brief + cold-email pipeline:**
Top-of-funnel sits in `brief-app` and is built to convert cold-outbound prospects into discovery calls.
- **Vertical brief** (`brief-app/scripts/generate-html-brief.js`) — an editorial, serif-display HTML page scoped to a vertical with two named competitors (e.g. E-Learning · Docebo vs Absorb LMS). Rendered as a static file served from `brief-app/public/<slug>-brief.html`. Serves as proof-of-quality in cold email. For slugs that contain hyphens, a mirror copy without hyphens is written alongside (e.g. `elearning-brief.html`) so legacy cold-email URLs in circulation keep resolving.
- **Skim-path table of contents** sits above the fold inside the brief header. A CRO opening the link on mobile at 7 AM can scan to Trigger Events, Pricing, or Talk Tracks in one tap.
- **Analyst byline** renders in the trust block at the bottom of the brief when the `BRIEF_AUTHOR_*` env vars are set (name, title, credential, LinkedIn, optional avatar). Converts "anonymous AI tool" into "private research note from a named operator" — the single biggest trust delta on the brief. The outbound ask (book a call) lives in the cold-email body, not on the brief page, so the prospect's first click lands on analysis, not a pitch.
- **Per-prospect cold-email generator** (`brief-app/scripts/generate-cold-email.js`, Claude Opus 4.7) reads the brief JSON, picks the sharpest signal matching the prospect's feared competitor, and drafts three cold-email variants (pattern-interrupt, helpful-frame, peer-reference) with a personalised brief URL (`?id=<company>`). Validation enforces 40–80 word bodies, specific subjects, soft CTAs, and brief-URL inclusion. Drafts land in `brief-app/data/cold-emails/<industry>--<company>.md` (gitignored) and print to stdout. This is the **1:1 ABM** tool — the bulk-outbound copy generator for Instantly lives in `gtm-engine/scripts/3-generate-copy.js` and uses Claude Sonnet for cost-efficiency at scale.

**What you are selling, in one sentence:**
> "Your competitors are moving every week. We make sure you know about it before your sales team walks into a call blind."

**Why this beats the GTM Engine model for minimal oversight:**
The GTM Engine requires you to respond to interested replies in real-time, monitor domains, and manage outbound deliverability. This model delivers a tangible product autonomously every Monday regardless of whether you look at it. A client never needs to call you because something went wrong. They call you to expand.

---

## 2. The Market Opportunity

### Recommended wedge for first validation

Although the service can be adapted to multiple B2B SaaS categories, the highest-odds first wedge for this repo is **sales tech**:

- The GTM Engine already targets VP Sales / CRO buyers.
- The example client and demo competitors are already sales-tech-native (`Outreach`, `Salesloft`, `Apollo.io`, `Gong`, `Clari`).
- The pain is immediate and easy to explain: reps get compared against visible competitors constantly, and outdated competitor knowledge hurts live deals.

This does **not** mean the long-term business must stay narrow. It means your first proof loop should be easier to sell, easier to demo, and easier to learn from.

### Why competitive intelligence is a high-demand service right now

B2B SaaS markets have compressed dramatically. In 2019, the average VP of Sales competed against 3–5 serious alternatives. In 2026, they compete against 15–30. Every category — CRM, sales engagement, data enrichment, customer success — has fragmented into dozens of funded competitors.

The response time between a competitor's product announcement and a client asking your sales rep about it is now measured in days, not months. Sales teams that are not continuously monitoring competitors are walking into calls uninformed and losing deals to objections they could have prepared for.

**The existing market for CI software is large and validated:**
- Klue raised $62M and serves enterprise teams at $15,000–$80,000/year
- Crayon raised $55M+ at similar price points
- Kompyte was acquired by Semrush for $120M
- Battlecards.io, Sparklane, and Episerver all have eight-figure valuations

All of these are software products requiring the client to have a dedicated "competitive intelligence manager" to run them. Most B2B SaaS companies at 50–200 employees do not have that person.

**The gap you fill:**
A fully managed, done-for-you service at $1,500–$4,000/month — with zero software to learn, zero internal resource required, and a report in the inbox every Monday. You are 10x cheaper than enterprise CI platforms and 100x less effort for the client.

### Your ICP (Ideal Customer Profile)

**Primary target:**
- B2B SaaS companies, 50–300 employees
- Have a sales team of 3+ reps
- Operate in a competitive category (sales tech, martech, HR tech, fintech, devtools, customer success)
- Buyer: VP of Sales, CRO, VP of Product Marketing, Head of Sales Enablement

**Why they buy:**
- They are losing deals to competitors and do not know why
- Their reps are caught off-guard by competitor announcements on calls
- They have no internal bandwidth to track 5+ competitors consistently
- They have seen a competitor raise funding or launch a new feature and felt blindsided

**Why they stay:**
The report becomes a fixture in their Monday morning routine. Cancelling it feels like turning off a smoke detector — nothing may happen, but the downside of being caught uninformed outweighs the $2,500/month cost. Average client lifetime in a well-run intelligence service is 18–24 months.

---

## 3. Pricing Structure

### Service Tiers

| Tier | Setup Fee | Monthly Retainer | What They Get |
|---|---|---|---|
| **Starter** | $1,000 | $800/month | 2 competitors, weekly briefing email only |
| **Standard** | $2,000 | $1,500/month | 3 competitors, weekly briefing, monthly deep-dive digest |
| **Growth** | $2,500 | $2,500/month | 6 competitors, weekly briefing, monthly digest, Slack delivery, trigger event alerts, client dashboard |
| **Strategic** | $3,500 | $4,000/month | 10 competitors, everything above, monthly 45-min strategy call with you, quarterly impact summary |

**Why the Starter tier exists:** The $800/month tier removes buying friction for budget-conscious teams. A VP of Sales can expense $800/month without a finance review at most 50–200 person companies. This gets clients in the door faster, proves value in the first 4 weeks, and creates a natural upsell path to Growth when they inevitably want more competitors and Slack delivery. Expect 40–60% of Starter clients to upgrade within 3 months.

**What "Slack delivery" means operationally (Growth and Strategic):** Create a Slack Connect channel per client (`client-<slug>`), share it with their workspace, and post the Monday briefing summary there in addition to email. This is the two-way surface that turns the report from a passive artifact into an analyst-on-Slack relationship. Full workflow, intro message templates, and weekly rhythm in `docs/CLIENT-SLACK-CONNECT-PLAYBOOK.md`. You can also do this for Starter clients as a differentiator if capacity allows.

**Recommended default pitch:** Lead with Growth at $2,500/month as the anchor, but offer Starter when you sense price hesitation. The worst outcome is a client paying $800/month — the best outcome is they upgrade to $2,500/month within a quarter because the reports became indispensable.

**Setup fee psychology:** The setup fee accomplishes two things. First, it filters out tyre-kickers — anyone unwilling to pay $1,000 upfront will also cancel the retainer at the first sign of friction. Second, it covers your time to configure the system (2–3 hours per client), write the first report prompt calibration, and do the initial quality review.

### Annual Contracts

Offer a **10–15% discount for annual prepayment**:

| Tier | Monthly | Annual (15% off) | Annual Savings |
|---|---|---|---|
| **Starter** | $9,600/yr | $8,160/yr | $1,440 |
| **Standard** | $18,000/yr | $15,300/yr | $2,700 |
| **Growth** | $30,000/yr | $25,500/yr | $4,500 |
| **Strategic** | $48,000/yr | $40,800/yr | $7,200 |

Annual contracts accomplish three things: (1) front-load cash for reinvestment, (2) dramatically reduce churn because the client has committed psychologically and financially, and (3) simplify your revenue forecasting. Push annual contracts from the first proposal — frame it as "the Growth annual plan is $25,500, which comes out to $2,125/month vs $2,500 on the monthly plan."

### Annual Value Framing

When a prospect hesitates on the retainer, use this:

> "You are paying one CI platform or one analyst tool $15,000–$40,000 a year, plus the internal time to run it. We deliver the same output — a briefing every Monday, trigger alerts when something significant happens — for $30,000 a year with zero internal overhead. And if it is not valuable, you cancel with 30 days notice."

At $2,500/month, the client pays $30,000/year. A single deal they save or win by being better prepared than a competitor pays for multiple years of this service.

---

## 4. The Full Business Cycle

### Phase 1 — Client Acquisition (Weeks 1–3 per client)

**Step 1: Build your outbound list**

Use the GTM Engine (already built in `../gtm-engine`) targeting:
- Title: VP of Sales, CRO, VP of Product Marketing, Head of Sales Enablement, Director of Competitive Intelligence
- Company: 50–300 employees, B2B SaaS, US-based
- Signal: companies that have raised Series A or B in the last 18 months (growth stage = competitive pressure)

The GTM Engine's Apollo + Claude + Instantly stack finds these people, writes personalised cold emails, and books discovery calls. You run it for your own pipeline the same way you will run it for clients.

**Step 2: The cold email angle**

Do not pitch "competitive intelligence service." Lead with a **specific, dated competitor signal** lifted from a live vertical brief. The repo now has a purpose-built generator (`brief-app/scripts/generate-cold-email.js`) that does exactly this: it reads the vertical brief JSON you already produced, picks the sharpest signal that mentions the prospect's most-feared competitor, and drafts three short cold-email variants (pattern-interrupt, helpful-frame, peer-reference) with a personalised brief URL (`?id=<company>`).

Run per prospect:

```bash
cd brief-app
npm run generate-cold-email -- \
  --industry        "E-Learning" \
  --prospect-name   "Jane Doe" \
  --prospect-company "Acme Corp" \
  --prospect-role   "VP Sales" \
  --competitor      "Docebo"
```

The three drafts land in `brief-app/data/cold-emails/<industry>--<company>.md` and also print to stdout for paste-into-Apollo/Instantly. Validation is enforced at the source: 40–80 word body, specific subject (no "Quick question"), every factual claim grounded in the brief, soft CTA only. Pick the variant you trust; send.

If the prospect replies, run a **custom** capture for **their** competitors using the free collectors. Create a throwaway `config/clients/prospect-[name].json`, run the intelligence engine, review the HTML, and send by Monday. ~30 min of your weekend per prospect. Reference the Gold Standard demo (`demo-salesloft`) only when someone asks for format proof — not as the default fulfillment.

**Step 3: The discovery call**

Goal: confirm the pain, not pitch the service.

Key questions:
- "When a competitor announces a new feature or raises a round, how does your team find out?"
- "Have your reps ever been caught off-guard by a competitor on a call in the last quarter?"
- "Do you have someone internally tracking competitors consistently, or is it ad hoc?"
- "If you knew every Monday morning exactly what your top 5 competitors did last week, how would that change how your team prepares?"

If they answer yes to question 2 and no to question 3, they are a buyer. Move to the proposal the same day.

**Step 4: The proposal**

Send a one-page email proposal within 4 hours of the discovery call. Include:
- The custom report you already sent them (or a fresh run for their exact competitors)
- Three tier options with pricing
- A 30-day satisfaction guarantee (if the first 4 reports are not valuable, full refund — you will never trigger this)
- A link to book the kickoff call

**Step 5: Closing**

The most common objection is "we need to think about it." The correct response:

> "Totally understand. I will generate one more live report this Monday — your actual competitors, this week's real signals — and send it to you so you can see exactly what your team would receive. If it is not worth $2,500 a month, tell me and we close it there."

You generate the second free report using the system. Takes you 5 minutes. Closes 60–70% of stalled deals.

---

### Phase 2 — Client Onboarding (1–2 hours per client)

**What you do once:**

1. Duplicate `config/clients/example-client.json` → `config/clients/[client-id].json`
2. Fill in:
   - Client name and contact email
   - Their product description and ICP (from the discovery call notes)
   - Their differentiators and known weaknesses
   - Their top 3–10 competitors with website URLs, G2 slugs, LinkedIn slugs
3. Run the first report manually: `node scripts/run-client.js [client-id] --no-email`
4. Open `data/[client-id]/report-*.html` in a browser
5. Review it for quality — check that competitor names are correct, findings are relevant, trigger emails make sense for their space
6. Adjust prompts in `prompts/` if the tone or framing needs calibration for this client
7. Run the final version with email: `node scripts/run-client.js [client-id]`
8. Confirm the client received the report and it rendered correctly

Total time: 2 hours maximum, including quality review.

The system then runs autonomously every Monday. You never touch it again unless the client requests changes.

---

### Phase 3 — Ongoing Delivery (Autonomous)

The n8n cron workflow fires every Monday at 6am. It runs `run-all-clients.js`, which processes every active client config. Each client receives their report via email before they start their work week.

**Your Monday morning task:** Check Slack. The n8n workflow posts a summary showing which clients received reports and whether any trigger events were detected. If everything is green, you are done for the week on delivery.

**When something breaks:** n8n posts an error alert to Slack. Common failure points:
- G2 changed their HTML structure (fix: update `g2-monitor.js` selector patterns)
- A competitor website is down or blocks the scraper (fix: remove that URL temporarily)
- Claude API rate limit hit (fix: increase `DELAY` in `analyse.js`)
- SMTP credentials expired (fix: refresh app password in Google account) or Resend `EMAIL_FROM` no longer verified (fix: re-verify in Resend dashboard)
- Validation gate blocked a client's report (fix: run `npm run validate <id>` to see failing checks, correct, and deliver manually)
- Wayback CDX API timed out for a competitor (self-heals next week; no action required)
- Reddit public search returned 429/blocked responses (self-heals, usually transient; set `REDDIT_USER_AGENT` in `.env` to something distinctive)
- Sitemap collector is reporting "first snapshot — no diff" for weeks (competitor's sitemap URL is changing or blocked; override with `competitor.sitemapUrl` in the client config)
- A deep-dive shipped and the client expected the usual weekly briefing — expected on silent weeks (see runbook §12). If the client always wants weekly-news, set `reportPreferences.forceArtifact: "weekly-news"` in their config

None of these are emergencies. Fix them before the next Monday run. The validation gate specifically ensures a bad report cannot reach a client while you sleep.

**Weekly client touch (new, cheap, high-retention):**
Alongside the automated Monday email, post the same briefing summary into each client's Slack Connect channel and triage any ad-hoc asks by Friday. Full workflow in `docs/CLIENT-SLACK-CONNECT-PLAYBOOK.md`. This is the Tier 1 productization move that converts the report from a passive artifact into a visible, two-way surface — the biggest single lever on month-3 renewal odds.

---

### Phase 4 — Client Retention and Expansion

**Monthly check-in call (Strategic tier only):**
45 minutes on the first Tuesday of each month. Agenda:
- Walk through the most significant finding from the past 4 reports
- Ask: "Did any of these findings change how your team approached a conversation?"
- Update competitor list if they want to add or remove a name
- Ask if there are departments beyond sales (product, marketing) who would benefit from the report

**Expansion signals to watch for:**
- Client forwards the report to additional team members → pitch adding cc emails or a second seat
- Client asks "can you also track X?" where X is a fourth category → upsell to next tier
- Client mentions the report to their CMO or CPO → warm intro to a new buyer within the same company
- Client refers you to a peer at another company → most powerful acquisition channel, handle immediately

**Reducing churn:**
The primary churn risks are (a) the report becoming routine and (b) a stretch of quiet weeks where nothing newsworthy happens and the client quietly concludes they aren't getting their money's worth. Prevent both by:
- Flagging the two most important findings in the subject line ("Outreach just cut enterprise pricing — this week's briefing")
- When a trigger event occurs, send a separate short email the same day highlighting it (the system flags these — you send a 3-line personal note)
- On quarterly renewal months, send a "4-week summary" report compiled from the last 4 briefings — reinforces accumulated value
- **Silent-week coverage is now automatic:** When a week scores low on signal richness, the pipeline automatically ships a deep-dive (positioning teardown, pricing forensics, hiring signals, scenario essay, or meta-analysis) instead of a thin "not much happened" email. The client gets a differently-shaped high-value artifact, and the subject line in `generate-report.js` / `deliver.js` reflects the deep-dive topic. This is the single biggest mechanical lever on month-3+ retention, because it attacks the failure mode where $2k/mo feels wasted on a quiet Monday.
- **Rolling 30-day momentum is the second lever:** Every report from week 2 onwards carries a "30-Day Momentum" section showing recurring themes, shifts, and competitors going quiet. Even when a single week is light, the client sees a month of accumulated pattern recognition — which is what they actually bought.

---

### Phase 5 — The Flywheel

At 4+ clients, referrals become your primary acquisition channel. Every client is a VP of Sales or CRO who has a professional network of other VPs of Sales and CROs. Ask directly:

> "Is there anyone else in your network running a sales team in a competitive category who might benefit from this? I will set up their first two reports for free if they come through you."

A referred client closes 3x faster and churns 50% less often than a cold-outbound client. Prioritise building this channel from month 4 onward.

---

## 5. Your Weekly Operating Rhythm

This is the full time commitment once the business is running.

| Day | Task | Time |
|---|---|---|
| **Monday** | Check Slack for n8n run confirmation. Review any error alerts. Verify dashboards regenerated. | 15 min |
| **Tuesday** | Review any trigger event alerts. Send personal 3-line email to clients affected. Publish weekly LinkedIn post. | 30–45 min |
| **Wednesday** | Run GTM Engine outbound batch (50 new leads, using `../gtm-engine`). | 20 min |
| **Thursday** | Discovery calls and proposal follow-ups. | Variable |
| **Friday** | Onboard any new clients signed this week. Review pipeline. Check email open rates for churn signals. | 0–2 hrs |
| **Quarterly** | Run impact summaries for all clients. Send personal renewal notes. Review prompt quality. | 2–3 hrs |

**Total weekly time at 4 clients:** 4–6 hours.
**Total weekly time at 8 clients:** 6–10 hours (mostly weighted toward Tuesday/Wednesday/Thursday activity).

This is designed to run alongside your full-time role at Scotiabank.

---

## 6. Cost Structure

### Pre-revenue phase (Concierge MVP — zero premium API spend)

Until the **first paying client** signs, do **not** purchase premium scraping APIs (Proxycurl, BrightData, Exa). The free collectors (Google News RSS, careers pages, G2 search snippets, Wayback Machine pricing archaeology, SEC EDGAR, sitemap diff, Hacker News, Reddit) already produce report quality sufficient to close deals — proven by the Gold Standard demo. Prospect fulfillment is manual concierge work (~30 min/prospect on your weekend using free sources).

| Item | Pre-revenue cost | Notes |
|---|---|---|
| Premium scraping APIs | **$0** | Buy only after first retainer is collected |
| Anthropic API | ~$5–10 | Gold Standard + a few prospect runs |
| Apollo.io | ~$99 | For your own outbound |
| Instantly | ~$97 | For your own outbound |
| Domain + hosting | ~$20 | For outbound sending domains |
| **Total pre-revenue** | **~$221/month** | Covers outbound + concierge runs |

### Post-revenue phase (monthly operating costs)

Once client retainers arrive, add premium APIs to improve weekly report depth:

| Item | Cost | Notes |
|---|---|---|
| Anthropic API | ~$15–40 | Scales with client count. ~$5–8/client/month at current usage |
| Proxycurl / BrightData | ~$50–100 | Funded by first client retainer. LinkedIn + deeper scraping |
| nodemailer / SMTP | $0 | Gmail + App Password — fine up to ~10 clients / ~500 emails/day |
| Resend (recommended past 10 clients) | $0–20 | Free tier: 100/day, 3k/month. Paid starts $20/mo for 50k. Also unlocks per-client from-domain branding |
| Wayback Machine (Internet Archive) | $0 | Pricing-archive collector, unlimited, no key |
| SEC EDGAR | $0 | 8-K filings for public competitors, no key (descriptive UA required) |
| Competitor sitemap / robots.txt | $0 | Week-over-week URL diff, silent-week workhorse, no key |
| Hacker News (Algolia Search API) | $0 | Competitor mentions, unlimited, no key |
| Reddit public JSON search | $0 | Competitor mentions across all subs, unlimited, no key (descriptive UA required) |
| n8n (self-hosted) | $0 | You already have this |
| Apollo.io | ~$99 | For your own outbound only |
| Instantly | ~$97 | For your own outbound only |
| Domain + hosting | ~$20 | For your own outbound sending domains |
| **Total fixed** | **~$281–351/month** | Does not scale with client count |
| **Total variable** | **~$5–8/client/month** | Claude API usage |

**Blended tier example (4 clients):** Starter $800 + Standard $1,500 × 2 + Growth $2,500 = **$6,300/month** retainer. Costs: $231 fixed + ~$32 variable (4 × $8) ≈ **$263/month** → **~$6,037/mo gross profit** (~96% gross margin on the blended book).

**All-Growth example (4 × $2,500):** $10,000/month retainer vs ~$259 costs → **~97.4% gross margin** (use when you are fully upmarket).

---

## 7. Revenue Projections — 18 Months

### Assumptions (revised for realism)

These projections incorporate honest assumptions based on B2B SaaS benchmarks for a solo-operated service business:

| Assumption | Original | Revised | Rationale |
|---|---|---|---|
| Close rate | 25% | 15% | Industry benchmark for cold-outbound-sourced B2B deals at $10k+ ACV. A strong custom baseline proof helps but does not fully offset brand/trust gap for a new service. |
| Sales cycle | Same-month close | 30–45 days average | $2,500/month requires VP-level budget sign-off at most 50–200 person companies. |
| Churn rate | 0% modeled | 15% annual | Realistic for first 12 months of an unproven solo service. Drops to 8–10% once you have 6+ months of proven delivery. |
| Average deal size | $2,500/mo (Growth) | $1,800/mo blended | Mix of Starter ($800), Standard ($1,500), and Growth ($2,500) clients weighted toward the middle. |
| Discovery calls/week | 2–3 from month 2 | 1–2 from month 3 | Constrained by Scotiabank full-time role and inbox warmup timeline. |

### How to read the projection tables

These tables use a **fixed accounting convention** so every row reconciles:

| Rule | Meaning |
|---|---|
| **Setup fee** | Collected in the month the client signs. |
| **First retainer** | The first monthly retainer is charged **starting the month after** signup (matches “setup + kickoff, then billing begins”). |
| **Retainer MRR** | Sum of all clients who are **in their retainer billing period** that month. |
| **Active (retainer)** | Count of clients paying retainer **at end of month** (after any churn). |
| **Churned** | A client who leaves at **end of month** still pays their full retainer for that month; they are removed from **Active** and from next month’s **Retainer MRR**. |

**Signup month vs. billing month:** When **New** = 1, **Setup Rev** is collected that month, but that client’s **first retainer** is included **starting the next month**. **Monthly Rev** = Setup Rev + Retainer MRR for that calendar month.

**Ending MRR vs. last month’s retainer cash:** In a month with **Churned** = 1, up to **N** clients may still pay retainer (full month) before the churn takes effect at month-end — so **Retainer MRR** that month can be **N × blended rate** even though **Active (retainer)** at month-end is **N − 1**. The **forward run-rate** entering the next month is **Active (retainer) × blended rate** (e.g. month 18 ends with 7 clients → **$12,600/mo** forward MRR at $1,800 each, while month 18 **collected** $14,400 in retainer fees from eight in-billing clients).

### Conservative Scenario (Realistic Base Case)
*Slow ramp. 1 new client every 5–6 weeks from month 3. Blended **$1,800/mo** per retainer client. **~15% annual churn** modeled as one departure at quarter-end once the base is large enough (FIFO: oldest client). Rows below are **reconciled** to that convention.*

| Month | New | Churned | Active (retainer) | Setup Rev | Retainer MRR | Monthly Rev | Cumulative |
|---|---|---|---|---|---|---|---|
| 1 | 0 | 0 | 0 | $0 | $0 | $0 | $0 |
| 2 | 0 | 0 | 0 | $0 | $0 | $0 | $0 |
| 3 | 1 | 0 | 0 | $1,500 | $0 | $1,500 | $1,500 |
| 4 | 0 | 0 | 1 | $0 | $1,800 | $1,800 | $3,300 |
| 5 | 1 | 0 | 1 | $1,500 | $1,800 | $3,300 | $6,600 |
| 6 | 0 | 0 | 2 | $0 | $3,600 | $3,600 | $10,200 |
| 7 | 1 | 0 | 2 | $2,000 | $3,600 | $5,600 | $15,800 |
| 8 | 1 | 0 | 3 | $2,000 | $5,400 | $7,400 | $23,200 |
| 9 | 0 | 1 | 3 | $0 | $7,200 | $7,200 | $30,400 |
| 10 | 1 | 0 | 3 | $2,000 | $5,400 | $7,400 | $37,800 |
| 11 | 1 | 0 | 4 | $2,000 | $7,200 | $9,200 | $47,000 |
| 12 | 0 | 1 | 4 | $0 | $9,000 | $9,000 | $56,000 |
| 13 | 1 | 0 | 4 | $2,000 | $7,200 | $9,200 | $65,200 |
| 14 | 1 | 0 | 5 | $2,500 | $9,000 | $11,500 | $76,700 |
| 15 | 1 | 1 | 5 | $2,500 | $10,800 | $13,300 | $90,000 |
| 16 | 1 | 0 | 6 | $2,500 | $10,800 | $13,300 | $103,300 |
| 17 | 1 | 0 | 7 | $2,500 | $12,600 | $15,100 | $118,400 |
| 18 | 0 | 1 | 7 | $0 | $14,400 | $14,400 | $132,800 |

**Forward MRR after month 18:** 7 × $1,800 = **$12,600/month** (retainer run-rate entering month 19).

**18-month cumulative revenue:** **~$132,800**

This is a side business producing ~$133k in 18 months on 5–8 hours/week. Still an exceptional outcome.

---

### Moderate Scenario (Active Execution)
*Active outbound from month 2. 1 new client/month from month 4. Referral channel kicks in month 8. Blended ACV rises to $2,000 as you shift toward Growth tier. 12% annual churn (better retention from dashboard + annual contracts).*

| Month | New | Churned | Active | Setup Rev | Retainer MRR | Monthly Rev | Cumulative |
|---|---|---|---|---|---|---|---|
| 1 | 0 | 0 | 0 | $0 | $0 | $0 | $0 |
| 2 | 1 | 0 | 1 | $1,500 | $0 | $1,500 | $1,500 |
| 3 | 1 | 0 | 2 | $2,000 | $1,800 | $3,800 | $5,300 |
| 4 | 1 | 0 | 3 | $2,000 | $3,600 | $5,600 | $10,900 |
| 5 | 1 | 0 | 4 | $2,000 | $5,600 | $7,600 | $18,500 |
| 6 | 1 | 0 | 5 | $2,500 | $7,600 | $10,100 | $28,600 |
| 7 | 1 | 0 | 6 | $2,500 | $10,000 | $12,500 | $41,100 |
| 8 | 2 | 0 | 8 | $5,000 | $12,000 | $17,000 | $58,100 |
| 9 | 1 | 1 | 8 | $2,500 | $16,000 | $18,500 | $76,600 |
| 10 | 2 | 0 | 10 | $5,000 | $16,000 | $21,000 | $97,600 |
| 11 | 1 | 0 | 11 | $2,500 | $20,000 | $22,500 | $120,100 |
| 12 | 1 | 1 | 11 | $2,500 | $22,000 | $24,500 | $144,600 |
| 13 | 2 | 0 | 13 | $5,000 | $22,000 | $27,000 | $171,600 |
| 14 | 1 | 0 | 14 | $2,500 | $26,000 | $28,500 | $200,100 |
| 15 | 2 | 1 | 15 | $5,000 | $28,000 | $33,000 | $233,100 |
| 16 | 1 | 0 | 16 | $2,500 | $30,000 | $32,500 | $265,600 |
| 17 | 2 | 0 | 18 | $5,000 | $32,000 | $37,000 | $302,600 |
| 18 | 1 | 1 | 18 | $2,500 | $36,000 | $38,500 | $341,100 |

**Month 18 — last month’s retainer cash (Monthly Rev):** ~$38,500 | **Forward MRR entering month 19:** ~$36,000 (18 paying clients × ~$2,000 blended after churn). **18-month cumulative revenue:** ~$341,000.

**Precision note:** This scenario uses a **rising blended retainer** per row (not a fixed $2,000 for every client). **Cumulative** equals the sum of the **Monthly Rev** column; individual **Retainer MRR** cells are illustrative of tier mix (Starter through Growth). If you need board-level audit, rebuild in a spreadsheet using the same rules as the conservative table (details in `DOCUMENTATION-NOTES.md`).

---

### Key Revenue Milestones (Revised)

| Milestone | Conservative | Moderate |
|---|---|---|
| First $10K month | Month 11 | Month 6 |
| First $20K month | Not reached in 18mo | Month 10 |
| First $30K month | Not reached in 18mo | Month 15 |
| $50K cumulative | Month 11 | Month 8 |
| $100K cumulative | Month 16 | Month 10 |
| $250K cumulative | Not reached in 18mo | Month 16 |

### How These Compare to the Original Projections

| Metric | Original Conservative | Revised Conservative | Original Moderate | Revised Moderate |
|---|---|---|---|---|
| Forward MRR (end month 18) | $22,500 | **$12,600** (7 × $1,800) | $57,500 | **~$36,000** (blended) |
| Last month retainer cash (mo. 18) | — | **$14,400** (8 pay before 1 churn) | — | **~$38,500** |
| 18-mo cumulative revenue | $202,500 | **$132,800** | $510,000 | **$341,100** |
| Active retainer clients (end mo. 18) | 9 | **7** | 23 | **18** |

The original projections assumed zero churn, 25% close rate, and same-month closing. The revised projections are still strong outcomes for a side business — they simply account for the realities of selling a new unproven service as a solo operator. The gap closes over time as brand, referrals, and case studies compound.

**What accelerates toward the original moderate scenario:** (1) landing 2–3 pilot clients in months 1–2 who convert to paid, (2) building an inbound content channel that generates leads without cold outbound, (3) signing annual contracts that eliminate churn exposure, (4) getting a referral from every happy client starting in month 4.

---

## 8. Retention Mechanics — Keeping Clients Past Month 3

Churn is the silent killer of recurring revenue. Most clients who cancel do so between months 2–4, when the novelty of the Monday report fades and the $2,500 line item shows up on a quarterly budget review. Build these retention mechanics into the service from day one.

### 8.1 Client Dashboard

Every Growth and Strategic client gets access to a web dashboard (generated weekly alongside the email report). The dashboard shows:

- **Report archive** — every past briefing, searchable by competitor and date
- **Signal timeline** — a visual history of all trigger events, pricing changes, and product launches detected
- **Competitor scorecard** — G2 ratings, hiring velocity, and website change frequency over time

The dashboard transforms the product from "an email" to "our competitive intelligence platform." Clients who log in to the dashboard churn at half the rate of email-only clients because they see accumulated value.

Run `node scripts/generate-dashboard.js <client-id>` after each Monday report to regenerate the dashboard. To regenerate for all clients at once: `node scripts/generate-dashboard.js --all`. Serve the HTML file from any static host (Vercel, Netlify free tier) or attach the link in each Monday email. The dashboard is self-contained — no backend required.

### 8.2 Quarterly Impact Summary

Every quarter, the system auto-generates a summary report covering:

- Total signals detected across all competitors
- Number of trigger events flagged
- Most significant competitive moves identified
- Estimated value delivered (based on client-reported wins)

Run `node scripts/generate-quarterly-summary.js <client-id>` to produce this. Send it alongside a brief personal note: "Here's what we caught for you in Q1. If any of these influenced a deal outcome, I'd love to hear about it — helps me calibrate the system."

This reinforces accumulated value and makes the service feel essential, not incremental.

### 8.3 Win Story Tracking

When a client reports that the briefing influenced a deal outcome, log it. Reference these win stories at renewal time and in your annual contract pitch. A single documented win ("We used the Outreach pricing change alert to close a $85k deal") pays for 2+ years of the service.

### 8.4 Churn Prevention Signals

Watch for these and act immediately:

| Signal | What to do |
|---|---|
| Client hasn't opened the last 3 emails | Send a personal note asking if the format is working. Offer to adjust competitors or tone. |
| Client's champion (VP Sales) leaves the company | Immediately reach out to their replacement with a "here's what we've been tracking" summary. |
| Client asks to downgrade | Offer a 1-month pause instead of downgrade. Most will resume. |
| Client goes silent on quarterly check-in | Flag as at-risk. Send an unsolicited "biggest finding this quarter" email. |

---

## 9. Content-Driven Inbound Strategy

Cold outbound alone is a bottleneck tied to your personal hours. Content marketing compounds — every post, article, and LinkedIn insight generates leads while you sleep.

### 9.1 LinkedIn Content (1 post/week, 30 min)

Publish one competitive intelligence insight per week using anonymised data from your reports. Examples:

> "Tracked 47 B2B SaaS companies this month. 11 quietly changed their pricing pages. 3 removed their free tier entirely. Here's what that signals for the market..."

> "This week, 4 of the 6 competitors we monitor for a client started hiring enterprise AEs. When 3+ competitors move upmarket simultaneously, it means the SMB segment is saturating. Here's how one sales leader used this intel..."

These posts build authority, demonstrate the product, and generate inbound leads from VPs who think "I want that for my team."

### 9.2 Free Monthly Market Report (Inbound Magnet)

Pick one vertical (e.g. "Sales Tech Competitive Landscape — March 2026") and publish a free monthly report covering the 10 biggest competitive moves. Gate it behind an email signup. This builds an email list of prospects who self-select as competitive intelligence buyers.

### 9.3 Referral Incentive Program

Formalise referrals. For every client who refers a new paying customer:

- Referring client gets 1 month free (or $500 credit toward annual contract)
- New client gets first month at 50% off
- You close referred deals 3x faster and they churn 50% less

---

## 10. The 90-Day Launch Plan

### Days 1–30: Foundation + Pilot Validation

- [ ] Copy `.env.example` to `.env` and fill in all API keys
- [ ] Set up 2 sending domains for your own outbound (e.g. `trymightx.com`, `mightxhq.io`)
- [ ] Warm up 2 inboxes in Instantly for 3–4 weeks before sending
- [ ] Configure the GTM Engine ICP for your own target buyers (VP Sales, CRO, Head of Sales Enablement, Head of Product Marketing at 50–300 person B2B SaaS)
- [ ] Generate the **Gold Standard** demo report (`demo-salesloft`) — one flawless HTML as core portfolio collateral (see `START-HERE.md` Step 4). Do **not** buy premium scraping APIs yet — free collectors are sufficient to close the first deal
- [ ] Import both n8n workflows (GTM Engine reply handler + Intelligence Engine cron)
- [ ] Build a simple one-page website describing the service
- [ ] **NEW:** Identify 2–3 companies for free 4-week pilot programs — reach into your network or use warm LinkedIn connections
- [ ] **NEW:** Run `node scripts/onboard-client.js` to set up pilot clients interactively
- [ ] **NEW:** Start LinkedIn content: publish first competitive intelligence insight post

### Days 30–60: First Revenue + Proof Points

- [ ] Launch GTM Engine outbound — 50 leads/week minimum
- [ ] Fulfill the **custom** baseline you offered: concierge-run intelligence for their named competitors (~30 min per prospect, free collectors, no premium API spend) and send the HTML to any reply that shows curiosity
- [ ] Target: 1–2 discovery calls per week (realistic with Scotiabank schedule)
- [ ] Convert pilot clients to paid — offer Starter at $800/month or Standard at $1,500/month for first clients as reference rate
- [ ] Onboard first paid client using `node scripts/onboard-client.js`, run first report, confirm delivery
- [ ] Collect testimonial or data point ("saw 3 competitor pricing changes we missed")
- [ ] **NEW:** Generate client dashboard for Growth+ clients: `node scripts/generate-dashboard.js <client-id>`
- [ ] **NEW:** Publish 4 LinkedIn posts (1/week) with anonymised competitive intelligence insights

### Days 60–90: Repeatable Motion + Retention

- [ ] Close second and third clients — push for annual contracts with 15% discount
- [ ] Set up Slack channel for yourself showing weekly n8n run summaries across all clients
- [ ] Ask first client for one referral introduction (formalise with referral incentive)
- [ ] Raise your cold email response rate by A/B testing 2 different subject lines in Instantly
- [ ] Document any prompt adjustments you made during onboarding — build a calibration checklist
- [ ] **NEW:** Run `node scripts/generate-quarterly-summary.js <client-id>` for pilot-turned-paid clients — send alongside personal note reinforcing value
- [ ] **NEW:** Publish first monthly market report (free, gated behind email signup) for one vertical
- [ ] **NEW:** Review and expand data collectors — enable LinkedIn, GitHub, and Crunchbase monitoring for clients with thin public footprints

---

## 11. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| G2 or news sources block scraping | Medium | Medium | Diversify data sources (LinkedIn, GitHub, Crunchbase — collectors already built). System still runs on remaining sources with graceful fallback. |
| Claude API pricing increase | Low | Low | Cost is already <$10/client/month; even a 3x increase is immaterial |
| Client cancels after 2–3 months | Medium-High | Medium | Annual contracts (10–15% discount), client dashboard showing accumulated value, quarterly impact summaries, and win story tracking. Target 85%+ annual retention. |
| Competitor launches an identical service | Medium | Medium | Your moat is client-specific calibration, prompt tuning, and relationship depth. Strengthen with: vertical expertise, documented win stories, and the dashboard as a switching cost. |
| You are too busy at Scotiabank to run outbound | Medium | High | Build inbound content channel (LinkedIn, monthly market report) that generates leads passively. The delivery is fully automated — only pipeline needs active effort. |
| Report quality degrades for a specific client | Low | High | Monthly prompt review; n8n logs flag clients that received reports. Re-run manually with adjusted prompts. The quarterly impact summary forces regular quality check-ins. |
| Close rate is lower than projected | High | Medium | The Starter tier at $800/month reduces buying friction. Pilot programs (4 free weeks) convert to paid at higher rates than cold-to-close. |
| Champion (buyer) leaves the client company | Medium | High | When you detect a champion change (no email opens, new contact in CRM), immediately reach out to the replacement with a curated summary of value delivered. |
| Sales cycle takes longer than expected | High | Medium | Offer 30-day money-back guarantee to accelerate decision. Lead with a **custom** baseline report on their competitors to demonstrate value before the prospect has to commit. |
| Data source produces low-quality signals for niche competitors | Medium | Medium | Add more collectors (LinkedIn, GitHub changelogs, Crunchbase). For niche competitors with thin public footprint, manually supplement with industry-specific sources during onboarding. |

---

## 12. Positioning and Differentiation

**What you say to a prospect who asks "how is this different from Klue or Crayon?"**

> "Klue and Crayon are software platforms. You need someone to run them, keep them updated, and synthesise the data into something your reps can use. Most teams buy them, use them for 60 days, and let them go stale because nobody owns it internally.
>
> We are a fully managed service. The briefing arrives in your inbox every Monday. Nobody on your team touches anything. When a trigger event happens — a competitor cuts pricing, launches a feature, gets hit with a wave of negative reviews — we send you an alert the same day with ready-to-use email templates for your reps. You do not need a competitive intelligence manager. You just need to read your Monday email."

**What you say about the engineering background:**

> "This is not a research analyst sending you a manually written PDF. It is an engineered system — continuous monitoring across websites, news feeds, review platforms, and job boards, run through an AI analysis layer I built with the same standards I use for production systems at a major bank. It does not miss things. It does not take holidays."

---

## 13. Expansion Path (Month 12+)

Once you have 6+ clients and $15,000+ MRR, two natural expansions open:

**1. Add the GTM Engine as an upsell**

Clients receiving weekly intelligence briefings are warm to the idea of acting on that intelligence with targeted outbound. Offer to also run their outbound campaigns triggered by the intelligence signals. This doubles the deal size without doubling the work — you already have their competitive data. Price this as a $3,000–$5,000/month add-on.

**2. White-label to agencies**

Marketing agencies and sales consultancies often want to offer competitive intelligence to their own clients but lack the technical infrastructure. License them access to your system at $800–$1,200/month per client they run through it. They handle client relationships; you handle the infrastructure. Minimum commitment of 3 clients.

**3. Vertical niching**

Pick one vertical — HR tech, devtools, or fintech — and build deep category expertise. Charge premium pricing ($5,000–$8,000/month) for vertical-specific reports that include qualitative analysis from your own category knowledge. This is the path to $100K+ MRR.
