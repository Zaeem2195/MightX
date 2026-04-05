/**
 * Collector: Competitor Website Monitor
 * ───────────────────────────────────────
 * Fetches the competitor's homepage and key pages,
 * compares against the stored snapshot from last week,
 * and returns a diff summary for Claude to analyse.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

// Pages to monitor per competitor (relative paths appended to their website URL)
const PAGES_TO_MONITOR = ['', '/pricing', '/product', '/features', '/blog'];

const FETCH_TIMEOUT = 12000;

// ── Strip HTML to meaningful text ─────────────────────────────────────────────
function extractText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 4000);   // cap to avoid token overload
}

// ── Fetch a single page with timeout ─────────────────────────────────────────
async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IntelligenceBot/1.0)' },
    });
    const html = await res.text();
    return { ok: true, url, text: extractText(html), status: res.status };
  } catch {
    return { ok: false, url, text: '', status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// ── Load / save snapshot ──────────────────────────────────────────────────────
function snapshotPath(clientId, competitorName) {
  const dir = path.join(ROOT, 'data', clientId, 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const slug = competitorName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  return path.join(dir, `${slug}-website.json`);
}

function loadSnapshot(clientId, competitorName) {
  const p = snapshotPath(clientId, competitorName);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveSnapshot(clientId, competitorName, data) {
  fs.writeFileSync(snapshotPath(clientId, competitorName), JSON.stringify(data, null, 2));
}

// ── Compute simple diff between old and new text ─────────────────────────────
function summariseDiff(oldText, newText, url) {
  if (!oldText) return `First-time snapshot of ${url} — no previous version to compare.`;

  const oldWords = new Set(oldText.toLowerCase().split(/\s+/));
  const newWords = newText.toLowerCase().split(/\s+/);

  const added = newWords.filter(w => w.length > 5 && !oldWords.has(w));
  const unique = [...new Set(added)].slice(0, 30);

  const lengthChange = newText.length - oldText.length;
  const changeDir = lengthChange > 100 ? 'significantly more' : lengthChange < -100 ? 'significantly less' : 'similar amount of';

  if (unique.length < 3 && Math.abs(lengthChange) < 200) {
    return `No significant changes detected on ${url}.`;
  }

  return `${url} changed (${changeDir} content). New/changed terms detected: ${unique.join(', ')}.`;
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function collectWebsite(clientId, competitor) {
  const { name, website } = competitor;
  if (!website) return { type: 'website', competitor: name, data: 'No website URL configured.' };

  const previous = loadSnapshot(clientId, name);
  const current  = {};
  const diffs    = [];

  for (const pagePath of PAGES_TO_MONITOR) {
    const url    = website.replace(/\/$/, '') + pagePath;
    const result = await fetchPage(url);
    if (!result.ok || !result.text) continue;

    current[pagePath || '/'] = result.text;

    const oldText = previous?.pages?.[pagePath || '/'] || '';
    diffs.push(summariseDiff(oldText, result.text, url));

    await new Promise(r => setTimeout(r, 800));
  }

  saveSnapshot(clientId, name, { pages: current, savedAt: new Date().toISOString() });

  const meaningful = diffs.filter(d => !d.includes('No significant changes'));

  return {
    type:       'website',
    competitor: name,
    data:       meaningful.length
      ? meaningful.join('\n\n')
      : 'No significant website changes detected this week.',
  };
}
