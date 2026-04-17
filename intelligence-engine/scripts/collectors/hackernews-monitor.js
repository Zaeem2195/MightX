/**
 * Collector: Hacker News Chatter Monitor
 * ────────────────────────────────────────
 * HN is a leading indicator for infra / dev-tooling / product news: competitor
 * launches, engineering changes, YC-adjacent strategy moves, and (frequently)
 * frustrated users posting switch stories before they hit review sites.
 *
 * Uses Algolia's free HN Search API — no auth, generous rate limits, documented
 * here: https://hn.algolia.com/api
 *
 * Endpoint:
 *   https://hn.algolia.com/api/v1/search_by_date
 *     ?query=<text>
 *     &tags=story
 *     &numericFilters=created_at_i>{unix-30-days-ago}
 *     &hitsPerPage=25
 *
 * Story objects include: title, url, points, num_comments, author, created_at,
 * and `objectID` (used to build a `news.ycombinator.com/item?id=<id>` link).
 */

import { extractDomain } from './_utils.js';

const FETCH_TIMEOUT_MS = 10000;
const MAX_STORIES      = 10;
const LOOKBACK_DAYS    = 30;
const MIN_POINTS       = 3;
const MIN_COMMENTS     = 1;

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'MightX-Intel/1.0 (hackernews-monitor)',
        Accept: 'application/json',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function buildQueries(competitor) {
  const { name, website } = competitor;
  const domain = extractDomain(website);
  const queries = [];
  if (name) queries.push(`"${name}"`);
  if (domain) queries.push(domain);
  if (name && domain) {
    const short = domain.split('.')[0];
    if (short.length > 3 && short.toLowerCase() !== name.toLowerCase()) queries.push(short);
  }
  return [...new Set(queries)].slice(0, 3);
}

async function searchAlgolia(query) {
  const cutoff = Math.floor((Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000) / 1000);
  const url =
    'https://hn.algolia.com/api/v1/search_by_date' +
    `?query=${encodeURIComponent(query)}` +
    '&tags=story' +
    `&numericFilters=created_at_i>${cutoff}` +
    '&hitsPerPage=25';

  let res;
  try {
    res = await fetchWithTimeout(url);
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
    title:       String(h.title || h.story_title || '').trim(),
    url:         String(h.url || h.story_url || '').trim(),
    points:      Number(h.points || 0),
    numComments: Number(h.num_comments || 0),
    author:      String(h.author || '').trim(),
    createdAt:   String(h.created_at || ''),
    objectID:    String(h.objectID || ''),
  }));

  return { ok: true, reason: 'ok', hits };
}

function isRelevant(story, competitor) {
  const name = (competitor.name || '').toLowerCase().trim();
  const domain = extractDomain(competitor.website).toLowerCase();
  const blob = `${story.title} ${story.url}`.toLowerCase();

  if (domain && blob.includes(domain)) return true;
  if (name && blob.includes(name)) return true;
  // allow name primary token for multi-word brands when url is on competitor domain
  const primary = name.split(/\s+/)[0];
  if (primary && primary.length > 4 && blob.includes(primary)) return true;

  return false;
}

function passesFloor(story) {
  return story.points >= MIN_POINTS || story.numComments >= MIN_COMMENTS;
}

function hnDiscussionLink(id) {
  return id ? `https://news.ycombinator.com/item?id=${id}` : '';
}

export async function collectHackerNews(competitor) {
  const { name } = competitor;
  const queries = buildQueries(competitor);
  const seen = new Set();
  const stories = [];
  let errors = 0;

  for (const q of queries) {
    const { ok, hits } = await searchAlgolia(q);
    if (!ok) {
      errors++;
      continue;
    }
    for (const s of hits) {
      const key = s.objectID || s.url || s.title;
      if (seen.has(key)) continue;
      if (!isRelevant(s, competitor)) continue;
      if (!passesFloor(s)) continue;
      seen.add(key);
      stories.push(s);
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  const ranked = stories
    .sort((a, b) => (b.points + b.numComments) - (a.points + a.numComments))
    .slice(0, MAX_STORIES);

  if (!ranked.length) {
    return {
      type:       'hackernews',
      competitor: name,
      data:       errors
        ? `Hacker News search returned ${errors}/${queries.length} errors — no usable hits this run.`
        : `No Hacker News discussion about ${name} in the last ${LOOKBACK_DAYS} days (score >= ${MIN_POINTS} OR comments >= ${MIN_COMMENTS}).`,
    };
  }

  const formatted = ranked
    .map((s) => {
      const discussion = hnDiscussionLink(s.objectID);
      return [
        `TITLE: ${s.title}`,
        `POINTS: ${s.points} · COMMENTS: ${s.numComments} · AUTHOR: ${s.author || 'unknown'}`,
        `POSTED: ${s.createdAt || 'unknown'}`,
        s.url ? `STORY URL: ${s.url}` : '',
        discussion ? `HN DISCUSSION: ${discussion}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n---\n\n');

  const header = [
    'Source: Hacker News via Algolia Search API (free).',
    `Lookback: last ${LOOKBACK_DAYS} days; score floor = ${MIN_POINTS} points OR ${MIN_COMMENTS} comments.`,
    `Queries: ${queries.join(' | ')}`,
    '',
  ];

  return {
    type:       'hackernews',
    competitor: name,
    data:       [...header, formatted].join('\n'),
  };
}
