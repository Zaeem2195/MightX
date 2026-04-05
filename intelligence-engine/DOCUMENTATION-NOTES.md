# Documentation notes — what you should know

This file is for **you** (the operator), not clients. It explains how the business docs and numbers fit together, and what assumptions are baked in.

---

## Which doc to use when

| Document | Purpose |
|---|---|
| `START-HERE.md` | Day-to-day execution: commands, phases, weekly rhythm. |
| `BUSINESS-OPERATIONS.md` | Strategy, pricing, projections, positioning, risks. |
| This file | Conventions, caveats, and how the projections were reconciled. |

---

## Paths in `START-HERE.md`

Commands use **`C:\mightx\...`** (lowercase). Your machine may use **`C:\MightX`** — Windows paths are case-insensitive for the default volume, but if you clone to Linux or share the repo, replace with your actual paths or use relative paths from the repo root.

---

## Revenue projections — accounting rules (Section 7)

The **conservative** scenario table in `BUSINESS-OPERATIONS.md` was reconciled to these rules:

1. **Setup fee** in the month the client signs.
2. **First retainer** in the **month after** signup.
3. **Churn** at **month-end**: the departing client still pays for that full month; they drop off **next** month’s billings.
4. **Blended retainer** for conservative rows: **$1,800/month** per paying client (illustrative mix of tiers).
5. **FIFO churn**: when one client churns, the **oldest** retainer account is removed (simplest model).

**Two different “MRR” numbers in the last month:**

- **Retainer MRR** in the table = **cash collected that month** from all clients in billing (including someone who churns at month-end).
- **Forward MRR** after month 18 = **Active (retainer) at end of month 18 × blended rate** — what you expect to collect **next** month if nothing changes.

Example (conservative, month 18): eight clients pay retainer during the month → **$14,400**; one churns at end → **seven** remain → forward MRR **$12,600** (7 × $1,800).

---

## Moderate scenario

The **moderate** table uses the **same story** (faster signups, higher tiers, referral acceleration) but **does not** use a single fixed dollar amount per client in every row. **Retainer MRR** cells reflect a **rising blended ACV** (~$1,950–$2,000+ effective). The **cumulative** column is the sum of **Monthly Rev** and was verified to **$341,100** total. If you need investor-grade audit, rebuild the moderate sheet month-by-month in Excel using the same signup/churn timing and your actual tier prices.

---

## Cost section (Section 6)

Examples include:

- **All-Growth** (4 × $2,500): ~97% gross margin on retainer vs variable costs.
- **Blended tiers** (Starter + Standard + Growth): still **~96%** gross margin — use this when modeling a realistic client mix.

Variable API cost is an estimate (~$5–8/client/month); re-check against Anthropic usage monthly.

---

## `START-HERE.md` revenue milestones

The milestone table (**$5k MRR, $10k MRR**, etc.) targets the **moderate** execution path, not the **conservative** base case. See `BUSINESS-OPERATIONS.md` Section 7 for both scenarios. If you underperform the moderate path, you are not “failing” — the conservative model is still a strong side-business outcome.

---

## Proposal tiers in `START-HERE.md`

The proposal lists **three** price anchors (Starter, Growth, Strategic) to avoid decision paralysis. **Standard ($1,500/mo)** is still in the full tier matrix in `BUSINESS-OPERATIONS.md` Section 3 — use it when the buyer is between Starter and Growth.

---

## Why the repo is currently biased toward sales tech

The highest-odds first validation path is **sales tech**, not because the product only works there, but because the repo already leans in that direction:

- GTM targeting already points at VP Sales / CRO buyers
- the example competitors already include sales-tech companies
- the value proposition is easiest to explain there

Treat this as a **go-to-market wedge**, not a permanent product restriction. Expand to adjacent niches only after you get credible signal from the first wedge.

---

## Product vs. marketing copy

- **LinkedIn / “company page” monitoring** in the codebase uses **RSS + public page signals**, not logged-in LinkedIn API access. Positioning should not promise “full LinkedIn API enrichment” unless you add a vendor (e.g. Proxycurl).
- **Crunchbase** in collectors uses **news-based funding signals**, not necessarily the paid Crunchbase API — align sales language with what the code actually does.

---

## Updating projections later

If you change tier prices or churn assumptions, prefer:

1. Copy the conservative logic into a spreadsheet.
2. Recompute **Monthly Rev** and **Cumulative** as the source of truth.
3. Update the summary lines at the bottom of Section 7 to match.

---

*Last aligned with `BUSINESS-OPERATIONS.md` Section 7 — conservative table reconciled to FIFO churn + month-lagged retainer start.*
