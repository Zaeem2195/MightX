/**
 * Script 4: Push leads + AI copy into Instantly campaign
 * ────────────────────────────────────────────────────────
 * Reads latest data/copy-*.json →
 * adds each lead to your Instantly campaign with
 * personalised subject/body as custom variables →
 * saves push log to data/push-log-[timestamp].json
 *
 * Uses Instantly API v2: POST https://api.instantly.ai/api/v2/leads
 *   Authorization: Bearer <API_KEY>  (no Bearer in .env — script adds it)
 * Docs: https://developer.instantly.ai — v1 /api/v1 deprecated Jan 2026
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
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const INSTANTLY_API_BASE    = 'https://api.instantly.ai/api/v2';
const TRACKING_TOKEN_TTL_SECONDS = parseInt(
  process.env.TRACKING_TOKEN_TTL_SECONDS || '',
  10,
) || 14 * 24 * 60 * 60;
const TRACKING_SIGNING_SECRET = process.env.TRACKING_SIGNING_SECRET?.trim();

function normalizeInstantlyApiKey(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  let k = raw.trim();
  if (k.startsWith('"') && k.endsWith('"')) k = k.slice(1, -1).trim();
  if (k.toLowerCase().startsWith('bearer ')) k = k.slice(7).trim();
  return k;
}

const INSTANTLY_API_KEY     = normalizeInstantlyApiKey(process.env.INSTANTLY_API_KEY);
const INSTANTLY_CAMPAIGN_ID = process.env.INSTANTLY_CAMPAIGN_ID?.trim();
const BATCH_DELAY           = 500;   // ms between Instantly API calls

if (!INSTANTLY_API_KEY || !INSTANTLY_CAMPAIGN_ID) {
  console.error('❌  INSTANTLY_API_KEY and INSTANTLY_CAMPAIGN_ID must be set in .env');
  console.error('    Use an API v2 key (Settings → API → create key with leads scope).');
  process.exit(1);
}

if (!TRACKING_SIGNING_SECRET) {
  console.error('❌  TRACKING_SIGNING_SECRET must be set in .env');
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

function resolveBriefHtmlFilename() {
  const rawBrief = process.env.GTM_BRIEF_HTML_FILENAME;
  return (rawBrief?.trim() || 'elearning-brief.html').replace(/^\/+/, '');
}

function resolveBriefBaseUrl() {
  return process.env.GTM_BRIEF_CTA_BASE_URL?.trim().replace(/\/+$/, '') || null;
}

function normalizeLeadId(value) {
  const raw = (value || '').toString().toLowerCase().trim();
  return raw
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown_lead';
}

function createTrackingToken(payload) {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', TRACKING_SIGNING_SECRET)
    .update(payloadB64)
    .digest('base64url');
  return `${payloadB64}.${signature}`;
}

function buildTrackingUrl(entry) {
  const baseUrl = resolveBriefBaseUrl();
  if (!baseUrl) {
    throw new Error('GTM_BRIEF_CTA_BASE_URL must be set to build tracked links');
  }

  const leadId = normalizeLeadId(entry.companyName || entry.email);
  const exp = Math.floor(Date.now() / 1000) + TRACKING_TOKEN_TTL_SECONDS;
  const token = createTrackingToken({
    v: 1,
    i: leadId,
    e: entry.email.toLowerCase().trim(),
    c: INSTANTLY_CAMPAIGN_ID,
    exp,
  });

  return `${baseUrl}/${resolveBriefHtmlFilename()}?id=${encodeURIComponent(leadId)}&trk=${encodeURIComponent(token)}`;
}

function buildTrackedBody(body, trackingUrl) {
  if (!body || typeof body !== 'string') return body;
  if (body.includes('{{trackingUrl}}')) {
    return body.replace(/\{\{trackingUrl\}\}/g, trackingUrl);
  }

  const legacyUrlPattern = /https?:\/\/[^\s]+?\.html\?id=\{\{companyName\}\}/gi;
  if (legacyUrlPattern.test(body)) {
    return body.replace(legacyUrlPattern, trackingUrl);
  }

  return body;
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

// ── Add a single lead via Instantly API v2 ───────────────────────────────────
function serviceOutcomesForInstantly(entry) {
  const raw = entry.serviceOutcomes;
  const arr = Array.isArray(raw)
    ? raw.map(s => String(s).trim()).filter(Boolean)
    : [];
  const pad = ['', '', ''];
  const three = [...arr, ...pad].slice(0, 3);
  return { o1: three[0], o2: three[1], o3: three[2], joined: three.filter(Boolean).join(' | ') };
}

async function pushLead(entry) {
  const trackingUrl = buildTrackingUrl(entry);
  const trackedBody = buildTrackedBody(entry.body, trackingUrl);
  const outcomes = serviceOutcomesForInstantly(entry);
  const body = {
    campaign: INSTANTLY_CAMPAIGN_ID,
    email: entry.email,
    first_name: entry.firstName,
    last_name: entry.lastName,
    company_name: entry.companyName,
    skip_if_in_workspace: true,
    custom_variables: {
      ai_subject: entry.subject,
      ai_body: trackedBody,
      title: entry.title,
      trackingUrl,
      leadId: normalizeLeadId(entry.companyName || entry.email),
      industry: typeof entry.industry === 'string' ? entry.industry : '',
      painPointTrigger:
        typeof entry.painPointTrigger === 'string' ? entry.painPointTrigger : '',
      serviceOutcomes: outcomes.joined,
      service_outcome_1: outcomes.o1,
      service_outcome_2: outcomes.o2,
      service_outcome_3: outcomes.o3,
    },
  };

  const res = await fetch(`${INSTANTLY_API_BASE}/leads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INSTANTLY_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    let hint = '';
    if (res.status === 401) {
      hint = ' (create a new API v2 key in Instantly → Settings → API; v1 keys no longer work with this script)';
    }
    throw new Error(`Instantly API ${res.status}: ${err}${hint}`);
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
