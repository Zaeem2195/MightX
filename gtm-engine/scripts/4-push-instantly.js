/**
 * Script 4: Push leads + AI copy into Instantly campaign
 * ────────────────────────────────────────────────────────
 * Reads latest data/copy-*.json →
 * adds each lead to your Instantly campaign with
 * personalised subject/body as custom variables →
 * saves push log to data/push-log-[timestamp].json
 *
 * Instantly handles: sending schedule, warmup, reply detection,
 * unsubscribe, open tracking, and bounce management.
 *
 * Usage:
 *   npm run push-instantly
 *   npm run push-instantly -- --file copy-2026-04-06T05-23-28.json
 *   npm run push-instantly -- --first 10
 *   npm run push-instantly -- --offset 10 --limit 500
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const INSTANTLY_BASE        = 'https://api.instantly.ai/api/v1';
const INSTANTLY_API_KEY     = process.env.INSTANTLY_API_KEY;
const INSTANTLY_CAMPAIGN_ID = process.env.INSTANTLY_CAMPAIGN_ID;
const BATCH_DELAY           = 500;   // ms between Instantly API calls

if (!INSTANTLY_API_KEY || !INSTANTLY_CAMPAIGN_ID) {
  console.error('❌  INSTANTLY_API_KEY and INSTANTLY_CAMPAIGN_ID must be set in .env');
  process.exit(1);
}

/** Same semantics as generate-copy: --first N overrides --offset/--limit. */
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

function resolveCopySlice(allEntries) {
  const total = allEntries.length;
  const first = parseFirstArg();

  if (first != null) {
    return {
      entries:   allEntries.slice(0, Math.min(first, total)),
      batchMeta: { mode: 'first', first, totalInFile: total },
    };
  }

  const hasOffset = process.argv.includes('--offset');
  const hasLimit = process.argv.includes('--limit');
  const offParsed = parseNonNegInt('--offset');
  const limParsed = parseNonNegInt('--limit');
  const offset = hasOffset && offParsed != null ? offParsed : 0;

  if (!hasOffset && !hasLimit) {
    return { entries: allEntries, batchMeta: { mode: 'all', totalInFile: total } };
  }

  if (hasLimit && limParsed != null && limParsed > 0) {
    const end = Math.min(offset + limParsed, total);
    return {
      entries:   allEntries.slice(offset, end),
      batchMeta: {
        mode: 'range', offset, limit: limParsed, endExclusive: end, totalInFile: total,
      },
    };
  }

  if (hasOffset) {
    return {
      entries:   allEntries.slice(offset),
      batchMeta: {
        mode: 'range', offset, limit: null, toEnd: true, totalInFile: total,
      },
    };
  }

  return { entries: allEntries, batchMeta: { mode: 'all', totalInFile: total } };
}

/** --file <name> → data/<name> or path relative to gtm-engine root. */
function resolveExplicitCopyPath() {
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

// ── Load copy JSON: --file wins, else latest data/copy-*.json ─────────────────
function loadCopyData() {
  const explicit = resolveExplicitCopyPath();
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      console.error(`❌  Copy file not found: ${explicit}`);
      process.exit(1);
    }
    console.log(`📂  Loading: ${path.relative(ROOT, explicit)}`);
    return {
      data: JSON.parse(fs.readFileSync(explicit, 'utf8')),
      sourceLabel: path.relative(ROOT, explicit).replace(/\\/g, '/'),
    };
  }

  const dataDir = path.join(ROOT, 'data');
  const files = fs.readdirSync(dataDir)
    .filter(f => f.startsWith('copy-') && f.endsWith('.json'))
    .sort()
    .reverse();

  if (!files.length) {
    console.error('❌  No copy file found. Run: npm run generate-copy');
    process.exit(1);
  }

  console.log(`📂  Loading: ${files[0]}`);
  return {
    data: JSON.parse(fs.readFileSync(path.join(dataDir, files[0]), 'utf8')),
    sourceLabel: `data/${files[0]}`,
  };
}

// ── Add a single lead to Instantly ───────────────────────────────────────────
async function pushLead(entry) {
  const payload = {
    api_key:                INSTANTLY_API_KEY,
    campaign_id:            INSTANTLY_CAMPAIGN_ID,
    skip_if_in_workspace:   true,    // idempotent — won't duplicate leads
    leads: [
      {
        email:        entry.email,
        first_name:   entry.firstName,
        last_name:    entry.lastName,
        company_name: entry.companyName,
        // Custom variables map to {{subject}} and {{body}} in your Instantly template
        // Set your Instantly sequence step to use these variables.
        custom_variables: {
          ai_subject: entry.subject,
          ai_body:    entry.body,
          title:      entry.title,
        },
      },
    ],
  };

  const res = await fetch(`${INSTANTLY_BASE}/lead/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Instantly API ${res.status}: ${err}`);
  }

  return res.json();
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const { data: copyJson, sourceLabel } = loadCopyData();
  const allEntries = copyJson.copy || [];

  if (!allEntries.length) {
    console.error('❌  Copy file is empty. Check generate-copy output.');
    process.exit(1);
  }

  const { entries, batchMeta } = resolveCopySlice(allEntries);

  if (!entries.length) {
    console.error('❌  No entries in selected range (check --first / --offset / --limit).');
    process.exit(1);
  }

  console.log(`\n🚀  Pushing ${entries.length} leads to Instantly campaign: ${INSTANTLY_CAMPAIGN_ID}\n`);
  if (batchMeta.mode !== 'all') {
    console.log(`    (batch: ${JSON.stringify(batchMeta)})\n`);
  }
  console.log('    Instantly will handle: schedule, warmup, open tracking, unsubscribe.\n');

  const pushed  = [];
  const failed  = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const label = `${entry.firstName} ${entry.lastName} @ ${entry.companyName}`;
    process.stdout.write(`    [${i + 1}/${entries.length}] ${label} <${entry.email}> ... `);

    try {
      await pushLead(entry);
      pushed.push(entry.email);
      process.stdout.write('✅\n');
    } catch (err) {
      failed.push({ email: entry.email, label, error: err.message });
      process.stdout.write(`❌  ${err.message}\n`);
    }

    if (i < entries.length - 1) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  const log = {
    meta: {
      pushedAt:     new Date().toISOString(),
      campaignId:   INSTANTLY_CAMPAIGN_ID,
      copyFile:     sourceLabel,
      totalPushed:  pushed.length,
      totalFailed:  failed.length,
      batch:        batchMeta,
    },
    pushed,
    failed,
  };

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logPath = path.join(ROOT, 'data', `push-log-${timestamp}.json`);
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2));

  console.log(`\n📊  Done:`);
  console.log(`    ✅  Pushed:  ${pushed.length}`);
  console.log(`    ❌  Failed:  ${failed.length}`);
  console.log(`\n📁  Log saved → data/push-log-${timestamp}.json`);
  console.log(`\n⏭️   Next: Import the n8n workflow (n8n/gtm-reply-handler.json) to`);
  console.log(`    automatically classify replies when Instantly sends webhook events.\n`);
}

main().catch(err => {
  console.error('❌  Error:', err.message);
  process.exit(1);
});
