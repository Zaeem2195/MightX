/**
 * Script 3: Generate personalised cold email copy via Claude
 * ───────────────────────────────────────────────────────────
 * Reads latest data/enriched-*.json →
 * calls Claude API for each lead (rate-limited) →
 * saves to data/copy-[timestamp].json
 *
 * Human review gate: this script outputs a copy file for your
 * review BEFORE anything is sent. Run push-instantly.js only
 * after you've spot-checked the output.
 *
 * Usage:
 *   npm run generate-copy
 *   npm run generate-copy -- --first 10          # smoke test
 *   npm run generate-copy -- --first 500          # first batch of 500
 *   npm run generate-copy -- --offset 500 --limit 500   # next 500 (501–1000)
 *   npm run generate-copy -- --file data/processed-companyindustry-e-learning-equals-batch.json
 *
 * CTA URL: set GTM_BRIEF_CTA_BASE_URL (host) and GTM_BRIEF_HTML_FILENAME (e.g. elearning-brief.html
 * or management-consulting-brief.html) in .env. personalization.txt uses __BRIEF_HTML_FILENAME__
 * plus https://yourdomain.com — both are substituted before the prompt is sent to Claude.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL         = 'claude-sonnet-4-6';
const BATCH_DELAY   = 1200;   // ms between API calls — stay well within rate limits
const MAX_RETRIES   = 2;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌  ANTHROPIC_API_KEY missing from .env');
  process.exit(1);
}

/** Optional: --first N → slice(0, N). Takes precedence over --offset/--limit. */
function parseFirstArg() {
  const idx = process.argv.indexOf('--first');
  if (idx === -1 || !process.argv[idx + 1]) return null;
  const n = parseInt(process.argv[idx + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseNonNegInt(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || !process.argv[idx + 1]) return null;
  const n = parseInt(process.argv[idx + 1], 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** --first N, or --offset / --limit for batches (500 at a time, etc.). */
function resolveLeadsSlice(allLeads) {
  const total = allLeads.length;
  const first = parseFirstArg();

  if (first != null) {
    return {
      leads:     allLeads.slice(0, Math.min(first, total)),
      batchMeta: { mode: 'first', first, totalInFile: total },
    };
  }

  const hasOffset = process.argv.includes('--offset');
  const hasLimit = process.argv.includes('--limit');
  const offParsed = parseNonNegInt('--offset');
  const limParsed = parseNonNegInt('--limit');
  const offset = hasOffset && offParsed != null ? offParsed : 0;

  if (!hasOffset && !hasLimit) {
    return { leads: allLeads, batchMeta: { mode: 'all', totalInFile: total } };
  }

  if (hasLimit && limParsed != null && limParsed > 0) {
    const end = Math.min(offset + limParsed, total);
    return {
      leads:     allLeads.slice(offset, end),
      batchMeta: {
        mode: 'range', offset, limit: limParsed, endExclusive: end, totalInFile: total,
      },
    };
  }

  if (hasOffset) {
    return {
      leads:     allLeads.slice(offset),
      batchMeta: {
        mode: 'range', offset, limit: null, toEnd: true, totalInFile: total,
      },
    };
  }

  return { leads: allLeads, batchMeta: { mode: 'all', totalInFile: total } };
}

/** --file <name> → data/<name> or path relative to gtm-engine root (same as push-instantly). */
function resolveExplicitEnrichedPath() {
  const idx = process.argv.indexOf('--file');
  if (idx === -1 || !process.argv[idx + 1]) return null;
  const raw = process.argv[idx + 1].trim();
  if (path.isAbsolute(raw)) return raw;
  const dataPrefix = `data${path.sep}`;
  if (
    raw.startsWith('data/') ||
    raw.startsWith('data\\') ||
    raw.startsWith(dataPrefix)
  ) {
    return path.join(ROOT, raw);
  }
  return path.join(ROOT, 'data', path.basename(raw));
}

// ── Load enriched JSON: --file wins, else latest data/enriched-*.json ────────
function loadEnrichedData() {
  const explicit = resolveExplicitEnrichedPath();
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      console.error(`❌  Enriched file not found: ${explicit}`);
      process.exit(1);
    }
    console.log(`📂  Loading: ${path.relative(ROOT, explicit).replace(/\\/g, '/')}`);
    return {
      data: JSON.parse(fs.readFileSync(explicit, 'utf8')),
      sourceLabel: path.relative(ROOT, explicit).replace(/\\/g, '/'),
    };
  }

  const dataDir = path.join(ROOT, 'data');
  const files = fs.readdirSync(dataDir)
    .filter(f => f.startsWith('enriched-') && f.endsWith('.json'))
    .sort()
    .reverse();

  if (!files.length) {
    console.error('❌  No enriched file found. Run: npm run enrich');
    process.exit(1);
  }

  console.log(`📂  Loading: ${files[0]}`);
  return {
    data: JSON.parse(fs.readFileSync(path.join(dataDir, files[0]), 'utf8')),
    sourceLabel: `data/${files[0]}`,
  };
}

function resolveBriefHtmlFilename() {
  const rawBrief = process.env.GTM_BRIEF_HTML_FILENAME;
  return (rawBrief?.trim() || 'elearning-brief.html').replace(/^\/+/, '');
}

// ── Load prompt template ──────────────────────────────────────────────────────
function loadPrompt() {
  let text = fs.readFileSync(
    path.join(ROOT, 'prompts', 'personalization.txt'),
    'utf8'
  );
  text = text.replace(/__BRIEF_HTML_FILENAME__/g, resolveBriefHtmlFilename());
  const base = process.env.GTM_BRIEF_CTA_BASE_URL?.trim().replace(/\/+$/, '');
  if (base) {
    text = text.replace(/https:\/\/yourdomain\.com/gi, base);
  }
  return text;
}

// ── Build lead data block for the prompt ─────────────────────────────────────
function buildLeadBlock(lead) {
  const p = lead.personalization;
  return [
    `Name: ${p.firstName} ${p.lastName}`,
    `Title: ${p.title}`,
    `Company: ${p.companyName}`,
    `Company size: ${p.companySize ? `~${p.companySize} employees` : 'unknown'}`,
    `Industry: ${p.companyIndustry || 'B2B SaaS'}`,
    `Location: ${p.location || 'US'}`,
    `Website: ${p.companyWebsite || 'unknown'}`,
    `Known tech stack: ${p.techStack || p.knownTools || 'not detected'}`,
    `Pain point context: ${p.painPointTrigger}`,
    `Founder credential: ${p.founderCredential}`,
    `Service outcomes to reference: ${(p.serviceOutcomes || []).join(' | ')}`,
  ].join('\n');
}

// ── Call Claude for one lead ──────────────────────────────────────────────────
async function generateCopy(lead, promptTemplate, attempt = 0) {
  const leadBlock = buildLeadBlock(lead);
  const prompt = promptTemplate.replace('{{LEAD_DATA}}', leadBlock);

  try {
    const message = await client.messages.create({
      model:      MODEL,
      max_tokens: 400,
      messages:   [{ role: 'user', content: prompt }],
    });

    const raw = message.content[0]?.text?.trim() || '';

    // Strip any markdown code fences Claude might add
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

    const parsed = JSON.parse(cleaned);

    if (!parsed.subject || !parsed.body) {
      throw new Error('Claude returned malformed JSON — missing subject or body');
    }

    return { ok: true, subject: parsed.subject, body: parsed.body };
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 2000));
      return generateCopy(lead, promptTemplate, attempt + 1);
    }
    return { ok: false, error: err.message };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const { data, sourceLabel } = loadEnrichedData();
  const allLeads = data.leads || [];
  const { leads, batchMeta } = resolveLeadsSlice(allLeads);
  const prompt = loadPrompt();
  const host = process.env.GTM_BRIEF_CTA_BASE_URL?.trim().replace(/\/+$/, '') || 'https://yourdomain.com';
  const briefFile = resolveBriefHtmlFilename();
  console.log(`\n🔗  CTA template for this run: ${host}/${briefFile}?id={{companyName}}`);

  console.log(`\n✍️   Generating copy for ${leads.length} leads via Claude (${MODEL})...\n`);
  if (batchMeta.mode !== 'all') {
    console.log(`    (batch: ${JSON.stringify(batchMeta)})\n`);
  }
  console.log('    ⚠️  You will review the output BEFORE anything is sent to Instantly.\n');

  const results  = [];
  const failures = [];
  let cost_estimate_tokens = 0;

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const label = `${lead.firstName} ${lead.lastName} @ ${lead.companyName}`;
    process.stdout.write(`    [${i + 1}/${leads.length}] ${label} ... `);

    const result = await generateCopy(lead, prompt);

    if (result.ok) {
      results.push({
        leadId:      lead.id,
        email:       lead.email,
        firstName:   lead.firstName,
        lastName:    lead.lastName,
        companyName: lead.companyName,
        title:       lead.title,
        subject:     result.subject,
        body:        result.body,
        generatedAt: new Date().toISOString(),
      });
      cost_estimate_tokens += 450;   // rough avg tokens per call
      process.stdout.write(`✅\n`);
    } else {
      failures.push({ leadId: lead.id, label, error: result.error });
      process.stdout.write(`❌  ${result.error}\n`);
    }

    if (i < leads.length - 1) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  // Rough cost estimate (Claude Sonnet pricing)
  const estimatedCost = ((cost_estimate_tokens / 1_000_000) * 3.0).toFixed(4);

  console.log(`\n📊  Results:`);
  console.log(`    ✅  Generated: ${results.length}`);
  console.log(`    ❌  Failed:    ${failures.length}`);
  console.log(`    💰  Estimated API cost: ~$${estimatedCost}`);

  const output = {
    meta: {
      generatedAt:    new Date().toISOString(),
      model:          MODEL,
      totalGenerated: results.length,
      totalFailed:    failures.length,
      estimatedCost:  `~$${estimatedCost}`,
      enrichedSource: sourceLabel,
      briefCtaBase:       process.env.GTM_BRIEF_CTA_BASE_URL?.trim() || null,
      briefHtmlFilename: resolveBriefHtmlFilename(),
      batch:          batchMeta,
      reviewNote:     'REVIEW THIS FILE before running push-instantly. Spot-check at least 10% of entries.',
    },
    copy: results,
    failures,
  };

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(ROOT, 'data', `copy-${timestamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`\n📁  Saved → data/copy-${timestamp}.json`);
  console.log(`\n👁️   NEXT STEP: Open that file, review 5–10 emails for quality.`);
  console.log(`    If they look good → npm run push-instantly\n`);
}

main().catch(err => {
  console.error('❌  Error:', err.message);
  process.exit(1);
});
