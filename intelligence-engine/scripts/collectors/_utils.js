/**
 * Shared helpers for intelligence collectors and analysis.
 */

/** Extract hostname without www. */
export function extractDomain(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Full hostname only (e.g. outreach.io, clari.com).
 * Do not match the bare label word: "outreach" appears in civic "public outreach"
 * and "Lacombe Outreach School"; "clari" appears inside "Clariteens".
 * Brand mentions without the domain are handled later (B2B signals, Outreach.io, etc.).
 */
function domainMentionedInText(domain, text) {
  if (!domain || !text) return false;
  return text.toLowerCase().includes(domain.toLowerCase());
}

/**
 * Build disambiguated Google News queries for general news.
 * Prioritizes newsKeywords; adds domain-scoped query from website.
 */
export function buildNewsSearchQueries(competitor) {
  const { name, website, newsKeywords = [] } = competitor;
  const domain = extractDomain(website);
  const queries = [];

  for (const kw of newsKeywords.slice(0, 4)) {
    if (kw?.trim()) queries.push(kw.trim());
  }

  if (domain) {
    queries.push(`"${name}" site:${domain} OR "${name}" (${domain})`);
  } else {
    queries.push(`"${name}" software OR "${name}" SaaS OR "${name}" platform`);
  }

  if (queries.length === 0) {
    queries.push(`"${name}" B2B OR "${name}" enterprise`);
  }

  return [...new Set(queries)].slice(0, 5);
}

/**
 * Build funding/corporate search queries with domain disambiguation.
 */
export function buildFundingSearchQueries(competitor) {
  const { name, website, newsKeywords = [] } = competitor;
  const domain = extractDomain(website);
  const base = domain
    ? `"${name}" (${domain})`
    : `"${name}"`;

  return [
    `${base} funding OR raised OR series`,
    `${base} acquisition OR acquired OR merger`,
    `${base} partnership OR integration OR "partners with"`,
    `${base} layoffs OR restructuring OR "job cuts"`,
    ...newsKeywords.slice(0, 2).map((kw) => `${kw} funding OR acquisition`),
  ].slice(0, 6);
}

const B2B_SIGNALS =
  /\b(saas|software|b2b|enterprise|revenue|sales|crm|platform|cloud|funding|series|acquisition|ipo|layoff|ceo|cfo|product launch|pricing|apollo\.io|outreach\.io|gong\.io|clari\.com|salesloft|demand gen|gartner)\b/i;

/** Civic / generic news patterns that collide with short brand names (outreach, gong, clari, apollo). */
const GENERIC_NOISE =
  /community outreach|public outreach|public outreach for|enterprise client outreach|outreach school|lacombe outreach|principal of.*outreach|investor outreach|graphite one|secures funding and expands|expands investor outreach|expands[^\n.,]{0,50}outreach|buys[^\n]{0,120}outreach|for enterprise client outreach|early childhood.*outreach|outreach center|outreach team|easter outreach|highway outreach|police outreach|homeless outreach|charity outreach|campaign outreach|lamat.*outreach|media outreach newswire|outreach for|targeted outreach|admissions.*outreach|jewish outreach|reading outreach|extension and outreach|outreach week|harvard.*outreach|schools.*outreach|gong show|falun gong|gong cha|gong yoo|elder gerrit|betty jean gong|gong lum|clariteens|skincare brand for children|science-led skincare|bubble tea|apollo cbd|cbd gummies|atlantic aviation|apollo tubes|apl apollo|apollo tyres|apollo hospitals|apollo global management|apollo global(?!\s+io)|nhl |hockey |obituar|britannica|church news/i;

/**
 * Post-fetch filter: drop obvious false positives for competitor news.
 * @param {{ title?: string, description?: string }} article
 * @param {{ name?: string, website?: string }} competitor
 * @param {{ strictFunding?: boolean }} [options] — Stricter title vs description checks for funding RSS.
 */
export function isRelevantArticle(article, competitor, options = {}) {
  const strictFunding = options.strictFunding === true;
  const { name, website } = competitor;
  const domain = extractDomain(website);
  const titleRaw = article.title || '';
  const title = titleRaw.toLowerCase();
  const desc = (article.description || '').toLowerCase();
  const blob = `${title} ${desc}`;
  const nameLower = (name || '').toLowerCase().trim();

  if (!nameLower) return true;

  const domainShort = domain ? domain.split('.')[0] : '';

  if (domain && domainMentionedInText(domain, blob)) {
    return true;
  }

  /* Noise in title: drop unless the title itself names the real company domain / brand TLD.
     (Do not use B2B-in-blob as rescue — words like "funding" appear in civic outreach stories.) */
  if (GENERIC_NOISE.test(titleRaw)) {
    const t = titleRaw.toLowerCase();
    if (domain && domainMentionedInText(domain, titleRaw)) return true;
    if (nameLower && (t.includes(`${nameLower}.io`) || t.includes(`${nameLower}.com`) || t.includes(`${nameLower}.ai`))) {
      return true;
    }
    return false;
  }

  if (nameLower === 'clari' && /\bclariteens\b/i.test(blob)) {
    return false;
  }

  if (strictFunding) {
    const domainInTitle = domain && domainMentionedInText(domain, titleRaw);
    const brandTldInTitle =
      title.includes(`${nameLower}.io`) ||
      title.includes(`${nameLower}.com`) ||
      title.includes(`${nameLower}.ai`);
    const b2bInTitle = B2B_SIGNALS.test(titleRaw);
    const nameInTitle = title.includes(nameLower);
    if (desc.includes(nameLower) && !nameInTitle && !domainInTitle && !brandTldInTitle && !b2bInTitle) {
      return false;
    }
  }

  const brandInTitle =
    title.includes(`${nameLower}.io`) ||
    title.includes(`${nameLower}.com`) ||
    (domainShort &&
      domain &&
      new RegExp(`\\b${escapeRegExp(domainShort)}\\b`, 'i').test(titleRaw) &&
      B2B_SIGNALS.test(blob));

  if (brandInTitle) return true;

  if (blob.includes(nameLower) && B2B_SIGNALS.test(blob)) {
    return true;
  }

  if (nameLower === 'outreach' && /\boutreach\b/i.test(blob) && !/\boutreach\.?io|sales engagement|salesloft|g2|saas\b/i.test(blob)) {
    return false;
  }

  if (nameLower === 'gong' && /\bgong\b/i.test(blob) && !/\bgong\.?io|revenue intelligence|conversation intelligence|saas\b/i.test(blob)) {
    return false;
  }

  if (nameLower === 'clari' && /\bclari\b/i.test(blob) && !/\bclari\.?com|revenue|forecast|saas|salesloft\b/i.test(blob)) {
    return false;
  }

  if (
    (nameLower.includes('apollo') || nameLower === 'apollo.io') &&
    /\bapollo\b/i.test(blob)
  ) {
    const strongApollo =
      /\bapollo\.?io\b/i.test(blob) ||
      /\bapollo\s+(?:sales|platform|labs|data|intelligence|acquires|raises|unicorn|CEO|founder|GTM|go-to-market)\b/i.test(blob) ||
      /\b(lead intelligence|sales intelligence|GTM operating|demand gen).{0,80}apollo|apollo.{0,80}(lead intelligence|sales intelligence|GTM|acquires|raises)\b/i.test(blob);
    if (!strongApollo) return false;
  }

  if (blob.includes(nameLower)) return true;

  const primary = nameLower.replace(/\.(io|com|ai|co)$/i, '').trim();
  if (primary.length > 2 && blob.includes(primary) && B2B_SIGNALS.test(blob)) {
    return true;
  }

  return false;
}

/**
 * LinkedIn / auth pages often block unauthenticated scrapers.
 */
export function detectLoginWall(html) {
  if (!html || html.length < 800) return true;
  const h = html.toLowerCase();
  if (h.includes('authwall')) return true;
  if (h.includes('join linkedin') && h.includes('sign in')) return true;
  if (h.includes('challenge') && h.includes('linkedin') && h.includes('security check')) return true;
  // Interstitial login with almost no org content
  if (h.includes('sign in to') && h.includes('linkedin') && !h.match(/\d[\d,]*\s*employees/)) return true;
  return false;
}

/**
 * Strip markdown fences and try JSON.parse; basic repair for truncated output.
 */
/**
 * Best-effort: pull first top-level `{ ... }` substring (handles leading prose).
 */
function extractFirstJsonObject(s) {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === '\\' && inStr) {
      esc = true;
      continue;
    }
    if (ch === '"' && !esc) {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export function tryParseJSON(text) {
  let s = (text || '').trim();
  s = s.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  const attempts = [s];
  const extracted = extractFirstJsonObject(s);
  if (extracted && extracted !== s) attempts.push(extracted);

  for (const chunk of attempts) {
    try {
      return { ok: true, value: JSON.parse(chunk) };
    } catch {
      let repaired = chunk.replace(/,(\s*[}\]])/g, '$1');
      try {
        return { ok: true, value: JSON.parse(repaired) };
      } catch {
        const lastBrace = repaired.lastIndexOf('}');
        if (lastBrace > 10) {
          const slice = repaired.slice(0, lastBrace + 1);
          try {
            return { ok: true, value: JSON.parse(slice) };
          } catch {
            /* next */
          }
        }
      }
    }
  }

  const err = new Error('Invalid JSON');
  return { ok: false, error: err };
}
