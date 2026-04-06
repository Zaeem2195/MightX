# Growth tier ($2,500/mo) — acceptance checklist

Use this before sending a **Growth** demo or turning on automated Monday delivery.

## Pipeline

- [ ] Full `node scripts/run-client.js <client-id> --no-email` completes with **no fatal errors**
- [ ] `analyses-*.json` has `meta.parseFailures === 0` (or any fallbacks are listed in the report **Data gaps** section)
- [ ] `data/<client-id>/dashboard.html` exists after the run when `includeDashboard` is true

## Report quality

- [ ] **Coverage & method** and **Data gaps** sections appear and read honest (not defensive)
- [ ] Findings are **specific** (named moves, plausible deal impact), not generic AI filler
- [ ] At least **one** item a VP Sales would forward (trigger, sharp talk track, or clear play)
- [ ] No obvious **false positives** (civic “outreach”, wrong Apollo, skincare “Clari”, etc.)
- [ ] Optional **source** lines under findings are sensible where the model adds them

## Commercial fit

- [ ] Delivered assets match the pitch: weekly HTML report + refreshed dashboard (+ email when enabled)
- [ ] You can explain in one sentence what was monitored this week and what was blocked

If any box fails, fix collectors/prompts first; do not rely on narrative alone at this price point.
