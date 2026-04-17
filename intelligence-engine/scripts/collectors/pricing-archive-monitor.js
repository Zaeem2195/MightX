/**
 * Collector: Competitor Pricing Archive Monitor (Wayback Machine)
 * ────────────────────────────────────────────────────────────────
 * Uses the Internet Archive's CDX API + snapshot content endpoints to
 * detect pricing-page changes over the last ~90 days. This is a
 * proprietary signal compared to Google News / G2 search snippets:
 * buyers generally cannot see pricing archaeology without a CI tool.
 *
 * API docs:
 * - CDX search: http://web.archive.org/cdx/search/cdx (free, no key)
 * - Raw snapshot: https://web.archive.org/web/<timestamp>id_/<url>
 *
 * Free tier only. No auth. Best-effort; on failure returns an
 * informative "could not check archive" data string so the analyst
 * still sees the attempt.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

const DEFAULT_PRICING_PATHS = ['/pricing', '/plans'];
const LOOKBACK_DAYS = 90;
const CDX_TIMEOUT_MS = 10000;
const SNAPSHOT_TIMEOUT_MS = 15000;
const MAX_SNAPSHOTS_PER_PAGE = 12;

function snapshotStatePath(clientId, competitorName) {
  const dir = path.join(ROOT, 'data', clientId, 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const slug = competitorName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  return path.join(dir, `${slug}-pricing-archive.json`);
}

function loadState(clientId, competitorName) {
  const p = snapshotStatePath(clientId, competitorName);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(clientId, competitorName, data) {
  fs.writeFileSync(snapshotStatePath(clientId, competitorName), JSON.stringify(data, null, 2));
}

function normalizeBaseUrl(website) {
  if (!website) return '';
  return website.replace(/\/$/, '');
}

function resolvePricingUrls(competitor) {
  const base = normalizeBaseUrl(competitor.website);
  if (!base) return [];
  const custom = Array.isArray(competitor.pricingUrls) ? competitor.pricingUrls.filter(Boolean) : [];
  if (custom.length) {
    return custom.map((u) => (u.startsWith('http') ? u : base + (u.startsWith('/') ? u : `/${u}`)));
  }
  return DEFAULT_PRICING_PATHS.map((p) => base + p);
}

function formatYYYYMMDD(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

async function fetchWithTimeout(url, ms, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; IntelligenceBot/1.0; +pricing-archive)',
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Query the Wayback CDX API for unique snapshots of a URL in the lookback
 * window. `collapse=digest` returns only rows where the content hash changed,
 * i.e. real page changes (not re-crawls of identical HTML).
 *
 * Returns array of { timestamp, original, digest, status } sorted oldest-first.
 */
async function listSnapshots(url) {
  const to = new Date();
  const from = new Date(to.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const cdxUrl =
    'http://web.archive.org/cdx/search/cdx' +
    `?url=${encodeURIComponent(url)}` +
    '&output=json' +
    '&collapse=digest' +
    '&fl=timestamp,original,digest,statuscode' +
    `&from=${formatYYYYMMDD(from)}` +
    `&to=${formatYYYYMMDD(to)}` +
    `&limit=${MAX_SNAPSHOTS_PER_PAGE}`;

  let res;
  try {
    res = await fetchWithTimeout(cdxUrl, CDX_TIMEOUT_MS);
  } catch {
    return { ok: false, reason: 'cdx_timeout', snapshots: [] };
  }

  if (!res.ok) return { ok: false, reason: `cdx_http_${res.status}`, snapshots: [] };

  let rows;
  try {
    rows = await res.json();
  } catch {
    return { ok: false, reason: 'cdx_invalid_json', snapshots: [] };
  }

  if (!Array.isArray(rows) || rows.length <= 1) {
    return { ok: true, reason: 'no_snapshots', snapshots: [] };
  }

  const [, ...data] = rows;
  const snapshots = data
    .map((r) => ({
      timestamp: r[0],
      original: r[1],
      digest: r[2],
      status: r[3],
    }))
    .filter((s) => s.timestamp && s.digest && String(s.status || '').startsWith('2'))
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

  return { ok: true, reason: 'ok', snapshots };
}

function extractPricingText(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 6000);
}

async function fetchSnapshotText(snapshot) {
  const rawUrl = `https://web.archive.org/web/${snapshot.timestamp}id_/${snapshot.original}`;
  try {
    const res = await fetchWithTimeout(rawUrl, SNAPSHOT_TIMEOUT_MS);
    if (!res.ok) return '';
    const html = await res.text();
    return extractPricingText(html);
  } catch {
    return '';
  }
}

const PRICE_TOKEN_RE = /\$\s?\d[\d,]*(?:\.\d+)?(?:\s?\/?\s?(?:mo|month|yr|year|user|seat))?/gi;
const PLAN_WORDS = [
  'starter',
  'basic',
  'essentials',
  'growth',
  'pro',
  'professional',
  'business',
  'team',
  'teams',
  'enterprise',
  'scale',
  'premium',
  'advanced',
  'custom',
  'contact sales',
  'annual',
  'per user',
  'per seat',
  'per month',
  'free trial',
];

function extractPriceTokens(text) {
  if (!text) return [];
  const matches = text.match(PRICE_TOKEN_RE) || [];
  return [...new Set(matches.map((m) => m.replace(/\s+/g, '').toLowerCase()))].slice(0, 20);
}

function extractPlanMentions(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  return PLAN_WORDS.filter((p) => lower.includes(p));
}

function diffSets(oldArr, newArr) {
  const oldSet = new Set(oldArr);
  const newSet = new Set(newArr);
  const added = newArr.filter((x) => !oldSet.has(x));
  const removed = oldArr.filter((x) => !newSet.has(x));
  return { added, removed };
}

function formatTimestamp(ts) {
  if (!ts || ts.length < 8) return ts || 'unknown';
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
}

function summarisePageChange(url, snapshots) {
  if (!snapshots.length) {
    return `No Wayback snapshots found for ${url} in the last ${LOOKBACK_DAYS} days.`;
  }

  const uniqueDigests = [...new Set(snapshots.map((s) => s.digest))];
  if (uniqueDigests.length <= 1) {
    return `${url} — ${snapshots.length} snapshot(s) in the last ${LOOKBACK_DAYS} days, all identical content (no pricing page change detected).`;
  }

  return null;
}

async function analysePageDiff(url, snapshots) {
  const earliest = snapshots[0];
  const latest = snapshots[snapshots.length - 1];

  const [oldText, newText] = await Promise.all([
    fetchSnapshotText(earliest),
    fetchSnapshotText(latest),
  ]);

  if (!oldText && !newText) {
    return `${url} — Wayback snapshots exist (${snapshots.length} unique versions ${formatTimestamp(earliest.timestamp)} → ${formatTimestamp(latest.timestamp)}), but raw snapshot fetch failed for both endpoints. Archive access may be rate-limited.`;
  }
  if (!oldText) {
    return `${url} — oldest snapshot ${formatTimestamp(earliest.timestamp)} unreadable; latest ${formatTimestamp(latest.timestamp)} captured. Pricing digest changed ${snapshots.length - 1} time(s) — human review recommended.`;
  }
  if (!newText) {
    return `${url} — latest snapshot ${formatTimestamp(latest.timestamp)} unreadable; ${snapshots.length - 1} digest change(s) over the window.`;
  }

  const oldPrices = extractPriceTokens(oldText);
  const newPrices = extractPriceTokens(newText);
  const priceDiff = diffSets(oldPrices, newPrices);

  const oldPlans = extractPlanMentions(oldText);
  const newPlans = extractPlanMentions(newText);
  const planDiff = diffSets(oldPlans, newPlans);

  const lengthDelta = newText.length - oldText.length;
  const lengthHint =
    Math.abs(lengthDelta) > 400
      ? `Page length changed by ${lengthDelta > 0 ? '+' : ''}${lengthDelta} characters.`
      : 'Page length roughly stable.';

  const lines = [
    `${url}`,
    `Window: ${formatTimestamp(earliest.timestamp)} → ${formatTimestamp(latest.timestamp)} (${snapshots.length - 1} content change(s) in Wayback)`,
    lengthHint,
  ];

  if (priceDiff.added.length || priceDiff.removed.length) {
    if (priceDiff.added.length) lines.push(`Price tokens ADDED: ${priceDiff.added.join(', ')}`);
    if (priceDiff.removed.length) lines.push(`Price tokens REMOVED: ${priceDiff.removed.join(', ')}`);
  } else if (oldPrices.length || newPrices.length) {
    lines.push('No visible price-token changes between earliest and latest snapshots.');
  } else {
    lines.push('No explicit price tokens ($X/mo style) detected — competitor likely uses "contact sales" pricing.');
  }

  if (planDiff.added.length) lines.push(`Plan / tier mentions ADDED: ${planDiff.added.join(', ')}`);
  if (planDiff.removed.length) lines.push(`Plan / tier mentions REMOVED: ${planDiff.removed.join(', ')}`);

  return lines.join('\n');
}

export async function collectPricingArchive(clientId, competitor) {
  const { name } = competitor;
  const urls = resolvePricingUrls(competitor);

  if (!urls.length) {
    return {
      type: 'pricing_archive',
      competitor: name,
      data: 'No competitor website configured — cannot query Wayback Machine for pricing page history.',
    };
  }

  const previous = loadState(clientId, name);
  const previousDigests = previous?.digestsByUrl || {};

  const perPageReports = [];
  const newDigestsByUrl = {};
  let anyMeaningful = false;

  for (const url of urls) {
    const { ok, reason, snapshots } = await listSnapshots(url);

    if (!ok) {
      perPageReports.push(`${url} — Wayback CDX query failed (${reason}).`);
      continue;
    }

    newDigestsByUrl[url] = snapshots.map((s) => s.digest);

    const earlyOut = summarisePageChange(url, snapshots);
    if (earlyOut) {
      perPageReports.push(earlyOut);
      continue;
    }

    const priorSet = new Set(previousDigests[url] || []);
    const newDigest = snapshots[snapshots.length - 1]?.digest;
    const sawNewDigestSinceLastRun =
      previous && newDigest && !priorSet.has(newDigest) && priorSet.size > 0;

    const diffSummary = await analysePageDiff(url, snapshots);
    perPageReports.push(diffSummary);
    anyMeaningful = true;

    if (sawNewDigestSinceLastRun) {
      perPageReports.push(`^^ NEW pricing digest observed since last collector run — this change is genuinely new this week.`);
    }

    await new Promise((r) => setTimeout(r, 600));
  }

  saveState(clientId, name, {
    digestsByUrl: newDigestsByUrl,
    lastRunAt: new Date().toISOString(),
    urls,
  });

  const header = [
    'Source: Wayback Machine (Internet Archive) — pricing page history.',
    `Lookback window: last ${LOOKBACK_DAYS} days.`,
    'CDX "collapse=digest" means each row is a genuine content change, not a re-crawl.',
    '',
  ];

  const data = anyMeaningful
    ? [...header, ...perPageReports].join('\n')
    : [...header, ...perPageReports, '', 'No material pricing-page changes detected in the archive this run.'].join('\n');

  return { type: 'pricing_archive', competitor: name, data };
}
