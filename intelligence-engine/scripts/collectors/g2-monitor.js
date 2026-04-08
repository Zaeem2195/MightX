/**
 * Collector: G2 Review Monitor
 * ─────────────────────────────
 * Free: SERP snippets + best-effort G2 HTML/JSON.
 * Premium (APIFY_API_TOKEN): zen-studio/g2-reviews-scraper — full review text.
 */

import { APIFY_ACTORS, getApifyClient, isApifyEnabled, runActorDataset, clipText } from './_apify.js';

const FETCH_TIMEOUT = 12000;
const MAX_REVIEWS = 10;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
];

function pickUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function fetchText(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': pickUA(),
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        ...headers,
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Decode DuckDuckGo redirect `uddg=` target URL. */
function decodeDdgTarget(href) {
  const m = href.match(/uddg=([^&]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/**
 * Parse DuckDuckGo Lite HTML for results pointing at g2.com/products/{slug}.
 */
function extractFromDuckDuckGoLite(html, g2Slug) {
  if (!html) return { aggregate: null, snippets: [], links: [] };
  const needle = `g2.com/products/${g2Slug}`;
  const linkRes = [
    /<a[^>]+href="([^"]*uddg=[^"]+)"[^>]*class=['"]result-link['"][^>]*>([^<]*)<\/a>/gi,
    /<a[^>]*class=['"]result-link['"][^>]*href="([^"]*uddg=[^"]+)"[^>]*>([^<]*)<\/a>/gi,
  ];
  const snippets = [];
  const links = [];
  for (const re of linkRes) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(html)) !== null) {
      const url = decodeDdgTarget(m[1]);
      const title = m[2].replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').trim();
      if (!url || !url.includes(needle)) continue;
      links.push({ url, title });
      const window = html.slice(m.index, m.index + 3500);
      const sn = window.match(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i);
      const raw = sn ? sn[1] : '';
      const text = raw.replace(/<[^>]+>/g, ' ').replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ').trim();
      if (text && isCleanSerpSnippet(text)) snippets.push(text.slice(0, 500));
    }
  }
  const cleanTitles = links.map((l) => l.title).filter(isCleanSerpSnippet);
  const aggregate = aggregateFromTextChunks([...snippets, ...cleanTitles].join(' '));
  return { aggregate, snippets, links };
}

/** Drop Bing/Google HTML fragments that look like chrome, not result snippets. */
function isCleanSerpSnippet(s) {
  if (!s || s.length < 28) return false;
  if (
    /og:title|meta property|aria-label=|autocomplete=|search suggestions|xmlns:Web|sw_clx|content="http|yvlrue|trouble accessing google|send\s+feedback|style\s*=\s*["']display:\s*none|looking for and rewards you|intelligent search from bing/i.test(
      s
    )
  ) {
    return false;
  }
  if (/^[\s\S]{0,200}site:g2\.com\/products/i.test(s) && /Search <meta/i.test(s)) return false;
  if (/won'?t allow us|description here but the site/i.test(s)) return false;
  return true;
}

/** Pull numeric rating / review count from free text (SERP snippets). */
function aggregateFromTextChunks(text) {
  if (!text) return null;
  const rating =
    text.match(/(\d\.\d)\s*(?:\/\s*5|out of 5|stars?|\u2605)/i) ||
    text.match(/(?:rated|rating|score)\s*:?\s*(\d\.\d)/i) ||
    text.match(/\b(\d\.\d)\s*\(\s*[\d,]+\s+reviews?\s*\)/i);
  const count =
    text.match(/([\d,]+)\s+reviews?\b/i) ||
    text.match(/\breviews?\s*[:(]?\s*([\d,]+)/i);
  const r = rating?.[1];
  const c = count?.[1]?.replace(/,/g, '');
  if (r && c) return `Overall rating: ${r}/5 (${c} reviews)`;
  if (r) return `Overall rating: ${r}/5 (review count from search snippet — verify on G2)`;
  if (c) return `G2 review volume signal: ~${c} reviews (from search snippet)`;
  return null;
}

/** Generic SERP text scan (Bing / Google HTML) for g2 slug. */
function extractFromRawSerp(html, g2Slug) {
  if (!html) return { aggregate: null, snippets: [] };
  const needle = `g2.com/products/${g2Slug}`;
  const idxs = [];
  let pos = 0;
  while ((pos = html.indexOf(needle, pos)) !== -1) {
    idxs.push(pos);
    pos += needle.length;
  }
  const chunks = idxs.map((i) => html.slice(Math.max(0, i - 120), i + 400));
  const snippets = chunks
    .map((c) => c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(isCleanSerpSnippet);
  const aggregate = aggregateFromTextChunks(snippets.join(' '));
  return { aggregate, snippets };
}

async function fetchSerpG2Signals(name, g2Slug) {
  /* Prefer site: — indexes G2 product cards; avoids relying on generic name queries first. */
  const queries = [
    `site:g2.com/products/${g2Slug} reviews`,
    `${name} g2.com reviews`,
    `${name} G2 Crowd rating reviews`,
  ];

  for (const q of queries) {
    const ddgUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`;
    const ddgHtml = await fetchText(ddgUrl);
    const ddg = extractFromDuckDuckGoLite(ddgHtml, g2Slug);
    if (ddg.aggregate || ddg.snippets.length) {
      return { source: 'DuckDuckGo Lite', ...ddg };
    }

    const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(q)}`;
    const bingHtml = await fetchText(bingUrl);
    const bing = extractFromRawSerp(bingHtml, g2Slug);
    if (bing.snippets.length) {
      return { source: 'Bing', ...bing };
    }

    const googleUrl = `https://www.google.com/search?gbv=1&q=${encodeURIComponent(q)}&hl=en&num=10`;
    const googleHtml = await fetchText(googleUrl);
    const goog = extractFromRawSerp(googleHtml, g2Slug);
    if (goog.snippets.length) {
      return { source: 'Google (basic HTML)', ...goog };
    }
  }

  return { source: null, aggregate: null, snippets: [], links: [] };
}

/** Optional: category page (may still 403; best-effort). */
async function tryG2CategoryPage() {
  const url = 'https://www.g2.com/categories/sales-engagement-platforms';
  const html = await fetchText(url);
  if (!html || html.length < 2000) return null;
  return aggregateFromTextChunks(html.slice(0, 80000));
}

/** Try G2 public JSON endpoints (may 404 depending on product). */
async function tryG2JsonEndpoints(slug) {
  const urls = [
    `https://www.g2.com/products/${slug}/reviews.json`,
    `https://www.g2.com/products/${slug}.json`,
  ];
  for (const url of urls) {
    const raw = await fetchText(url);
    if (!raw || raw.startsWith('<!')) continue;
    try {
      const j = JSON.parse(raw);
      return j;
    } catch {
      /* continue */
    }
  }
  return null;
}

/** Parse application/ld+json blocks for Product + reviews. */
function extractLdJsonProduct(html) {
  if (!html) return null;
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const j = JSON.parse(m[1].trim());
      const items = Array.isArray(j) ? j : [j];
      for (const item of items) {
        const t = item['@type'];
        const types = Array.isArray(t) ? t : [t];
        if (types.includes('Product') || types.includes('SoftwareApplication')) {
          return item;
        }
      }
    } catch {
      /* next block */
    }
  }
  return null;
}

function reviewsFromLdJson(ld) {
  if (!ld) return [];
  const out = [];
  const revs = ld.review || ld.reviews;
  const list = Array.isArray(revs) ? revs : revs ? [revs] : [];

  for (const r of list.slice(0, MAX_REVIEWS)) {
    const rating = r.reviewRating?.ratingValue || r.ratingValue || '';
    const title = r.name || r.headline || '';
    const body = r.reviewBody || r.description || '';
    if (title || body) {
      out.push({
        rating: String(rating),
        title: String(title).slice(0, 200),
        body: String(body).slice(0, 600),
        liked: '',
        disliked: '',
      });
    }
  }

  return out;
}

/** Legacy regex extraction (when server returns full HTML). */
function extractReviews(html) {
  if (!html) return [];

  const reviews = [];
  const ratingMatches = [...html.matchAll(/itemprop="ratingValue" content="(\d+\.?\d*)"/g)];
  const titleMatches = [...html.matchAll(/itemprop="name"[^>]*>([^<]{10,120})<\/span>/g)];
  const bodyMatches = [...html.matchAll(/class="[^"]*formatted-text[^"]*"[^>]*>\s*<p[^>]*>([\s\S]{50,600}?)<\/p>/g)];
  const likeMatches = [...html.matchAll(/What do you like best about[^?]+\?[^<]*<\/[^>]+>\s*<p[^>]*>([\s\S]{20,400}?)<\/p>/g)];
  const dislikeMatches = [...html.matchAll(/What do you dislike about[^?]+\?[^<]*<\/[^>]+>\s*<p[^>]*>([\s\S]{20,400}?)<\/p>/g)];

  const maxCount = Math.min(
    MAX_REVIEWS,
    Math.max(titleMatches.length, bodyMatches.length, likeMatches.length, dislikeMatches.length, 1)
  );

  for (let i = 0; i < maxCount; i++) {
    const title = titleMatches[i]?.[1]?.replace(/<[^>]+>/g, '').trim() || '';
    const rating = ratingMatches[i]?.[1] || '';
    const body = bodyMatches[i]?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '';
    const liked = likeMatches[i]?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '';
    const disliked = dislikeMatches[i]?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '';

    if (title || body || liked) {
      reviews.push({ rating, title, body, liked, disliked });
    }
  }

  return reviews;
}

function extractAggregateRating(html) {
  if (!html) return null;

  const ratingMatch = html.match(/itemprop="ratingValue" content="(\d+\.?\d*)"/);
  const countMatch = html.match(/itemprop="reviewCount" content="(\d+)"/);
  const avgMatch = html.match(/"averageRating":(\d+\.?\d*)/);

  const rating = ratingMatch?.[1] || avgMatch?.[1] || null;
  const count = countMatch?.[1] || null;

  return rating ? `Overall rating: ${rating}/5 (${count || 'unknown'} reviews)` : null;
}

/** Fallback: recent G2-related headlines via Google News. */
async function fetchG2NewsFallback(name, slug) {
  const q = encodeURIComponent(`site:g2.com "${name}" OR g2.com/products/${slug}`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': pickUA() } });
    if (!res.ok) return '';
    const xml = await res.text();
    const titles = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && titles.length < 5) {
      const block = match[1];
      const title = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(block) || /<title>(.*?)<\/title>/.exec(block))?.[1]?.trim() || '';
      if (title) titles.push(`- ${title}`);
    }
    return titles.length ? `Recent G2 ecosystem headlines (RSS fallback):\n${titles.join('\n')}` : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

function aggregateFromLd(ld) {
  const ar = ld?.aggregateRating;
  if (!ar) return null;
  const r = ar.ratingValue || ar.rating;
  const c = ar.reviewCount || ar.ratingCount;
  if (r) return `Overall rating: ${r}/5 (${c || 'unknown'} reviews)`;
  return null;
}

async function collectG2Apify(competitor) {
  const { name, g2Slug } = competitor;
  const client = getApifyClient();
  if (!client) return null;

  const url = `https://www.g2.com/products/${g2Slug}/reviews`;

  let items;
  try {
    ({ items } = await runActorDataset(
      client,
      APIFY_ACTORS.G2_REVIEWS,
      {
        url,
        limit: 15,
        sortOrder: 'most_recent',
        includeProsConsSummary: false,
      },
      { waitSecs: 900, itemLimit: 50, injectDefaultProxy: true }
    ));
  } catch {
    return null;
  }

  if (!items?.length) return null;

  const lines = [
    `Source: Apify (${APIFY_ACTORS.G2_REVIEWS})`,
    `Product URL: ${url}`,
    '',
  ];

  const meta = items.find((x) => x.productAverageRating != null) || items[0];
  if (meta?.productAverageRating != null && meta?.productReviewCount != null) {
    lines.push(`Overall (from scrape metadata): ${meta.productAverageRating}/5 (${meta.productReviewCount} reviews)`, '');
  }

  let n = 0;
  for (const r of items) {
    const text =
      r.reviewText ||
      r.reviewBody ||
      r.text ||
      r.markdownContent ||
      r.summary ||
      '';
    const title = r.title || r.reviewTitle || r.headline || '';
    const rating = r.rating || r.starRating || r.reviewRating || '';
    const role = r.reviewerJobTitle || r.reviewerTitle || r.jobTitle || '';
    const pros = r.prosText || r.pros || r.liked || '';
    const cons = r.consText || r.cons || r.disliked || '';
    const when = r.reviewDate || r.publishedDate || r.date || '';

    if (!text && !title && !pros && !cons) continue;
    n += 1;
    lines.push(`Review ${n}${rating ? ` (${rating}/5)` : ''}${when ? ` — ${when}` : ''}`);
    if (role) lines.push(`  Role: ${role}`);
    if (title) lines.push(`  Title: ${title}`);
    if (pros) lines.push(`  Pros: ${clipText(String(pros), 500)}`);
    if (cons) lines.push(`  Cons: ${clipText(String(cons), 500)}`);
    if (text) lines.push(`  Text: ${clipText(String(text), 1200)}`);
    lines.push('');
    if (n >= 15) break;
  }

  if (n === 0) return null;

  return { type: 'g2_reviews', competitor: name, data: lines.join('\n').trim() };
}

export async function collectG2(competitor) {
  const { name, g2Slug } = competitor;

  if (!g2Slug) {
    return {
      type:       'g2_reviews',
      competitor: name,
      data:       'No G2 slug configured for this competitor.',
    };
  }

  if (isApifyEnabled()) {
    const premium = await collectG2Apify(competitor);
    if (premium) return premium;
  }

  const serp = await fetchSerpG2Signals(name, g2Slug);
  let aggregate = serp.aggregate;
  let serpSnippets = (serp.snippets || []).filter(isCleanSerpSnippet);
  let sourceLine = serp.source ? `Source: search (${serp.source})` : '';
  if ((serp.source === 'Bing' || serp.source === 'Google (basic HTML)') && !serpSnippets.length) {
    aggregate = null;
  }

  /* Category aggregate early when SERP has no usable snippets (server-side HTML, no G2 bot wall). */
  if (!aggregate && !serpSnippets.length) {
    const catAgg = await tryG2CategoryPage();
    if (catAgg) {
      aggregate = catAgg;
      sourceLine = sourceLine || 'Source: G2 category page (aggregate only)';
    }
  }

  const reviewsUrl = `https://www.g2.com/products/${g2Slug}/reviews`;
  const html = await fetchText(reviewsUrl);

  let reviews = [];
  if (html && html.length > 500 && !/captcha|enable javascript|unusual traffic/i.test(html.slice(0, 3000))) {
    reviews = extractReviews(html);
    const aggDirect = extractAggregateRating(html);
    const ld = extractLdJsonProduct(html);
    const aggLd = aggregateFromLd(ld);
    if (aggDirect || aggLd) aggregate = aggDirect || aggLd || aggregate;
    if (ld) {
      const fromLd = reviewsFromLdJson(ld);
      if (fromLd.length) reviews = fromLd;
    }
  }

  const jsonBlob = await tryG2JsonEndpoints(g2Slug);
  if (jsonBlob && reviews.length === 0) {
    const data = jsonBlob;
    const maybeReviews = data.reviews || data.data?.reviews || data.product?.reviews;
    if (Array.isArray(maybeReviews)) {
      reviews = maybeReviews.slice(0, MAX_REVIEWS).map((r) => ({
        rating: String(r.rating || r.rating_value || ''),
        title: String(r.title || r.name || '').slice(0, 200),
        body: String(r.body || r.text || '').slice(0, 600),
        liked: '',
        disliked: '',
      }));
    }
  }

  const newsFallback = (!reviews.length || !aggregate)
    ? await fetchG2NewsFallback(name, g2Slug)
    : '';

  if (serpSnippets.length && !reviews.length) {
    const lines = [];
    if (sourceLine) lines.push(sourceLine);
    if (aggregate) lines.push(aggregate, '');
    lines.push('Review snippets (from search results — G2 blocks direct scraping):');
    serpSnippets.slice(0, MAX_REVIEWS).forEach((s, i) => {
      lines.push(`${i + 1}. ${s}`);
    });
    if (newsFallback) lines.push('', newsFallback);
    return {
      type:       'g2_reviews',
      competitor: name,
      data:       lines.join('\n').trim(),
    };
  }

  if (!reviews.length) {
    const parts = [];
    if (aggregate) parts.push(aggregate);
    if (sourceLine) parts.push(sourceLine);
    if (newsFallback) parts.push(newsFallback);
    return {
      type:       'g2_reviews',
      competitor: name,
      data:       parts.length
        ? `${parts.join('\n\n')}\n\nCould not extract individual review text (G2 page may be JS-rendered or blocked).`
        : `Could not extract G2 reviews for ${name}.`,
    };
  }

  const lines = [];
  if (aggregate) lines.push(aggregate, '');
  if (sourceLine) lines.push(sourceLine, '');

  reviews.forEach((r, i) => {
    lines.push(`Review ${i + 1} (${r.rating ? `${r.rating}/5` : 'unrated'}):`);
    if (r.title) lines.push(`  Title: ${r.title}`);
    if (r.liked) lines.push(`  Liked: ${r.liked}`);
    if (r.disliked) lines.push(`  Disliked: ${r.disliked}`);
    if (r.body && !r.liked) lines.push(`  Text: ${r.body}`);
    lines.push('');
  });

  if (newsFallback && !lines.some((l) => l.includes('RSS fallback'))) {
    lines.push(newsFallback);
  }

  return {
    type:       'g2_reviews',
    competitor: name,
    data:       lines.join('\n').trim(),
  };
}
