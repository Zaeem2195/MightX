# Client Slack Connect Playbook

Status: Tier 1 ops upgrade (no code — pure workflow).
Goal: replace the one-way Monday email with a two-way surface so clients feel the service evolve week to week and stay past month 3.

This is the single biggest retention lever available without building a portal. It costs nothing, takes ~10 minutes per client to set up, and converts the relationship from "I receive a PDF" to "I have an analyst on Slack."

---

## 1. Why Slack Connect (and not the client portal yet)

The plan in `mightx_saas_worth_analysis_dde009cc.plan.md` explicitly defers a customer-facing portal until there are 8–10 paying clients asking for one. Until then, Slack Connect gives you 80% of the portal value for 0% of the engineering cost:

- Client posts "dig deeper on X" → you run `node scripts/run-client.js <id>` with a one-off config tweak and paste results back the same week.
- Client flags a false positive → you update their `config/clients/<id>.json` (e.g., add a `newsKeywords` term) and it silently improves next Monday.
- You get visible proof the report is being read, which makes renewal conversations much easier.

Slack Connect (shared channels between two Slack workspaces) is free on every paid Slack plan and works asymmetrically — your client does not need a paid Slack plan to accept an invite.

---

## 2. Setup per new client (onboarding)

Run this once when a client signs. Target: 10 minutes.

1. In your Slack workspace, create a channel named `client-<slug>` (use the same slug as `config/clients/<slug>.json`).
2. Channel settings → **Connect this channel** → share with the client's workspace. Send the invite to your primary contact (the `contactEmail` from their config, same person who receives the Monday report).
3. Add to the channel on your side: you (operator), plus anyone you want visibility into client conversations. Keep it small — the client should see 1–2 people, not a crowd.
4. Pin a short intro message. Template:

   > Welcome! This is your direct line to your competitive intelligence analyst at MightX.
   >
   > **What goes here:**
   > - The Monday briefing summary + link to the full HTML report.
   > - Ad-hoc requests: "dig deeper on Competitor X's pricing change", "ignore press release Y", "add Competitor Z to my watch list".
   > - Trigger alerts the moment we spot them (funding rounds, leadership moves, SEC 8-K filings).
   >
   > **Response times:** Monday briefing posts by 09:00 ET. Ad-hoc requests answered within 24 business hours.
   >
   > **Not here:** billing, renewal, contract — those go via email.

5. Record the channel id in the client config under a new `slackConnect` block (optional, just for ops memory). Example:

   ```json
   "slackConnect": {
     "channelId": "C0ABCD1234",
     "clientPrimary": "vp-sales@acmecorp.com",
     "sharedAt": "2026-04-16"
   }
   ```

6. Send the client a brief confirmation email referencing the same expectations so it lives somewhere other than Slack.

---

## 3. Weekly rhythm

**Monday 09:00 ET — briefing post**

After the cron runs and validation passes (see `validate-report.js`), post to the client channel with this template:

> Your week in 30 seconds, <Client Name>:
>
> **Top alert:** <alert.headline — or "no urgent triggers this week">
>
> **What changed since last week:** <2–3 bullets from `changesSinceLastWeek.newThisWeek` + `progressed`>
>
> **Sales play for this week:** <one sentence from `salesPlayThisWeek`>
>
> Full report: <link to the mirrored HTML in brief-app, or attach the HTML file>
>
> Reply in-thread with anything you want me to dig into before next Monday.

Copy the text fields directly out of `data/<clientId>/report-content-<timestamp>.json` — no rewriting needed.

**Tuesday–Friday — inbound handling**

Aim for a single "we're on it" acknowledgement within 1 business hour and a substantive response within 24 business hours. Most asks fall into four patterns:

| Client request                               | Action                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| "Go deeper on Competitor X's pricing change" | Edit their config's competitor entry to set `pricingUrls` on X, re-run, post diff.    |
| "Ignore news about <topic>"                  | Add negative keyword guidance to their `context.clientWeaknesses` or competitor notes.|
| "Add Competitor Z to our watch list"         | Append Z to `competitors[]`. Re-run immediately so they see value same day.           |
| "What did I miss at <competitor> 3 weeks ago?" | Answer from `data/<clientId>/report-content-*.json` archive + dashboard.              |

**Friday — trigger sweep**

Skim the channel for anything not yet responded to. Nothing goes into the weekend unanswered.

---

## 4. Trigger-event rapid post

The system already flags `topAlert.exists = true` and `triggerEmails.exists = true`. When either is present in a weekly report, consider posting a follow-up to the channel 2–3 days later with:

> Quick follow-up on the <competitor> trigger we flagged Monday — any traction in live deals? Happy to produce talk tracks or battlecard copy for specific personas.

This is the single highest-signal retention touch. It converts the report from a passive artifact into visible attentiveness.

---

## 5. Escalation and renewal signals

Watch the channel for these signals and route them appropriately:

- **Silence for 3+ weeks:** renewal risk. Schedule a 20-minute review call.
- **"Can we add Competitor Z?":** expansion signal. Confirm current tier supports it; propose upgrade if needed.
- **Reply threads longer than 5 messages on a single topic:** product signal. The client may want a recurring section on it — consider codifying into their `context` or a new prompt variant.
- **Forwarding to their team ("can Jamie see this?"):** readiness signal for a portal-style multi-seat upsell (Tier 2 roadmap).

Record these in `retention.healthStatus` in the client config so you can spot patterns across clients during monthly review.

---

## 6. When to retire this playbook

Retire Slack Connect as the primary surface once you have at least 5 paying clients explicitly asking for:

- persistent history search across past reports, or
- multi-user access on their team, or
- an "ask a question" UX that does not require Slack.

At that point, the Tier 2 portal roadmap becomes justified. Until then, Slack Connect is the product.

---

## 7. Checklist

New client signed:

- [ ] `client-<slug>` channel created in your workspace
- [ ] Connected to client's workspace, invite sent to `contactEmail`
- [ ] Intro message pinned
- [ ] `slackConnect.channelId` recorded in `config/clients/<slug>.json`
- [ ] First Monday briefing posted in-channel (not just emailed)

Every Monday:

- [ ] Cron ran, `validate-report.js` passed
- [ ] Briefing summary posted to each client channel
- [ ] HTML link or file shared
- [ ] Any overnight client messages triaged

Every Friday:

- [ ] Trigger-event follow-ups sent where applicable
- [ ] Zero un-acknowledged threads heading into the weekend
- [ ] `retention.healthStatus` updated for any at-risk clients
