/**
 * Re-run only Apify-backed collectors that look blocked/failed in a saved raw-signals file,
 * merge fresh rows, then analyse + generate report (full resume after targeted collect).
 *
 * Usage:
 *   node scripts/retry-blocked-apify.js <client-id> [--dry-run] [--no-email]
 *   node scripts/retry-blocked-apify.js <client-id> path/to/raw-signals.json [--dry-run]
 *   node scripts/retry-blocked-apify.js demo-salesloft --types linkedin,glassdoor --no-email
 *
 * --dry-run     List what would be re-fetched and exit (no Apify, no report).
 * --types TYPES Comma list: linkedin, glassdoor, website, news, g2_reviews, jobs
 *               If set, only those types are considered (still filtered by shouldRetry* unless --force-all).
 * --force-all   With --types, retry every competitor for listed types (ignore block heuristics).
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { collectWebsite } from './collectors/website-monitor.js';
import { collectNews } from './collectors/news-monitor.js';
import { collectG2 } from './collectors/g2-monitor.js';
import { collectJobs } from './collectors/jobs-monitor.js';
import { collectLinkedIn } from './collectors/linkedin-monitor.js';
import { collectGlassdoor } from './collectors/glassdoor-monitor.js';
import { collectGitHub } from './collectors/github-monitor.js';
import { collectCrunchbase } from './collectors/crunchbase-monitor.js';
import { isApifyEnabled } from './collectors/_apify.js';
import { runAnalysis } from './analyse.js';
import { generateReport } from './generate-report.js';
import { generateClientDashboard } from './generate-dashboard.js';
import { deliverReport } from './deliver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const LINKEDIN_SOURCE = 'Source: Apify (artificially/linkedin-company-scraper)';
const GLASSDOOR_SOURCE = 'Source: Apify (crawlerbros/glassdoor-reviews-scraper)';

function loadClient(id) {
  const configPath = path.join(ROOT, 'config', 'clients', `${id}.json`);
  if (!fs.existsSync(configPath)) {
    console.error(`❌  Client config not found: ${configPath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function findLatestRawSignalsFile(clientId) {
  const dataDir = path.join(ROOT, 'data', clientId);
  if (!fs.existsSync(dataDir)) return null;
  const files = fs
    .readdirSync(dataDir)
    .filter((f) => f.startsWith('raw-signals-') && f.endsWith('.json'))
    .map((f) => {
      const full = path.join(dataDir, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.full ?? null;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const noEmail = args.includes('--no-email');
  const dryRun = args.includes('--dry-run');
  const forceAll = args.includes('--force-all');

  let typesFilter = null;
  const ti = args.indexOf('--types');
  if (ti !== -1 && args[ti + 1] && !args[ti + 1].startsWith('--')) {
    typesFilter = new Set(
      args[ti + 1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--no-email' || a === '--dry-run' || a === '--force-all') continue;
    if (a === '--types') {
      i++;
      continue;
    }
    if (a.startsWith('--')) continue;
    positional.push(a);
  }

  return {
    clientId: positional[0],
    rawPathArg: positional[1],
    noEmail,
    dryRun,
    typesFilter,
    forceAll,
  };
}

/** Heuristic: LinkedIn batch failed Apify or hit auth wall — worth re-crawling. */
function shouldRetryLinkedIn(data) {
  const d = (data || '').trim();
  if (!d) return true;
  if (d.includes('No LinkedIn slug configured')) return false;

  if (d.includes(LINKEDIN_SOURCE)) {
    if (/Employee count|About:|Company \(scraped\)|Tagline:/i.test(d) || d.length > 600) return false;
  }

  if (/Apify LinkedIn company scraper.*returned no usable/i.test(d)) return true;
  if (/Last Apify error:/i.test(d)) return true;
  if (/authentication wall/i.test(d)) return true;
  if (/Could not fetch LinkedIn company page/i.test(d)) return true;
  return false;
}

/** Heuristic: Glassdoor actor did not return usable reviews. */
function shouldRetryGlassdoor(data) {
  const d = data || '';
  if (/No glassdoorSlug configured/i.test(d)) return false;
  if (d.includes(GLASSDOOR_SOURCE) && /Pros:|Cons:|—\s*\d+\./i.test(d)) return false;
  if (/Glassdoor Apify run failed/i.test(d)) return true;
  if (/could not initialize Apify client/i.test(d)) return true;
  if (/skipped — set APIFY_API_TOKEN/i.test(d)) return true;
  if (/No Glassdoor reviews returned/i.test(d)) return true;
  return false;
}

function shouldRetryType(type, data, forceAll) {
  if (forceAll) return true;
  if (type === 'linkedin') return shouldRetryLinkedIn(data);
  if (type === 'glassdoor') return shouldRetryGlassdoor(data);
  return false;
}

function findCompetitor(cfg, name) {
  return (cfg.competitors || []).find((c) => c.name === name);
}

function competitorHasLinkedIn(c, additional) {
  if (!additional?.linkedin) return false;
  return Boolean(
    c.linkedinSlug ||
      (Array.isArray(c.linkedinSlugAlternates) && c.linkedinSlugAlternates.length) ||
      (Array.isArray(c.linkedinCompanyUrls) && c.linkedinCompanyUrls.length)
  );
}

async function runOneCollector(clientId, competitor, type) {
  const jm = competitor.jobMonitoring?.enabled !== false;

  switch (type) {
    case 'website':
      return collectWebsite(clientId, competitor);
    case 'news':
      return collectNews(competitor);
    case 'funding':
      return collectCrunchbase(competitor);
    case 'g2_reviews':
      return collectG2(competitor);
    case 'jobs':
      if (!jm) {
        return { type: 'jobs', competitor: competitor.name, data: 'Job monitoring disabled for this competitor or client.' };
      }
      return collectJobs(competitor);
    case 'linkedin':
      return collectLinkedIn(clientId, competitor);
    case 'glassdoor':
      return collectGlassdoor(competitor);
    case 'github':
      return collectGitHub(clientId, competitor);
    default:
      return null;
  }
}

/** Types that use Apify when token is set (for --types filtering / docs). */
const APIFY_TYPES = new Set(['website', 'news', 'g2_reviews', 'jobs', 'linkedin', 'glassdoor']);

function discoverRetries(signals, clientConfig, typesFilter, forceAll) {
  const additional = clientConfig.additionalCollectors || {};
  const retries = [];

  for (const sig of signals) {
    const { competitor: compName, type, data } = sig;
    if (!compName || !type) continue;
    if (typesFilter && !typesFilter.has(type)) continue;

    const c = findCompetitor(clientConfig, compName);
    if (!c) continue;

    if (type === 'funding' && (!additional.crunchbase || !c.crunchbaseSlug)) continue;
    if (type === 'linkedin' && !competitorHasLinkedIn(c, additional)) continue;
    if (type === 'glassdoor' && (!additional.glassdoor || !c.glassdoorSlug)) continue;
    if (type === 'github' && (!additional.github || !c.githubOrg)) continue;

    if (!APIFY_TYPES.has(type) && !typesFilter) continue;

    const need = shouldRetryType(type, data, forceAll);
    if (!need) continue;

    retries.push({
      competitorName: compName,
      type,
      reason: forceAll ? 'manual --force-all' : 'heuristic blocked / failed',
    });
  }

  return retries;
}

/** When --types and --force-all: re-fetch listed types for every competitor that has config (even if missing from raw file). */
function buildForceAllRetries(clientConfig, typesFilter) {
  const additional = clientConfig.additionalCollectors || {};
  const list = [];
  const seen = new Set();

  for (const type of typesFilter) {
    if (!APIFY_TYPES.has(type)) continue;

    for (const c of clientConfig.competitors || []) {
      const name = c.name;
      let ok = false;
      if (type === 'website' && c.website) ok = true;
      if (type === 'news' && c.website) ok = true;
      if (type === 'funding' && additional.crunchbase && c.crunchbaseSlug) ok = true;
      if (type === 'g2_reviews' && c.g2Slug) ok = true;
      if (type === 'jobs' && c.jobMonitoring?.enabled !== false && (c.website || c.atsSlug)) ok = true;
      if (type === 'linkedin' && competitorHasLinkedIn(c, additional)) ok = true;
      if (type === 'glassdoor' && additional.glassdoor && c.glassdoorSlug) ok = true;
      if (type === 'github' && additional.github && c.githubOrg) ok = true;

      if (!ok) continue;

      const k = `${name}||${type}`;
      if (seen.has(k)) continue;
      seen.add(k);
      list.push({ competitorName: name, type, reason: '--types --force-all' });
    }
  }

  return list;
}

async function main() {
  const { clientId, rawPathArg, noEmail, dryRun, typesFilter, forceAll } = parseArgs(process.argv);

  if (!clientId) {
    console.error('❌  Usage: node scripts/retry-blocked-apify.js <client-id> [raw-signals.json] [--dry-run] [--types a,b] [--force-all] [--no-email]');
    process.exit(1);
  }

  if (!isApifyEnabled()) {
    console.error('❌  APIFY_API_TOKEN is not set. This script only re-runs Apify-backed collectors.');
    process.exit(1);
  }

  const clientConfig = loadClient(clientId);
  if (!clientConfig.active) {
    console.log(`⏭️   Client inactive. Skipping.`);
    process.exit(0);
  }

  let rawPath;
  if (rawPathArg) {
    rawPath = path.isAbsolute(rawPathArg) ? rawPathArg : path.join(ROOT, rawPathArg);
    if (!fs.existsSync(rawPath)) {
      console.error(`❌  File not found: ${rawPath}`);
      process.exit(1);
    }
  } else {
    rawPath = findLatestRawSignalsFile(clientId);
    if (!rawPath) {
      console.error(`❌  No raw-signals-*.json under data/${clientId}/`);
      process.exit(1);
    }
  }

  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  const signals = raw.signals;
  if (!Array.isArray(signals)) {
    console.error('❌  Invalid raw file: expected { signals: [...] }');
    process.exit(1);
  }

  let retries = discoverRetries(signals, clientConfig, typesFilter, forceAll);
  if (typesFilter?.size && forceAll) {
    retries = buildForceAllRetries(clientConfig, typesFilter);
  }

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   RETRY BLOCKED APIFY → MERGE → REPORT       ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`\n📂  Base raw file: ${path.relative(ROOT, rawPath)}`);
  console.log(`🏢  Client: ${clientConfig.name}`);

  if (!retries.length) {
    console.log('\n✅  No matching blocked/failed Apify signals to retry (or nothing passes filters).');
    console.log('    Tip: use --types linkedin,glassdoor --force-all to re-fetch those types for all competitors.');
    process.exit(0);
  }

  console.log('\n📋  Planned re-fetches:');
  for (const r of retries) {
    console.log(`    • ${r.competitorName} / ${r.type}  (${r.reason})`);
  }

  if (dryRun) {
    console.log('\n🔬  Dry run — no collectors run.');
    process.exit(0);
  }

  const merged = signals.map((s) => ({ ...s }));
  const key = (comp, typ) => `${comp}||${typ}`;

  for (const r of retries) {
    const competitor = findCompetitor(clientConfig, r.competitorName);
    if (!competitor) continue;

    console.log(`\n  📡  Re-fetching: ${r.competitorName} / ${r.type} ...`);
    const fresh = await runOneCollector(clientId, competitor, r.type);
    if (!fresh) {
      console.log(`     ⚠️  Collector returned nothing for ${r.type}`);
      continue;
    }

    const idx = merged.findIndex((s) => s.competitor === r.competitorName && s.type === r.type);
    if (idx >= 0) {
      merged[idx] = fresh;
      console.log(`     ✅  Merged (${(fresh.data || '').length} chars)`);
    } else {
      merged.push(fresh);
      console.log(`     ✅  Appended new signal (${(fresh.data || '').length} chars)`);
    }

    await new Promise((res) => setTimeout(res, r.type === 'linkedin' ? 4500 : 500));
  }

  const dataDir = path.join(ROOT, 'data', clientId);
  fs.mkdirSync(dataDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outRaw = path.join(dataDir, `raw-signals-${timestamp}.json`);
  const collectedAt = new Date().toISOString();
  fs.writeFileSync(
    outRaw,
    JSON.stringify(
      {
        collectedAt,
        baseRawFile: path.relative(ROOT, rawPath),
        retryBlockedApify: {
          at: collectedAt,
          retried: retries.map((x) => ({ competitor: x.competitorName, type: x.type })),
        },
        signals: merged,
      },
      null,
      2
    )
  );
  console.log(`\n📁  Merged raw signals → ${path.relative(ROOT, outRaw)}`);

  console.log('\n── Analysing signals ───────────────────────────────────────────');
  const { analyses } = await runAnalysis(clientId, merged, clientConfig);

  console.log('\n── Generating & delivering report ─────────────────────────────');
  const { html, reportContent, htmlPath } = await generateReport(clientId, analyses, clientConfig);

  if (clientConfig.reportPreferences?.includeDashboard !== false) {
    const dash = generateClientDashboard(clientId);
    if (dash.ok && dash.path) {
      console.log(`📊  Dashboard → ${path.relative(ROOT, dash.path)}`);
    } else if (!dash.ok) {
      console.log(`⚠️   Dashboard: ${dash.message || 'skipped'}`);
    }
  }

  if (!noEmail) {
    try {
      await deliverReport(clientConfig, html, reportContent);
    } catch (emailErr) {
      console.error(`\n⚠️   Email delivery failed: ${emailErr.message}`);
      console.log(`    Report saved to: ${htmlPath}`);
    }
  } else {
    console.log(`\n📵  Email skipped. Report saved to: ${htmlPath}`);
  }

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║         RETRY + REPORT COMPLETE ✅           ║');
  console.log('╚══════════════════════════════════════════════╝\n');
}

main().catch((err) => {
  console.error('\n❌  Fatal error:', err.message);
  process.exit(1);
});
