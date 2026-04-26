/**
 * Collector: Pricing Signals (fallback when Wayback /pricing is empty)
 * ─────────────────────────────────────────────────────────────────────
 * The default `pricing-archive-monitor.js` queries Wayback for /pricing and
 * /plans. For enterprise vendors with hidden pricing ("contact sales"-only),
 * those pages are sparse or absent and the brief's pricing section comes back
 * empty — exactly the opposite of what a buyer wants from a competitive
 * brief. This collector fills that gap by mining buyer-public discussion
 * channels for explicit dollar figures and pricing-structure mentions:
 *
 *   1. Wayback CDX on additional URL paths a buyer might land on
 *      (/enterprise, /plans/enterprise, /contact-sales, /demo, /quote).
 *      We don't deeply diff these — we just want a digest hit so we can tell
 *      Claude "this URL exists in the archive, here's the latest snapshot
 *      label" if the standard /pricing came up dry.
 *
 *   2. Reddit public JSON search with pricing-intent queries (cost,
 *      "per seat", "per endpoint", "expensive", "quote", "renewal"). Only
 *      keeps posts whose title/body actually contains a `$` figure or a
 *      pricing-structure phrase.
 *
 *   3. Hacker News (Algolia) search with the same intent. HN tends to
 *      surface infra/dev-tooling pricing complaints earlier than Reddit.
 *
 * Output is a single signal of type `pricing_signals`, distinct from
 * `pricing_archive`. The brief generator is configured to use this as a
 * fallback narrative when `pricing_archive.exists` is empty/uninformative.
 *
 * Free tier only. No auth keys. Best-effort: on failure we return an
 * informative line so the analyst (or the prompt) can see the attempt.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractDomain } from './_utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Tunables ─────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS   = 12000;
const CDX_TIMEOUT_MS     = 10000;
const REDDIT_THROTTLE_MS = 900;
const HN_THROTTLE_MS     = 400;
const LOOKBACK_DAYS      = 90;
const MAX_REDDIT_POSTS   = 8;
const MAX_HN_STORIES     = 6;
const MIN_REDDIT_SCORE   = 2;
const MIN_HN_POINTS      = 2;

// Additional URL paths buyers actually land on when /pricing is gated.
const ENTERPRISE_PATHS = [
  '/enterprise',
  '/plans/enterprise',
  '/contact-sales',
  '/contact',
  '/demo',
  '/quote',
];

// Pricing-intent keywords. We OR them into Reddit/HN queries so that a
// generic competitor mention still has to be paired with money-talk to land.
const PRICING_INTENT_QUERY_TERMS = [
  'pricing',
  'cost',
  'quote',
  'expensive',
  '"per seat"',
  '"per user"',
  '"per endpoint"',
  '"enterprise plan"',
  'renewal',
];

// Phrases that signal a pricing structure even without a `$` figure.
const PRICING_STRUCTURE_PATTERNS = [
  /per\s+(?:seat|user|endpoint|host|node|workspace|agent|gb)/i,
  /\bMSRP\b/,
  /\bACV\b/,
  /annual contract/i,
  /enterprise (?:plan|tier|pricing)/i,
  /(?:renewal|negotiat\w+)\s+(?:price|increase|hike|jump)/i,
  /(?:doubled|tripled|raised)\s+(?:our\s+)?price/i,
  /list price/i,
  /(?:floor|ceiling)\s+price/i,
];

const DOLLAR_FIGURE_RE = /\$\s?\d[\d,]*(?:\.\d+)?(?:\s?[kKmM])?(?:\s?\/?\s?(?:mo|month|yr|year|user|seat|endpoint|host|node))?/g;

const UA_REDDIT =
  process.env.REDDIT_USER_AGENT?.trim() ||
  'MightX-Intel/1.0 (+pricing-signals; contact=ops@mightx.local)';

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function fetchWithTimeout(url, ms, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'User-Agent': 'MightX-Intel/1.0 (pricing-signals)',
        Accept: 'application/json',
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Wayback enterprise-paths probe ───────────────────────────────────────────

function formatYYYYMMDD(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function formatTimestamp(ts) {
  if (!ts || ts.length < 8) return ts || 'unknown';
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
}

async function probeEnterprisePath(url) {
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
    '&limit=8';

  let res;
  try {
    res = await fetchWithTimeout(cdxUrl, CDX_TIMEOUT_MS);
  } catch {
    return { url, ok: false, reason: 'cdx_timeout', snapshots: [] };
  }
  if (!res.ok) return { url, ok: false, reason: `cdx_http_${res.status}`, snapshots: [] };

  let rows;
  try {
    rows = await res.json();
  } catch {
    return { url, ok: false, reason: 'cdx_invalid_json', snapshots: [] };
  }
  if (!Array.isArray(rows) || rows.length <= 1) {
    return { url, ok: true, reason: 'no_snapshots', snapshots: [] };
  }

  const [, ...data] = rows;
  const snapshots = data
    .map((r) => ({ timestamp: r[0], original: r[1], digest: r[2], status: r[3] }))
    .filter((s) => s.timestamp && s.digest && String(s.status || '').startsWith('2'))
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

  return { url, ok: true, reason: 'ok', snapshots };
}

async function probeEnterprisePaths(competitor) {
  const base = (competitor.website || '').replace(/\/$/, '');
  if (!base) return [];
  const urls = ENTERPRISE_PATHS.map((p) => base + p);
  const out = [];
  for (const u of urls) {
    const r = await probeEnterprisePath(u);
    out.push(r);
    await new Promise((res) => setTimeout(res, 600));
  }
  return out;
}

function summariseEnterprisePaths(probes) {
  const hits = probes.filter((p) => p.ok && p.snapshots.length > 0);
  if (!hits.length) return null;
  const lines = hits.map((p) => {
    const last = p.snapshots[p.snapshots.length - 1];
    const archive = `https://web.archive.org/web/${last.timestamp}/${last.original}`;
    return `${p.url} — ${p.snapshots.length} archived snapshot(s); latest ${formatTimestamp(last.timestamp)} → ${archive}`;
  });
  return lines.join('\n');
}

// ─── Reddit pricing-intent search ─────────────────────────────────────────────

function isRecentUnix(unix, days = LOOKBACK_DAYS) {
  if (!unix) return false;
  const cutoff = (Date.now() - days * 24 * 60 * 60 * 1000) / 1000;
  return unix >= cutoff;
}

function hasPricingPayload(text) {
  if (!text) return false;
  if (DOLLAR_FIGURE_RE.test(text)) {
    DOLLAR_FIGURE_RE.lastIndex = 0;
    return true;
  }
  return PRICING_STRUCTURE_PATTERNS.some((re) => re.test(text));
}

function extractPriceTokens(text) {
  if (!text) return [];
  const matches = text.match(DOLLAR_FIGURE_RE) || [];
  return [...new Set(matches.map((m) => m.replace(/\s+/g, '')))].slice(0, 8);
}

function buildRedditQueries(competitor) {
  const { name, website } = competitor;
  const domain = extractDomain(website);
  const queries = [];
  if (name) {
    queries.push(`"${name}" pricing OR cost OR quote`);
    queries.push(`"${name}" "per seat" OR "per user" OR "per endpoint"`);
    queries.push(`"${name}" expensive OR renewal OR negotiat`);
  }
  if (domain) {
    queries.push(`"${domain}" pricing`);
  }
  return [...new Set(queries)].slice(0, 4);
}

async function searchReddit(query) {
  const url =
    'https://www.reddit.com/search.json' +
    `?q=${encodeURIComponent(query)}` +
    '&sort=new' +
    '&t=year' +
    '&limit=25' +
    '&type=link';

  let res;
  try {
    res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS, {
      headers: { 'User-Agent': UA_REDDIT },
    });
  } catch {
    return { ok: false, reason: 'timeout', posts: [] };
  }
  if (!res.ok) return { ok: false, reason: `http_${res.status}`, posts: [] };

  let json;
  try {
    json = await res.json();
  } catch {
    return { ok: false, reason: 'invalid_json', posts: [] };
  }

  const children = json?.data?.children || [];
  const posts = children
    .map((c) => c?.data || {})
    .filter((d) => d && d.title)
    .map((d) => ({
      title: String(d.title || '').trim(),
      subreddit: String(d.subreddit || '').trim(),
      author: String(d.author || '').trim(),
      created: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : '',
      createdUnix: Number(d.created_utc || 0),
      score: Number(d.score || 0),
      numComments: Number(d.num_comments || 0),
      permalink: d.permalink ? `https://www.reddit.com${d.permalink}` : '',
      selftext: String(d.selftext || '').trim().slice(0, 1200),
    }));
  return { ok: true, reason: 'ok', posts };
}

function passesRedditPricingFilter(post, competitor) {
  const name = (competitor.name || '').toLowerCase().trim();
  if (!name) return false;
  const blob = `${post.title} ${post.selftext}`;
  const lower = blob.toLowerCase();
  if (!lower.includes(name) && !lower.includes(name.replace(/\s+/g, ''))) {
    const primary = name.split(/\s+/)[0];
    if (primary.length < 4 || !lower.includes(primary)) return false;
  }
  if (post.score < MIN_REDDIT_SCORE && post.numComments < 1) return false;
  if (!hasPricingPayload(blob)) return false;
  const junkSubs = /^(teenagers|relationship_advice|crypto|nsfw|amitheasshole|conspiracy)$/i;
  if (junkSubs.test(post.subreddit)) return false;
  return true;
}

async function collectRedditPricing(competitor) {
  const queries = buildRedditQueries(competitor);
  const collected = [];
  let blocks = 0;

  for (const q of queries) {
    const { ok, posts } = await searchReddit(q);
    if (!ok) {
      blocks++;
      continue;
    }
    for (const p of posts) {
      if (!isRecentUnix(p.createdUnix)) continue;
      if (!passesRedditPricingFilter(p, competitor)) continue;
      collected.push(p);
    }
    await new Promise((r) => setTimeout(r, REDDIT_THROTTLE_MS));
  }

  const seen = new Set();
  const unique = [];
  for (const p of collected) {
    const key = p.permalink || p.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  unique.sort((a, b) => (b.score + b.numComments) - (a.score + a.numComments));
  return { posts: unique.slice(0, MAX_REDDIT_POSTS), blocks, queries };
}

// ─── Hacker News pricing-intent search ────────────────────────────────────────

function buildHnQueries(competitor) {
  const { name, website } = competitor;
  const domain = extractDomain(website);
  const queries = [];
  if (name) {
    queries.push(`"${name}" pricing`);
    queries.push(`"${name}" cost`);
  }
  if (domain) queries.push(`${domain} pricing`);
  return [...new Set(queries)].slice(0, 3);
}

async function searchAlgolia(query) {
  const cutoff = Math.floor((Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000) / 1000);
  const url =
    'https://hn.algolia.com/api/v1/search_by_date' +
    `?query=${encodeURIComponent(query)}` +
    '&tags=story,comment' +
    `&numericFilters=created_at_i>${cutoff}` +
    '&hitsPerPage=25';

  let res;
  try {
    res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
  } catch {
    return { ok: false, reason: 'timeout', hits: [] };
  }
  if (!res.ok) return { ok: false, reason: `http_${res.status}`, hits: [] };

  let json;
  try {
    json = await res.json();
  } catch {
    return { ok: false, reason: 'invalid_json', hits: [] };
  }

  const hits = (json?.hits || []).map((h) => ({
    title: String(h.title || h.story_title || '').trim(),
    storyText: String(h.story_text || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 1200),
    commentText: String(h.comment_text || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 1200),
    url: String(h.url || h.story_url || '').trim(),
    points: Number(h.points || 0),
    numComments: Number(h.num_comments || 0),
    author: String(h.author || '').trim(),
    createdAt: String(h.created_at || ''),
    objectID: String(h.objectID || ''),
  }));
  return { ok: true, reason: 'ok', hits };
}

function passesHnPricingFilter(hit, competitor) {
  const name = (competitor.name || '').toLowerCase().trim();
  const domain = extractDomain(competitor.website).toLowerCase();
  const blob = `${hit.title} ${hit.storyText} ${hit.commentText} ${hit.url}`;
  const lower = blob.toLowerCase();
  let hasBrand = false;
  if (domain && lower.includes(domain)) hasBrand = true;
  if (name && lower.includes(name)) hasBrand = true;
  if (!hasBrand) {
    const primary = name.split(/\s+/)[0];
    if (primary && primary.length > 4 && lower.includes(primary)) hasBrand = true;
  }
  if (!hasBrand) return false;
  if (hit.points < MIN_HN_POINTS && hit.numComments < 1) return false;
  return hasPricingPayload(blob);
}

async function collectHnPricing(competitor) {
  const queries = buildHnQueries(competitor);
  const seen = new Set();
  const hits = [];
  let errors = 0;

  for (const q of queries) {
    const { ok, hits: rawHits } = await searchAlgolia(q);
    if (!ok) {
      errors++;
      continue;
    }
    for (const h of rawHits) {
      const key = h.objectID || h.url || h.title;
      if (seen.has(key)) continue;
      if (!passesHnPricingFilter(h, competitor)) continue;
      seen.add(key);
      hits.push(h);
    }
    await new Promise((r) => setTimeout(r, HN_THROTTLE_MS));
  }

  hits.sort((a, b) => (b.points + b.numComments) - (a.points + a.numComments));
  return { stories: hits.slice(0, MAX_HN_STORIES), errors, queries };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatRedditPosts(posts) {
  return posts
    .map((p) => {
      const blob = `${p.title} ${p.selftext}`;
      const tokens = extractPriceTokens(blob);
      const lines = [
        `TITLE: ${p.title}`,
        `SUBREDDIT: r/${p.subreddit}`,
        `POSTED: ${p.created || 'unknown'} · score ${p.score} · ${p.numComments} comments`,
        `LINK: ${p.permalink || 'n/a'}`,
      ];
      if (tokens.length) lines.push(`PRICE TOKENS: ${tokens.join(', ')}`);
      if (p.selftext) lines.push(`EXCERPT: ${p.selftext}`);
      return lines.join('\n');
    })
    .join('\n\n---\n\n');
}

function formatHnHits(hits) {
  return hits
    .map((h) => {
      const blob = `${h.title} ${h.storyText} ${h.commentText}`;
      const tokens = extractPriceTokens(blob);
      const discussion = h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : '';
      const lines = [
        `TITLE: ${h.title || '(comment)'}`,
        `POINTS: ${h.points} · COMMENTS: ${h.numComments} · AUTHOR: ${h.author || 'unknown'}`,
        `POSTED: ${h.createdAt || 'unknown'}`,
        h.url ? `STORY URL: ${h.url}` : '',
        discussion ? `HN DISCUSSION: ${discussion}` : '',
      ];
      if (tokens.length) lines.push(`PRICE TOKENS: ${tokens.join(', ')}`);
      const excerpt = h.commentText || h.storyText;
      if (excerpt) lines.push(`EXCERPT: ${excerpt}`);
      return lines.filter(Boolean).join('\n');
    })
    .join('\n\n---\n\n');
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function collectPricingSignals(competitor) {
  const { name } = competitor;
  if (!name) {
    return {
      type: 'pricing_signals',
      competitor: name || '(unknown)',
      data: 'No competitor name provided — cannot run pricing-signals search.',
    };
  }

  const [enterpriseProbes, reddit, hn] = await Promise.all([
    probeEnterprisePaths(competitor),
    collectRedditPricing(competitor),
    collectHnPricing(competitor),
  ]);

  const sections = [];
  const header = [
    'Source: Buyer-public pricing chatter (fallback when /pricing is hidden behind "contact sales").',
    `Lookback: last ${LOOKBACK_DAYS} days. Reddit + HN posts are kept ONLY if they actually contain a $-figure or pricing-structure phrase.`,
    `Reddit queries: ${reddit.queries.join(' | ')}`,
    `HN queries: ${hn.queries.join(' | ')}`,
    `Enterprise URL probes: ${ENTERPRISE_PATHS.join(', ')}`,
    '',
  ];
  sections.push(header.join('\n'));

  const enterpriseLines = summariseEnterprisePaths(enterpriseProbes);
  if (enterpriseLines) {
    sections.push('### ENTERPRISE / CONTACT-SALES URL ARCHAEOLOGY');
    sections.push(enterpriseLines);
  } else {
    sections.push('### ENTERPRISE / CONTACT-SALES URL ARCHAEOLOGY');
    sections.push('No archived snapshots found for /enterprise, /plans/enterprise, /contact-sales, /demo, or /quote in the lookback window.');
  }

  if (reddit.posts.length) {
    sections.push('### REDDIT PRICING DISCUSSION (filtered: must contain $-figure or pricing-structure phrase)');
    sections.push(formatRedditPosts(reddit.posts));
  } else {
    const note = reddit.blocks
      ? `Reddit returned ${reddit.blocks}/${reddit.queries.length} blocked or empty responses — manual skim of r/SaaS or vertical sub recommended.`
      : `No Reddit posts mentioning ${name} alongside an explicit $-figure or pricing-structure phrase in the last ${LOOKBACK_DAYS} days.`;
    sections.push('### REDDIT PRICING DISCUSSION');
    sections.push(note);
  }

  if (hn.stories.length) {
    sections.push('### HACKER NEWS PRICING DISCUSSION (filtered: must contain $-figure or pricing-structure phrase)');
    sections.push(formatHnHits(hn.stories));
  } else {
    const note = hn.errors
      ? `Hacker News search returned ${hn.errors}/${hn.queries.length} errors — no usable hits this run.`
      : `No HN posts mentioning ${name} alongside an explicit $-figure or pricing-structure phrase in the last ${LOOKBACK_DAYS} days.`;
    sections.push('### HACKER NEWS PRICING DISCUSSION');
    sections.push(note);
  }

  const anyPayload = reddit.posts.length > 0 || hn.stories.length > 0 || !!enterpriseLines;
  if (!anyPayload) {
    sections.push('');
    sections.push('No pricing-signal payloads detected this run. Pricing intelligence for this competitor is genuinely opaque to public buyer channels.');
  }

  return {
    type: 'pricing_signals',
    competitor: name,
    data: sections.join('\n\n'),
  };
}
