/**
 * Collector: Job Postings Monitor
 * ─────────────────────────────────
 * Fetches recent job postings for each competitor via
 * Google News RSS (searching for their hiring announcements)
 * and direct scraping of their /careers page.
 *
 * Job postings are one of the best competitive signals:
 * - Hiring ML engineers = building AI features
 * - Hiring enterprise sales reps = moving upmarket
 * - Hiring integration engineers = expanding their ecosystem
 * - Mass layoffs in engineering = product slowdown incoming
 */

const FETCH_TIMEOUT = 10000;
const MAX_JOBS = 15;

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

  // Common patterns for job title elements
  const patterns = [
    /<h[23][^>]*class="[^"]*job[^"]*"[^>]*>([\s\S]{5,80}?)<\/h[23]>/gi,
    /<a[^>]*class="[^"]*job[^"]*"[^>]*>([\s\S]{5,80}?)<\/a>/gi,
    /<div[^>]*class="[^"]*position[^"]*"[^>]*>([\s\S]{5,80}?)<\/div>/gi,
    /<li[^>]*class="[^"]*job[^"]*"[^>]*>([\s\S]{5,80}?)<\/li>/gi,
    /<span[^>]*class="[^"]*job-title[^"]*"[^>]*>([\s\S]{5,80}?)<\/span>/gi,
    /data-job-title="([^"]{5,80})"/gi,
    /"title":"([^"]{5,80})"/g,
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

// ── Main export ───────────────────────────────────────────────────────────────
export async function collectJobs(competitor) {
  const { name, website, jobMonitoring } = competitor;

  if (!website) {
    return { type: 'jobs', competitor: name, data: 'No website URL configured.' };
  }

  const result = await fetchCareersPage(website);

  if (!result) {
    return {
      type:       'jobs',
      competitor: name,
      data:       `Could not access careers page for ${name}. They may use an external ATS (Greenhouse, Lever, Workday).`,
    };
  }

  const titles     = extractJobTitles(result.html);
  const categories = categoriseJobs(titles);
  const signals    = interpretSignals(categories, name);

  if (!titles.length) {
    return {
      type:       'jobs',
      competitor: name,
      data:       `Careers page found at ${result.url} but no job titles could be extracted.`,
    };
  }

  const lines = [`Careers page: ${result.url}`, `Total visible roles: ${titles.length}`, ''];

  if (categories.ai_ml.length)      lines.push(`AI/ML roles (${categories.ai_ml.length}): ${categories.ai_ml.join(', ')}`);
  if (categories.enterprise.length) lines.push(`Enterprise roles (${categories.enterprise.length}): ${categories.enterprise.join(', ')}`);
  if (categories.sales.length)      lines.push(`Sales roles (${categories.sales.length}): ${categories.sales.join(', ')}`);
  if (categories.product.length)    lines.push(`Product roles (${categories.product.length}): ${categories.product.join(', ')}`);
  if (categories.engineering.length)lines.push(`Engineering roles (${categories.engineering.length}): ${categories.engineering.slice(0,5).join(', ')}`);
  if (categories.marketing.length)  lines.push(`Marketing roles (${categories.marketing.length}): ${categories.marketing.join(', ')}`);
  if (categories.other.length)      lines.push(`Other roles (${categories.other.length}): ${categories.other.slice(0,5).join(', ')}`);

  if (signals.length) {
    lines.push('', 'Strategic signals:');
    signals.forEach(s => lines.push(`- ${s}`));
  }

  return {
    type:       'jobs',
    competitor: name,
    data:       lines.join('\n'),
  };
}
