/**
 * Collector: LinkedIn Company Monitor
 * ─────────────────────────────────────
 * Free: raw company page fetch + Google News (often auth-walled).
 * Premium (APIFY_API_TOKEN): artificially/linkedin-company-scraper; optional posts actor.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectLoginWall, isRelevantArticle } from './_utils.js';
import { APIFY_ACTORS, getApifyClient, isApifyEnabled, runActorDataset, clipText } from './_apify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

const FETCH_TIMEOUT = 12000;

async function fetchWithTimeout(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...headers,
      },
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch {
    return { ok: false, status: 0, text: '' };
  } finally {
    clearTimeout(timer);
  }
}

function snapshotPath(clientId, competitorName) {
  const dir = path.join(ROOT, 'data', clientId, 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const slug = competitorName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  return path.join(dir, `${slug}-linkedin.json`);
}

function loadSnapshot(clientId, competitorName) {
  const p = snapshotPath(clientId, competitorName);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveSnapshot(clientId, competitorName, data) {
  fs.writeFileSync(snapshotPath(clientId, competitorName), JSON.stringify(data, null, 2));
}

function parseRSSItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(block) || /<title>(.*?)<\/title>/.exec(block))?.[1] || '';
    const pubDate = (/<pubDate>(.*?)<\/pubDate>/.exec(block))?.[1] || '';
    const source = (/<source[^>]*>(.*?)<\/source>/.exec(block))?.[1] || '';
    const desc = (/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/.exec(block) || /<description>([\s\S]*?)<\/description>/.exec(block))?.[1] || '';
    const cleanDesc = desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
    items.push({ title: title.trim(), pubDate, source: source.trim(), description: cleanDesc });
  }
  return items;
}

async function fetchLinkedInNews(competitor) {
  const competitorName = competitor.name;
  const queries = [
    `"${competitorName}" linkedin announcement`,
    `"${competitorName}" hiring OR layoffs OR "new hire"`,
    `"${competitorName}" "joined as" OR "appointed" OR "promoted"`,
  ];

  const allItems = [];
  const seen = new Set();
  const cutoff = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

  for (const q of queries) {
    const encoded = encodeURIComponent(q);
    const url = `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) continue;

    const items = parseRSSItems(res.text);
    for (const item of items) {
      if (!seen.has(item.title) && isRelevantArticle(item, competitor)) {
        seen.add(item.title);
        try {
          if (new Date(item.pubDate) >= cutoff) allItems.push(item);
        } catch {
          allItems.push(item);
        }
      }
    }
    await new Promise((r) => setTimeout(r, 600));
  }

  return allItems.slice(0, 8);
}

/** Third-party hint when LinkedIn HTML is an auth wall — search snippets often quote headcount. */
async function fetchHeadcountHintFromGoogle(name, linkedinSlug) {
  const q = encodeURIComponent(
    linkedinSlug
      ? `"${name}" site:linkedin.com/company/${linkedinSlug} employees`
      : `"${name}" linkedin company employees`
  );
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) return null;

  const items = parseRSSItems(res.text);
  const blob = items.map((i) => `${i.title} ${i.description}`).join(' ');
  const m = blob.match(/([\d,]+)\s*\+?\s*employees/i) || blob.match(/([\d,]+)\s*employees on linkedin/i);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function isPlausibleHeadcount(n, range) {
  if (!Number.isFinite(n) || n < 1) return false;
  if (range && Array.isArray(range) && range.length === 2) {
    const [min, max] = range;
    return n >= min && n <= max;
  }
  if (n < 15) return false;
  if (n > 500000) return false;
  return true;
}

async function fetchLinkedInPage(linkedinSlug) {
  const url = `https://www.linkedin.com/company/${linkedinSlug}/`;
  const res = await fetchWithTimeout(url);
  if (!res.ok || !res.text) return null;

  const loginWall = detectLoginWall(res.text);
  if (loginWall) {
    return { raw: res.text, loginWall: true, employees: null, description: null, followers: null };
  }

  const employeeMatch = res.text.match(/(\d[\d,]+)\s*(?:employees|associates|team members)/i);
  const descMatch = res.text.match(/<meta\s+name="description"\s+content="([^"]{20,500})"/i);
  const followersMatch = res.text.match(/([\d,]+)\s*followers/i);

  return {
    raw: res.text,
    loginWall: false,
    employees: employeeMatch?.[1]?.replace(/,/g, '') || null,
    description: descMatch?.[1] || null,
    followers: followersMatch?.[1]?.replace(/,/g, '') || null,
  };
}

function normEmployeeDigits(s) {
  if (s == null || s === '') return null;
  const n = parseInt(String(s).replace(/,/g, ''), 10);
  return Number.isFinite(n) ? String(n) : null;
}

async function collectLinkedInApify(clientId, competitor) {
  const { name, linkedinSlug, knownHeadcountRange } = competitor;
  const client = getApifyClient();
  if (!client) return null;

  const companyUrl = `https://www.linkedin.com/company/${linkedinSlug}/`;
  const previous = loadSnapshot(clientId, name);
  const findings = [`Source: Apify (${APIFY_ACTORS.LINKEDIN_COMPANY})`, ''];

  let items;
  try {
    ({ items } = await runActorDataset(
      client,
      APIFY_ACTORS.LINKEDIN_COMPANY,
      {
        companyUrls: [companyUrl],
        includeSpecialties: true,
        includeLocations: false,
      },
      { waitSecs: 600, itemLimit: 25, injectDefaultProxy: true }
    ));
  } catch {
    return null;
  }

  const row = Array.isArray(items) && items[0] ? items[0] : null;
  if (!row) return null;

  const empRaw = row.employeeCountOnLinkedIn || row.employeeCount || row.companySize || '';
  const emp = normEmployeeDigits(empRaw);
  const fol = normEmployeeDigits(row.followerCount || row.followersCount || '');

  if (row.name || row.companyName) findings.push(`Company (scraped): ${row.name || row.companyName}`);
  if (row.tagline) findings.push(`Tagline: ${clipText(row.tagline, 240)}`);
  if (row.description) findings.push(`About: ${clipText(String(row.description), 600)}`);
  if (row.industry) findings.push(`Industry: ${row.industry}`);
  if (row.headquarters) findings.push(`Headquarters: ${row.headquarters}`);
  if (Array.isArray(row.specialties) && row.specialties.length) {
    findings.push(`Specialties: ${row.specialties.slice(0, 12).join(', ')}`);
  }
  if (emp && isPlausibleHeadcount(parseInt(emp, 10), knownHeadcountRange)) {
    findings.push(`Employee count (LinkedIn / Apify): ${parseInt(emp, 10).toLocaleString()}`);
  }
  if (fol) findings.push(`Followers (approx.): ${parseInt(fol, 10).toLocaleString()}`);

  const changes = analyseChanges(previous, { employees: emp || undefined, followers: fol || undefined }, name);
  findings.push(...changes);

  saveSnapshot(clientId, name, {
    employees: emp,
    followers: fol,
    description: row.description ? String(row.description).slice(0, 500) : null,
    loginWall: false,
    source: 'apify',
    savedAt: new Date().toISOString(),
  });

  if (process.env.APIFY_FETCH_LINKEDIN_POSTS === '1') {
    try {
      const { items: posts } = await runActorDataset(
        client,
        APIFY_ACTORS.LINKEDIN_POSTS,
        { urls: [companyUrl], maxPosts: 10 },
        { waitSecs: 600, itemLimit: 30, injectDefaultProxy: true }
      );
      if (posts?.length) {
        findings.push('', 'Recent LinkedIn company posts (Apify):');
        posts.slice(0, 8).forEach((p, i) => {
          const txt = clipText(String(p.text || p.message || p.postText || ''), 450);
          const when = p.CompanyPostedAtISO || p.postedAt || p.createdAt || '';
          if (txt) findings.push(`${i + 1}. ${when ? `[${when}] ` : ''}${txt}`);
        });
      }
    } catch {
      findings.push('(LinkedIn posts actor skipped or failed.)');
    }
  }

  const newsItems = await fetchLinkedInNews(competitor);
  if (newsItems.length) {
    findings.push('', 'Recent LinkedIn/leadership news (Google News RSS):');
    for (const item of newsItems) {
      findings.push(`- ${item.title} (${item.source || 'unknown'}, ${item.pubDate || 'recent'})`);
    }
  }

  return {
    type: 'linkedin',
    competitor: name,
    data: findings.join('\n').trim(),
  };
}

function analyseChanges(previous, current, competitorName) {
  const signals = [];

  if (previous?.employees && current?.employees) {
    const prev = parseInt(previous.employees, 10);
    const curr = parseInt(current.employees, 10);
    const change = curr - prev;
    const pctChange = ((change / prev) * 100).toFixed(1);

    if (Math.abs(change) > 10 || Math.abs(parseFloat(pctChange)) > 5) {
      const direction = change > 0 ? 'grew' : 'shrank';
      signals.push(`${competitorName} headcount ${direction} by ${Math.abs(change)} employees (${pctChange}% change) since last check. Previous: ${prev}, Current: ${curr}.`);
    }
  }

  if (previous?.followers && current?.followers) {
    const prev = parseInt(previous.followers, 10);
    const curr = parseInt(current.followers, 10);
    const change = curr - prev;
    if (Math.abs(change) > 500) {
      const direction = change > 0 ? 'gained' : 'lost';
      signals.push(`${competitorName} ${direction} ${Math.abs(change).toLocaleString()} LinkedIn followers since last check.`);
    }
  }

  return signals;
}

export async function collectLinkedIn(clientId, competitor) {
  const { name, linkedinSlug, knownHeadcountRange } = competitor;

  if (!linkedinSlug) {
    return { type: 'linkedin', competitor: name, data: 'No LinkedIn slug configured.' };
  }

  if (isApifyEnabled()) {
    const premium = await collectLinkedInApify(clientId, competitor);
    if (premium) return premium;
  }

  const previous = loadSnapshot(clientId, name);
  const findings = [];

  const [pageData, newsItems] = await Promise.all([
    fetchLinkedInPage(linkedinSlug),
    fetchLinkedInNews(competitor),
  ]);

  let employeesForSnapshot = null;
  let followersForSnapshot = null;
  let descriptionForSnapshot = null;

  if (!pageData) {
    findings.push('Could not fetch LinkedIn company page (network or block).');
  } else {
    const changes = pageData.loginWall ? [] : analyseChanges(previous, pageData, name);
    findings.push(...changes);

    let headcountLine = null;
    const parsed = pageData.employees ? parseInt(pageData.employees, 10) : null;

    if (pageData.loginWall) {
      findings.push(
        'LinkedIn returned an authentication wall — direct headcount from the company page was not reliable.'
      );
      const hint = await fetchHeadcountHintFromGoogle(name, linkedinSlug);
      if (hint && isPlausibleHeadcount(hint, knownHeadcountRange)) {
        headcountLine = `Third-party search snippet suggests ~${hint.toLocaleString()} employees (verify on LinkedIn).`;
        employeesForSnapshot = String(hint);
      }
    } else if (parsed != null) {
      if (isPlausibleHeadcount(parsed, knownHeadcountRange)) {
        headcountLine = `Current estimated headcount: ${parsed.toLocaleString()}`;
        employeesForSnapshot = pageData.employees;
      } else {
        findings.push(
          `Parsed employee count (${parsed}) looks unreliable (login wall or HTML noise). Not using as a hard number.`
        );
        const hint = await fetchHeadcountHintFromGoogle(name, linkedinSlug);
        if (hint && isPlausibleHeadcount(hint, knownHeadcountRange)) {
          headcountLine = `Third-party search snippet suggests ~${hint.toLocaleString()} employees (verify on LinkedIn).`;
          employeesForSnapshot = String(hint);
        }
      }
    }

    if (headcountLine) findings.push(headcountLine);

    followersForSnapshot = pageData.followers || null;
    descriptionForSnapshot = pageData.description || null;

    saveSnapshot(clientId, name, {
      employees: employeesForSnapshot,
      followers: followersForSnapshot,
      description: descriptionForSnapshot,
      loginWall: pageData.loginWall,
      savedAt: new Date().toISOString(),
    });
  }

  if (newsItems.length) {
    findings.push('');
    findings.push('Recent LinkedIn/leadership news:');
    for (const item of newsItems) {
      findings.push(`- ${item.title} (${item.source || 'unknown'}, ${item.pubDate || 'recent'})`);
    }
  }

  if (!findings.length) {
    return {
      type: 'linkedin',
      competitor: name,
      data: `No significant LinkedIn signals detected for ${name} this week.`,
    };
  }

  return {
    type: 'linkedin',
    competitor: name,
    data: findings.join('\n').trim(),
  };
}
