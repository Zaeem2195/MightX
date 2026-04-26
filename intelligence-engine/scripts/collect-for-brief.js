/**
 * collect-for-brief.js
 * ─────────────────────
 * Lightweight bridge between the intelligence-engine collectors and the
 * top-of-funnel vertical sample generator in `brief-app/scripts/generate-html-brief.js`.
 *
 * Runs the free, no-key-required collectors for an ad-hoc pair of competitors
 * and writes a single signals JSON file that the brief generator can consume.
 * This is what turns the static "e-learning vertical sample" artifact from a
 * Claude-memory essay into a dated, citeable mini-briefing with real URLs.
 *
 * Collectors run (free tier, no keys needed):
 *   - website-monitor          (live homepage fetch)
 *   - news-monitor             (Google News RSS)
 *   - g2-monitor               (G2 public search + listing pages)
 *   - jobs-monitor             (careers pages)
 *   - pricing-archive-monitor  (Wayback Machine)
 *   - pricing-signals-monitor  (Reddit/HN $-figure mining + enterprise URL probes; fallback when /pricing is hidden)
 *   - sitemap-monitor          (sitemap.xml diff vs prior run)
 *   - hackernews-monitor       (Algolia HN search API)
 *   - reddit-monitor           (Reddit public JSON search)
 *   - sec-filings-monitor      (only when a ticker or CIK is supplied)
 *
 * Usage:
 *   node scripts/collect-for-brief.js "<Industry>" "<Competitor A>" "<Competitor B>"
 *   node scripts/collect-for-brief.js "E-Learning" "Docebo" "Absorb LMS"
 *   node scripts/collect-for-brief.js "Cybersecurity" "CrowdStrike" "SentinelOne"
 *
 * By default the script auto-resolves each competitor's website, G2 slug,
 * and SEC ticker/CIK via Claude (ANTHROPIC_API_KEY required). Results are
 * cached in data/_cache/vendor-profiles.json so each vendor is only resolved
 * once. Use --no-auto to skip that step.
 *
 * Optional overrides (apply per competitor A|B, all win over the resolver):
 *   --a-website "https://docebo.com"
 *   --b-website "https://absorblms.com"
 *   --a-g2 "docebo"                       (g2 slug)
 *   --b-g2 "absorb-lms"
 *   --a-ticker "DCBO"                     (enables SEC 8-K for A)
 *   --b-ticker "..."
 *   --a-cik "0001735953"                  (alternative to ticker)
 *   --b-cik "..."
 *   --no-auto                             (skip Claude resolver entirely)
 *
 * Output:
 *   intelligence-engine/data/brief-signals/<industry-slug>.json
 *
 * The JSON shape is a thin wrapper over the collector raw signals:
 *   {
 *     generatedAt: ISO string,
 *     industry:    string,
 *     competitors: [ { name, website, g2Slug, secTicker, secCik } ... ],
 *     signals:     [ { type, competitor, data } ... ]   // raw collector output
 *   }
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirnameEarly = path.dirname(__filename);
// Load .env from the intelligence-engine root regardless of the cwd we were
// invoked from (this script is routinely spawned from brief-app/).
dotenv.config({ path: path.join(__dirnameEarly, '..', '.env') });

import { collectWebsite }         from './collectors/website-monitor.js';
import { collectNews }            from './collectors/news-monitor.js';
import { collectG2 }              from './collectors/g2-monitor.js';
import { collectJobs }            from './collectors/jobs-monitor.js';
import { collectPricingArchive }  from './collectors/pricing-archive-monitor.js';
import { collectPricingSignals }  from './collectors/pricing-signals-monitor.js';
import { collectSECFilings }      from './collectors/sec-filings-monitor.js';
import { collectReddit }          from './collectors/reddit-monitor.js';
import { collectHackerNews }      from './collectors/hackernews-monitor.js';
import { collectSitemap }         from './collectors/sitemap-monitor.js';

const __dirname = __dirnameEarly;
const ROOT = path.join(__dirname, '..');

const BRIEF_CLIENT_ID = 'brief-sample';
const OUT_DIR_DEFAULT = path.join(ROOT, 'data', 'brief-signals');
const VENDOR_CACHE_PATH = path.join(ROOT, 'data', '_cache', 'vendor-profiles.json');
const VENDOR_RESOLVER_MODEL = 'claude-opus-4-7';

function usage() {
  console.error(`
Usage:
  node scripts/collect-for-brief.js "<Industry>" "<Competitor A>" "<Competitor B>" [flags]

Examples:
  node scripts/collect-for-brief.js "E-Learning" "Docebo" "Absorb LMS"
  node scripts/collect-for-brief.js "Cybersecurity" "CrowdStrike" "SentinelOne"
  node scripts/collect-for-brief.js "Sales Engagement" "Outreach" "Salesloft"

By default the script asks Claude to auto-resolve each competitor's official
website, G2 slug, and SEC ticker/CIK (cached in data/_cache/vendor-profiles.json
so each vendor is only resolved once). Use --no-auto to skip this step, or the
per-side flags below to override a specific field.

Flags (all optional):
  --no-auto            Skip Claude vendor-profile auto-resolution
  --a-website <url>    --b-website <url>
  --a-g2 <slug>        --b-g2 <slug>
  --a-ticker <sym>     --b-ticker <sym>      (enables SEC 8-K collector)
  --a-cik <10-digit>   --b-cik <10-digit>
  --out <path>         (override output JSON path; default: data/brief-signals/<slug>.json)
`);
  process.exit(1);
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'industry';
}

function guessWebsite(name) {
  const hostSafe = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
  return `https://${hostSafe}.com`;
}

function guessG2Slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const BOOLEAN_FLAGS = new Set(['no-auto']);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        console.error(`Missing value for --${key}`);
        usage();
      }
      flags[key] = val;
      i++;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 3) usage();
  return { positional, flags };
}

function buildCompetitor(side, name, flags, resolved = {}) {
  // Precedence: explicit CLI flag > Claude-resolved profile > deterministic guess.
  const website = flags[`${side}-website`] || resolved.website || guessWebsite(name);
  const g2Slug  = flags[`${side}-g2`]      || resolved.g2Slug  || guessG2Slug(name);
  const comp = {
    name,
    website,
    g2Slug,
    newsKeywords: [name],
    jobMonitoring: { enabled: true, roles: ['engineer', 'product', 'sales'] },
  };
  const ticker = flags[`${side}-ticker`] || resolved.secTicker;
  const cik    = flags[`${side}-cik`]    || resolved.secCik;
  if (ticker) comp.secTicker = ticker;
  if (cik)    comp.secCik    = cik;
  return comp;
}

// ─── Vendor-profile auto-resolution (Claude) ────────────────────────────────
//
// Most users don't want to memorise the G2 slug for every SaaS vendor on
// earth, or look up whether "SentinelOne" trades on NYSE (S) or NASDAQ. Claude
// knows these, so we ask once per vendor and cache the answer indefinitely.
// Cache is keyed by lowercased, punctuation-free vendor name.

function vendorCacheKey(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function loadVendorCache() {
  try {
    if (!fs.existsSync(VENDOR_CACHE_PATH)) return {};
    return JSON.parse(fs.readFileSync(VENDOR_CACHE_PATH, 'utf8'));
  } catch (err) {
    console.warn(`   ⚠️   vendor-profile cache unreadable (${err.message}); starting fresh`);
    return {};
  }
}

function saveVendorCache(cache) {
  try {
    fs.mkdirSync(path.dirname(VENDOR_CACHE_PATH), { recursive: true });
    fs.writeFileSync(VENDOR_CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.warn(`   ⚠️   could not persist vendor-profile cache: ${err.message}`);
  }
}

function extractJsonObject(text) {
  if (!text) return null;
  const direct = text.trim();
  try { return JSON.parse(direct); } catch {}
  const match = direct.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

async function askClaudeForProfiles(names) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set — cannot auto-resolve vendor profiles');
  }
  const client = new Anthropic({ apiKey });

  const system = `You are a B2B SaaS research assistant. You return STRICT JSON only — no prose, no code fences.

For each vendor name provided, return:
  - website:   canonical marketing site (with https://, no trailing slash)
  - g2Slug:    the vendor's G2 listing slug (the URL suffix after "g2.com/products/"),
               e.g. "crowdstrike-falcon" for CrowdStrike. Use null if uncertain.
  - secTicker: NYSE/NASDAQ ticker if publicly traded (US exchange preferred; TSX
               if that's the primary listing). Null if private or unknown.
  - secCik:    10-digit SEC CIK if publicly traded in the US, else null.
  - notes:     one-line hint if you had to guess anything, else null.

Never fabricate. If you're not confident about a field, return null for it.
Ticker format: uppercase, no "NYSE:" prefix.`;

  const userPrompt = `Resolve profiles for these vendors:\n${names.map((n) => `- ${n}`).join('\n')}\n\nReturn a JSON object of shape:\n{\n  "vendors": {\n    "<exact vendor name>": { "website": "...", "g2Slug": "...", "secTicker": "...", "secCik": "...", "notes": null }\n  }\n}`;

  const response = await client.messages.create({
    model: VENDOR_RESOLVER_MODEL,
    max_tokens: 2048,
    system,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content.map((b) => b.text || '').join('').trim();
  const parsed = extractJsonObject(text);
  if (!parsed || !parsed.vendors) {
    throw new Error(`Claude returned unparseable vendor-profile JSON: ${text.slice(0, 160)}`);
  }
  return parsed.vendors;
}

async function resolveVendorProfiles(names) {
  const cache = loadVendorCache();
  const resolved = {};
  const missing = [];

  for (const name of names) {
    const key = vendorCacheKey(name);
    if (cache[key]) {
      resolved[name] = cache[key];
    } else {
      missing.push(name);
    }
  }

  if (missing.length === 0) return { resolved, cacheHits: names.length, cacheMisses: 0 };

  console.log(`\n🧠  Asking Claude to resolve ${missing.length} vendor profile(s): ${missing.join(', ')}`);
  let vendors;
  try {
    vendors = await askClaudeForProfiles(missing);
  } catch (err) {
    console.warn(`   ⚠️   vendor auto-resolve failed: ${err.message}`);
    console.warn(`       Falling back to deterministic guesses for: ${missing.join(', ')}`);
    return { resolved, cacheHits: names.length - missing.length, cacheMisses: missing.length, failed: true };
  }

  for (const name of missing) {
    const match = vendors[name]
      || vendors[name.toLowerCase()]
      || Object.entries(vendors).find(([k]) => vendorCacheKey(k) === vendorCacheKey(name))?.[1];
    if (!match) {
      console.warn(`   ⚠️   Claude did not return a profile for "${name}"`);
      continue;
    }
    const profile = {
      website:   typeof match.website   === 'string' ? match.website.replace(/\/$/, '') : null,
      g2Slug:    typeof match.g2Slug    === 'string' ? match.g2Slug : null,
      secTicker: typeof match.secTicker === 'string' ? match.secTicker : null,
      secCik:    typeof match.secCik    === 'string' ? match.secCik : null,
      notes:     typeof match.notes     === 'string' ? match.notes : null,
      resolvedAt: new Date().toISOString(),
    };
    resolved[name] = profile;
    cache[vendorCacheKey(name)] = profile;
  }

  saveVendorCache(cache);
  return { resolved, cacheHits: names.length - missing.length, cacheMisses: missing.length };
}

async function safe(label, promise) {
  try {
    const result = await promise;
    return result;
  } catch (err) {
    console.warn(`   ⚠️   ${label} failed: ${err.message}`);
    return null;
  }
}

async function collectForCompetitor(competitor) {
  console.log(`\n  📡  Collecting signals for: ${competitor.name}`);
  const signals = [];

  const parallel = await Promise.all([
    safe('website',         collectWebsite(BRIEF_CLIENT_ID, competitor)),
    safe('news',            collectNews(competitor)),
    safe('pricing-archive', collectPricingArchive(BRIEF_CLIENT_ID, competitor)),
    safe('pricing-signals', collectPricingSignals(competitor)),
    safe('sitemap',         collectSitemap(BRIEF_CLIENT_ID, competitor)),
    safe('hackernews',      collectHackerNews(competitor)),
    safe('reddit',          collectReddit(competitor)),
  ]);
  for (const s of parallel) if (s) signals.push(s);

  await new Promise((r) => setTimeout(r, 600));
  const g2 = await safe('g2', collectG2(competitor));
  if (g2) signals.push(g2);

  await new Promise((r) => setTimeout(r, 600));
  const jobs = await safe('jobs', collectJobs(competitor));
  if (jobs) signals.push(jobs);

  if (competitor.secTicker || competitor.secCik) {
    await new Promise((r) => setTimeout(r, 600));
    const sec = await safe('sec-filings', collectSECFilings(BRIEF_CLIENT_ID, competitor));
    if (sec) signals.push(sec);
  }

  return signals;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [industry, aName, bName] = positional;

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║      COLLECT-FOR-BRIEF — VERTICAL SAMPLE     ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`\n🏷️   Industry: ${industry}`);

  // Auto-resolve website / G2 slug / SEC ticker via Claude (with on-disk cache)
  // unless the user passed --no-auto. Each CLI flag still overrides the
  // resolved value for its side, so power users keep full control.
  const autoResolve = flags['no-auto'] === undefined;
  let resolvedProfiles = {};
  if (autoResolve) {
    const { resolved, cacheHits, cacheMisses, failed } = await resolveVendorProfiles([aName, bName]);
    resolvedProfiles = resolved;
    if (!failed) {
      console.log(`🧠  Vendor profiles: ${cacheHits} from cache, ${cacheMisses} resolved live`);
    }
  }

  const competitors = [
    buildCompetitor('a', aName, flags, resolvedProfiles[aName] || {}),
    buildCompetitor('b', bName, flags, resolvedProfiles[bName] || {}),
  ];

  for (const c of competitors) {
    const tags = [];
    if (c.secTicker) tags.push(`ticker=${c.secTicker}`);
    if (c.secCik)    tags.push(`cik=${c.secCik}`);
    console.log(`🔍  ${c.name} → ${c.website} (g2=${c.g2Slug}${tags.length ? ', ' + tags.join(', ') : ''})`);
  }

  const allSignals = [];
  for (const c of competitors) {
    const s = await collectForCompetitor(c);
    allSignals.push(...s);
  }

  const slug = slugify(industry);
  const outPath = flags.out
    ? path.resolve(flags.out)
    : path.join(OUT_DIR_DEFAULT, `${slug}.json`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const payload = {
    generatedAt: new Date().toISOString(),
    industry,
    industrySlug: slug,
    competitors: competitors.map((c) => ({
      name: c.name,
      website: c.website,
      g2Slug: c.g2Slug,
      secTicker: c.secTicker || null,
      secCik: c.secCik || null,
    })),
    signals: allSignals,
  };

  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

  console.log(`\n✅  Collected ${allSignals.length} signal batches across ${competitors.length} competitors.`);
  console.log(`📁  Signals JSON → ${path.relative(ROOT, outPath)}`);
  console.log(`\nNext: from brief-app, run`);
  console.log(`   npm run generate-html-brief -- "${industry}" "${aName}" "${bName}"`);
  console.log(`(the generator auto-loads the matching signals file)\n`);
}

main().catch((err) => {
  console.error('\n❌  Fatal error:', err.message);
  process.exit(1);
});
