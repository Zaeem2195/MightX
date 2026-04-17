/**
 * Collector: Sitemap Diff Monitor
 * ────────────────────────────────
 * Every substantive product / content / careers / docs change a competitor
 * ships eventually shows up as a new URL in their sitemap. Diffing the
 * sitemap week-over-week gives us a cheap, structured view of:
 *   - new product / feature pages (e.g. /product/ai-agents)
 *   - new customer stories (e.g. /customers/<logo>)
 *   - new pricing / plan pages (e.g. /pricing/enterprise)
 *   - new blog posts, docs, integrations, careers
 *
 * This is especially valuable on "quiet" weeks where news / G2 return nothing:
 * the sitemap almost always has some net-new URLs worth commenting on.
 *
 * Free tier only. No auth.
 *
 * Strategy:
 *   1. Try /sitemap.xml (with robots.txt fallback).
 *   2. If it's a sitemap index, follow up to MAX_SUB_SITEMAPS child sitemaps.
 *   3. Extract <loc> URLs, normalise, compare to state from last run.
 *   4. Group additions by URL prefix (e.g. /blog, /customers, /product).
 *
 * State: data/<clientId>/snapshots/<slug>-sitemap.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

const FETCH_TIMEOUT_MS        = 12000;
const MAX_URLS                = 8000;
const MAX_SUB_SITEMAPS        = 5;
const MAX_REPORTED_ADDITIONS  = 40;
const MAX_REPORTED_REMOVALS   = 20;

function snapshotStatePath(clientId, competitorName) {
  const dir = path.join(ROOT, 'data', clientId, 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const slug = competitorName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  return path.join(dir, `${slug}-sitemap.json`);
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

function normaliseBase(website) {
  if (!website) return '';
  return website.replace(/\/+$/, '');
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; IntelligenceBot/1.0; +sitemap-monitor)',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Robots.txt may advertise extra sitemaps — opportunistically read it. */
async function discoverFromRobots(base) {
  try {
    const res = await fetchWithTimeout(`${base}/robots.txt`);
    if (!res.ok) return [];
    const txt = await res.text();
    return [...txt.matchAll(/^\s*Sitemap:\s*(\S+)/gim)].map((m) => m[1].trim()).slice(0, 5);
  } catch {
    return [];
  }
}

function extractLocs(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<loc[^>]*>\s*([\s\S]*?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const val = m[1].trim().replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
    if (val) out.push(val);
  }
  return out;
}

function isSitemapIndex(xml) {
  return /<sitemapindex\b/i.test(xml);
}

async function fetchSitemap(url) {
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return { ok: false, reason: `http_${res.status}`, xml: '' };
    const xml = await res.text();
    return { ok: true, xml };
  } catch {
    return { ok: false, reason: 'timeout', xml: '' };
  }
}

/**
 * Resolve final list of content sitemaps starting from base/sitemap.xml and
 * robots.txt, recursing one level into sitemap indexes.
 */
async function discoverSitemaps(base) {
  const candidates = [`${base}/sitemap.xml`, `${base}/sitemap_index.xml`];
  const robots = await discoverFromRobots(base);
  candidates.push(...robots);

  const unique = [...new Set(candidates)];
  const contentSitemaps = [];
  const failures = [];

  for (const c of unique) {
    const { ok, xml, reason } = await fetchSitemap(c);
    if (!ok || !xml) {
      failures.push(`${c} (${reason || 'empty'})`);
      continue;
    }

    if (isSitemapIndex(xml)) {
      const children = extractLocs(xml).slice(0, MAX_SUB_SITEMAPS);
      for (const child of children) {
        const cr = await fetchSitemap(child);
        if (cr.ok && cr.xml && !isSitemapIndex(cr.xml)) {
          contentSitemaps.push({ url: child, xml: cr.xml });
        }
      }
    } else {
      contentSitemaps.push({ url: c, xml });
    }

    if (contentSitemaps.length >= MAX_SUB_SITEMAPS + 1) break;
  }

  return { contentSitemaps, failures };
}

function collectUrls(sitemaps) {
  const set = new Set();
  for (const s of sitemaps) {
    for (const loc of extractLocs(s.xml)) {
      set.add(loc);
      if (set.size >= MAX_URLS) return set;
    }
  }
  return set;
}

function urlPrefix(u) {
  try {
    const parsed = new URL(u);
    const first = parsed.pathname.split('/').filter(Boolean)[0];
    return first ? `/${first}` : '/';
  } catch {
    return '/other';
  }
}

function groupByPrefix(urls) {
  const groups = {};
  for (const u of urls) {
    const k = urlPrefix(u);
    if (!groups[k]) groups[k] = [];
    groups[k].push(u);
  }
  return groups;
}

function formatGroups(groups, limit) {
  const entries = Object.entries(groups)
    .sort((a, b) => b[1].length - a[1].length);

  const lines = [];
  let totalShown = 0;
  for (const [prefix, urls] of entries) {
    lines.push(`  ${prefix} — ${urls.length} URL(s)`);
    for (const u of urls.slice(0, 6)) {
      if (totalShown >= limit) break;
      lines.push(`    • ${u}`);
      totalShown++;
    }
    if (urls.length > 6) lines.push(`    … and ${urls.length - 6} more under ${prefix}`);
    if (totalShown >= limit) {
      lines.push(`    (truncated — ${limit} lines shown)`);
      break;
    }
  }
  return lines.join('\n');
}

export async function collectSitemap(clientId, competitor) {
  const { name } = competitor;
  const base = normaliseBase(competitor.website);

  if (!base) {
    return {
      type:       'sitemap',
      competitor: name,
      data:       `No website configured for ${name} — cannot diff sitemap.`,
    };
  }

  const { contentSitemaps, failures } = await discoverSitemaps(base);
  if (!contentSitemaps.length) {
    return {
      type:       'sitemap',
      competitor: name,
      data:       [
        `Could not retrieve a usable sitemap for ${base}.`,
        failures.length ? `Attempts: ${failures.join('; ')}` : 'No sitemap advertised.',
      ].join('\n'),
    };
  }

  const currentUrls = collectUrls(contentSitemaps);
  const prior = loadState(clientId, name);
  const priorUrls = new Set(prior?.urls || []);

  const added = [...currentUrls].filter((u) => !priorUrls.has(u));
  const removed = [...priorUrls].filter((u) => !currentUrls.has(u));

  saveState(clientId, name, {
    lastRunAt: new Date().toISOString(),
    sitemapsFetched: contentSitemaps.map((s) => s.url),
    totalUrls: currentUrls.size,
    urls: [...currentUrls].slice(0, MAX_URLS),
  });

  const header = [
    `Source: ${name} sitemap (free, no auth).`,
    `Sitemaps fetched: ${contentSitemaps.map((s) => s.url).join(', ')}`,
    `URLs now: ${currentUrls.size}${prior ? ` (prior snapshot: ${priorUrls.size})` : ' (first snapshot — no diff available yet)'}`,
    '',
  ];

  if (!prior) {
    return {
      type:       'sitemap',
      competitor: name,
      data:       [
        ...header,
        'This is the first sitemap snapshot we have for this competitor — subsequent runs will diff against it and surface net-new URLs (new product pages, case studies, pricing tiers, blog posts, job openings, etc.).',
      ].join('\n'),
    };
  }

  if (!added.length && !removed.length) {
    return {
      type:       'sitemap',
      competitor: name,
      data:       [
        ...header,
        'No URLs added or removed since last snapshot — the site graph is stable.',
      ].join('\n'),
    };
  }

  const addedGroups   = groupByPrefix(added);
  const removedGroups = groupByPrefix(removed);

  const body = [
    added.length
      ? `URLs ADDED since last snapshot (${added.length} total):\n${formatGroups(addedGroups, MAX_REPORTED_ADDITIONS)}`
      : 'No URLs added.',
    '',
    removed.length
      ? `URLs REMOVED since last snapshot (${removed.length} total):\n${formatGroups(removedGroups, MAX_REPORTED_REMOVALS)}`
      : 'No URLs removed.',
  ].join('\n');

  return {
    type:       'sitemap',
    competitor: name,
    data:       [...header, body].join('\n'),
  };
}
