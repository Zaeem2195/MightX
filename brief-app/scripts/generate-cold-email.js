/**
 * generate-cold-email.js
 * ──────────────────────
 * Given a vertical brief JSON that was already produced by generate-html-brief.js,
 * write 3 short cold-email variants that reference a real recent signal from the
 * brief and link to the prospect-personalised brief URL.
 *
 * This is the actual top-of-funnel conversion asset. A premium brief behind a
 * generic "Quick question about competitive intel" email converts ~0%. A specific,
 * recent, sourced opener dramatically raises click-through and reply rates.
 *
 * Flow:
 *   1. Load brief JSON from public/<industry-slug>-brief.json (produced by
 *      generate-html-brief.js). Fail loudly if not present.
 *   2. Pick the sharpest signal(s) that mention the prospect's named competitor
 *      (trigger events → thisWeekSignals → marketMoves → pricingIntelligence →
 *      high-confidence fallback).
 *   3. Ask Claude to write 3 variants (pattern-interrupt / helpful-frame /
 *      peer-reference) grounded strictly in the selected signal — no invented
 *      stats, no "Hope you're well", no clickbait subjects.
 *   4. Save to data/cold-emails/<industry-slug>--<company-slug>.md (gitignored)
 *      AND print to stdout so you can copy-paste straight into Apollo/Instantly.
 *
 * Usage:
 *   node scripts/generate-cold-email.js \
 *     --industry        "E-Learning" \
 *     --prospect-name   "Jane Doe" \
 *     --prospect-company "Acme Corp" \
 *     --prospect-role   "VP Sales" \
 *     --competitor      "Docebo" \
 *     --brief-base      "https://intel.nextbuildtech.com"   (optional; defaults to BRIEF_URL_BASE env)
 *     --sender-name     "Zaeem"                (optional; defaults to BRIEF_AUTHOR_NAME env)
 *
 * Prerequisites:
 *   - A brief JSON at public/<industry-slug>-brief.json (run generate-html-brief.js first)
 *   - ANTHROPIC_API_KEY in brief-app/.env.local or .env
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Anthropic = require("@anthropic-ai/sdk");

// ─── Constants ────────────────────────────────────────────────────────────────

const MODEL = "claude-opus-4-7";
const MAX_TOKENS = 4_096;

const BRIEF_URL_BASE   = (process.env.BRIEF_URL_BASE || "https://intel.nextbuildtech.com").replace(/\/$/, "");
const DEFAULT_SENDER   = (process.env.BRIEF_AUTHOR_NAME || "").trim();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function slugify(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function parseCliInputs() {
  const argv = process.argv.slice(2);
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      console.error(`Unexpected positional argument: ${a}`);
      process.exit(1);
    }
    const key = a.slice(2);
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("--")) {
      console.error(`Missing value for --${key}`);
      process.exit(1);
    }
    flags[key] = val;
    i++;
  }

  const required = ["industry", "prospect-name", "prospect-company", "competitor"];
  const missing = required.filter((k) => !flags[k]);
  if (missing.length) {
    console.error(`
Missing required flags: ${missing.map((m) => "--" + m).join(", ")}

Usage:
  node scripts/generate-cold-email.js \\
    --industry         "<Industry>" \\
    --prospect-name    "<Full Name>" \\
    --prospect-company "<Company>" \\
    --competitor       "<Competitor they fear>" \\
    [--prospect-role   "<Role>"] \\
    [--brief-base      "https://intel.nextbuildtech.com"] \\
    [--sender-name     "Zaeem"]
`);
    process.exit(1);
  }

  return {
    industryName:     flags["industry"].trim(),
    prospectName:     flags["prospect-name"].trim(),
    prospectCompany:  flags["prospect-company"].trim(),
    prospectRole:     (flags["prospect-role"] || "").trim(),
    competitor:       flags["competitor"].trim(),
    briefUrlBase:     (flags["brief-base"] || BRIEF_URL_BASE).replace(/\/$/, ""),
    senderName:       (flags["sender-name"] || DEFAULT_SENDER).trim(),
  };
}

function loadBrief(industryName) {
  const publicDir = path.join(__dirname, "..", "public");
  const file = path.join(publicDir, `${slugify(industryName)}-brief.json`);
  if (!fs.existsSync(file)) {
    console.error(`
No brief JSON found at:
  ${path.relative(process.cwd(), file)}

Run generate-html-brief.js first, for example:
  node scripts/generate-html-brief.js "${industryName}" "Competitor A" "Competitor B"
`);
    process.exit(1);
  }
  try {
    return { path: file, data: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (err) {
    console.error(`Failed to parse ${path.relative(process.cwd(), file)}: ${err.message}`);
    process.exit(1);
  }
}

// ─── Signal selection ────────────────────────────────────────────────────────

function matchesCompetitor(item, competitor) {
  const target = competitor.toLowerCase();
  if (!item) return false;

  if (typeof item.competitor === "string" && item.competitor.toLowerCase().includes(target)) return true;
  if (Array.isArray(item.competitors)) {
    if (item.competitors.some((c) => String(c).toLowerCase().includes(target))) return true;
  }

  // Sometimes the competitor is only in headline/body
  const blob = [item.headline, item.title, item.body, item.detail, item.summary]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return blob.includes(target);
}

function pickSignalsForProspect(brief, competitor) {
  const picked = [];
  const seenHeadlines = new Set();
  const take = (sig, bucket) => {
    if (!sig) return;
    const key = (sig.headline || sig.title || sig.summary || "").trim().toLowerCase();
    if (!key || seenHeadlines.has(key)) return;
    seenHeadlines.add(key);
    picked.push({ bucket, ...sig });
  };

  // Priority 1: trigger events matching the competitor (these are the sharpest)
  const te = brief.triggerEvents;
  if (te && te.exists && Array.isArray(te.items)) {
    for (const t of te.items) if (matchesCompetitor(t, competitor)) take(t, "triggerEvent");
  }

  // Priority 2: this-week signals for the competitor
  if (Array.isArray(brief.thisWeekSignals)) {
    for (const s of brief.thisWeekSignals) if (matchesCompetitor(s, competitor)) take(s, "thisWeekSignal");
  }

  // Priority 3: market moves for the competitor (prefer High/Medium confidence)
  if (Array.isArray(brief.marketMoves)) {
    const sorted = [...brief.marketMoves].sort((a, b) => {
      const rank = (c) => (c === "High" ? 0 : c === "Medium" ? 1 : 2);
      return rank(a.confidence) - rank(b.confidence);
    });
    for (const m of sorted) if (matchesCompetitor(m, competitor)) take(m, "marketMove");
  }

  // Priority 4: pricing intelligence
  const pi = brief.pricingIntelligence;
  if (pi && pi.exists && Array.isArray(pi.findings)) {
    for (const p of pi.findings) if (matchesCompetitor(p, competitor)) take(p, "pricing");
  }

  // Priority 5: SEC filings
  const sf = brief.secFilings;
  if (sf && sf.exists && Array.isArray(sf.items)) {
    for (const f of sf.items) {
      if (matchesCompetitor(f, competitor) && f.filedDate && String(f.filedDate).toLowerCase() !== "n/a") {
        take(f, "sec");
      }
    }
  }

  // Fallback 1: any non-matching trigger event (still a strong hook even if not
  // on the named competitor — "your category is moving" framing).
  if (!picked.length && te && te.exists && Array.isArray(te.items)) {
    for (const t of te.items) take(t, "triggerEvent");
  }

  // Fallback 2: first high-confidence market move
  if (!picked.length && Array.isArray(brief.marketMoves)) {
    const high = brief.marketMoves.find((m) => m.confidence === "High") || brief.marketMoves[0];
    if (high) take(high, "marketMove");
  }

  return picked.slice(0, 3); // 3 is plenty for the prompt
}

function formatSignalForPrompt(sig) {
  const lines = [];
  lines.push(`[${sig.bucket}]`);
  if (sig.competitor) lines.push(`COMPETITOR: ${sig.competitor}`);
  if (Array.isArray(sig.competitors) && sig.competitors.length) lines.push(`COMPETITORS: ${sig.competitors.join(", ")}`);
  if (sig.headline)   lines.push(`HEADLINE: ${sig.headline}`);
  if (sig.title)      lines.push(`TITLE: ${sig.title}`);
  if (sig.summary)    lines.push(`SUMMARY: ${sig.summary}`);
  if (sig.detail)     lines.push(`DETAIL: ${sig.detail}`);
  if (sig.body)       lines.push(`BODY: ${sig.body}`);
  if (sig.date)       lines.push(`DATE: ${sig.date}`);
  if (sig.filedDate)  lines.push(`FILED: ${sig.filedDate}`);
  if (sig.confidence) lines.push(`CONFIDENCE: ${sig.confidence}`);
  if (Array.isArray(sig.sources) && sig.sources.length) {
    lines.push("SOURCES:");
    for (const s of sig.sources.slice(0, 3)) {
      const label = s.label || s.url || "source";
      const date  = s.date ? ` (${s.date})` : "";
      lines.push(`  - ${label}${s.url ? " — " + s.url : ""}${date}`);
    }
  }
  return lines.join("\n");
}

// ─── Claude prompt ───────────────────────────────────────────────────────────

function buildSystemPrompt() {
  return `You are writing short, honest, specific cold emails for a competitive-intelligence service.

Hard rules — violate any and the email is rejected:
- 40 to 80 words total body, 3-4 sentences max. Shorter is better.
- The subject line is specific and recent. It names the competitor and the actual move. No "Quick question", no "Following up", no clickbait, no emoji.
- The opener references a real dated signal from the SIGNALS block, not "Hope you're well" or "I was reading about your company".
- Every factual claim must come from the SIGNALS block. If a signal has a date, mention it. If it has a source type (Wayback, SEC 8-K, sitemap diff, HN, Reddit), you may reference it to signal rigour.
- The CTA is soft: "Worth a look?", "Sending it over if useful", "Happy to pull a quick version for your actual competitors" — never "book a demo", "schedule a call", "interested?".
- Link the brief URL exactly as provided, including the ?id= param.
- Sign off with just the sender's first name.
- No bullet points. Prose only. No em-dash spam. Max one "I" per email.
- Write like a thoughtful peer, not like a marketer.

Produce THREE variants:
  A. "Pattern interrupt" — lead with the surprising move itself. Short. Direct.
  B. "Helpful frame" — frame the email as "I built this and thought you'd want the version scoped to your competitors".
  C. "Peer reference" — frame it as "a few VPs of Sales in your vertical have been asking about this — thought the write-up might save you a call".

Return STRICT JSON, no prose, no markdown fences, no commentary:

{
  "variants": [
    {
      "label":   "Pattern interrupt",
      "subject": "...",
      "body":    "...",
      "rationale": "one sentence on what this variant is betting on"
    },
    {
      "label":   "Helpful frame",
      "subject": "...",
      "body":    "...",
      "rationale": "..."
    },
    {
      "label":   "Peer reference",
      "subject": "...",
      "body":    "...",
      "rationale": "..."
    }
  ]
}`;
}

function buildUserPrompt({
  industryName, prospectName, prospectCompany, prospectRole,
  competitor, briefUrl, senderName, signals, competitorA, competitorB,
}) {
  const signalsBlock = signals.length
    ? signals.map(formatSignalForPrompt).join("\n\n---\n\n")
    : "NO COMPETITOR-SPECIFIC SIGNAL AVAILABLE — use the most useful high-confidence insight from the brief in a 'your category is moving' framing.";

  return `PROSPECT
  Name:    ${prospectName}
  Company: ${prospectCompany}${prospectRole ? `\n  Role:    ${prospectRole}` : ""}
  Feared competitor (the one they lose deals to): ${competitor}

INDUSTRY / VERTICAL: ${industryName}
BRIEF COMPETITORS IN THIS REPORT: ${competitorA} vs ${competitorB}

BRIEF URL (paste exactly, includes ?id= for personalization):
  ${briefUrl}

SENDER FIRST NAME: ${senderName || "[Your name]"}

SIGNALS (ground the opener in one of these):

${signalsBlock}

Now write the three variants as JSON.`;
}

// ─── Claude call ─────────────────────────────────────────────────────────────

async function callClaude(system, user) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: "user", content: user }],
  });

  const text = (resp.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  // Strip accidental ``` fences Claude occasionally adds
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error("\nClaude returned non-JSON. Raw output below:\n");
    console.error(text);
    throw new Error(`Claude response was not valid JSON: ${err.message}`);
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validateEmail(e, briefUrl) {
  const problems = [];
  if (!e.subject || e.subject.length < 10)            problems.push("subject missing or too short");
  if (/quick question|following up|hope you/i.test(e.subject || ""))
    problems.push("subject uses a banned opener");
  if (!e.body) {
    problems.push("body missing");
    return problems;
  }
  const words = e.body.trim().split(/\s+/).length;
  if (words < 30)  problems.push(`body too short (${words} words, want 40-80)`);
  if (words > 110) problems.push(`body too long  (${words} words, want 40-80)`);
  if (!e.body.includes(briefUrl)) problems.push("body is missing the brief URL (with ?id=)");
  if (/hope you'?re well|i hope this finds you/i.test(e.body))
    problems.push("body uses a banned opener phrase");
  return problems;
}

// ─── Markdown rendering ──────────────────────────────────────────────────────

function renderMarkdown({
  variants, prospectName, prospectCompany, prospectRole, competitor,
  industryName, briefUrl, senderName, brief,
}) {
  const hdr = [
    `# Cold email — ${prospectCompany} · ${industryName}`,
    ``,
    `- **Prospect:** ${prospectName}${prospectRole ? ` · ${prospectRole}` : ""} @ ${prospectCompany}`,
    `- **Feared competitor:** ${competitor}`,
    `- **Brief URL:** ${briefUrl}`,
    `- **Sender:** ${senderName || "(not set — export BRIEF_AUTHOR_NAME)"}`,
    `- **Generated:** ${new Date().toISOString()}`,
    `- **Brief generated at:** ${brief.freshness?.generatedAt || "unknown"}`,
    ``,
    `---`,
    ``,
  ].join("\n");

  const vBlocks = variants.map((v, i) => {
    const letter = String.fromCharCode(65 + i); // A, B, C
    return [
      `## Variant ${letter} — ${v.label || "(no label)"}`,
      v.rationale ? `\n_Rationale: ${v.rationale}_\n` : "",
      ``,
      `**Subject:** ${v.subject || "(no subject)"}`,
      ``,
      v.body || "(no body)",
      ``,
      `---`,
      ``,
    ].join("\n");
  }).join("\n");

  return hdr + vBlocks;
}

function printTerminalBlock(variants, briefUrl) {
  console.log("");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(" COLD EMAIL VARIANTS — copy directly into Apollo / Instantly");
  console.log("══════════════════════════════════════════════════════════════════════");
  variants.forEach((v, i) => {
    const letter = String.fromCharCode(65 + i);
    console.log("");
    console.log(`  ── Variant ${letter} · ${v.label || ""} `.padEnd(72, "─"));
    console.log("");
    console.log(`  SUBJECT: ${v.subject || "(missing)"}`);
    console.log("");
    const body = (v.body || "").split("\n").map((l) => "  " + l).join("\n");
    console.log(body);
    console.log("");
  });
  console.log("──────────────────────────────────────────────────────────────────────");
  console.log(`  Brief URL used: ${briefUrl}`);
  console.log("──────────────────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is missing. Set it in brief-app/.env.local or .env");
    process.exit(1);
  }

  const {
    industryName, prospectName, prospectCompany, prospectRole,
    competitor, briefUrlBase, senderName,
  } = parseCliInputs();

  const { path: briefPath, data: brief } = loadBrief(industryName);

  const competitorA = brief.hero?.competitorA || "(A)";
  const competitorB = brief.hero?.competitorB || "(B)";
  const industryFromBrief = brief.hero?.industry || industryName;

  // Build personalised brief URL with ?id= (same scheme as renderHtml's script uses)
  // URL id= uses the raw company name (trimmed, no lowercase, spaces→ +) so the
  // brief renders "Prepared for Acme Corp" exactly as typed, matching how
  // existing cold emails already link (e.g. ?id=Salesoft, not ?id=salesoft).
  const companyIdParam = encodeURIComponent(prospectCompany.trim().replace(/\s+/g, "+"));

  // Match the cold-email URL style that's already in circulation: the collapsed
  // filename without hyphens (e.g. /elearning-brief.html for E-Learning). The
  // generator now writes both hyphenated and collapsed copies so either works.
  const industrySlug = slugify(industryFromBrief);
  const collapsedSlug = industrySlug.replace(/-/g, "");
  const briefFilename = `${collapsedSlug}-brief.html`;
  const briefUrl = `${briefUrlBase}/${briefFilename}?id=${companyIdParam}`;

  const signals = pickSignalsForProspect(brief, competitor);

  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║     COLD EMAIL — PER-PROSPECT GENERATOR      ║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);
  console.log(`  Prospect:     ${prospectName}${prospectRole ? " (" + prospectRole + ")" : ""} @ ${prospectCompany}`);
  console.log(`  Industry:     ${industryFromBrief}`);
  console.log(`  Competitor:   ${competitor}`);
  console.log(`  Brief:        ${path.relative(process.cwd(), briefPath)}`);
  console.log(`  Brief URL:    ${briefUrl}`);
  console.log(`  Signals hit:  ${signals.length} (${signals.map((s) => s.bucket).join(", ") || "none — fallback framing"})`);
  console.log(`  Sender:       ${senderName || "(not set — pass --sender-name or set BRIEF_AUTHOR_NAME)"}`);

  if (!senderName) {
    console.warn(`\n  ⚠  No sender name — Claude will leave a [Your name] placeholder. Set BRIEF_AUTHOR_NAME or pass --sender-name.`);
  }

  console.log(`\n  🧠  Asking Claude for three variants...`);

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({
    industryName: industryFromBrief,
    prospectName,
    prospectCompany,
    prospectRole,
    competitor,
    briefUrl,
    senderName,
    signals,
    competitorA,
    competitorB,
  });

  const result = await callClaude(systemPrompt, userPrompt);

  if (!result || !Array.isArray(result.variants) || result.variants.length < 3) {
    console.error("Claude returned fewer than 3 variants. Aborting so you can inspect the raw output above.");
    process.exit(1);
  }

  // Validate
  const issues = result.variants.map((v, i) => ({
    i, label: v.label, problems: validateEmail(v, briefUrl),
  })).filter((x) => x.problems.length);

  if (issues.length) {
    console.warn(`\n  ⚠  Validation warnings on ${issues.length} variant(s):`);
    for (const it of issues) {
      console.warn(`     Variant ${String.fromCharCode(65 + it.i)} (${it.label}): ${it.problems.join("; ")}`);
    }
    console.warn(`     (the drafts are still saved — decide per-variant whether to use as-is, edit, or re-run)\n`);
  }

  // Write markdown
  const outDir = path.join(__dirname, "..", "data", "cold-emails");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFilename = `${slugify(industryFromBrief)}--${companySlug}.md`;
  const outPath = path.join(outDir, outFilename);

  const md = renderMarkdown({
    variants: result.variants,
    prospectName,
    prospectCompany,
    prospectRole,
    competitor,
    industryName: industryFromBrief,
    briefUrl,
    senderName,
    brief,
  });

  fs.writeFileSync(outPath, md, "utf8");

  printTerminalBlock(result.variants, briefUrl);

  console.log(`  ✅  Saved → data/cold-emails/${outFilename}\n`);
}

main().catch((err) => {
  console.error("\n❌  Fatal error:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
