/**
 * Collector: News Monitor (Google News RSS)
 * ──────────────────────────────────────────
 * Uses Google News RSS feeds — free, no API key required.
 * Returns recent news articles per competitor for Claude to analyse.
 */

const FETCH_TIMEOUT  = 10000;
const MAX_ARTICLES   = 8;
const LOOKBACK_DAYS  = 8;   // slightly more than a week to avoid gaps

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

    // Strip HTML tags from description
    const cleanDesc = desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

    items.push({ title: title.trim(), pubDate, source: source.trim(), link, description: cleanDesc });
  }

  return items;
}

// ── Filter to articles within lookback window ─────────────────────────────────
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

// ── Fetch Google News RSS for a keyword ───────────────────────────────────────
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
    const xml = await res.text();
    return parseRSS(xml);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function collectNews(competitor) {
  const { name, newsKeywords = [] } = competitor;

  // Always include the company name as a keyword
  const keywords = [name, ...newsKeywords].slice(0, 4);

  const allArticles = [];
  const seen = new Set();

  for (const keyword of keywords) {
    const articles = await fetchGoogleNews(keyword);
    for (const a of articles) {
      if (!seen.has(a.title) && isRecent(a.pubDate)) {
        seen.add(a.title);
        allArticles.push(a);
      }
    }
    await new Promise(r => setTimeout(r, 600));
  }

  const recent = allArticles.slice(0, MAX_ARTICLES);

  if (!recent.length) {
    return {
      type:       'news',
      competitor: name,
      data:       `No news articles found for ${name} in the past ${LOOKBACK_DAYS} days.`,
    };
  }

  const formatted = recent.map(a =>
    `HEADLINE: ${a.title}\nSOURCE: ${a.source || 'unknown'}\nDATE: ${a.pubDate}\nSUMMARY: ${a.description || 'No description'}`
  ).join('\n\n---\n\n');

  return {
    type:       'news',
    competitor: name,
    data:       formatted,
  };
}
