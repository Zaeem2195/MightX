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
 *   npm run generate-html-brief
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Anthropic = require("@anthropic-ai/sdk");

// ── Inputs (edit these for each vertical / competitor pair) ─────────────────
const industryName = "E-Learning";
const competitorA = "Docebo";
const competitorB = "Absorb LMS";
// ─────────────────────────────────────────────────────────────────────────────

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

REQUIRED BEHAVIOR:
- Include a <script> that runs on DOMContentLoaded, reads the URL query parameter "id" (e.g. ?id=acme_corp), URL-decodes it, and displays it in a header welcome line: exactly the phrase pattern: Custom Intelligence Capture for [ID] — if id is missing, show a sensible fallback like "Custom Intelligence Capture for (no id in URL)".
- Include exactly these three sections as <section> elements with clear headings:
  1) Recent Market Moves
  2) Pricing Vulnerabilities
  3) Rep Talk Tracks (Objection Handling)

CONTENT:
- The teardown must focus on the two named competitors and the given industry vertical.
- Be specific and actionable for reps; avoid generic filler. If you must infer, label uncertainty briefly rather than inventing false facts.`;

function buildUserPrompt() {
  return `Generate the full HTML file now.

Industry vertical: ${industryName}
Competitor A: ${competitorA}
Competitor B: ${competitorB}

Structure the competitive analysis between ${competitorA} and ${competitorB} for teams selling in ${industryName}.

Remember: raw HTML only, embedded CSS, dark enterprise SaaS styling, responsive layout, the three required sections, and the JavaScript that injects the ?id= query parameter into "Custom Intelligence Capture for [ID]".`;
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

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is missing. Set it in brief-app/.env.local or .env");
    process.exit(1);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  console.log(`Generating HTML brief: ${industryName} | ${competitorA} vs ${competitorB}…`);

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserPrompt() }],
  });

  const block = message.content.find((b) => b.type === "text");
  const rawHtml = block?.text?.trim() || "";
  if (!rawHtml) {
    console.error("Empty response from Claude.");
    process.exit(1);
  }

  const html = stripMarkdownFences(rawHtml);
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
