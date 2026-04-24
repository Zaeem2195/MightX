/**
 * generate-html-brief.js
 * ─────────────────────
 * Generates the vertical-sample competitive brief HTML that the brief-app serves
 * publicly (e.g. /elearning-brief.html). This is a **top-of-funnel proof artifact**
 * shown to prospects during cold outbound — not the weekly briefing sent to paying
 * clients (that lives in `intelligence-engine/scripts/generate-report.js`).
 *
 * Flow:
 *   1. Loads a raw-signals JSON produced by
 *         intelligence-engine/scripts/collect-for-brief.js
 *      at  intelligence-engine/data/brief-signals/<industry-slug>.json
 *      (path can be overridden with --signals <path>)
 *   2. Asks Claude to produce a STRUCTURED JSON brief grounded in those signals
 *      with inline source URLs + dates on every insight.
 *   3. Renders the JSON to HTML via a local template (so we own the design and
 *      the compliance story, rather than trusting Claude to produce valid HTML).
 *
 * If no signals file is present, the generator falls back to a "sample-only"
 * mode that clearly labels itself as such — the prospect must know when the
 * artifact is live vs illustrative.
 *
 * Prerequisites:
 *   - ANTHROPIC_API_KEY in brief-app/.env.local or brief-app/.env
 *   - (Optional but recommended) A signals JSON from
 *       cd ../intelligence-engine
 *       node scripts/collect-for-brief.js "<Industry>" "<A>" "<B>"
 *
 * Usage:
 *   node scripts/generate-html-brief.js
 *   node scripts/generate-html-brief.js "E-Learning" "Docebo" "Absorb LMS"
 *   node scripts/generate-html-brief.js "E-Learning" "Docebo" "Absorb LMS" --signals ../intelligence-engine/data/brief-signals/e-learning.json
 *   node scripts/generate-html-brief.js "E-Learning" "Docebo" "Absorb LMS" --cta-url "https://cal.com/you/intro"
 *
 * Output:
 *   public/<industry-slug>-brief.html
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Anthropic = require("@anthropic-ai/sdk");

// ─── Defaults & constants ─────────────────────────────────────────────────────

const DEFAULT_INDUSTRY     = "E-Learning";
const DEFAULT_COMPETITOR_A = "Docebo";
const DEFAULT_COMPETITOR_B = "Absorb LMS";

const MODEL = "claude-opus-4-7";
const MAX_TOKENS = 32_000;

const BRIEF_SIGNALS_DIR_DEFAULT = path.join(
  __dirname, "..", "..", "intelligence-engine", "data", "brief-signals",
);

// NOTE: The in-page "Book a Call" block is currently disabled in renderHtml()
// so this URL is not user-visible. It remains wired so the CTA can be
// re-enabled with a one-line change when the outbound ask moves back onto
// the brief page. Set BRIEF_CTA_URL in brief-app/.env.local to override.
const DEFAULT_CTA_URL = process.env.BRIEF_CTA_URL || "";
const DEFAULT_BRAND_NAME = process.env.BRIEF_BRAND_NAME
  || "MightX Competitive Intelligence";

// Analyst byline (trust lever directly above the CTA). All optional — the whole
// block is suppressed if BRIEF_AUTHOR_NAME is unset. Set these in brief-app/.env.local.
const AUTHOR_NAME       = (process.env.BRIEF_AUTHOR_NAME       || "").trim();
const AUTHOR_TITLE      = (process.env.BRIEF_AUTHOR_TITLE      || "").trim();
const AUTHOR_CREDENTIAL = (process.env.BRIEF_AUTHOR_CREDENTIAL || "").trim();
const AUTHOR_LINKEDIN   = (process.env.BRIEF_AUTHOR_LINKEDIN   || "").trim();
const AUTHOR_AVATAR_URL = (process.env.BRIEF_AUTHOR_AVATAR_URL || "").trim();

// ─── Argument parsing ─────────────────────────────────────────────────────────

function parseCliInputs() {
  const argv = process.argv.slice(2);
  const positional = [];
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        console.error(`Missing value for --${key}`);
        process.exit(1);
      }
      flags[key] = val;
      i++;
    } else {
      positional.push(a);
    }
  }

  let industryName, competitorA, competitorB;
  if (positional.length === 0) {
    industryName = DEFAULT_INDUSTRY;
    competitorA  = DEFAULT_COMPETITOR_A;
    competitorB  = DEFAULT_COMPETITOR_B;
  } else if (positional.length === 3) {
    [industryName, competitorA, competitorB] = positional.map((s) => s.trim());
    if (!industryName || !competitorA || !competitorB) {
      console.error("Industry and both competitor names must be non-empty.");
      process.exit(1);
    }
  } else {
    console.error(`
Usage:
  node scripts/generate-html-brief.js
  node scripts/generate-html-brief.js "<Industry>" "<Competitor A>" "<Competitor B>" [flags]

Flags:
  --signals <path>   Path to the signals JSON produced by
                     intelligence-engine/scripts/collect-for-brief.js.
                     Defaults to
                     ../intelligence-engine/data/brief-signals/<industry-slug>.json
  --cta-url  <url>   Override the booking URL in the footer CTA.
  --brand    <name>  Override the byline brand name.

Omit all three positional arguments to use defaults:
  ${DEFAULT_INDUSTRY} | ${DEFAULT_COMPETITOR_A} vs ${DEFAULT_COMPETITOR_B}
`);
    process.exit(1);
  }

  return {
    industryName,
    competitorA,
    competitorB,
    signalsPath: flags.signals || null,
    ctaUrl: flags["cta-url"] || DEFAULT_CTA_URL,
    brandName: flags.brand || DEFAULT_BRAND_NAME,
  };
}

function slugifyIndustry(name) {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "industry";
}

// ─── Signals loader ───────────────────────────────────────────────────────────

function resolveSignalsPath(industryName, explicitPath) {
  if (explicitPath) return path.resolve(explicitPath);
  const slug = slugifyIndustry(industryName);
  return path.join(BRIEF_SIGNALS_DIR_DEFAULT, `${slug}.json`);
}

function loadSignals(signalsPath) {
  if (!fs.existsSync(signalsPath)) {
    return { found: false, path: signalsPath, payload: null };
  }
  try {
    const raw = fs.readFileSync(signalsPath, "utf8");
    const payload = JSON.parse(raw);
    if (!Array.isArray(payload.signals)) {
      throw new Error("signals array missing");
    }
    return { found: true, path: signalsPath, payload };
  } catch (err) {
    console.warn(`⚠️   Could not parse signals JSON at ${signalsPath}: ${err.message}`);
    return { found: false, path: signalsPath, payload: null };
  }
}

function formatSignalsForPrompt(payload) {
  if (!payload || !Array.isArray(payload.signals) || payload.signals.length === 0) {
    return "NO LIVE SIGNALS PROVIDED. Treat this brief as illustrative / sample only.";
  }

  const lines = [];
  lines.push(`Signals collected at: ${payload.generatedAt}`);
  lines.push(`Industry: ${payload.industry}`);
  lines.push("Competitors:");
  for (const c of payload.competitors || []) {
    const extras = [];
    if (c.website) extras.push(`website=${c.website}`);
    if (c.g2Slug) extras.push(`g2=${c.g2Slug}`);
    if (c.secTicker) extras.push(`ticker=${c.secTicker}`);
    if (c.secCik) extras.push(`cik=${c.secCik}`);
    lines.push(`  - ${c.name} (${extras.join(", ") || "no metadata"})`);
  }
  lines.push("");
  lines.push("─── RAW COLLECTOR OUTPUT ───");

  for (const s of payload.signals) {
    lines.push("");
    lines.push(`### SIGNAL type=${s.type} competitor=${s.competitor}`);
    lines.push(String(s.data || "").trim());
  }

  return lines.join("\n");
}

// ─── Claude prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Senior Competitive Intelligence Analyst producing a sales-ready public-facing "vertical sample" briefing. The output is used as a proof artifact in cold outbound to demonstrate what a paying client would receive every Monday.

OUTPUT FORMAT (strict):
- Respond with ONE JSON object and nothing else. No prose before or after. No markdown fences.
- The JSON must match the schema described in the user message exactly. Omit fields only when the schema explicitly allows it.
- Every insight must be grounded in the RAW COLLECTOR OUTPUT the user supplies. Do NOT invent numbers, dates, URLs, customers, quotes, or events.
- When raw signals are not provided, set "mode": "sample" on the top-level object and produce conservative, clearly-labeled illustrative content.

EVIDENCE RULES:
- Every "marketMoves", "thisWeekSignals", "pricingIntelligence.findings", "secFilings.items", and "triggerEvents.items" entry MUST include an array of at least one source object of shape {"url": string, "label": string, "date": "YYYY-MM-DD" or null, "type": string}. Pull these from the raw collector text — prefer URLs and dates that literally appear in the signal data.
- EVERY source object MUST have a non-empty "url". If an insight cannot be backed by at least one source with a real URL, DROP THE INSIGHT ENTIRELY. Never emit an unlinked citation — the whole trust pitch is "every claim has a clickable source," and a single src-nolink entry destroys that. Never fabricate a URL either.
- Confidence is scored High / Medium / Low:
  - High   = directly evidenced by a dated, sourced signal (news URL, 8-K filing, Wayback diff).
  - Medium = pattern consistent with multiple signals but not explicitly stated.
  - Low    = general market reasoning not pinned to a specific signal this run.
- Do NOT add hedge language like "may vary", "industry chatter", "anecdotally", "some customers". Remove such phrases before responding.

DEDUPLICATION (critical for perceived depth):
- Each distinct underlying signal (a specific news story, Reddit thread, SEC filing, G2 review) should appear in AT MOST TWO sections across the whole brief.
- If a signal is the hero of triggerEvents, do NOT repeat it as a thisWeekSignals card — pick a different signal for thisWeekSignals.
- If a signal is covered in marketMoves, talkTracks should reference it briefly (e.g. "as noted in Market Moves, the April 9 CPU-Z kill-chain…") rather than re-telling the full narrative.
- Spread coverage horizontally: different competitors, different signal types (news / Reddit / 8-K / sitemap / jobs / HN), different dates. A reader who sees the same signal in five sections concludes the analyst had a shallow pool.

WRITING STYLE:
- Claim-first, tactical, sales-ready. Each insight is one short title + 2-4 sentence body.
- Talk tracks split 50/50: produce AT LEAST 3 fully-worked examples (example=true) that contain ZERO "[your X]" / "[your platform]" / "[your …]" placeholders — name the actual competitor, cite a dated signal, and read as copy-paste-ready on a call. Produce AT LEAST 2 templates (example=false) that DO contain customizable "[your X]" placeholders for reps to adapt. Briefs with only one fully-worked example feel skeletal and will be rejected.
- Everything should be useful to a VP of Sales inside 60 seconds of reading.`;

function buildUserPrompt({ industryName, competitorA, competitorB, signalsBlock, hasSignals }) {
  return `Produce the JSON brief now.

INPUTS
Industry: ${industryName}
Competitor A: ${competitorA}
Competitor B: ${competitorB}
Raw signals available: ${hasSignals ? "YES" : "NO"}

${signalsBlock}

─── REQUIRED JSON SCHEMA ───

{
  "mode": "live" | "sample",                            // "live" only if raw signals were provided
  "hero": {
    "industry": string,
    "competitorA": string,
    "competitorB": string,
    "weekSummary": string                                // 2-3 sentence executive take
  },
  "freshness": {
    "generatedAt": string,                               // ISO date
    "signalWindowLabel": string,                         // e.g. "Last 7 days" or "Last 30 days (sample mode)"
    "signalCount": number,                               // approximate count of raw signals used
    "sourceTypeCount": number                            // number of distinct collectors consulted
  },
  "triggerEvents": {
    "exists": boolean,
    "items": [
      {
        "competitor": string,
        "headline": string,                              // 1 line
        "detail":   string,                              // 1-3 sentences explaining why this matters right now
        "date":     string | null,                       // "YYYY-MM-DD" when known, else null
        "sources":  [ { "url": string, "label": string, "date": string | null, "type": string } ]
      }
    ]
  },
  "thisWeekSignals": [                                   // 3-5 items. Dated + sourced. Name each competitor.
    {
      "competitor": string,
      "headline":   string,
      "date":       string | null,
      "sourceType": string,                              // "news" | "pricing_archive" | "sec_filings" | "g2" | "jobs" | "website" | ...
      "sources":    [ { "url": string, "label": string, "date": string | null, "type": string } ]
    }
  ],
  "pricingIntelligence": {
    "exists": boolean,                                   // true only if raw pricing_archive signals were provided
    "findings": [
      {
        "competitor": string,
        "summary":    string,                            // e.g. "Docebo /pricing changed 4x in the last 90 days; last change removed explicit price tokens."
        "priceChanges": string[],                        // short bullets of concrete diffs pulled from the signal text
        "sources":    [ { "url": string, "label": string, "date": string | null, "type": string } ]
      }
    ]
  },
  "secFilings": {
    "exists": boolean,                                   // true only if raw sec_filings signals were provided
    "items": [
      {
        "competitor": string,
        "form":       string,                            // e.g. "8-K"
        "filedDate":  string,                            // YYYY-MM-DD
        "items":      string,                            // "Item 2.02: Results of Operations..."
        "summary":    string,
        "sources":    [ { "url": string, "label": string, "date": string | null, "type": "sec_filings" } ]
      }
    ]
  },
  "comparisonMatrix": {
    "rows": [                                            // 5-7 rows
      {
        "axis": string,                                  // e.g. "Pricing model", "Deployment speed"
        "a":    string,
        "b":    string,
        "note": string | null                            // optional tactical implication, 1 sentence
      }
    ]
  },
  "marketMoves": [                                       // 4-6 cards. Each with inline sources.
    {
      "competitors": string[],                           // one or both
      "title":       string,
      "body":        string,                             // 2-4 sentences
      "confidence":  "High" | "Medium" | "Low",
      "confidenceBasis": string,                         // 1 sentence on why this confidence
      "verify":      string,                             // 1 sentence, concrete next step
      "date":        string | null,
      "sources":     [ { "url": string, "label": string, "date": string | null, "type": string } ]
    }
  ],
  "talkTracks": [                                        // 5-6 objections total — MINIMUM 3 example=true + MINIMUM 2 example=false
    {
      "objection":       string,
      "response":        string,                         // example=true → zero placeholders, concrete competitor name + dated signal. example=false → MUST contain "[your X]" placeholders for reps to customize.
      "example":         boolean,                        // at least 3 entries must be true; at least 2 must be false
      "confidence":      "High" | "Medium" | "Low",
      "confidenceBasis": string,
      "sources":         [ { "url": string, "label": string, "date": string | null, "type": string } ]
    }
  ],
  "watchNextWeek": [                                     // 3-5 forward-looking items with a trigger/date
    {
      "text":        string,
      "trigger":     string,                             // e.g. "Earnings call", "Pricing snapshot recheck"
      "expectedBy":  string | null                       // YYYY-MM-DD or ISO-like window
    }
  ],
  "evidenceIndex": [                                     // per-competitor roll-up of every source URL used in the brief
    {
      "competitor": string,
      "sources":    [ { "url": string, "label": string, "type": string, "date": string | null } ]
    }
  ]
}

HARD REQUIREMENTS:
- talkTracks: AT LEAST 3 entries with example=true (zero "[your ...]" placeholders, real competitor named, dated signal cited). AT LEAST 2 entries with example=false that DO contain "[your X]" placeholders. Briefs with fewer than 3 fully-worked examples will be rejected by the validator.
- EVERY source object across the whole brief must have a non-empty "url". No src-nolink fallbacks. If you can't source an insight with a real URL, delete the insight.
- marketMoves, thisWeekSignals, pricingIntelligence.findings, secFilings.items, and triggerEvents.items each have at least one "sources" entry with a real URL.
- When the raw signals contain URLs, those URLs MUST appear in the "sources" arrays.
- No single underlying signal (same news article, same Reddit thread, same 8-K) may appear in more than 2 sections. Talk tracks should reference earlier sections instead of re-narrating.
- If raw pricing_archive signals show no material change, pricingIntelligence.exists may still be true but findings[].priceChanges should plainly say "No material pricing-page changes detected in the archive window."
- If raw sec_filings signals are not present, secFilings.exists = false and items = [].

Return only the JSON.`;
}

// ─── Claude call + robust JSON parsing ────────────────────────────────────────

function stripCodeFences(s) {
  let t = s.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  }
  return t.trim();
}

function extractJson(raw) {
  const fenced = stripCodeFences(raw);
  try {
    return JSON.parse(fenced);
  } catch (_) {
    const first = fenced.indexOf("{");
    const last  = fenced.lastIndexOf("}");
    if (first !== -1 && last > first) {
      const slice = fenced.slice(first, last + 1);
      return JSON.parse(slice);
    }
    throw new Error("Claude response was not valid JSON");
  }
}

async function callClaudeForBriefJson({ industryName, competitorA, competitorB, signalsPayload }) {
  const hasSignals = !!signalsPayload && Array.isArray(signalsPayload.signals) && signalsPayload.signals.length > 0;
  const signalsBlock = formatSignalsForPrompt(signalsPayload);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Must stream: at MAX_TOKENS=32k the SDK refuses non-streaming calls because
  // total wall time can exceed the Anthropic 10-minute non-streaming ceiling.
  // Streaming also gives the operator live "tokens in" progress while the
  // brief generates, which is useful for a ~60-90s call.
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildUserPrompt({
          industryName, competitorA, competitorB, signalsBlock, hasSignals,
        }),
      },
    ],
  });

  let buffer = "";
  let lastTick = Date.now();
  stream.on("text", (delta) => {
    buffer += delta;
    const now = Date.now();
    if (now - lastTick > 2_000) {
      process.stdout.write(`    ... ${buffer.length.toLocaleString()} chars streamed\r`);
      lastTick = now;
    }
  });

  await stream.finalMessage();
  if (buffer.trim().length > 0) process.stdout.write("\n");

  if (!buffer.trim()) throw new Error("Empty response from Claude");
  return extractJson(buffer);
}

// ─── JSON → HTML rendering ────────────────────────────────────────────────────

function esc(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return "";
  const items = sources
    .map((s) => {
      if (!s) return "";
      const label = esc(s.label || s.url || "source");
      const type  = s.type  ? `<span class="src-type">${esc(s.type)}</span>` : "";
      const date  = s.date  ? `<span class="src-date">${esc(s.date)}</span>` : "";
      if (s.url) {
        return `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${label}</a>${type}${date}</li>`;
      }
      return `<li><span class="src-nolink">${label}</span>${type}${date}</li>`;
    })
    .filter(Boolean)
    .join("");
  return `<ul class="sources">${items}</ul>`;
}

function renderCompetitorTags(names, a, b) {
  if (!Array.isArray(names) || names.length === 0) return "";
  return names.map((n) => {
    const cls = n === a ? "tag-a" : n === b ? "tag-b" : "tag-neutral";
    return `<span class="competitor-tag ${cls}">${esc(n)}</span>`;
  }).join("");
}

function confidenceLabel(levelRaw) {
  const level = (levelRaw || "Low").toString().trim();
  if (level === "High") return "High confidence";
  if (level === "Medium") return "Medium confidence";
  if (level === "Low") return "Low confidence";
  return level;
}

function renderConfidencePill(c) {
  const level = (c || "Low").toString().trim();
  const cls = level === "High" ? "conf-high" : level === "Medium" ? "conf-med" : "conf-low";
  const label = confidenceLabel(level);
  return `<span class="conf-pill ${cls}" title="${esc(label)}">${esc(label)}</span>`;
}

function fmtMonthYear(iso) {
  try {
    const d = iso ? new Date(iso) : new Date();
    return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  } catch {
    return "";
  }
}

function renderFreshnessStrip(freshness, mode, signalsFound) {
  if (mode === "live" || signalsFound) {
    const n = freshness?.signalCount ?? 0;
    const t = freshness?.sourceTypeCount ?? 0;
    const w = esc(freshness?.signalWindowLabel || "Last 7 days");
    return `<div class="freshness live">
      <span class="freshness-dot"></span>
      <span><strong>Live signals</strong> &middot; ${esc(String(n))} from ${esc(String(t))} source type(s) &middot; ${w}</span>
    </div>`;
  }
  return `<div class="freshness sample">
    <span class="freshness-dot"></span>
    <span><strong>Sample content</strong> &middot; no live collector signals attached &middot; not representative of a live client run</span>
  </div>`;
}

function renderTriggerEventsBanner(te, a, b) {
  if (!te || !te.exists || !Array.isArray(te.items) || te.items.length === 0) {
    return `<div class="trigger-banner none">No trigger events this week — baseline week. Signals are still being collected.</div>`;
  }
  const items = te.items.map((it) => {
    const date = it.date ? `<span class="te-date">${esc(it.date)}</span>` : "";
    const srcs = renderSources(it.sources);
    return `<div class="trigger-card">
      <div class="trigger-head">${renderCompetitorTags([it.competitor], a, b)}<strong>${esc(it.headline)}</strong>${date}</div>
      <p class="trigger-detail">${esc(it.detail)}</p>
      ${srcs}
    </div>`;
  }).join("");
  return `<div class="trigger-banner has">
    <div class="trigger-label">${te.items.length} trigger event${te.items.length === 1 ? "" : "s"} this week</div>
    ${items}
  </div>`;
}

function renderThisWeekSignals(list, a, b) {
  if (!Array.isArray(list) || list.length === 0) return "";
  const cards = list.map((s) => {
    const date = s.date ? `<span class="sig-date">${esc(s.date)}</span>` : "";
    return `<div class="signal-card">
      ${renderCompetitorTags([s.competitor], a, b)}
      <div class="sig-head"><strong>${esc(s.headline)}</strong>${date}</div>
      <div class="sig-type">${esc(s.sourceType || "")}</div>
      ${renderSources(s.sources)}
    </div>`;
  }).join("");
  return `<section id="this-week">
    <span class="section-label">Section 1</span>
    <h2>This Week's Signals</h2>
    <div class="signal-grid">${cards}</div>
  </section>`;
}

function renderPricingIntelligence(pi, a, b) {
  if (!pi || !pi.exists || !Array.isArray(pi.findings) || pi.findings.length === 0) {
    return `<section id="pricing-intel">
      <span class="section-label">Section 2</span>
      <h2>Pricing Intelligence</h2>
      <p class="muted">No pricing-archive signals attached this run. Pricing intelligence requires the Wayback Machine collector from the intelligence-engine to have run against each competitor's /pricing and /plans pages.</p>
    </section>`;
  }
  const cards = pi.findings.map((f) => {
    const bullets = Array.isArray(f.priceChanges) && f.priceChanges.length
      ? `<ul class="price-bullets">${f.priceChanges.map((b2) => `<li>${esc(b2)}</li>`).join("")}</ul>`
      : "";
    return `<div class="insight-card">
      ${renderCompetitorTags([f.competitor], a, b)}
      <h3>${esc(f.summary)}</h3>
      ${bullets}
      ${renderSources(f.sources)}
    </div>`;
  }).join("");
  return `<section id="pricing-intel">
    <span class="section-label">Section 2</span>
    <h2>Pricing Intelligence <span class="badge-src">Wayback Machine</span></h2>
    <p class="muted">Pricing-page changes detected by diffing archived snapshots. Most prospects cannot replicate this with ChatGPT.</p>
    ${cards}
  </section>`;
}

function renderSecFilings(sf, a, b) {
  if (!sf || !sf.exists || !Array.isArray(sf.items) || sf.items.length === 0) {
    return "";
  }
  const hasMaterial = (f) => {
    const d = String(f.filedDate || "").trim().toLowerCase();
    const i = String(f.items || "").toLowerCase();
    if (!d || d === "n/a" || d === "none") return false;
    if (i.includes("no 8-k") || i.includes("no filings")) return false;
    return true;
  };
  const material = sf.items.filter(hasMaterial);
  const empty    = sf.items.filter((f) => !hasMaterial(f));

  const materialCards = material.map((f) => {
    return `<div class="insight-card">
      ${renderCompetitorTags([f.competitor], a, b)}
      <h3>${esc(f.form || "8-K")} &middot; filed ${esc(f.filedDate)}</h3>
      <p class="sec-items">${esc(f.items || "")}</p>
      <p>${esc(f.summary || "")}</p>
      ${renderSources(f.sources)}
    </div>`;
  }).join("");

  const emptyNote = empty.length
    ? `<div class="insight-card sec-empty">
        <p>${empty.map((f) => `<strong>${esc(f.competitor)}</strong>: ${esc(f.summary || "No 8-K filings in the lookback window — EDGAR was checked.")}`).join("<br>")}</p>
        ${renderSources(empty.flatMap((f) => f.sources || []))}
      </div>`
    : "";

  const cards = `${materialCards}${emptyNote}`;
  return `<section id="sec-filings">
    <span class="section-label">Section 3</span>
    <h2>SEC 8-K Filings <span class="badge-src">EDGAR</span></h2>
    <p class="muted">Material events a public competitor is legally required to disclose within 4 business days. Unimpeachable, zero-cost signal source.</p>
    ${cards}
  </section>`;
}

function renderComparisonMatrix(cm, a, b) {
  if (!cm || !Array.isArray(cm.rows) || cm.rows.length === 0) return "";
  const header = `<tr><th>&nbsp;</th><th>${esc(a)}</th><th>${esc(b)}</th></tr>`;
  const rows = cm.rows.map((r) => {
    const note = r.note ? `<div class="matrix-note">${esc(r.note)}</div>` : "";
    return `<tr>
      <th class="axis">${esc(r.axis)}${note}</th>
      <td>${esc(r.a)}</td>
      <td>${esc(r.b)}</td>
    </tr>`;
  }).join("");
  return `<section id="matrix">
    <span class="section-label">At a glance</span>
    <h2>Competitor Comparison</h2>
    <div class="matrix-wrap"><table class="matrix">${header}${rows}</table></div>
  </section>`;
}

function renderMarketMoves(mm, a, b) {
  if (!Array.isArray(mm) || mm.length === 0) return "";
  const cards = mm.map((m) => {
    const date = m.date ? `<span class="mm-date">${esc(m.date)}</span>` : "";
    const verify = m.verify
      ? `<details class="verify"><summary>How to verify</summary><p>${esc(m.verify)}</p><p class="verify-basis"><em>Confidence basis:</em> ${esc(m.confidenceBasis || "")}</p></details>`
      : "";
    return `<div class="insight-card">
      <div class="card-head">
        ${renderCompetitorTags(m.competitors || [], a, b)}
        ${renderConfidencePill(m.confidence)}
        ${date}
      </div>
      <h3>${esc(m.title)}</h3>
      <p>${esc(m.body)}</p>
      ${renderSources(m.sources)}
      ${verify}
    </div>`;
  }).join("");
  return `<section id="moves">
    <span class="section-label">Recent market moves</span>
    <h2>What Each Competitor Is Doing</h2>
    ${cards}
  </section>`;
}

function renderTalkTracks(tt) {
  if (!Array.isArray(tt) || tt.length === 0) return "";
  const cards = tt.map((t) => {
    const badge = t.example
      ? `<span class="tt-badge tt-example">Fully-worked example</span>`
      : `<span class="tt-badge tt-template">Template &mdash; customize</span>`;
    const srcs = renderSources(t.sources);
    return `<div class="talk-track">
      <div class="tt-head">
        <span class="objection-label">Objection</span>
        ${renderConfidencePill(t.confidence)}
        ${badge}
      </div>
      <p class="objection">${esc(t.objection)}</p>
      <p class="response-label">Recommended Response</p>
      <p class="response">${esc(t.response)}</p>
      ${srcs}
    </div>`;
  }).join("");
  return `<section id="talk-tracks">
    <span class="section-label">Rep talk tracks</span>
    <h2>Objection Handling</h2>
    ${cards}
  </section>`;
}

function renderWatchNextWeek(list) {
  if (!Array.isArray(list) || list.length === 0) return "";
  const rows = list.map((w) => {
    const when = w.expectedBy ? `<span class="w-when">${esc(w.expectedBy)}</span>` : "";
    return `<li><span class="w-trigger">${esc(w.trigger || "")}</span><span class="w-text">${esc(w.text)}</span>${when}</li>`;
  }).join("");
  return `<section id="watch">
    <span class="section-label">Forward look</span>
    <h2>Watch Next Week</h2>
    <ul class="watch-list">${rows}</ul>
  </section>`;
}

function renderEvidenceIndex(ei) {
  if (!Array.isArray(ei) || ei.length === 0) return "";
  const blocks = ei.map((e) => {
    const srcs = renderSources(e.sources);
    return `<details class="ev-block"><summary>${esc(e.competitor)} &middot; ${(e.sources || []).length} source(s)</summary>${srcs}</details>`;
  }).join("");
  return `<section id="evidence">
    <span class="section-label">Appendix</span>
    <h2>Evidence Index</h2>
    <p class="muted">Every source URL consulted for this brief, grouped by competitor.</p>
    ${blocks}
  </section>`;
}

function renderTableOfContents(brief) {
  // Only render anchors for sections that will actually be shown. Each helper
  // check mirrors the corresponding render function's gating logic so the TOC
  // never points at an empty section.
  const items = [];

  const te = brief.triggerEvents;
  if (te && te.exists && Array.isArray(te.items) && te.items.length) {
    items.push({ href: "#this-week", label: "Trigger Events" });
  }

  if (Array.isArray(brief.thisWeekSignals) && brief.thisWeekSignals.length) {
    items.push({ href: "#this-week", label: "This Week's Signals" });
  }

  const pi = brief.pricingIntelligence;
  if (pi && pi.exists && Array.isArray(pi.findings) && pi.findings.length) {
    items.push({ href: "#pricing-intel", label: "Pricing" });
  }

  const sf = brief.secFilings;
  if (sf && sf.exists && Array.isArray(sf.items) && sf.items.length) {
    items.push({ href: "#sec-filings", label: "SEC 8-K" });
  }

  const cm = brief.comparisonMatrix;
  if (cm && Array.isArray(cm.rows) && cm.rows.length) {
    items.push({ href: "#matrix", label: "Comparison" });
  }

  if (Array.isArray(brief.marketMoves) && brief.marketMoves.length) {
    items.push({ href: "#moves", label: "Market Moves" });
  }

  if (Array.isArray(brief.talkTracks) && brief.talkTracks.length) {
    items.push({ href: "#talk-tracks", label: "Talk Tracks" });
  }

  if (Array.isArray(brief.watchNextWeek) && brief.watchNextWeek.length) {
    items.push({ href: "#watch", label: "Watch Next Week" });
  }

  // Dedupe (signals + triggers both anchor to #this-week) while preserving order
  const seen = new Set();
  const dedup = items.filter((it) => {
    if (seen.has(it.href)) return false;
    seen.add(it.href);
    return true;
  });

  if (dedup.length <= 1) return ""; // nothing meaningful to skim to

  const links = dedup
    .map((it) => `<a href="${esc(it.href)}">${esc(it.label)}</a>`)
    .join("");

  return `<nav class="toc" aria-label="Sections">
    <span class="toc-label">Sections</span>
    <div class="toc-links">${links}</div>
  </nav>`;
}

function authorInitials(name) {
  if (!name) return "";
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((p) => p[0].toUpperCase()).join("");
}

function renderByline() {
  // Entire block is suppressed if the founder hasn't set their name in env.
  // This keeps the default output clean for anyone running the brief generator
  // without customising credentials.
  if (!AUTHOR_NAME) return "";

  const avatar = AUTHOR_AVATAR_URL
    ? `<img class="byline-avatar" src="${esc(AUTHOR_AVATAR_URL)}" alt="${esc(AUTHOR_NAME)}" />`
    : `<span class="byline-monogram" aria-hidden="true">${esc(authorInitials(AUTHOR_NAME))}</span>`;

  const credentialLine = AUTHOR_CREDENTIAL
    ? `<p class="byline-credential">${esc(AUTHOR_CREDENTIAL)}</p>`
    : "";

  const linkedinLink = AUTHOR_LINKEDIN
    ? `<a class="byline-link" href="${esc(AUTHOR_LINKEDIN)}" target="_blank" rel="noopener noreferrer">Verify on LinkedIn →</a>`
    : "";

  const titleLine = AUTHOR_TITLE
    ? `<span class="byline-title">${esc(AUTHOR_TITLE)}</span>`
    : "";

  return `<aside class="byline" aria-label="Analyst">
    <div class="byline-id">
      ${avatar}
      <div class="byline-text">
        <span class="byline-eyebrow">Prepared by</span>
        <p class="byline-name">${esc(AUTHOR_NAME)}${titleLine ? ` <span class="byline-sep">·</span> ${titleLine}` : ""}</p>
        ${credentialLine}
        ${linkedinLink}
      </div>
    </div>
  </aside>`;
}

function renderCta(ctaUrl, brandName, industryName) {
  return `<section id="cta">
    <div class="cta-card">
      <h2>A briefing like this &mdash; every Monday, on your competitors.</h2>
      <p>You just read a vertical sample. A live ${esc(brandName)} engagement delivers a briefing of this depth every Monday, scoped to the two or three competitors your sales team actually loses deals to in ${esc(industryName)}, with trigger alerts the same day something material happens.</p>
      <a class="cta-btn" href="${esc(ctaUrl)}" id="cta-link" target="_blank" rel="noopener noreferrer">Book a 15-minute scoping call</a>
      <p class="cta-micro">No pitch. We scope your two most-feared competitors live on the call.</p>
    </div>
  </section>`;
}

// Self-contained CSS — dark editorial aesthetic (Stratechery / Bloomberg Intelligence school),
// restrained accent palette, serif display type, responsive.
const STYLE = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg-primary:#0b0c10; --bg-secondary:#111216; --bg-tertiary:#161820; --bg-card:#141620;
  --border-subtle:#262830; --border-accent:#3a3d48;
  --text-primary:#f2efe8; --text-secondary:#a8a49a; --text-tertiary:#6f6b60;
  --accent:#c48a47;          /* burnt amber — the single editorial accent */
  --accent-tint:rgba(196,138,71,0.08);
  --accent-line:rgba(196,138,71,0.35);
  --positive:#7fb896;        /* muted sage, not neon green */
  --warning:#d4a44e;
  --alert:#c35555;            /* oxblood, not bright red */
  --rule:#2a2c36;
  --font-serif:'Fraunces','Iowan Old Style',Georgia,'Times New Roman',serif;
  --font-sans:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  --font-mono:ui-monospace,'Cascadia Code','Segoe UI Mono','SF Mono',Menlo,Consolas,monospace;
  --max-width:880px;
}
html{scroll-behavior:smooth}
body{background:var(--bg-primary);color:var(--text-primary);font-family:var(--font-sans);font-size:16.5px;line-height:1.65;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;font-feature-settings:"kern" 1,"liga" 1,"cv11" 1}
.container{max-width:var(--max-width);margin:0 auto;padding:0 28px}
a{color:var(--accent);text-decoration:none;border-bottom:1px solid transparent;transition:border-color 0.15s ease}
a:hover{border-bottom-color:var(--accent-line);text-decoration:none}

/* ── Masthead ────────────────────────────────────────────────────────────── */
header{border-bottom:2px solid var(--rule);padding:64px 0 40px;position:relative}
header::before{content:"";position:absolute;top:0;left:50%;transform:translateX(-50%);width:100%;max-width:var(--max-width);height:1px;background:var(--rule);padding:0 28px}
.tag-line{display:block;font-family:var(--font-sans);font-size:10.5px;font-weight:600;letter-spacing:0.28em;text-transform:uppercase;color:var(--accent);margin-bottom:28px;padding:0;background:transparent;border:none;border-radius:0}
.tag-line::before{content:"§ ";font-family:var(--font-serif);font-style:italic}
header h1{font-family:var(--font-serif);font-size:clamp(34px,5vw,52px);font-weight:600;line-height:1.12;letter-spacing:-0.02em;color:var(--text-primary);margin-bottom:16px}
header h1 span.vs{color:var(--text-tertiary);font-style:italic;font-weight:400;font-size:0.68em;padding:0 4px;vertical-align:0.08em}
.vertical-badge{display:inline-block;font-family:var(--font-sans);font-size:10px;font-weight:600;color:var(--text-secondary);background:transparent;border:1px solid var(--rule);padding:4px 12px;border-radius:0;margin-top:8px;letter-spacing:0.2em;text-transform:uppercase}
.custom-id{font-family:var(--font-sans);font-size:12.5px;color:var(--text-tertiary);margin-top:20px;font-weight:500;letter-spacing:0.06em;text-transform:none}
.custom-id::before{content:"";display:inline-block;width:24px;height:1px;background:var(--accent);vertical-align:middle;margin-right:10px}
.week-summary{font-family:var(--font-serif);font-size:20px;font-weight:400;line-height:1.6;color:var(--text-primary);letter-spacing:-0.01em;margin-top:32px;padding:0 0 0 24px;background:transparent;border-left:2px solid var(--accent);border-radius:0}

/* ── Freshness strip ─────────────────────────────────────────────────────── */
.freshness{display:flex;align-items:center;gap:12px;margin:24px 0 0;padding:12px 16px;border-radius:0;font-family:var(--font-sans);font-size:13px;letter-spacing:0.02em;color:var(--text-secondary);border:1px solid var(--rule);background:var(--bg-secondary);text-transform:none}
.freshness.live{border-color:rgba(127,184,150,0.3)}
.freshness.sample{border-color:rgba(212,164,78,0.3)}
.freshness-dot{width:6px;height:6px;border-radius:50%;background:var(--positive);box-shadow:0 0 0 4px rgba(127,184,150,0.1)}
.freshness.sample .freshness-dot{background:var(--warning);box-shadow:0 0 0 4px rgba(212,164,78,0.1)}
.freshness strong{color:var(--text-primary);font-weight:600}

/* ── Confidence legend ───────────────────────────────────────────────────── */
.conf-legend{display:flex;flex-direction:column;gap:10px;font-family:var(--font-sans);font-size:14px;line-height:1.5;color:var(--text-secondary);margin:20px 0 0;padding:16px 18px;background:var(--bg-secondary);border:1px solid var(--rule);border-radius:0}
.conf-legend-intro{margin-bottom:2px}
.conf-legend strong{font-family:var(--font-sans);color:var(--text-primary);font-weight:600;text-transform:none;letter-spacing:0;font-size:14px}
.conf-legend-row{display:block;padding-left:0}
.conf-pill{display:inline-flex;align-items:center;justify-content:center;min-height:24px;padding:3px 10px;border-radius:4px;font-size:12.5px;font-weight:600;font-family:var(--font-sans);margin-right:8px;vertical-align:middle;border:1px solid;white-space:nowrap;letter-spacing:0.01em}
.conf-high{background:rgba(127,184,150,0.12);color:var(--positive);border-color:rgba(127,184,150,0.45)}
.conf-med{background:var(--accent-tint);color:var(--accent);border-color:var(--accent-line)}
.conf-low{background:transparent;color:var(--text-tertiary);border-color:var(--rule)}

/* ── How to use (now framed as editor's note) ────────────────────────────── */
.how-to-use{background:transparent;border:none;border-top:1px solid var(--rule);border-bottom:1px solid var(--rule);border-radius:0;padding:24px 0;margin:28px 0 0}
.how-to-use h2{font-family:var(--font-sans);font-size:10.5px;font-weight:700;color:var(--accent);margin-bottom:16px;letter-spacing:0.24em;text-transform:uppercase}
.how-to-use h2::before{content:"Editor's note · "}
.how-to-use ol{list-style:none;counter-reset:steps}
.how-to-use ol li{counter-increment:steps;position:relative;padding-left:36px;margin-bottom:10px;font-size:14.5px;color:var(--text-secondary);line-height:1.65}
.how-to-use ol li::before{content:counter(steps,upper-roman);position:absolute;left:0;top:0;font-family:var(--font-serif);font-style:italic;font-size:14px;color:var(--accent);letter-spacing:0.02em}
.how-to-use ol li strong{color:var(--text-primary);font-weight:600}

/* ── Sections (numbered editorial chapters) ──────────────────────────────── */
section{padding:56px 0;border-bottom:1px solid var(--rule);position:relative}
section:last-of-type{border-bottom:none}
.section-label{display:block;font-family:var(--font-sans);font-size:10.5px;font-weight:600;letter-spacing:0.28em;text-transform:uppercase;color:var(--text-tertiary);margin-bottom:14px}
.section-label::before{content:"— "}
section h2{font-family:var(--font-serif);font-size:clamp(26px,3.8vw,36px);font-weight:600;letter-spacing:-0.015em;line-height:1.22;margin-bottom:10px;color:var(--text-primary)}
section p.muted{color:var(--text-secondary);font-size:14.5px;margin-bottom:24px;font-family:var(--font-serif);font-style:italic;line-height:1.6;max-width:640px}
.badge-src{display:inline-block;font-family:var(--font-sans);font-size:10px;font-weight:600;color:var(--accent);background:transparent;border:1px solid var(--accent-line);padding:3px 10px;border-radius:0;margin-left:10px;vertical-align:middle;letter-spacing:0.18em;text-transform:uppercase}

/* ── Trigger banner ──────────────────────────────────────────────────────── */
.trigger-banner{margin:20px 0 0;padding:22px 26px;border-radius:0;border:1px solid var(--rule);background:var(--bg-secondary)}
.trigger-banner.none{background:transparent;color:var(--text-tertiary);font-family:var(--font-serif);font-style:italic;font-size:15px;padding:18px 0;border:none;border-top:1px solid var(--rule);border-bottom:1px solid var(--rule)}
.trigger-banner.has{background:transparent;border-color:rgba(195,85,85,0.3);border-left:3px solid var(--alert)}
.trigger-label{font-family:var(--font-sans);font-size:10px;font-weight:700;letter-spacing:0.28em;text-transform:uppercase;color:var(--alert);margin-bottom:18px}
.trigger-card{padding:14px 0 4px;border-top:1px solid var(--rule)}
.trigger-card:first-of-type{border-top:none;padding-top:0}
.trigger-head{display:flex;flex-wrap:wrap;gap:10px;align-items:baseline;margin-bottom:8px}
.trigger-head strong{font-family:var(--font-serif);color:var(--text-primary);font-size:19px;font-weight:400;line-height:1.3}
.te-date,.sig-date,.mm-date,.w-when{font-family:var(--font-mono);font-size:10.5px;color:var(--text-tertiary);letter-spacing:0.04em;text-transform:uppercase}
.trigger-detail{font-size:14.5px;color:var(--text-secondary);line-height:1.7}

/* ── Signal grid ─────────────────────────────────────────────────────────── */
.signal-grid{display:grid;grid-template-columns:1fr;gap:0;margin-top:8px}
@media(min-width:720px){.signal-grid{grid-template-columns:1fr 1fr;gap:0 36px}}
.signal-card{background:transparent;border:none;border-top:1px solid var(--rule);border-radius:0;padding:18px 0 16px}
.sig-head{margin-top:8px;display:flex;flex-wrap:wrap;align-items:baseline;gap:10px}
.sig-head strong{font-family:var(--font-serif);font-size:17px;font-weight:400;color:var(--text-primary);line-height:1.3}
.sig-type{font-size:10.5px;font-family:var(--font-mono);color:var(--text-tertiary);margin-top:6px;text-transform:uppercase;letter-spacing:0.14em}

/* ── Insight cards (pricing, SEC, market moves) ──────────────────────────── */
.insight-card{background:transparent;border:none;border-top:1px solid var(--rule);border-radius:0;padding:24px 0 20px;margin-bottom:0;transition:none}
.insight-card:hover{border-color:var(--rule)}
.insight-card .card-head{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:10px}
.insight-card h3{font-family:var(--font-serif);font-size:21px;font-weight:400;color:var(--text-primary);margin-bottom:10px;letter-spacing:-0.01em;line-height:1.3}
.insight-card p{font-size:14.5px;color:var(--text-secondary);line-height:1.75;margin-bottom:10px}
.insight-card p:last-of-type{margin-bottom:0}
.price-bullets{margin:10px 0 14px 0;list-style:none}
.price-bullets li{font-size:14px;color:var(--text-secondary);margin-bottom:6px;padding-left:20px;position:relative;line-height:1.6}
.price-bullets li::before{content:"→";position:absolute;left:0;top:0;color:var(--accent);font-family:var(--font-serif)}
.sec-items{font-family:var(--font-mono);font-size:11.5px;color:var(--text-tertiary) !important;background:transparent;padding:6px 10px;border-radius:0;border:1px solid var(--rule);display:inline-block;letter-spacing:0.02em}

/* ── Competitor tags (restrained, not neon) ──────────────────────────────── */
.competitor-tag{display:inline-block;font-family:var(--font-sans);font-size:10px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;padding:3px 10px;border-radius:0;margin-right:6px;border:1px solid}
.tag-a{color:var(--accent);background:transparent;border-color:var(--accent-line)}
.tag-b{color:var(--positive);background:transparent;border-color:rgba(127,184,150,0.35)}
.tag-neutral{color:var(--text-tertiary);background:transparent;border-color:var(--rule)}

/* ── Sources (editorial footnote style) ──────────────────────────────────── */
.sources{list-style:none;margin:14px 0 0;padding:10px 0 0;background:transparent;border:none;border-top:1px dashed var(--rule);border-radius:0;font-family:var(--font-mono);font-size:11.5px;line-height:1.7}
.sources li{padding:3px 0;display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;letter-spacing:0.01em}
.sources li::before{content:"·";color:var(--text-tertiary);margin-right:2px}
.sources a{color:var(--accent);word-break:break-all;border-bottom:1px dotted var(--accent-line)}
.sources .src-nolink{color:var(--text-secondary)}
.sources .src-type{font-family:var(--font-mono);font-size:10px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.16em;background:transparent;padding:1px 0;border-radius:0;border:none}
.sources .src-type::before{content:"["}
.sources .src-type::after{content:"]"}
.sources .src-date{font-family:var(--font-mono);font-size:10.5px;color:var(--text-tertiary)}

/* ── Verify details ──────────────────────────────────────────────────────── */
details.verify{margin-top:12px;font-size:13px;color:var(--text-tertiary)}
details.verify summary{cursor:pointer;color:var(--accent);user-select:none;font-family:var(--font-sans);font-size:11px;letter-spacing:0.14em;text-transform:uppercase;font-weight:600;padding:4px 0}
details.verify summary:hover{color:var(--text-primary)}
details.verify p{font-size:13.5px;color:var(--text-secondary);margin-top:8px;margin-bottom:0;line-height:1.7}
details.verify .verify-basis{font-family:var(--font-serif);font-style:italic;color:var(--text-tertiary);font-size:13px}

/* ── Matrix ──────────────────────────────────────────────────────────────── */
.matrix-wrap{overflow-x:auto;margin-top:12px;border:1px solid var(--rule)}
table.matrix{width:100%;border-collapse:collapse;font-size:14.5px}
table.matrix th,table.matrix td{text-align:left;padding:16px 18px;border-bottom:1px solid var(--rule);vertical-align:top}
table.matrix tr:last-child th,table.matrix tr:last-child td{border-bottom:none}
table.matrix th{color:var(--text-tertiary);font-weight:700;font-size:10.5px;letter-spacing:0.2em;text-transform:uppercase;font-family:var(--font-sans)}
table.matrix tr:first-child th{font-family:var(--font-serif);font-size:17px;color:var(--text-primary);text-transform:none;letter-spacing:-0.005em;font-weight:400;background:var(--bg-secondary)}
table.matrix th.axis{color:var(--text-primary);font-weight:600;text-transform:none;letter-spacing:0;font-size:14.5px;width:32%;font-family:var(--font-sans)}
table.matrix td{color:var(--text-secondary);line-height:1.65}
.matrix-note{font-family:var(--font-serif);font-size:13px;color:var(--text-tertiary);font-style:italic;font-weight:400;margin-top:6px}

/* ── Talk tracks (objection + response, editorial dialogue) ─────────────── */
.talk-track{background:transparent;border:none;border-top:1px solid var(--rule);border-radius:0;padding:28px 0 24px;margin-bottom:0}
.talk-track:first-of-type{border-top:none;padding-top:8px}
.tt-head{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-bottom:12px}
.objection-label{font-family:var(--font-sans);font-size:10.5px;font-weight:700;letter-spacing:0.24em;text-transform:uppercase;color:var(--alert)}
.response-label{font-family:var(--font-sans);font-size:10.5px;font-weight:700;letter-spacing:0.24em;text-transform:uppercase;color:var(--positive);margin:18px 0 10px}
.objection{font-family:var(--font-serif);font-size:22px;font-weight:400;color:var(--text-primary);font-style:italic;margin-bottom:12px;line-height:1.4;letter-spacing:-0.01em;padding-left:16px;border-left:2px solid var(--rule)}
.objection::before{content:"\\201C";color:var(--text-tertiary);font-size:1.2em;margin-right:2px}
.objection::after{content:"\\201D";color:var(--text-tertiary);font-size:1.2em;margin-left:2px}
.response{font-size:15px;color:var(--text-secondary);line-height:1.8}
.tt-badge{font-family:var(--font-sans);font-size:9.5px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;padding:3px 10px;border-radius:0;border:1px solid}
.tt-example{color:var(--positive);background:transparent;border-color:rgba(127,184,150,0.35)}
.tt-template{color:var(--text-tertiary);background:transparent;border-color:var(--rule)}

/* ── Watch list ──────────────────────────────────────────────────────────── */
.watch-list{list-style:none;padding:0;margin:12px 0 0}
.watch-list li{padding:16px 0;border:none;border-bottom:1px solid var(--rule);border-radius:0;margin-bottom:0;display:flex;flex-wrap:wrap;gap:14px;align-items:baseline;background:transparent}
.watch-list li:last-child{border-bottom:none}
.w-trigger{font-family:var(--font-sans);font-size:10px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:var(--accent);background:transparent;border:1px solid var(--accent-line);padding:3px 10px;border-radius:0}
.w-text{font-family:var(--font-serif);font-size:16px;color:var(--text-secondary);flex:1 1 60%;line-height:1.5;font-weight:400}

/* ── Evidence index (appendix) ───────────────────────────────────────────── */
.ev-block{margin-bottom:4px;padding:14px 0;background:transparent;border:none;border-bottom:1px solid var(--rule);border-radius:0}
.ev-block summary{cursor:pointer;font-family:var(--font-sans);font-size:13px;color:var(--text-primary);font-weight:600;letter-spacing:0.02em;user-select:none;padding:4px 0}
.ev-block summary:hover{color:var(--accent)}

/* ── CTA (tasteful, single confident button) ─────────────────────────────── */
#cta{border-bottom:none;padding-bottom:72px}
.cta-card{background:transparent;border:1px solid var(--rule);border-radius:0;padding:48px 36px;text-align:center;position:relative}
.cta-card::before{content:"";position:absolute;top:-1px;left:50%;transform:translateX(-50%);width:80px;height:2px;background:var(--accent)}
.cta-card h2{font-family:var(--font-serif);font-size:clamp(28px,4vw,36px);font-weight:400;letter-spacing:-0.015em;margin-bottom:16px;color:var(--text-primary);line-height:1.2}
.cta-card p{font-family:var(--font-serif);color:var(--text-secondary);font-size:17px;line-height:1.6;max-width:560px;margin:0 auto 28px;font-weight:400}
.cta-btn{display:inline-block;background:var(--accent);color:var(--bg-primary);padding:14px 36px;border-radius:0;font-family:var(--font-sans);font-weight:600;font-size:13.5px;letter-spacing:0.14em;text-transform:uppercase;border:none;transition:background 0.15s ease;border-bottom:none}
.cta-btn:hover{background:#d79b55;text-decoration:none;border-bottom:none}
.cta-micro{font-family:var(--font-mono);color:var(--text-tertiary);font-size:11px;margin-top:20px;letter-spacing:0.04em;text-transform:uppercase}

/* ── Footer colophon ─────────────────────────────────────────────────────── */
footer{border-top:2px solid var(--rule);padding:32px 0 48px;text-align:center;position:relative}
footer::before{content:"§";display:block;font-family:var(--font-serif);font-style:italic;font-size:20px;color:var(--accent);margin-bottom:14px}
footer p{font-family:var(--font-sans);font-size:13px;color:var(--text-tertiary);letter-spacing:0.02em;line-height:1.75}
footer p.colophon{font-family:var(--font-serif);font-style:italic;font-size:14px;color:var(--text-secondary);letter-spacing:0;margin-bottom:8px}
footer .gen-date{font-family:var(--font-sans);font-weight:500;color:var(--text-secondary);text-transform:none;letter-spacing:0.04em;font-size:12px}

/* ── Table of contents (skim path above the fold) ────────────────────────── */
.toc{margin-top:32px;padding:18px 0;border-top:1px solid var(--rule);border-bottom:1px solid var(--rule);display:flex;flex-wrap:wrap;align-items:baseline;gap:18px}
.toc-label{font-family:var(--font-sans);font-size:10px;font-weight:700;letter-spacing:0.28em;text-transform:uppercase;color:var(--text-tertiary);white-space:nowrap}
.toc-label::before{content:"§ "}
.toc-links{display:flex;flex-wrap:wrap;gap:0 20px;flex:1 1 auto}
.toc-links a{font-family:var(--font-sans);font-size:12px;font-weight:500;letter-spacing:0.04em;color:var(--text-secondary);border-bottom:none;padding:2px 0;position:relative;transition:color 0.15s ease}
.toc-links a:hover{color:var(--accent);border-bottom:none}
.toc-links a + a::before{content:"";position:absolute;left:-10px;top:50%;transform:translateY(-50%);width:2px;height:2px;background:var(--text-tertiary);border-radius:50%}

/* ── Analyst byline (trust lever directly above the CTA) ─────────────────── */
.byline{padding:32px 0 24px;border-top:1px solid var(--rule)}
.byline-id{display:flex;gap:20px;align-items:flex-start;max-width:560px;margin:0 auto;text-align:left}
.byline-avatar{width:56px;height:56px;border-radius:50%;object-fit:cover;border:1px solid var(--rule);flex-shrink:0}
.byline-monogram{width:56px;height:56px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-family:var(--font-serif);font-size:22px;font-weight:400;color:var(--accent);background:transparent;border:1px solid var(--accent-line);flex-shrink:0;letter-spacing:0.02em}
.byline-text{flex:1 1 auto;min-width:0}
.byline-eyebrow{display:block;font-family:var(--font-sans);font-size:10px;font-weight:600;letter-spacing:0.24em;text-transform:uppercase;color:var(--text-tertiary);margin-bottom:4px}
.byline-name{font-family:var(--font-serif);font-size:22px;font-weight:400;letter-spacing:-0.01em;color:var(--text-primary);line-height:1.25;margin-bottom:6px}
.byline-title{font-family:var(--font-sans);font-size:13px;font-weight:500;color:var(--text-secondary);letter-spacing:0;text-transform:none}
.byline-sep{color:var(--text-tertiary);font-weight:400;margin:0 2px}
.byline-credential{font-family:var(--font-serif);font-style:italic;font-size:15px;line-height:1.55;color:var(--text-secondary);margin-bottom:10px;letter-spacing:-0.002em}
.byline-link{font-family:var(--font-sans);font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:var(--accent);border-bottom:1px solid var(--accent-line);padding-bottom:1px}
.byline-link:hover{border-bottom-color:var(--accent)}

/* ── Responsive ──────────────────────────────────────────────────────────── */
@media(max-width:600px){
  .container{padding:0 20px}
  header{padding:44px 0 32px}
  header h1{font-size:32px}
  .week-summary{font-size:17px;padding-left:18px}
  section{padding:40px 0}
  section h2{font-size:26px}
  .insight-card,.talk-track,.signal-card{padding:20px 0}
  table.matrix th,table.matrix td{padding:12px 12px;font-size:13.5px}
  .objection{font-size:18px}
  .cta-card{padding:36px 22px}
  .cta-card h2{font-size:26px}
  .cta-card p{font-size:15.5px}
  .toc{padding:14px 0;gap:12px}
  .toc-links{gap:0 14px}
  .toc-links a{font-size:11.5px}
  .byline-id{gap:16px}
  .byline-name{font-size:19px}
  .byline-avatar,.byline-monogram{width:48px;height:48px;font-size:19px}
}
`;

function renderHtml({ brief, industryName, competitorA, competitorB, signalsFound, ctaUrl, brandName }) {
  const mode = brief.mode || (signalsFound ? "live" : "sample");
  const hero = brief.hero || {};
  const freshness = brief.freshness || {};
  const generatedLabel = fmtMonthYear(freshness.generatedAt);

  const confLegend = `<div class="conf-legend">
    <span class="conf-legend-intro"><strong>Confidence:</strong> each insight uses a label for how strongly the claim is supported.</span>
    <span class="conf-legend-row">${renderConfidencePill("High")} — directly evidenced by a dated source</span>
    <span class="conf-legend-row">${renderConfidencePill("Medium")} — pattern consistent with multiple signals</span>
    <span class="conf-legend-row">${renderConfidencePill("Low")} — market reasoning, not pinned to this week</span>
  </div>`;

  const howToUse = `<div class="how-to-use">
    <h2>How to read this brief</h2>
    <ol>
      <li>Start with <strong>This Week's Signals</strong> and <strong>Trigger Events</strong>. These are today's talking points.</li>
      <li>The <strong>Talk Track</strong> tagged "Fully-worked example" is ready to paste into your next discovery call as-is.</li>
      <li>Every claim carries a source. Click through before citing a specific number in a proposal.</li>
    </ol>
  </div>`;

  const toc    = renderTableOfContents(brief);
  const byline = renderByline();

  const body = [
    renderFreshnessStrip(freshness, mode, signalsFound),
    confLegend,
    howToUse,
    renderTriggerEventsBanner(brief.triggerEvents, competitorA, competitorB),
    renderThisWeekSignals(brief.thisWeekSignals, competitorA, competitorB),
    renderPricingIntelligence(brief.pricingIntelligence, competitorA, competitorB),
    renderSecFilings(brief.secFilings, competitorA, competitorB),
    renderComparisonMatrix(brief.comparisonMatrix, competitorA, competitorB),
    renderMarketMoves(brief.marketMoves, competitorA, competitorB),
    renderTalkTracks(brief.talkTracks),
    renderWatchNextWeek(brief.watchNextWeek),
    renderEvidenceIndex(brief.evidenceIndex),
    byline,
    // CTA intentionally disabled for now — the cold email itself carries the ask.
    // Re-enable later by uncommenting the next line.
    // renderCta(ctaUrl, brandName, industryName),
  ].filter(Boolean).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>The Briefing · ${esc(competitorA)} vs ${esc(competitorB)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;1,9..144,500&display=swap" rel="stylesheet">
<style>${STYLE}</style>
</head>
<body>
<div class="container">
  <header>
    <div class="tag-line">The Briefing · Competitive Intelligence</div>
    <h1>${esc(competitorA)} <span class="vs">versus</span> ${esc(competitorB)}</h1>
    <div class="vertical-badge">${esc(hero.industry || industryName)} &middot; Vertical Sample</div>
    <p class="custom-id" id="custom-id-line"></p>
    ${hero.weekSummary ? `<div class="week-summary">${esc(hero.weekSummary)}</div>` : ""}
    ${toc}
  </header>

  ${body}
</div>

<footer>
  <div class="container">
    <p class="colophon">Prepared by the ${esc(brandName)} analyst desk.</p>
    <p><span class="gen-date" id="generated-date-label">${generatedLabel ? `Generated ${esc(generatedLabel)}` : "Generated"}</span> &middot; ${esc(industryName)} vertical &middot; ${esc(competitorA)} vs ${esc(competitorB)}</p>
  </div>
</footer>

<script>
document.addEventListener('DOMContentLoaded', function () {
  // Personalize the hero line from ?id=
  var params = new URLSearchParams(window.location.search);
  var idRaw = params.get('id');
  var displayId = idRaw ? decodeURIComponent(idRaw) : '(no id in URL)';
  var el = document.getElementById('custom-id-line');
  if (el) el.textContent = 'Prepared for ' + displayId;

  // Preserve ?id= through the CTA click so open-tracking can bind the lead
  var cta = document.getElementById('cta-link');
  if (cta && idRaw) {
    try {
      var url = new URL(cta.href);
      url.searchParams.set('ref_id', idRaw);
      cta.href = url.toString();
    } catch (_) { /* leave href unchanged */ }
  }

  // Dynamic Month Year if the server-side label wasn't filled in
  var dateEl = document.getElementById('generated-date-label');
  if (dateEl && dateEl.textContent.trim() === 'Generated') {
    var d = new Date();
    var fmt = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(d);
    dateEl.textContent = 'Generated ' + fmt;
  }
});
</script>
</body>
</html>`;
}

// ─── Post-generation validation ───────────────────────────────────────────────

const PLACEHOLDER_PATTERN = /\[your [^\]]+\]/i;

function collectAllSourceEntries(brief) {
  const out = [];
  const push = (label, sources) => {
    if (!Array.isArray(sources)) return;
    sources.forEach((s, i) => out.push({ location: `${label}[${i}]`, source: s }));
  };
  (brief.marketMoves || []).forEach((m, i) => push(`marketMoves[${i}].sources`, m?.sources));
  (brief.thisWeekSignals || []).forEach((s, i) => push(`thisWeekSignals[${i}].sources`, s?.sources));
  (brief.triggerEvents?.items || []).forEach((t, i) => push(`triggerEvents.items[${i}].sources`, t?.sources));
  (brief.pricingIntelligence?.findings || []).forEach((f, i) => push(`pricingIntelligence.findings[${i}].sources`, f?.sources));
  (brief.secFilings?.items || []).forEach((f, i) => push(`secFilings.items[${i}].sources`, f?.sources));
  (brief.talkTracks || []).forEach((t, i) => push(`talkTracks[${i}].sources`, t?.sources));
  return out;
}

function validateBriefJson(brief) {
  const problems = [];
  if (!brief || typeof brief !== "object") {
    problems.push("brief is not an object");
    return problems;
  }

  if (!brief.hero || !brief.hero.weekSummary || brief.hero.weekSummary.length < 40) {
    problems.push("hero.weekSummary is missing or too short");
  }

  // Talk-track quota: ≥3 fully-worked examples (no placeholders), ≥2 templates (with placeholders).
  const tt = Array.isArray(brief.talkTracks) ? brief.talkTracks : [];
  if (tt.length === 0) problems.push("talkTracks is empty");

  const examples = tt.filter((t) => t && t.example === true);
  const templates = tt.filter((t) => t && t.example === false);

  if (examples.length < 3) {
    problems.push(`only ${examples.length} talkTrack(s) marked example=true (need ≥3 fully-worked examples; prompt enforces the 3/2 split)`);
  }
  if (templates.length < 2) {
    problems.push(`only ${templates.length} talkTrack(s) marked example=false (need ≥2 templates with [your X] placeholders)`);
  }

  // Any "fully-worked" example must not contain an unresolved placeholder.
  examples.forEach((t, i) => {
    const resp = typeof t.response === "string" ? t.response : "";
    if (PLACEHOLDER_PATTERN.test(resp)) {
      problems.push(`talkTracks example[${i}] is marked example=true but still contains a "[your ...]" placeholder — fully-worked entries must resolve all placeholders`);
    }
  });

  // Templates should actually carry a placeholder (otherwise they are just examples mislabeled).
  templates.forEach((t, i) => {
    const resp = typeof t.response === "string" ? t.response : "";
    if (!PLACEHOLDER_PATTERN.test(resp)) {
      problems.push(`talkTracks template[${i}] is marked example=false but has no "[your X]" placeholder — template entries must leave something for the rep to customize`);
    }
  });

  const mm = Array.isArray(brief.marketMoves) ? brief.marketMoves : [];
  if (mm.length === 0) problems.push("marketMoves is empty");
  const mmNoSource = mm.findIndex((m) => !Array.isArray(m.sources) || m.sources.length === 0);
  if (mmNoSource !== -1) problems.push(`marketMoves[${mmNoSource}] has no sources`);

  // Every source across the whole brief must carry a real URL. src-nolink entries destroy the "every claim sourced" trust pitch.
  const allSources = collectAllSourceEntries(brief);
  const unlinked = allSources.filter(({ source }) => !source || typeof source.url !== "string" || source.url.trim() === "");
  if (unlinked.length > 0) {
    const sample = unlinked.slice(0, 3).map((u) => u.location).join(", ");
    problems.push(
      `${unlinked.length} source(s) have empty "url" — unlinked citations are banned (first: ${sample}). Drop the parent insight or find a real URL.`
    );
  }

  return problems;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is missing. Set it in brief-app/.env.local or .env");
    process.exit(1);
  }

  const {
    industryName, competitorA, competitorB,
    signalsPath, ctaUrl, brandName,
  } = parseCliInputs();

  const resolved = resolveSignalsPath(industryName, signalsPath);
  const signals = loadSignals(resolved);

  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║       BRIEF GENERATOR — VERTICAL SAMPLE      ║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);
  console.log(`🏷️   ${industryName} | ${competitorA} vs ${competitorB}`);
  if (signals.found) {
    console.log(`📁  Signals loaded: ${path.relative(process.cwd(), signals.path)}`);
    console.log(`    ${(signals.payload.signals || []).length} raw signals collected at ${signals.payload.generatedAt}`);
  } else {
    console.log(`⚠️   No signals JSON found at ${path.relative(process.cwd(), resolved)}`);
    console.log(`    Brief will be generated in SAMPLE mode (labeled as such). To produce a live sample:`);
    console.log(`      cd ../intelligence-engine`);
    console.log(`      node scripts/collect-for-brief.js "${industryName}" "${competitorA}" "${competitorB}"`);
  }

  console.log(`\n🧠  Asking Claude for structured brief JSON...`);
  const brief = await callClaudeForBriefJson({
    industryName, competitorA, competitorB,
    signalsPayload: signals.payload,
  });

  const problems = validateBriefJson(brief);
  if (problems.length) {
    const strict = /^(1|true|yes)$/i.test(String(process.env.BRIEF_STRICT_VALIDATION || ""));
    const label = strict ? "Brief JSON validation FAILED" : "Brief JSON validation warnings";
    console.warn(`\n⚠️   ${label}:`);
    for (const p of problems) console.warn(`    - ${p}`);
    if (strict) {
      console.error(`\n    Strict mode on (BRIEF_STRICT_VALIDATION=1) — refusing to write a brief that fails the quality gate.`);
      console.error(`    Re-run the generator; Claude usually meets the quota on the second attempt when the prompt is honored.\n`);
      process.exit(2);
    } else {
      console.warn(`    (continuing — inspect the output to decide if a re-run is needed. Set BRIEF_STRICT_VALIDATION=1 to make these fatal.)\n`);
    }
  }

  const html = renderHtml({
    brief,
    industryName,
    competitorA,
    competitorB,
    signalsFound: signals.found,
    ctaUrl,
    brandName,
  });

  const publicDir = path.join(__dirname, "..", "public");
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

  const slug = slugifyIndustry(industryName);
  const filename = `${slug}-brief.html`;
  const outPath = path.join(publicDir, filename);
  fs.writeFileSync(outPath, html, "utf8");

  // Also persist the raw brief JSON alongside the HTML for debugging / replays.
  const jsonSidecar = path.join(publicDir, `${slug}-brief.json`);
  fs.writeFileSync(jsonSidecar, JSON.stringify(brief, null, 2), "utf8");

  // Write a mirror without hyphens if the slug contains any. Many existing
  // cold emails use the collapsed path (e.g. /elearning-brief.html for the
  // E-Learning vertical) because that's what was first published. Keeping the
  // mirror in sync means links already circulating in Instantly continue to
  // work, and newer links can use either form interchangeably.
  const collapsedSlug = slug.replace(/-/g, "");
  const mirrorFilename = `${collapsedSlug}-brief.html`;
  const mirrorJsonName = `${collapsedSlug}-brief.json`;
  let mirrorWritten = false;
  if (collapsedSlug && collapsedSlug !== slug) {
    fs.writeFileSync(path.join(publicDir, mirrorFilename), html, "utf8");
    fs.writeFileSync(path.join(publicDir, mirrorJsonName), JSON.stringify(brief, null, 2), "utf8");
    mirrorWritten = true;
  }

  console.log(`\n✅  Saved → public/${filename}`);
  console.log(`   Sidecar → public/${path.basename(jsonSidecar)}`);
  if (mirrorWritten) {
    console.log(`   Mirror  → public/${mirrorFilename} (kept in sync for legacy cold-email URLs)`);
  }
  console.log(`   Mode: ${brief.mode || (signals.found ? "live" : "sample")}`);
  console.log(`   Open locally: http://localhost:3000/${filename}?id=your_company_id\n`);
}

main().catch((err) => {
  console.error("\n❌  Fatal error:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
