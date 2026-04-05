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

## The exact validation goal

In the first cycle, you are not trying to scale.

You are trying to get:

1. 2 real buyers to ask for a sample report
2. 1 discovery call
3. 1 paid or discounted pilot

If you get those, keep going.

## Demo assets to generate first

Use these two ready-made demo configs:

- `config/clients/demo-salesloft.json`
- `config/clients/demo-outreach.json`

Generate both with:

```bash
node scripts/run-client.js demo-salesloft --no-email
node scripts/run-client.js demo-outreach --no-email
```

Then review the HTML output under:

- `data/demo-salesloft/`
- `data/demo-outreach/`

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

Ask if they want to see a sample report for their category.

If they reply with interest:

1. Send one demo report
2. Ask one short question: "Would something like this be useful for your team each Monday?"
3. Only then move to a call or pilot

## Pilot structure

Best initial pilot:

- 2–4 weeks
- 3–4 competitors
- Weekly briefing only
- Manual review before delivery
- Discounted paid pilot or clearly bounded trial

## Success criteria

Continue if:

- buyers reply positively to the sample report
- they ask for their own competitor set
- they say the output would help reps or managers prepare better

Reposition if:

- the report feels like a generic AI summary
- replies are polite but nobody wants a pilot
- buyers care more about battlecards or live objection handling than monitoring itself

## If validation works

Your next move is not "more features."

Your next move is:

- tighten positioning around sales-tech revenue teams
- collect 1 testimonial or win story
- create a repeatable sample-report-to-pilot motion
