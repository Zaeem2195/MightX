# Sales-Tech Validation Playbook

This is the fastest path to test whether the competitive intelligence offer resonates with revenue leaders in the sales-tech category.

## Why sales tech first

This repo already leans sales-tech in three ways:

- The GTM buyer targets are already VP Sales / CRO / Revenue leaders.
- The example client and competitor set already includes `Outreach`, `Salesloft`, and `Apollo.io`.
- The pain in this category is visible and easy to explain: reps get compared against well-funded competitors constantly.

## The offer to validate

Do not lead with "AI."

Lead with:

> A weekly competitive intelligence briefing for sales leaders in sales tech. We track competitor launches, pricing changes, G2 review trends, hiring signals, and funding moves — then turn it into a Monday briefing your reps can actually use in call prep and objection handling.

**Outbound (first touch)** uses the narrative in `gtm-engine/prompts/personalization.txt`: peer tone, two named competitors, and a **hosted sample brief** link (`/brief?id={{companyName}}`) for **tracked** engagement — that is validation signal, not a substitute for a **custom** `run-client` deliverable when you commit to one.

## The exact validation goal

In the first cycle, you are not trying to scale.

You are trying to get:

1. Meaningful engagement on your **hosted brief** (tracked opens on `/brief?id=…` — see `brief-app/README.md`) *or* explicit replies agreeing to a **custom** baseline (named competitors → you deliver Monday-quality HTML via `run-client`)
2. 2 real buyers who move past “polite interest” (either repeat opens + reply, or direct yes to a custom run)
3. 1 discovery call
4. 1 paid or discounted pilot

If you get those, keep going.

## The "Gold Standard" demo report (portfolio proof)

Generate **one flawless report** for a famous SaaS rivalry. This is your core sales collateral — LinkedIn, Looms, DMs, calls.

```bash
node scripts/run-client.js demo-salesloft --no-email
# Review: data/demo-salesloft/report-*.html
```

Every finding must be defensible. If anything reads like generic AI, re-run or manually edit. This represents $2,500/month quality.

**Positive replies** should get a **custom concierge run** for *their* competitors (see below), not this demo file alone.

The same `demo-salesloft` output can also power the **Brief App** when the prospect’s `id` matches your `data/demo-*` slug convention (e.g. `salesloft`) — useful for tracked sample views; serious buyers still get a **custom** `run-client` report when you promised bespoke work.

## What to check before sending a demo

- Are the findings specific, not generic?
- Do the implications sound useful for a VP Sales or CRO?
- Are there 1–2 insights that would genuinely improve objection handling or call prep?
- Does the report look like something worth forwarding internally?

If not, tune the prompt or competitor list before sending anything.

## Who to target

Start with:

- VP of Sales
- CRO
- Head of Sales Enablement
- VP Revenue

Company profile:

- 50–300 employees
- B2B SaaS
- Competes directly in sales engagement, revenue intelligence, or adjacent GTM tooling

## What to send first

Do not pitch the whole service in email one.

Use the current GTM prompt rules in `gtm-engine/prompts/personalization.txt`:

- **Prospect-first opener** (one verifiable detail — never invent facts).
- **Abstracted Authority** line (tier-1 engineering + automated competitive intelligence engine for SaaS).
- Exactly **two real competitors** named in the body.
- **Delivery-assuming CTA**: baseline capture + Rep Talk Tracks framing, then a hosted link on its own line:
  - `https://yourdomain.com/brief?id={{companyName}}`
- **`{{companyName}}` must remain literal** in generated copy so Instantly merges it per lead.

That link hits **Brief App** (`brief-app`): server-side open logging, optional **Slack** alert (via `SLACK_WEBHOOK_URL`), and optional **report-backed** UI when `id` aligns with **`brief-app/data/demo-*`** (populated by `intelligence-engine/scripts/generate-report.js` when you run the report pipeline). Test connectivity with `GET /api/health/tracking` after deploy.

**Deliverability:** URLs in email 1 can hurt inbox placement on some domains; many teams put the first link in **step 2–3** of the Instantly sequence. See `gtm-engine/README.md` and `START-HERE.md` (Phase 2).

**Optional vertical collateral:** `cd brief-app && npm run generate-html-brief` (edit `scripts/generate-html-brief.js` inputs) writes `public/<industry-slug>-brief.html` — separate from the weekly `run-client` pipeline.

If they **only open the link** (no reply): you still have a signal — follow up in sequence or manually.

If they reply with interest — **concierge fulfillment** (no premium APIs needed):

1. Create a throwaway config: `config/clients/prospect-[name].json` with their 2-4 competitors.
2. Run: `node scripts/run-client.js prospect-[name] --no-email`
3. Review the HTML — manual QA expected. Fix anything thin. (~30 min total)
4. Send the HTML by Monday as promised (or as agreed). Attach or reference the Gold Standard **only** if they explicitly asked for “example format.”
5. Ask one short question: "Would something like this be useful for your team each Monday?"
6. Only then move to a call or pilot

## Pilot structure

Best initial pilot:

- 2–4 weeks
- 3–4 competitors
- Weekly briefing only
- Manual review before delivery
- Discounted paid pilot or clearly bounded trial

## Success criteria

Continue if:

- tracked **brief opens** cluster on real accounts (Slack / logs) and correlate with replies or meetings
- buyers reply positively to the **custom** report you delivered
- they ask for their own competitor set
- they say the output would help reps or managers prepare better

Reposition if:

- the report feels like a generic AI summary
- replies are polite but nobody wants a pilot
- buyers care more about battlecards or live objection handling than monitoring itself

## API spend gating rule

Do **not** purchase premium scraping APIs (Proxycurl, BrightData, Exa) until the first paying client signs. The free collectors already produce the Gold Standard quality. First retainer funds premium APIs for deeper ongoing weekly reports.

## If validation works

Your next move is not "more features."

Your next move is:

- tighten positioning around sales-tech revenue teams
- collect 1 testimonial or win story
- create a repeatable **tracked-sample → custom run → pilot** motion (Brief App + `run-client` + Instantly sequencing)
- use first retainer to add Proxycurl / BrightData for richer weekly reports

**Reference docs:** `START-HERE.md` (full stack), `brief-app/README.md` (tracking + env), `gtm-engine/README.md` (pipeline + prompt framework).
