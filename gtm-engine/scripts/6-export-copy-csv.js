/**
 * Export data/copy-*.json (AI subject/body) to UTF-8 CSV for Instantly manual import.
 * No API key required — for plans without API access.
 *
 * Columns match push-instantly custom variables: ai_subject, ai_body, title
 * (use {{ai_subject}} / {{ai_body}} in your Instantly sequence).
 *
 * Usage:
 *   npm run export-copy-csv
 *   npm run export-copy-csv -- --file copy-2026-04-06T05-23-28.json
 *   npm run export-copy-csv -- --first 500
 *   npm run export-copy-csv -- --out data/my-leads.csv
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const HEADERS = [
  'email',
  'first_name',
  'last_name',
  'company_name',
  'ai_subject',
  'ai_body',
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

  const rows = entries.map((e) => [
    e.email,
    e.firstName,
    e.lastName,
    e.companyName,
    e.subject,
    e.body,
    e.title,
  ]);

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
  console.log('    Custom fields: ai_subject, ai_body, title (match your sequence {{ai_subject}} / {{ai_body}})\n');
}

main();
