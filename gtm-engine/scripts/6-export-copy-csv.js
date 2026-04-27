/**
 * Export data/copy-*.json (AI sequence fields) to UTF-8 CSV for Instantly manual import.
 * No API key required — for plans without API access.
 *
 * Columns match push-instantly custom variables. Prefer email_1/2/3 fields in
 * Instantly; ai_subject/ai_body remain aliases for older single-email campaigns.
 *
 * Usage:
 *   npm run export-copy-csv
 *   npm run export-copy-csv -- --file copy-2026-04-06T05-23-28.json
 *   npm run export-copy-csv -- --first 500
 *   npm run export-copy-csv -- --out data/my-leads.csv
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TRACKING_TOKEN_TTL_SECONDS = parseInt(
  process.env.TRACKING_TOKEN_TTL_SECONDS || '',
  10,
) || 14 * 24 * 60 * 60;
const TRACKING_SIGNING_SECRET = process.env.TRACKING_SIGNING_SECRET?.trim();

const HEADERS = [
  'email',
  'first_name',
  'last_name',
  'company_name',
  'ai_subject',
  'ai_body',
  'email_1_subject',
  'email_1_body',
  'email_2_subject',
  'email_2_body',
  'email_3_subject',
  'email_3_body',
  'trackingUrl',
  'title',
];

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
      entries: allEntries.slice(0, Math.min(first, total)),
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
      entries: allEntries.slice(offset, end),
      batchMeta: {
        mode: 'range', offset, limit: limParsed, endExclusive: end, totalInFile: total,
      },
    };
  }

  if (hasOffset) {
    return {
      entries: allEntries.slice(offset),
      batchMeta: {
        mode: 'range', offset, limit: null, toEnd: true, totalInFile: total,
      },
    };
  }

  return { entries: allEntries, batchMeta: { mode: 'all', totalInFile: total } };
}

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

function parseOutPath() {
  const idx = process.argv.indexOf('--out');
  if (idx === -1 || !process.argv[idx + 1]) return null;
  const raw = process.argv[idx + 1].trim();
  if (path.isAbsolute(raw)) return raw;
  return path.join(ROOT, raw);
}

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

/** RFC 4180-style field escaping */
function escapeCsvField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildCsv(rows) {
  const lines = [HEADERS.join(',')];
  for (const r of rows) {
    lines.push(r.map(escapeCsvField).join(','));
  }
  return lines.join('\r\n');
}

function resolveBriefHtmlFilename(copyJson) {
  const fromCopy = copyJson?.meta?.briefHtmlFilename;
  const rawBrief = process.env.GTM_BRIEF_HTML_FILENAME || fromCopy;
  return (rawBrief?.trim() || 'elearning-brief.html').replace(/^\/+/, '');
}

function resolveBriefBaseUrl(copyJson) {
  return process.env.GTM_BRIEF_CTA_BASE_URL?.trim().replace(/\/+$/, '')
    || copyJson?.meta?.briefCtaBase?.trim().replace(/\/+$/, '')
    || null;
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

function buildTrackingUrl(entry, copyJson) {
  const baseUrl = resolveBriefBaseUrl(copyJson);
  if (!baseUrl || !TRACKING_SIGNING_SECRET) return '';

  const leadId = normalizeLeadId(entry.companyName || entry.email);
  const exp = Math.floor(Date.now() / 1000) + TRACKING_TOKEN_TTL_SECONDS;
  const token = createTrackingToken({
    v: 1,
    i: leadId,
    e: entry.email.toLowerCase().trim(),
    c: process.env.INSTANTLY_CAMPAIGN_ID?.trim() || 'csv_export',
    exp,
  });

  return `${baseUrl}/${resolveBriefHtmlFilename(copyJson)}?id=${encodeURIComponent(leadId)}&trk=${encodeURIComponent(token)}`;
}

function buildTrackedBody(body, trackingUrl) {
  if (!body || typeof body !== 'string') return body;
  if (!trackingUrl) return body;
  return body.replace(/\{\{trackingUrl\}\}/g, trackingUrl);
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function sequenceFieldsForCsv(entry, copyJson) {
  const trackingUrl = buildTrackingUrl(entry, copyJson);
  const email1Subject = firstString(entry.email_1_subject, entry.subject);
  const email1Body = firstString(entry.email_1_body, entry.body);
  const email2Subject = firstString(entry.email_2_subject);
  const email2Body = buildTrackedBody(firstString(entry.email_2_body), trackingUrl);
  const email3Subject = firstString(entry.email_3_subject);
  const email3Body = firstString(entry.email_3_body);

  return {
    trackingUrl,
    email1Subject,
    email1Body,
    email2Subject,
    email2Body,
    email3Subject,
    email3Body,
  };
}

function main() {
  const { data: copyJson, sourceLabel } = loadCopyData();
  const allEntries = copyJson.copy || [];

  if (!allEntries.length) {
    console.error('❌  Copy file has no entries.');
    process.exit(1);
  }

  const { entries, batchMeta } = resolveCopySlice(allEntries);
  if (!entries.length) {
    console.error('❌  No rows in selected range.');
    process.exit(1);
  }

  const rows = entries.map((e) => {
    const sequence = sequenceFieldsForCsv(e, copyJson);
    return [
      e.email,
      e.firstName,
      e.lastName,
      e.companyName,
      sequence.email1Subject,
      sequence.email1Body,
      sequence.email1Subject,
      sequence.email1Body,
      sequence.email2Subject,
      sequence.email2Body,
      sequence.email3Subject,
      sequence.email3Body,
      sequence.trackingUrl,
      e.title,
    ];
  });

  const csvBody = buildCsv(rows);
  const bom = '\uFEFF';
  const csv = bom + csvBody;

  const outArg = parseOutPath();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = outArg || path.join(ROOT, 'data', `copy-export-${timestamp}.csv`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, csv, 'utf8');

  console.log(`\n✅  Wrote ${entries.length} rows → ${path.relative(ROOT, outPath)}`);
  if (batchMeta.mode !== 'all') {
    console.log(`    (batch: ${JSON.stringify(batchMeta)})`);
  }
  console.log(`    Source: ${sourceLabel}`);
  console.log('\n📥  Instantly: Campaign → Leads → Upload CSV');
  console.log('    Map columns to: email, first_name, last_name, company_name');
  console.log('    Custom fields: email_1_subject/body, email_2_subject/body, email_3_subject/body, trackingUrl, title');
  console.log('    Backwards-compatible aliases: ai_subject, ai_body\n');
  if (!TRACKING_SIGNING_SECRET) {
    console.warn('    ⚠  TRACKING_SIGNING_SECRET is not set, so email_2_body still contains {{trackingUrl}}.\n');
  }
}

main();
