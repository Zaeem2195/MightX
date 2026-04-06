/**
 * Collector: Crunchbase / Funding Monitor
 * ─────────────────────────────────────────
 * Monitors competitor funding activity, acquisitions, and corporate events.
 *
 * Uses Google News RSS to track funding announcements (Crunchbase's API
 * requires a paid plan). This approach catches the same events via press
 * coverage within 24–48 hours of announcement.
 *
 * Signals tracked:
 * - Funding rounds (Series A/B/C, seed, etc.)
 * - Acquisitions (acquirer or target)
 * - IPO filings or SPAC activity
 * - Major partnerships
 * - Layoffs or restructuring
 */

import { buildFundingSearchQueries, isRelevantArticle } from './_utils.js';

const FETCH_TIMEOUT = 10000;
const MAX_ARTICLES = 10;
const LOOKBACK_DAYS = 14;

function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(block) || /<title>(.*?)<\/title>/.exec(block))?.[1] || '';
    const pubDate = (/<pubDate>(.*?)<\/pubDate>/.exec(block))?.[1] || '';
    const source = (/<source[^>]*>(.*?)<\/source>/.exec(block))?.[1] || '';
    const desc = (/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/.exec(block) || /<description>([\s\S]*?)<\/description>/.exec(block))?.[1] || '';
    const cleanDesc = desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    items.push({ title: title.trim(), pubDate, source: source.trim(), description: cleanDesc });
  }
  return items;
}

function isRecent(pubDateStr) {
  if (!pubDateStr) return true;
  try {
    return new Date(pubDateStr) >= new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  } catch {
    return true;
  }
}

const FUNDING_KEYWORDS = /\b(raises?|raised|funding|series [a-e]|seed round|venture|investment|ipo|spac|valuation|\$\d+[mb])\b/i;
const ACQUISITION_KEYWORDS = /\b(acquires?|acquired|acquisition|merger|merges?|buys?|bought|takeover)\b/i;
const PARTNERSHIP_KEYWORDS = /\b(partners? with|partnership|integrates? with|integration|joins? forces|alliance|collaboration)\b/i;
const LAYOFF_KEYWORDS = /\b(layoffs?|laid off|restructur|downsiz|headcount reduction|workforce reduction|job cuts)\b/i;

function categoriseArticle(article) {
  const text = `${article.title} ${article.description}`.toLowerCase();

  if (FUNDING_KEYWORDS.test(text)) return 'funding';
  if (ACQUISITION_KEYWORDS.test(text)) return 'acquisition';
  if (PARTNERSHIP_KEYWORDS.test(text)) return 'partnership';
  if (LAYOFF_KEYWORDS.test(text)) return 'restructuring';
  return 'corporate';
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
    return parseRSS(await res.text());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function collectCrunchbase(competitor) {
  const { name, crunchbaseSlug } = competitor;

  if (!crunchbaseSlug && !name) {
    return { type: 'funding', competitor: name, data: 'No Crunchbase slug or company name configured.' };
  }

  const searchQueries = buildFundingSearchQueries(competitor);

  const allArticles = [];
  const seen = new Set();

  for (const query of searchQueries) {
    const articles = await fetchGoogleNews(query);
    for (const a of articles) {
      if (!seen.has(a.title) && isRecent(a.pubDate) && isRelevantArticle(a, competitor, { strictFunding: true })) {
        seen.add(a.title);
        allArticles.push({ ...a, category: categoriseArticle(a) });
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const relevant = allArticles.slice(0, MAX_ARTICLES);

  if (!relevant.length) {
    return {
      type: 'funding',
      competitor: name,
      data: `No funding, acquisition, or corporate news found for ${name} in the past ${LOOKBACK_DAYS} days (after entity filtering).`,
    };
  }

  const grouped = {};
  for (const article of relevant) {
    if (!grouped[article.category]) grouped[article.category] = [];
    grouped[article.category].push(article);
  }

  const categoryLabels = {
    funding: 'Funding & Investment',
    acquisition: 'Acquisitions & Mergers',
    partnership: 'Partnerships & Integrations',
    restructuring: 'Restructuring & Layoffs',
    corporate: 'Other Corporate News',
  };

  const lines = [];

  for (const [category, articles] of Object.entries(grouped)) {
    lines.push(`${categoryLabels[category] || category}:`);
    for (const a of articles) {
      lines.push(`  - ${a.title}`);
      lines.push(`    Source: ${a.source || 'unknown'} | Date: ${a.pubDate || 'recent'}`);
      if (a.description) lines.push(`    Summary: ${a.description}`);
    }
    lines.push('');
  }

  return {
    type: 'funding',
    competitor: name,
    data: lines.join('\n').trim(),
  };
}
