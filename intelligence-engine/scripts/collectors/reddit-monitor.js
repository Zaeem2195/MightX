/**
 * Collector: Reddit Community Chatter Monitor
 * ────────────────────────────────────────────
 * Reddit's public JSON endpoints expose the same data the site renders, no auth
 * required. For competitive intelligence this is gold on silent weeks:
 *   - SaaS subs (r/sales, r/CustomerSuccess, r/ITManager, r/sysadmin, r/devops,
 *     r/ProductManagement, r/SaaS, r/startups, r/Entrepreneur, vertical-specific)
 *     regularly discuss pricing, rollout pain, churn reasons, head-to-head picks.
 *   - Activity surfaces before it hits G2 reviews or news articles.
 *   - Per-post score + comment count give us a crude "how loud" filter.
 *
 * Endpoint used (free, rate-limited — be gentle):
 *   https://www.reddit.com/search.json?q=<query>&sort=new&t=month&limit=25
 *
 * Reddit occasionally returns 429 / blocks no-UA requests; we retry once and
 * degrade to an informative "reddit_blocked" data string rather than error.
 */

import { extractDomain } from './_utils.js';

const FETCH_TIMEOUT_MS = 12000;
const MAX_POSTS         = 12;
const LOOKBACK_DAYS     = 30;
const MIN_SCORE         = 2;   // filter single-vote throwaway posts
const MIN_COMMENTS      = 1;

const UA =
  process.env.REDDIT_USER_AGENT?.trim() ||
  'MightX-Intel/1.0 (+competitive-intel; contact=ops@mightx.local)';

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function searchReddit(query) {
  const url =
    'https://www.reddit.com/search.json' +
    `?q=${encodeURIComponent(query)}` +
    '&sort=new' +
    '&t=month' +
    '&limit=25' +
    '&type=link';

  let res;
  try {
    res = await fetchWithTimeout(url);
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
      title:       String(d.title || '').trim(),
      subreddit:   String(d.subreddit || '').trim(),
      author:      String(d.author || '').trim(),
      created:     d.created_utc ? new Date(d.created_utc * 1000).toISOString() : '',
      createdUnix: Number(d.created_utc || 0),
      score:       Number(d.score || 0),
      numComments: Number(d.num_comments || 0),
      permalink:   d.permalink ? `https://www.reddit.com${d.permalink}` : '',
      selftext:    String(d.selftext || '').trim().slice(0, 600),
      flair:       String(d.link_flair_text || '').trim(),
    }));

  return { ok: true, reason: 'ok', posts };
}

function isRecent(unix) {
  if (!unix) return true;
  const cutoff = (Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000) / 1000;
  return unix >= cutoff;
}

function isRelevant(post, competitor) {
  const name = (competitor.name || '').toLowerCase().trim();
  if (!name) return true;
  const blob = `${post.title} ${post.selftext}`.toLowerCase();

  if (!blob.includes(name) && !blob.includes(name.replace(/\s+/g, ''))) {
    // allow primary token match when the full name is multi-word (e.g. "Absorb LMS" → "absorb")
    const primary = name.split(/\s+/)[0];
    if (primary.length < 4 || !blob.includes(primary)) return false;
  }

  if (post.score < MIN_SCORE && post.numComments < MIN_COMMENTS) return false;

  // filter obvious off-topic: crypto/nsfw/relationship subs that collide with short brand tokens
  const junkSubs = /^(teenagers|relationship_advice|crypto|nsfw|amitheasshole|conspiracy)$/i;
  if (junkSubs.test(post.subreddit)) return false;

  return true;
}

function buildQueries(competitor) {
  const { name, website } = competitor;
  const domain = extractDomain(website);
  const queries = [];

  if (name) {
    queries.push(`"${name}"`);
    // also try domain short ("docebo.com" or "outreach.io")
    if (domain) queries.push(`"${domain}"`);
    // brand + pain keywords (focused on commercial signal)
    queries.push(`"${name}" pricing OR review OR alternatives`);
    queries.push(`"${name}" switched OR migrated OR "moved from"`);
  }

  return [...new Set(queries)].slice(0, 4);
}

function dedupe(posts) {
  const seen = new Set();
  const out = [];
  for (const p of posts) {
    const key = p.permalink || p.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function formatPosts(posts) {
  return posts
    .map((p) => {
      const lines = [
        `TITLE: ${p.title}`,
        `SUBREDDIT: r/${p.subreddit}${p.flair ? ` · flair: ${p.flair}` : ''}`,
        `POSTED: ${p.created || 'unknown'} · score ${p.score} · ${p.numComments} comments`,
        `LINK: ${p.permalink || 'n/a'}`,
      ];
      if (p.selftext) lines.push(`EXCERPT: ${p.selftext}`);
      return lines.join('\n');
    })
    .join('\n\n---\n\n');
}

export async function collectReddit(competitor) {
  const { name } = competitor;
  const queries = buildQueries(competitor);

  const collected = [];
  let blocks = 0;

  for (const q of queries) {
    const { ok, reason, posts } = await searchReddit(q);
    if (!ok) {
      blocks++;
      continue;
    }

    for (const p of posts) {
      if (!isRecent(p.createdUnix)) continue;
      if (!isRelevant(p, competitor)) continue;
      collected.push(p);
    }

    await new Promise((r) => setTimeout(r, 900)); // be gentle with Reddit
  }

  const uniqueRanked = dedupe(collected)
    .sort((a, b) => (b.score + b.numComments) - (a.score + a.numComments))
    .slice(0, MAX_POSTS);

  if (!uniqueRanked.length) {
    const reasonNote = blocks
      ? `Reddit returned ${blocks}/${queries.length} blocked or empty responses — worth a manual skim of r/SaaS for ${name}.`
      : `No relevant Reddit discussion about ${name} in the last ${LOOKBACK_DAYS} days (public search).`;
    return {
      type:       'reddit',
      competitor: name,
      data:       reasonNote,
    };
  }

  const header = [
    'Source: Reddit public JSON search (free tier).',
    `Lookback: last ${LOOKBACK_DAYS} days, ranked by score + comment count.`,
    `Queries: ${queries.join(' | ')}`,
    '',
  ];

  return {
    type:       'reddit',
    competitor: name,
    data:       [...header, formatPosts(uniqueRanked)].join('\n'),
  };
}
