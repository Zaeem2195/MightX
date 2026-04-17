/**
 * Collector: SEC EDGAR 8-K Filings Monitor
 * ─────────────────────────────────────────
 * For public-company competitors, 8-K filings are the legal requirement to
 * disclose material events within 4 business days. This is an unimpeachable,
 * zero-cost signal source that Google News RSS will surface late or miss.
 *
 * APIs used (all free, no auth; require descriptive User-Agent):
 * - Submissions:      https://data.sec.gov/submissions/CIK{10-digit-pad}.json
 * - Ticker -> CIK:    https://www.sec.gov/files/company_tickers.json
 *
 * SEC rate limit: 10 req/sec. We stay well under that.
 *
 * Only runs for competitors configured with secCik or secTicker. For private
 * competitors this collector is skipped by run-client.js.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

const FETCH_TIMEOUT_MS = 12000;
const LOOKBACK_DAYS = 30;
const MAX_FILINGS_REPORTED = 10;
const TICKER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function userAgent() {
  const from = process.env.SEC_EDGAR_USER_AGENT?.trim();
  if (from) return from;
  return 'MightX Intelligence Engine (competitive-intel@mightx.local)';
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': userAgent(),
        Accept: 'application/json',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function cacheDir() {
  const dir = path.join(ROOT, 'data', '_cache');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function tickerCachePath() {
  return path.join(cacheDir(), 'sec-company-tickers.json');
}

function snapshotStatePath(clientId, competitorName) {
  const dir = path.join(ROOT, 'data', clientId, 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const slug = competitorName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  return path.join(dir, `${slug}-sec-filings.json`);
}

function loadState(clientId, competitorName) {
  const p = snapshotStatePath(clientId, competitorName);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(clientId, competitorName, data) {
  fs.writeFileSync(snapshotStatePath(clientId, competitorName), JSON.stringify(data, null, 2));
}

function pad10(cik) {
  const n = String(cik).replace(/[^0-9]/g, '');
  return n.padStart(10, '0');
}

async function loadTickerMap() {
  const cachePath = tickerCachePath();
  if (fs.existsSync(cachePath)) {
    try {
      const stat = fs.statSync(cachePath);
      if (Date.now() - stat.mtimeMs < TICKER_CACHE_TTL_MS) {
        return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      }
    } catch {
      /* re-fetch */
    }
  }

  try {
    const res = await fetchWithTimeout('https://www.sec.gov/files/company_tickers.json', FETCH_TIMEOUT_MS);
    if (!res.ok) return null;
    const data = await res.json();
    fs.writeFileSync(cachePath, JSON.stringify(data));
    return data;
  } catch {
    return null;
  }
}

async function resolveCikFromTicker(ticker) {
  if (!ticker) return null;
  const map = await loadTickerMap();
  if (!map) return null;
  const upper = String(ticker).toUpperCase();
  for (const row of Object.values(map)) {
    if (row?.ticker && String(row.ticker).toUpperCase() === upper) {
      return pad10(row.cik_str);
    }
  }
  return null;
}

/**
 * 8-K item code legend — keep this short. Analyst + Claude will interpret
 * item numbers much better with a reference sheet inline than without.
 */
const ITEM_LEGEND = {
  '1.01': 'Entry into a Material Definitive Agreement',
  '1.02': 'Termination of a Material Definitive Agreement',
  '1.03': 'Bankruptcy or Receivership',
  '2.01': 'Completion of Acquisition or Disposition of Assets',
  '2.02': 'Results of Operations and Financial Condition',
  '2.03': 'Creation of a Material Financial Obligation',
  '2.04': 'Triggering Events That Accelerate a Financial Obligation',
  '2.05': 'Costs Associated with Exit or Disposal Activities',
  '2.06': 'Material Impairments',
  '3.01': 'Notice of Delisting or Transfer of Listing',
  '3.02': 'Unregistered Sales of Equity Securities',
  '3.03': 'Material Modification to Rights of Security Holders',
  '4.01': 'Changes in Registrant Certifying Accountant',
  '4.02': 'Non-Reliance on Previously Issued Financial Statements',
  '5.01': 'Changes in Control of Registrant',
  '5.02': 'Departure / Appointment of Directors or Officers',
  '5.03': 'Amendments to Articles / Bylaws',
  '5.07': 'Submission of Matters to a Vote of Security Holders',
  '7.01': 'Regulation FD Disclosure',
  '8.01': 'Other Events (material to investors)',
  '9.01': 'Financial Statements and Exhibits',
};

function parseItemCodes(itemsStr) {
  if (!itemsStr) return [];
  return String(itemsStr)
    .split(',')
    .map((s) => s.trim().replace(/^item\s*/i, ''))
    .filter(Boolean);
}

function describeItems(items) {
  if (!items.length) return '(no item codes reported)';
  return items
    .map((code) => {
      const desc = ITEM_LEGEND[code];
      return desc ? `${code} (${desc})` : code;
    })
    .join('; ');
}

function daysAgo(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  const diff = Date.now() - d.getTime();
  return Math.floor(diff / (24 * 60 * 60 * 1000));
}

function buildAccessionUrl(cik, accessionNumberDashed, primaryDoc) {
  if (!cik || !accessionNumberDashed) return null;
  const nodash = accessionNumberDashed.replace(/-/g, '');
  const cikNoPad = String(cik).replace(/^0+/, '') || '0';
  const base = `https://www.sec.gov/Archives/edgar/data/${cikNoPad}/${nodash}`;
  return primaryDoc ? `${base}/${primaryDoc}` : `${base}/`;
}

async function fetchSubmissions(cik) {
  const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
  try {
    const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    if (!res.ok) return { ok: false, reason: `submissions_http_${res.status}` };
    const data = await res.json();
    return { ok: true, data };
  } catch {
    return { ok: false, reason: 'submissions_timeout' };
  }
}

/**
 * SEC submissions JSON stores "recent" filings as parallel column arrays.
 * Zip them into per-filing objects for easier filtering.
 */
function zipRecentFilings(submissions) {
  const recent = submissions?.filings?.recent;
  if (!recent) return [];

  const fields = [
    'accessionNumber',
    'filingDate',
    'reportDate',
    'form',
    'primaryDocument',
    'primaryDocDescription',
    'items',
  ];

  const n = recent.accessionNumber?.length || 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    const row = {};
    for (const f of fields) {
      row[f] = recent[f]?.[i] ?? null;
    }
    out.push(row);
  }
  return out;
}

function filterRelevantFilings(filings) {
  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  return filings
    .filter((f) => {
      if (!f.filingDate) return false;
      const t = new Date(f.filingDate).getTime();
      if (Number.isNaN(t)) return false;
      if (t < cutoff) return false;
      return f.form === '8-K' || f.form === '8-K/A';
    })
    .sort((a, b) => String(b.filingDate).localeCompare(String(a.filingDate)));
}

export async function collectSECFilings(clientId, competitor) {
  const { name } = competitor;

  let cik = null;
  if (competitor.secCik) {
    cik = pad10(competitor.secCik);
  } else if (competitor.secTicker) {
    cik = await resolveCikFromTicker(competitor.secTicker);
  }

  if (!cik) {
    return {
      type: 'sec_filings',
      competitor: name,
      data: `No SEC CIK configured and ticker lookup did not resolve for ${name}. Skipping SEC 8-K monitoring — this is expected for private competitors.`,
    };
  }

  const { ok, reason, data: submissions } = await fetchSubmissions(cik);
  if (!ok) {
    return {
      type: 'sec_filings',
      competitor: name,
      data: `SEC EDGAR submissions endpoint failed for CIK ${cik} (${reason}). Retry next week.`,
    };
  }

  const allFilings = zipRecentFilings(submissions);
  const recent8K = filterRelevantFilings(allFilings).slice(0, MAX_FILINGS_REPORTED);

  const state = loadState(clientId, name);
  const priorAccession = new Set(state?.lastSeenAccessions || []);
  const newThisRun = recent8K.filter((f) => f.accessionNumber && !priorAccession.has(f.accessionNumber));

  const headerLines = [
    `Source: SEC EDGAR (8-K filings) — CIK ${cik}`,
    `Registrant (per EDGAR): ${submissions?.name || name}`,
    `Ticker(s): ${(submissions?.tickers || []).join(', ') || 'n/a'}`,
    `Lookback window: last ${LOOKBACK_DAYS} days`,
    '',
  ];

  if (!recent8K.length) {
    saveState(clientId, name, {
      cik,
      lastRunAt: new Date().toISOString(),
      lastSeenAccessions: [],
    });
    return {
      type: 'sec_filings',
      competitor: name,
      data: [...headerLines, `No 8-K filings in the last ${LOOKBACK_DAYS} days.`].join('\n'),
    };
  }

  const lines = [...headerLines, `Found ${recent8K.length} 8-K filing(s) in the window:`, ''];

  for (const f of recent8K) {
    const items = parseItemCodes(f.items);
    const description = describeItems(items);
    const ageDays = daysAgo(f.filingDate);
    const ageLabel = ageDays == null ? '' : ` (${ageDays} day${ageDays === 1 ? '' : 's'} ago)`;
    const link = buildAccessionUrl(cik, f.accessionNumber, f.primaryDocument);
    const isNew = f.accessionNumber && !priorAccession.has(f.accessionNumber);

    lines.push(`— ${f.form} filed ${f.filingDate}${ageLabel}${isNew ? ' [NEW since last run]' : ''}`);
    lines.push(`  Items: ${description}`);
    if (f.primaryDocDescription) lines.push(`  Doc: ${f.primaryDocDescription}`);
    if (link) lines.push(`  Link: ${link}`);
    lines.push('');
  }

  if (newThisRun.length && priorAccession.size > 0) {
    lines.push(`Net new 8-K filings since last collector run: ${newThisRun.length}.`);
  }

  saveState(clientId, name, {
    cik,
    lastRunAt: new Date().toISOString(),
    lastSeenAccessions: recent8K.map((f) => f.accessionNumber).filter(Boolean),
  });

  return {
    type: 'sec_filings',
    competitor: name,
    data: lines.join('\n').trim(),
  };
}
