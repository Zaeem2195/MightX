/**
 * Collector: News Monitor
 * ───────────────────────
 * Free: Google News RSS (headline + short description).
 * Premium (APIFY_API_TOKEN): fabri-lab/apify-google-news-scraper — full article text.
 */

import { buildNewsSearchQueries, isRelevantArticle } from './_utils.js';
import { APIFY_ACTORS, getApifyClient, isApifyEnabled, runActorDataset, clipText } from './_apify.js';

const FETCH_TIMEOUT = 10000;
const MAX_ARTICLES = 8;
const LOOKBACK_DAYS = 8;
const FULL_TEXT_CAP = 2000;

// ── Parse Google News RSS XML ─────────────────────────────────────────────────
function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title   = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(block) || /<title>(.*?)<\/title>/.exec(block))?.[1] || '';
    const pubDate = (/<pubDate>(.*?)<\/pubDate>/.exec(block))?.[1] || '';
    const source  = (/<source[^>]*>(.*?)<\/source>/.exec(block))?.[1] || '';
    const link    = (/<link>(.*?)<\/link>/.exec(block))?.[1] || '';
    const desc    = (/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/.exec(block) || /<description>([\s\S]*?)<\/description>/.exec(block))?.[1] || '';

    const cleanDesc = desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

    items.push({ title: title.trim(), pubDate, source: source.trim(), link, description: cleanDesc });
  }

  return items;
}

function isRecent(pubDateStr) {
  if (!pubDateStr) return true;
  try {
    const pub  = new Date(pubDateStr);
    const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    return pub >= cutoff;
  } catch {
    return true;
  }
}

async function fetchGoogleNews(keyword) {
  const encoded = encodeURIComponent(keyword);
  const url = `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IntelligenceBot/1.0)' },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRSS(xml);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** RSS-only collection (free tier). */
async function collectNewsFree(competitor) {
  const { name } = competitor;
  const keywords = buildNewsSearchQueries(competitor);
  const allArticles = [];
  const seen = new Set();

  for (const keyword of keywords) {
    const articles = await fetchGoogleNews(keyword);
    for (const a of articles) {
      if (!seen.has(a.title) && isRecent(a.pubDate) && isRelevantArticle(a, competitor)) {
        seen.add(a.title);
        allArticles.push(a);
      }
    }
    await new Promise((r) => setTimeout(r, 600));
  }

  const recent = allArticles.slice(0, MAX_ARTICLES);
  if (!recent.length) {
    return {
      type:       'news',
      competitor: name,
      data:       `No relevant news articles found for ${name} in the past ${LOOKBACK_DAYS} days (after entity filtering).`,
    };
  }

  const formatted = recent.map((a) =>
    `HEADLINE: ${a.title}\nSOURCE: ${a.source || 'unknown'}\nDATE: ${a.pubDate}\nSUMMARY: ${a.description || 'No description'}`
  ).join('\n\n---\n\n');

  return { type: 'news', competitor: name, data: formatted };
}

/** One Google News actor run per query keyword; merge + dedupe. */
async function collectNewsApify(competitor) {
  const { name } = competitor;
  const client = getApifyClient();
  if (!client) return null;

  const keywords = buildNewsSearchQueries(competitor);
  const merged = [];
  const seen = new Set();

  for (const keyword of keywords) {
    try {
      const { items } = await runActorDataset(
        client,
        APIFY_ACTORS.GOOGLE_NEWS,
        {
          searchQuery: keyword,
          maxResults: 5,
          country: 'US',
          language: 'en',
          timeRange: '7d',
          extractFullText: true,
        },
        { waitSecs: 420, itemLimit: 50, injectDefaultProxy: true }
      );

      for (const row of items || []) {
        const title = String(row.title || row.headline || '').trim();
        if (!title || seen.has(title)) continue;

        const art = {
          title,
          pubDate: row.date || row.pubDate || row.publishedAt || '',
          source: row.source || row.sourceName || 'unknown',
          link: row.link || row.url || '',
          description: String(row.snippet || row.description || '').slice(0, 400),
          fullText: row.fullText || row.text || row.articleText || '',
        };

        const descBlob = `${art.description} ${clipText(art.fullText, 500)}`;
        if (!isRelevantArticle({ title: art.title, description: descBlob }, competitor)) continue;
        if (art.pubDate && !isRecent(art.pubDate)) continue;

        seen.add(title);
        merged.push(art);
        if (merged.length >= MAX_ARTICLES * 2) break;
      }
    } catch {
      /* continue other keywords */
    }

    await new Promise((r) => setTimeout(r, 400));
    if (merged.length >= MAX_ARTICLES * 2) break;
  }

  const recent = merged.slice(0, MAX_ARTICLES);
  if (!recent.length) return null;

  const formatted = recent.map((a) => {
    const body = clipText(a.fullText || a.description || '', FULL_TEXT_CAP);
    return [
      `HEADLINE: ${a.title}`,
      `SOURCE: ${a.source || 'unknown'}`,
      `DATE: ${a.pubDate || 'unknown'}`,
      `LINK: ${a.link || 'n/a'}`,
      `SUMMARY: ${a.description || 'No snippet'}`,
      `FULL_TEXT (Apify, capped): ${body || '—'}`,
    ].join('\n');
  }).join('\n\n---\n\n');

  return {
    type:       'news',
    competitor: name,
    data:       `Source: Apify (${APIFY_ACTORS.GOOGLE_NEWS}) — full article extraction where available.\n\n${formatted}`,
  };
}

export async function collectNews(competitor) {
  if (isApifyEnabled()) {
    const premium = await collectNewsApify(competitor);
    if (premium) return premium;
  }
  return collectNewsFree(competitor);
}
