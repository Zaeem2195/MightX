/**
 * Collector: LinkedIn Company Monitor
 * ─────────────────────────────────────
 * Monitors competitor LinkedIn company pages for signals:
 * - Employee count changes (growth/contraction)
 * - Recent company posts and announcements
 * - Leadership changes
 *
 * Uses Google News RSS as a proxy (searching for LinkedIn-specific announcements)
 * and the public LinkedIn company page (limited data without auth).
 *
 * For richer LinkedIn data, integrate with a provider like Proxycurl or PhantomBuster.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
    items.push({ title: title.trim(), pubDate, source: source.trim() });
  }
  return items;
}

async function fetchLinkedInNews(competitorName, linkedinSlug) {
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
      if (!seen.has(item.title)) {
        seen.add(item.title);
        try {
          if (new Date(item.pubDate) >= cutoff) allItems.push(item);
        } catch {
          allItems.push(item);
        }
      }
    }
    await new Promise(r => setTimeout(r, 600));
  }

  return allItems.slice(0, 8);
}

async function fetchLinkedInPage(linkedinSlug) {
  const url = `https://www.linkedin.com/company/${linkedinSlug}/`;
  const res = await fetchWithTimeout(url);
  if (!res.ok || !res.text) return null;

  const employeeMatch = res.text.match(/(\d[\d,]+)\s*(?:employees|associates|team members)/i);
  const descMatch = res.text.match(/<meta\s+name="description"\s+content="([^"]{20,500})"/i);
  const followersMatch = res.text.match(/([\d,]+)\s*followers/i);

  return {
    employees: employeeMatch?.[1]?.replace(/,/g, '') || null,
    description: descMatch?.[1] || null,
    followers: followersMatch?.[1]?.replace(/,/g, '') || null,
  };
}

function analyseChanges(previous, current, competitorName) {
  const signals = [];

  if (previous?.employees && current?.employees) {
    const prev = parseInt(previous.employees);
    const curr = parseInt(current.employees);
    const change = curr - prev;
    const pctChange = ((change / prev) * 100).toFixed(1);

    if (Math.abs(change) > 10 || Math.abs(parseFloat(pctChange)) > 5) {
      const direction = change > 0 ? 'grew' : 'shrank';
      signals.push(`${competitorName} headcount ${direction} by ${Math.abs(change)} employees (${pctChange}% change) since last check. Previous: ${prev}, Current: ${curr}.`);
    }
  }

  if (previous?.followers && current?.followers) {
    const prev = parseInt(previous.followers);
    const curr = parseInt(current.followers);
    const change = curr - prev;
    if (Math.abs(change) > 500) {
      const direction = change > 0 ? 'gained' : 'lost';
      signals.push(`${competitorName} ${direction} ${Math.abs(change).toLocaleString()} LinkedIn followers since last check.`);
    }
  }

  return signals;
}

export async function collectLinkedIn(clientId, competitor) {
  const { name, linkedinSlug } = competitor;

  if (!linkedinSlug) {
    return { type: 'linkedin', competitor: name, data: 'No LinkedIn slug configured.' };
  }

  const previous = loadSnapshot(clientId, name);
  const findings = [];

  const [pageData, newsItems] = await Promise.all([
    fetchLinkedInPage(linkedinSlug),
    fetchLinkedInNews(name, linkedinSlug),
  ]);

  if (pageData) {
    const changes = analyseChanges(previous, pageData, name);
    findings.push(...changes);

    saveSnapshot(clientId, name, {
      ...pageData,
      savedAt: new Date().toISOString(),
    });

    if (pageData.employees) {
      findings.push(`Current estimated headcount: ${parseInt(pageData.employees).toLocaleString()}`);
    }
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
