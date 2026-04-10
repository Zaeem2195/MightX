/**
 * Collector: Competitor Website Monitor
 * ───────────────────────────────────────
 * Free: fetch + word-diff vs local snapshot.
 * Premium (APIFY_API_TOKEN): automation-lab/website-change-monitor (diff + severity).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { APIFY_ACTORS, getApifyClient, isApifyEnabled, runActorDataset, clipText } from './_apify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

const PAGES_TO_MONITOR = [
  '',
  '/pricing',
  '/product',
  '/features',
  '/blog',
  '/about',
  '/customers',
  '/enterprise',
  '/integrations',
  '/partners',
  '/platform',
];

const FETCH_TIMEOUT = 12000;

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
    .slice(0, 4000);
}

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

async function collectWebsiteApify(clientId, competitor) {
  const { name, website } = competitor;
  if (!website) return null;

  const client = getApifyClient();
  if (!client) return null;

  const base = website.replace(/\/$/, '');
  const urls = PAGES_TO_MONITOR.map((p) => base + p);

  let items;
  try {
    ({ items } = await runActorDataset(
      client,
      APIFY_ACTORS.WEBSITE_CHANGE,
      {
        urls,
        cssSelector: '',
        mode: 'text',
        ignorePatterns: ['\\d+\\s*(minutes?|hours?|days?)\\s+ago', 'session[_-]?id=[a-f0-9]+'],
        notifyOnFirstRun: false,
      },
      { waitSecs: 600, itemLimit: 50, injectDefaultProxy: true }
    ));
  } catch {
    return null;
  }

  if (!items?.length) return null;

  const lines = [
    `Source: Apify (${APIFY_ACTORS.WEBSITE_CHANGE})`,
    'Baseline snapshots are stored by the actor on Apify (compared run-to-run).',
    '',
  ];

  for (const row of items) {
    const u = row.url || row.pageUrl || '';
    const status = row.status || row.changeStatus || 'unknown';
    const pct = row.changePercent != null ? `${row.changePercent}%` : 'n/a';
    const sev = row.severity || row.importance || '';
    lines.push(`— ${u || 'URL unknown'}`);
    lines.push(`  Status: ${status}${sev ? ` | Severity: ${sev}` : ''} | Change: ${pct}`);
    if (row.diffSummary) lines.push(`  Diff summary: ${clipText(String(row.diffSummary), 900)}`);
    if (row.newContent) lines.push(`  New/changed excerpt: ${clipText(String(row.newContent), 600)}`);
    lines.push('');
  }

  saveSnapshot(clientId, name, {
    apifyWebsiteMonitor: true,
    lastUrls: urls,
    lastRunAt: new Date().toISOString(),
    rawItemCount: items.length,
  });

  const meaningful = items.some((row) => {
    const st = String(row.status || '').toLowerCase();
    return st === 'changed' || st === 'new' || (row.changePercent && row.changePercent > 0);
  });

  return {
    type: 'website',
    competitor: name,
    data: meaningful
      ? lines.join('\n').trim()
      : `${lines.join('\n').trim()}\n\nNo material website text changes flagged by Apify for the monitored URLs this run.`,
  };
}

async function collectWebsiteFree(clientId, competitor) {
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

export async function collectWebsite(clientId, competitor) {
  if (isApifyEnabled()) {
    const premium = await collectWebsiteApify(clientId, competitor);
    if (premium) return premium;
  }
  return collectWebsiteFree(clientId, competitor);
}
