/**
 * Collector: Job Postings Monitor
 * ─────────────────────────────────
 * Tries hosted ATS JSON APIs (Greenhouse, Lever, Ashby) when detectable,
 * then falls back to HTML heuristics on the careers page,
 * then Google News RSS for hiring / job-site signals.
 * Premium (APIFY_API_TOKEN): tugelbay/article-extractor on ATS job posting URLs.
 */

import { extractDomain } from './_utils.js';
import { APIFY_ACTORS, getApifyClient, isApifyEnabled, runActorDataset, clipText } from './_apify.js';

const FETCH_TIMEOUT = 10000;
const MAX_JOBS = 15;

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** @returns {{ titles: string[], entries: { title: string, url: string | null }[] } | null} */
async function fetchGreenhouseJobs(token) {
  const data = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`);
  if (!data?.jobs?.length) return null;
  const slice = data.jobs.slice(0, MAX_JOBS);
  const entries = slice
    .map((j) => ({
      title: j.title,
      url: j.absolute_url || j.absoluteUrl || null,
    }))
    .filter((e) => e.title);
  const titles = entries.map((e) => e.title);
  return titles.length ? { titles, entries } : null;
}

/** @returns {{ titles: string[], entries: { title: string, url: string | null }[] } | null} */
async function fetchLeverJobs(site) {
  const data = await fetchJson(`https://api.lever.co/v0/postings/${encodeURIComponent(site)}?mode=json`);
  if (!Array.isArray(data) || !data.length) return null;
  const slice = data.slice(0, MAX_JOBS);
  const entries = slice
    .map((p) => ({
      title: p.text || p.title,
      url: p.hostedUrl || p.urls?.show || null,
    }))
    .filter((e) => e.title);
  const titles = entries.map((e) => e.title);
  return titles.length ? { titles, entries } : null;
}

/** @returns {{ titles: string[], entries: { title: string, url: string | null }[] } | null} */
async function fetchAshbyJobs(org) {
  const data = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}`);
  const jobs = data?.jobs || data?.data?.jobs || [];
  if (!Array.isArray(jobs) || !jobs.length) return null;
  const slice = jobs.slice(0, MAX_JOBS);
  const entries = slice
    .map((j) => ({
      title: j.title || j.name,
      url:
        j.jobPostingUrl ||
        j.applyUrl ||
        j.publicPostingUrl ||
        j.canonicalUrl ||
        j.link ||
        null,
    }))
    .filter((e) => e.title);
  const titles = entries.map((e) => e.title);
  return titles.length ? { titles, entries } : null;
}

async function fetchAtsJobs(provider, token) {
  if (!token) return null;
  switch (provider) {
    case 'greenhouse':
      return fetchGreenhouseJobs(token);
    case 'lever':
      return fetchLeverJobs(token);
    case 'ashby':
      return fetchAshbyJobs(token);
    default:
      return null;
  }
}

const ATS_RETRY_DELAY_MS = 2000;

/** One retry after delay when ATS JSON is flaky (timeouts, empty responses). */
async function fetchAtsJobsWithRetry(provider, token) {
  let pack = await fetchAtsJobs(provider, token);
  if (pack?.titles?.length) return pack;
  await new Promise((r) => setTimeout(r, ATS_RETRY_DELAY_MS));
  pack = await fetchAtsJobs(provider, token);
  return pack?.titles?.length ? pack : null;
}

/**
 * Detect ATS provider + board token from careers page HTML.
 */
function detectAtsFromHtml(html) {
  if (!html) return null;

  const ghEmbed = html.match(/boards\.greenhouse\.io\/embed\/job_board\?for=([a-z0-9_-]+)/i);
  if (ghEmbed) return { provider: 'greenhouse', token: ghEmbed[1] };

  const ghPath = html.match(/boards\.greenhouse\.io\/([a-z0-9_-]+)\/?(?:["'\s>]|$)/i);
  if (ghPath && ghPath[1] !== 'embed') return { provider: 'greenhouse', token: ghPath[1] };

  const ghApi = html.match(/boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)\//i);
  if (ghApi) return { provider: 'greenhouse', token: ghApi[1] };

  const lever = html.match(/jobs\.lever\.co\/([a-z0-9_-]+)/i) || html.match(/api\.lever\.co\/v0\/postings\/([a-z0-9_-]+)/i);
  if (lever) return { provider: 'lever', token: lever[1] };

  const ashby = html.match(/jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i) || html.match(/api\.ashbyhq\.com\/posting-api\/job-board\/([a-z0-9_-]+)/i);
  if (ashby) return { provider: 'ashby', token: ashby[1] };

  return null;
}

/** If user set atsSlug only, try APIs in likely order. Skip a provider already tried (e.g. configured ATS empty). */
async function tryAtsSlugAcrossProviders(slug, skipProvider = null) {
  const order = [
    ['greenhouse', slug],
    ['lever', slug],
    ['ashby', slug],
  ];
  for (const [provider, token] of order) {
    if (skipProvider && provider === skipProvider) continue;
    const pack = await fetchAtsJobsWithRetry(provider, token);
    if (pack?.titles?.length) return { ...pack, provider, token };
  }
  return null;
}

/** RSS job headlines must name the competitor or its domain (drops unrelated Greenhouse noise). */
function jobsRssTitleMatchesCompetitor(title, competitorName, domain) {
  const t = title.toLowerCase();
  const n = (competitorName || '').toLowerCase().trim();
  if (n && t.includes(n)) return true;
  if (domain) {
    const d = domain.toLowerCase();
    if (t.includes(d)) return true;
    const short = d.replace(/\.(com|io|ai|co)$/i, '');
    if (short.length >= 3 && t.includes(short)) return true;
  }
  return false;
}

/** When structured ATS + careers scrape fail: surface hiring signals from Google News RSS. */
async function fetchGoogleJobsRssFallback(name, website) {
  const domain = extractDomain(website);
  const scope =
    '(site:linkedin.com/jobs OR site:greenhouse.io OR site:lever.co OR site:jobs.ashbyhq.com OR site:boards.greenhouse.io)';
  const q = encodeURIComponent(`"${name}" jobs ${scope}${domain ? ` ${domain}` : ''}`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IntelligenceBot/1.0)' },
    });
    if (!res.ok) return null;
    const xml = await res.text();
    const lines = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && lines.length < 12) {
      const block = match[1];
      const title = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(block) || /<title>(.*?)<\/title>/.exec(block))?.[1]?.trim() || '';
      if (!title || title.toLowerCase().includes('google news')) continue;
      if (!jobsRssTitleMatchesCompetitor(title, name, domain)) continue;
      lines.push(`- ${title}`);
    }
    return lines.length ? lines : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Fetch and parse careers page ─────────────────────────────────────────────
async function fetchCareersPage(website) {
  const careerUrls = [
    website.replace(/\/$/, '') + '/careers',
    website.replace(/\/$/, '') + '/jobs',
    website.replace(/\/$/, '') + '/about/careers',
    website.replace(/\/$/, '') + '/company/careers',
  ];

  for (const url of careerUrls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IntelligenceBot/1.0)' },
        redirect: 'follow',
      });
      if (!res.ok) continue;
      const html = await res.text();
      if (html.length < 500) continue;
      return { url, html };
    } catch {
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// ── Extract job titles from careers page HTML ─────────────────────────────────
function extractJobTitles(html) {
  if (!html) return [];

  const titles = new Set();

  const patterns = [
    /<h[23][^>]*class="[^"]*job[^"]*"[^>]*>([\s\S]{5,80}?)<\/h[23]>/gi,
    /<a[^>]*class="[^"]*job[^"]*"[^>]*>([\s\S]{5,80}?)<\/a>/gi,
    /<div[^>]*class="[^"]*position[^"]*"[^>]*>([\s\S]{5,80}?)<\/div>/gi,
    /<li[^>]*class="[^"]*job[^"]*"[^>]*>([\s\S]{5,80}?)<\/li>/gi,
    /<span[^>]*class="[^"]*job-title[^"]*"[^>]*>([\s\S]{5,80}?)<\/span>/gi,
    /data-job-title="([^"]{5,80})"/gi,
  ];

  for (const pattern of patterns) {
    let match;
    const regex = new RegExp(pattern.source, pattern.flags);
    while ((match = regex.exec(html)) !== null) {
      const title = match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (title.length > 4 && title.length < 80 && /[a-zA-Z]/.test(title)) {
        titles.add(title);
      }
      if (titles.size >= MAX_JOBS) break;
    }
  }

  return [...titles].slice(0, MAX_JOBS);
}

// ── Categorise job titles into strategic signals ──────────────────────────────
function categoriseJobs(titles) {
  const categories = {
    ai_ml:        [],
    enterprise:   [],
    product:      [],
    engineering:  [],
    sales:        [],
    marketing:    [],
    other:        [],
  };

  for (const title of titles) {
    const lower = title.toLowerCase();
    if (lower.match(/\b(ai|ml|machine learning|llm|nlp|data scientist|artificial intelligence)\b/)) {
      categories.ai_ml.push(title);
    } else if (lower.match(/\b(enterprise|strategic|key account|major account)\b/)) {
      categories.enterprise.push(title);
    } else if (lower.match(/\b(product manager|product director|head of product|vp product)\b/)) {
      categories.product.push(title);
    } else if (lower.match(/\b(engineer|developer|architect|devops|sre|backend|frontend|fullstack)\b/)) {
      categories.engineering.push(title);
    } else if (lower.match(/\b(account executive|sdr|bdr|sales development|sales manager|vp sales)\b/)) {
      categories.sales.push(title);
    } else if (lower.match(/\b(marketing|growth|demand gen|content|seo|brand)\b/)) {
      categories.marketing.push(title);
    } else {
      categories.other.push(title);
    }
  }

  return categories;
}

// ── Interpret job signals strategically ──────────────────────────────────────
function interpretSignals(categories, competitorName) {
  const signals = [];

  if (categories.ai_ml.length >= 2) {
    signals.push(`${competitorName} is heavily investing in AI/ML (${categories.ai_ml.length} open roles: ${categories.ai_ml.slice(0, 3).join(', ')}). Expect AI feature announcements in the next 2-3 quarters.`);
  }

  if (categories.enterprise.length >= 2) {
    signals.push(`${competitorName} is expanding enterprise sales motion (${categories.enterprise.length} enterprise roles). They are likely moving upmarket — a threat to larger shared accounts.`);
  }

  if (categories.sales.length >= 3) {
    signals.push(`${competitorName} is aggressively building sales headcount (${categories.sales.length} sales roles). They are likely entering a growth push — expect increased competitive encounters.`);
  }

  if (categories.product.length >= 2) {
    signals.push(`${competitorName} is adding product management capacity (${categories.product.length} PM roles), suggesting new product lines or major feature work in development.`);
  }

  if (categories.ai_ml.length === 0 && categories.engineering.length < 2) {
    signals.push(`${competitorName} has minimal engineering/AI hiring visible — possible product investment slowdown or headcount freeze.`);
  }

  return signals;
}

/** Max posting URLs to send to Apify article-extractor per competitor. */
const MAX_JD_ENRICH_URLS = 12;

/** Pull JD text for up to N ATS posting URLs via Apify. */
async function enrichJobDescriptionsWithApify(entries) {
  if (!isApifyEnabled() || !entries?.length) return '';
  const client = getApifyClient();
  if (!client) return '';

  const withUrl = entries.filter((e) => e.url).slice(0, MAX_JD_ENRICH_URLS);
  if (!withUrl.length) return '';

  try {
    const { items } = await runActorDataset(
      client,
      APIFY_ACTORS.ARTICLE_EXTRACTOR,
      {
        urls: withUrl.map((e) => ({ url: e.url })),
        maxItems: withUrl.length,
        outputFormat: 'text',
        extractImages: false,
        extractLinks: false,
        timeout: 45,
        maxConcurrency: 4,
      },
      { waitSecs: 600, itemLimit: 20, injectDefaultProxy: true }
    );

    if (!items?.length) return '';

    const lines = [];
    withUrl.forEach((e, i) => {
      const row = items[i] || {};
      const blob =
        row.text ||
        row.articleText ||
        row.markdown ||
        row.content ||
        row.body ||
        '';
      if (blob) {
        lines.push(`• ${e.title}\n  ${clipText(String(blob), 800)}`);
      }
    });

    if (!lines.length) return '';
    return [
      '',
      `Job description excerpts (Apify ${APIFY_ACTORS.ARTICLE_EXTRACTOR}, first-party posting pages):`,
      ...lines,
    ].join('\n');
  } catch {
    return '';
  }
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function collectJobs(competitor) {
  const { name, website, atsSlug, atsProvider } = competitor;

  if (!website && !atsSlug) {
    return { type: 'jobs', competitor: name, data: 'No website URL or atsSlug configured.' };
  }

  let titles = [];
  let jobEntries = [];
  let sourceNote = '';

  if (atsProvider && atsSlug) {
    const pack = await fetchAtsJobsWithRetry(atsProvider, atsSlug);
    if (pack?.titles?.length) {
      titles = pack.titles;
      jobEntries = pack.entries || [];
      sourceNote = `ATS: ${atsProvider} (board: ${atsSlug})`;
    }
  }

  /* Cross-provider fallback: e.g. Lever flaky empty but Greenhouse same slug works, or wrong atsProvider in config. */
  if (!titles.length && atsSlug) {
    const tried = await tryAtsSlugAcrossProviders(atsSlug, atsProvider || null);
    if (tried) {
      titles = tried.titles;
      jobEntries = tried.entries || [];
      sourceNote = atsProvider
        ? `ATS: ${tried.provider} (board: ${tried.token}; cross-provider fallback — ${atsProvider} had no listings)`
        : `ATS: ${tried.provider} (board: ${tried.token})`;
    }
  }

  const result = website ? await fetchCareersPage(website) : null;

  if (!titles.length && result?.html) {
    const det = detectAtsFromHtml(result.html);
    if (det) {
      const pack = await fetchAtsJobsWithRetry(det.provider, det.token);
      if (pack?.titles?.length) {
        titles = pack.titles;
        jobEntries = pack.entries || [];
        sourceNote = `ATS: ${det.provider} (auto-detected board: ${det.token})`;
      }
    }
  }

  if (!titles.length && result?.html) {
    titles = extractJobTitles(result.html);
    if (titles.length) {
      sourceNote = 'HTML scrape';
      jobEntries = [];
    }
  }

  if (!titles.length && !result) {
    const rss = website ? await fetchGoogleJobsRssFallback(name, website) : null;
    if (rss?.length) {
      return {
        type:       'jobs',
        competitor: name,
        data:       [
          `Could not access careers page for ${name}.`,
          'Hiring / job-site signals (Google News RSS fallback — not verified ATS):',
          ...rss,
          '',
          'Tip: set atsProvider + atsSlug in config when known (Greenhouse, Lever, or Ashby).',
        ].join('\n'),
      };
    }
    return {
      type:       'jobs',
      competitor: name,
      data:       `Could not access careers page for ${name}. Set optional atsSlug + atsProvider in the client config if jobs are on Greenhouse/Lever/Ashby.`,
    };
  }

  if (!titles.length) {
    const rss = website ? await fetchGoogleJobsRssFallback(name, website) : null;
    if (rss?.length) {
      return {
        type:       'jobs',
        competitor: name,
        data:       [
          `Careers page: ${result?.url || 'n/a'}`,
          'No structured job titles from ATS or HTML; hiring-related headlines (RSS fallback):',
          ...rss,
          '',
          'Add accurate "atsSlug" + "atsProvider" (greenhouse|lever|ashby) for this competitor if known.',
        ].join('\n'),
      };
    }
    return {
      type:       'jobs',
      competitor: name,
      data:       `Careers page found at ${result?.url || 'n/a'} but no job titles could be extracted. Add "atsSlug" + "atsProvider" (greenhouse|lever|ashby) to this competitor in config.`,
    };
  }

  const categories = categoriseJobs(titles);
  const signals    = interpretSignals(categories, name);

  const lines = [];
  if (result?.url) lines.push(`Careers page: ${result.url}`);
  if (sourceNote) lines.push(`Source: ${sourceNote}`);
  lines.push(`Total visible roles: ${titles.length}`, '');

  if (categories.ai_ml.length)      lines.push(`AI/ML roles (${categories.ai_ml.length}): ${categories.ai_ml.join(', ')}`);
  if (categories.enterprise.length) lines.push(`Enterprise roles (${categories.enterprise.length}): ${categories.enterprise.join(', ')}`);
  if (categories.sales.length)      lines.push(`Sales roles (${categories.sales.length}): ${categories.sales.join(', ')}`);
  if (categories.product.length)    lines.push(`Product roles (${categories.product.length}): ${categories.product.join(', ')}`);
  if (categories.engineering.length)lines.push(`Engineering roles (${categories.engineering.length}): ${categories.engineering.slice(0, 5).join(', ')}`);
  if (categories.marketing.length)  lines.push(`Marketing roles (${categories.marketing.length}): ${categories.marketing.join(', ')}`);
  if (categories.other.length)      lines.push(`Other roles (${categories.other.length}): ${categories.other.slice(0, 5).join(', ')}`);

  if (signals.length) {
    lines.push('', 'Strategic signals:');
    signals.forEach((s) => lines.push(`- ${s}`));
  }

  const enriched = await enrichJobDescriptionsWithApify(jobEntries);
  if (enriched) lines.push(enriched);

  return {
    type:       'jobs',
    competitor: name,
    data:       lines.join('\n'),
  };
}
