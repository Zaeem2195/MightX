/**
 * generate-html-brief.js
 * ─────────────────────
 * Calls Claude Sonnet to generate a polished, dark-mode HTML competitive brief
 * and writes it to public/<industry-slug>-brief.html for the Next.js brief app.
 *
 * Prerequisites:
 *   - ANTHROPIC_API_KEY in brief-app/.env.local or brief-app/.env
 *
 * Usage:
 *   node scripts/generate-html-brief.js
 *   node scripts/generate-html-brief.js "Cybersecurity" "CrowdStrike" "SentinelOne"
 *   npm run generate-html-brief
 *   npm run generate-html-brief -- "Cybersecurity" "CrowdStrike" "SentinelOne"
 *
 * Arguments (optional): <Industry vertical> <Competitor A> <Competitor B>
 * Output: public/<slug-from-industry>-brief.html
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Anthropic = require("@anthropic-ai/sdk");

const DEFAULT_INDUSTRY = "E-Learning";
const DEFAULT_COMPETITOR_A = "Docebo";
const DEFAULT_COMPETITOR_B = "Absorb LMS";

/** @returns {{ industryName: string, competitorA: string, competitorB: string }} */
function parseCliInputs() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    return {
      industryName: DEFAULT_INDUSTRY,
      competitorA: DEFAULT_COMPETITOR_A,
      competitorB: DEFAULT_COMPETITOR_B,
    };
  }
  if (args.length === 3) {
    const industryName = args[0].trim();
    const competitorA = args[1].trim();
    const competitorB = args[2].trim();
    if (!industryName || !competitorA || !competitorB) {
      console.error("Industry and both competitor names must be non-empty.");
      process.exit(1);
    }
    return { industryName, competitorA, competitorB };
  }
  console.error(`
Usage:
  node scripts/generate-html-brief.js "<Industry>" "<Competitor A>" "<Competitor B>"

Examples:
  node scripts/generate-html-brief.js "Cybersecurity" "CrowdStrike" "SentinelOne"
  npm run generate-html-brief -- "Cybersecurity" "CrowdStrike" "SentinelOne"

Omit all three arguments to use defaults: ${DEFAULT_INDUSTRY} | ${DEFAULT_COMPETITOR_A} vs ${DEFAULT_COMPETITOR_B}
`);
  process.exit(1);
}

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 16_384;

const SYSTEM_PROMPT = `You are a Senior RevOps Analyst specializing in competitive intelligence for B2B SaaS. You produce executive-grade teardowns for sales and enablement teams.

OUTPUT RULES (strict):
- Output ONLY raw HTML. No markdown. No triple backticks. No preamble or explanation before or after the document.
- The document must be a single complete HTML5 file with all CSS embedded in a <style> tag in <head>.
- Use semantic HTML. Ensure the page is readable and responsive on mobile and desktop.

VISUAL / UX:
- Dark mode, enterprise SaaS aesthetic (inspired by Vercel or Linear: restrained colors, clear hierarchy, subtle borders).
- Use system-ui or a safe font stack. High contrast text on dark background.
- Polished typography: clear h1/h2, adequate spacing, max-width container for readability.

STRUCTURE RULES:
- Include a <script> that runs on DOMContentLoaded, reads the URL query parameter "id" (e.g. ?id=acme_corp), URL-decodes it, and displays it in a header welcome line: exactly the phrase pattern: Custom Intelligence Capture for [ID] — if id is missing, show "Custom Intelligence Capture for (no id in URL)".
- Add a distinct "How to Use This Brief" block immediately below the hero/header area.
- The "How to Use This Brief" block must include exactly these three lines:
  1) For Outbound: Use Section 1 (Recent Market Moves) to create urgency in emails.
  2) For Active Deals: Use Section 3 (Talk Tracks) verbatim in discovery calls.
  3) Verification: Before using in proposals, verify specific pricing claims with live demos.
- Include exactly these three sections as <section> elements with clear headings:
  1) Recent Market Moves
  2) Pricing Vulnerabilities
  3) Rep Talk Tracks (Objection Handling)
- Include a footer date placeholder that can be set by JavaScript as "Generated <Month> <Year>" (do not use quarter labels like Q3 2025).

INTELLIGENCE WRITING RULES (strict):
- Ban defensive disclaimers and weak hedge language. Do NOT use phrases such as:
  "may vary by region", "verify with prospect's quote", "field reports say", "some customers", "industry chatter", "anecdotally".
- Do NOT add standalone caveat/disclaimer paragraphs, banners, or callout boxes.
- Every strategic claim must include exactly one confidence tag in this exact schema:
  [CONFIDENCE: <Low|Medium|High> — <Evidence basis>. VERIFY: <Concrete verification action>.]
- The literal token "[CONFIDENCE:" must appear in output for each strategic claim.
- Confidence tags must be adjacent to the claim they qualify (same paragraph or immediately following sentence).
- Use specific source framing when citing observations (role + company profile + context) instead of vague sourcing.

GROUNDED EVIDENCE RULES (hard constraints):
- Never fabricate numbers, quotes, review counts, headcount deltas, partner-sheet counts, or customer anecdotes.
- Use quantified statements only when supported by available context in the prompt/session.
- If evidence is missing, do NOT invent details. Use deterministic fallback phrasing:
  [CONFIDENCE: Low — Evidence not provided in current inputs. VERIFY: <precise next validation step>.]
- Keep recommendations actionable and direct even at low confidence.

CONTENT QUALITY:
- Focus analysis on the two named competitors and the provided industry vertical.
- Write claim-first, tactical, sales-ready language. Avoid generic filler.
- Prefer concise, concrete statements over narrative padding.`;

function buildUserPrompt(industryName, competitorA, competitorB) {
  return `Generate the full HTML file now.

Industry vertical: ${industryName}
Competitor A: ${competitorA}
Competitor B: ${competitorB}

Structure the competitive analysis between ${competitorA} and ${competitorB} for teams selling in ${industryName}.

Execution style requirements:
- Keep each major insight claim-first and specific.
- Attach one confidence tag per strategic claim using:
  [CONFIDENCE: <Low|Medium|High> — <Evidence basis>. VERIFY: <Concrete verification action>.]
- Use the confidence tag as plain visible text (do not hide it in comments or metadata).
- Do not use vague attributions (e.g., "some customers", "field chatter", "market feedback").
- Do not add generic disclaimer blocks. Put verification only inside confidence tags.
- Use quantified statements only when evidence is available in the provided context. If missing evidence, explicitly use:
  [CONFIDENCE: Low — Evidence not provided in current inputs. VERIFY: <precise next validation step>.]

Output quality gate (must pass):
- If any strategic claim lacks a visible "[CONFIDENCE:" tag, rewrite before finalizing output.
- If you include a banned phrase, rewrite before finalizing output.

Remember: raw HTML only, embedded CSS, dark enterprise SaaS styling, responsive layout, the three required sections, the "How to Use This Brief" block directly below hero/header with exact copy, and the JavaScript that injects the ?id= query parameter into "Custom Intelligence Capture for [ID]".`;
}

function slugifyIndustry(name) {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 48);
  return slug || "industry";
}

function stripMarkdownFences(raw) {
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:html)?\s*/i, "");
    s = s.replace(/\s*```\s*$/i, "");
  }
  return s.trim();
}

const HOW_TO_USE_BLOCK_MARKER = 'id="how-to-use-brief"';
const HOW_TO_USE_BLOCK_HTML = `
<!-- HOW TO USE THIS BRIEF -->
<div id="how-to-use-brief" class="how-to-use-brief">
  <div class="how-to-use-card">
    <div class="how-to-use-title">How to Use This Brief</div>
    <ul class="how-to-use-items">
      <li><strong>For Outbound:</strong> Use Section 1 (Recent Market Moves) to create urgency in emails.</li>
      <li><strong>For Active Deals:</strong> Use Section 3 (Talk Tracks) verbatim in discovery calls.</li>
      <li><strong>Verification:</strong> Before using in proposals, verify specific pricing claims with live demos.</li>
    </ul>
  </div>
</div>
`;

const HOW_TO_USE_BLOCK_CSS = `
/* ── HOW TO USE THIS BRIEF ── */
.how-to-use-brief {
  max-width: var(--max-w, 960px);
  margin: 0 auto 36px;
  padding: 0 24px;
}
.how-to-use-card {
  background: var(--bg-card, #17171f);
  border: 1px solid var(--border, #2a2a38);
  border-left: 3px solid var(--accent, #7c6dfa);
  border-radius: var(--radius, 10px);
  padding: 18px 22px;
}
.how-to-use-title {
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--accent, #7c6dfa);
  margin-bottom: 10px;
}
.how-to-use-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.how-to-use-items li {
  font-size: 14px;
  color: var(--text-secondary, #9090a8);
  line-height: 1.6;
}
.how-to-use-items strong {
  color: var(--text-primary, #f0f0f5);
}
`;

const DYNAMIC_DATE_SCRIPT_MARKER = "generated-date-script";
const DYNAMIC_DATE_SCRIPT = `
<script id="${DYNAMIC_DATE_SCRIPT_MARKER}">
  document.addEventListener('DOMContentLoaded', function () {
    var generatedDateEl = document.getElementById('generated-date-label');
    if (generatedDateEl) {
      var formattedMonthYear = new Intl.DateTimeFormat('en-US', {
        month: 'long',
        year: 'numeric',
      }).format(new Date());
      generatedDateEl.textContent = 'Generated ' + formattedMonthYear;
    }
  });
</script>
`;

function findMatchingTagEnd(html, startIndex, tagName) {
  const tagRegex = new RegExp(`<\\/?${tagName}\\b[^>]*>`, "gi");
  tagRegex.lastIndex = startIndex;
  let depth = 0;
  let match;

  while ((match = tagRegex.exec(html)) !== null) {
    const token = match[0];
    const isClosing = token.startsWith("</");
    const isSelfClosing = token.endsWith("/>");

    if (!isClosing) {
      depth += 1;
      if (isSelfClosing) {
        depth -= 1;
      }
    } else {
      depth -= 1;
      if (depth === 0) {
        return tagRegex.lastIndex;
      }
    }
  }

  return -1;
}

function ensureHowToUseBlock(html) {
  if (html.includes(HOW_TO_USE_BLOCK_MARKER)) {
    return html;
  }
  const hasHowToUseHeading = /How to Use This Brief/i.test(html);
  const hasOutboundLine = /For Outbound:\s*(?:<\/strong>\s*)?Use Section 1 \(Recent Market Moves\) to create urgency in emails\./i.test(html);
  const hasDealsLine = /For Active Deals:\s*(?:<\/strong>\s*)?Use Section 3 \(Talk Tracks\) verbatim in discovery calls\./i.test(html);
  const hasVerificationLine = /Verification:\s*(?:<\/strong>\s*)?Before using in proposals, verify specific pricing claims with live demos\./i.test(html);
  if (hasHowToUseHeading && hasOutboundLine && hasDealsLine && hasVerificationLine) {
    return html;
  }

  const heroMatch = /<(div|section)\b[^>]*class=(["'])[^"']*\bhero\b[^"']*\2[^>]*>/i.exec(html);
  if (heroMatch && heroMatch.index !== undefined) {
    const heroStart = heroMatch.index;
    const heroTag = heroMatch[1].toLowerCase();
    const heroEnd = findMatchingTagEnd(html, heroStart, heroTag);
    if (heroEnd !== -1) {
      return `${html.slice(0, heroEnd)}\n${HOW_TO_USE_BLOCK_HTML}\n${html.slice(heroEnd)}`;
    }
  }

  const firstSectionIndex = html.search(/<section\b/i);
  if (firstSectionIndex !== -1) {
    return `${html.slice(0, firstSectionIndex)}\n${HOW_TO_USE_BLOCK_HTML}\n${html.slice(firstSectionIndex)}`;
  }

  return html;
}

function ensureHowToUseStyles(html) {
  if (html.includes(".how-to-use-brief")) {
    return html;
  }

  const styleCloseIndex = html.search(/<\/style>/i);
  if (styleCloseIndex === -1) {
    return html;
  }

  return `${html.slice(0, styleCloseIndex)}\n${HOW_TO_USE_BLOCK_CSS}\n${html.slice(styleCloseIndex)}`;
}

function ensureDynamicFooterDateTarget(html) {
  let output = html;
  output = output.replace(
    /<strong[^>]*>\s*Generated\s+(?:Q[1-4]\s+\d{4}|[A-Za-z]+\s+\d{4})\s*<\/strong>/gi,
    '<strong id="generated-date-label">Generated</strong>',
  );
  output = output.replace(
    /Generated\s+(?:Q[1-4]\s+\d{4}|[A-Za-z]+\s+\d{4})/gi,
    '<span id="generated-date-label">Generated</span>',
  );

  if (output.includes('id="generated-date-label"')) {
    return output;
  }
  const hasExistingDynamicFooterDate = (
    /id=(["'])footer-date\1/i.test(output)
    && /new Date\(\)/i.test(output)
    && /getElementById\((["'])footer-date\1\)/i.test(output)
  );
  if (hasExistingDynamicFooterDate) {
    return output;
  }

  const footerIndex = output.search(/<footer\b[^>]*>/i);
  if (footerIndex === -1) {
    return output;
  }
  const footerCloseIndex = output.indexOf("</footer>", footerIndex);
  if (footerCloseIndex === -1) {
    return output;
  }

  const injection = '\n  <strong id="generated-date-label">Generated</strong>\n';
  return `${output.slice(0, footerCloseIndex)}${injection}${output.slice(footerCloseIndex)}`;
}

function ensureDynamicFooterDateScript(html) {
  if (html.includes(`id="${DYNAMIC_DATE_SCRIPT_MARKER}"`)) {
    return html;
  }
  const alreadyHasDynamicFooterDateScript = (
    /new Date\(\)/i.test(html)
    && (
      /getElementById\((["'])generated-date-label\1\)/i.test(html)
      || /getElementById\((["'])footer-date\1\)/i.test(html)
    )
  );
  if (alreadyHasDynamicFooterDateScript) {
    return html;
  }

  const bodyCloseIndex = html.search(/<\/body>/i);
  if (bodyCloseIndex === -1) {
    return `${html}\n${DYNAMIC_DATE_SCRIPT}`;
  }

  return `${html.slice(0, bodyCloseIndex)}\n${DYNAMIC_DATE_SCRIPT}\n${html.slice(bodyCloseIndex)}`;
}

function enforceBriefSkeleton(html) {
  let output = html;
  output = ensureHowToUseBlock(output);
  output = ensureHowToUseStyles(output);
  output = ensureDynamicFooterDateTarget(output);
  output = ensureDynamicFooterDateScript(output);
  return output;
}

function validateGeneratedHtmlCompliance(html) {
  const bannedPhrasePatterns = [
    /may vary by region/i,
    /verify with prospect'?s quote/i,
    /field reports say/i,
    /some customers/i,
    /industry chatter/i,
    /anecdotally/i,
  ];

  const bannedHits = bannedPhrasePatterns
    .map((pattern) => pattern.exec(html)?.[0])
    .filter(Boolean);

  if (bannedHits.length > 0) {
    throw new Error(
      `Compliance check failed: banned phrases detected (${bannedHits.join(", ")}).`,
    );
  }

  const confidenceTagRegex = /\[CONFIDENCE:[^\]]+\]/g;
  const confidenceTags = html.match(confidenceTagRegex) || [];
  if (confidenceTags.length === 0) {
    throw new Error("Compliance check failed: no [CONFIDENCE: ...] tags were found.");
  }

  const strictConfidenceTagRegex = /^\[CONFIDENCE:\s*(Low|Medium|High)\s+[-—]\s+.+\.\s+VERIFY:\s+.+\]$/;
  const malformedTags = confidenceTags.filter(
    (tag) => !strictConfidenceTagRegex.test(tag),
  );
  if (malformedTags.length > 0) {
    throw new Error(
      `Compliance check failed: malformed confidence tags detected (${malformedTags.slice(0, 3).join(" | ")}).`,
    );
  }

  const sectionBodies = html.match(/<section\b[\s\S]*?<\/section>/gi) || [];
  if (sectionBodies.length > 0) {
    const missingSectionConfidence = sectionBodies.some(
      (section) => !/\[CONFIDENCE:/.test(section),
    );
    if (missingSectionConfidence) {
      throw new Error(
        "Compliance check failed: at least one section is missing a confidence tag.",
      );
    }
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is missing. Set it in brief-app/.env.local or .env");
    process.exit(1);
  }

  const { industryName, competitorA, competitorB } = parseCliInputs();

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  console.log(`Generating HTML brief: ${industryName} | ${competitorA} vs ${competitorB}…`);

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildUserPrompt(
          industryName,
          competitorA,
          competitorB,
        ),
      },
    ],
  });

  const block = message.content.find((b) => b.type === "text");
  const rawHtml = block?.text?.trim() || "";
  if (!rawHtml) {
    console.error("Empty response from Claude.");
    process.exit(1);
  }

  const html = enforceBriefSkeleton(stripMarkdownFences(rawHtml));
  validateGeneratedHtmlCompliance(html);
  if (!html.toLowerCase().includes("<!doctype") && !html.toLowerCase().includes("<html")) {
    console.warn("Warning: output may not start with <!DOCTYPE html> or <html>; saving anyway.");
  }

  const publicDir = path.join(__dirname, "..", "public");
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }

  const filename = `${slugifyIndustry(industryName)}-brief.html`;
  const outPath = path.join(publicDir, filename);

  fs.writeFileSync(outPath, html, "utf8");
  console.log(`Saved → public/${filename}`);
  console.log(`Open locally: http://localhost:3000/${filename}?id=your_company_id`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
