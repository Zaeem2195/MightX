/**
 * Script 1: Pull ICP-matched leads from Apollo.io
 * ─────────────────────────────────────────────────
 * 1) mixed_people/api_search — find people (no credits; master API key required)
 * 2) people/bulk_match — reveal emails (consumes credits; max 10 people per call)
 *
 * Usage:
 *   npm run pull-leads
 *   node scripts/1-pull-leads.js --max-leads 2500
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const APOLLO_BASE = 'https://api.apollo.io/api/v1';
const APOLLO_API_KEY = process.env.APOLLO_API_KEY;

if (!APOLLO_API_KEY) {
  console.error('❌  APOLLO_API_KEY is missing from your .env file.');
  process.exit(1);
}

const icp = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'config', 'icp.json'), 'utf8')
);

const PAGE_SIZE = 100;
const BULK_CHUNK = 10;
const SEARCH_DELAY_MS = 800;
const BULK_DELAY_MS = 500;

function parseMaxLeadsArg() {
  const idx = process.argv.indexOf('--max-leads');
  if (idx === -1 || !process.argv[idx + 1]) return null;
  const n = parseInt(process.argv[idx + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function buildEmployeeRanges(ranges) {
  return ranges.map((r) => `${r.min},${r.max}`);
}

/** Build query string for People API Search (POST). */
function buildApiSearchQuery(page) {
  const p = new URLSearchParams();
  p.set('page', String(page));
  p.set('per_page', String(PAGE_SIZE));
  for (const t of icp.titles || []) p.append('person_titles[]', t);
  for (const r of buildEmployeeRanges(icp.employee_ranges || [])) {
    p.append('organization_num_employees_ranges[]', r);
  }
  for (const loc of icp.locations || []) p.append('person_locations[]', loc);
  p.append('contact_email_status[]', 'verified');
  p.append('contact_email_status[]', 'likely to engage');
  // Do not send icp.keywords as a single q_keywords string — Apollo treats it as a
  // tight match and often returns 0 results. Optional: set icp.apolloQKeywords (one string).
  if (typeof icp.apolloQKeywords === 'string' && icp.apolloQKeywords.trim()) {
    p.set('q_keywords', icp.apolloQKeywords.trim());
  }
  return p.toString();
}

async function apiSearchPeople(page) {
  const qs = buildApiSearchQuery(page);
  const url = `${APOLLO_BASE}/mixed_people/api_search?${qs}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'X-Api-Key': APOLLO_API_KEY,
    },
    body: '{}',
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Apollo api_search ${res.status}: ${err}`);
  }

  return res.json();
}

async function bulkMatchReveal(details) {
  const qs = new URLSearchParams({
    reveal_personal_emails: 'true',
    reveal_phone_number: 'false',
  });
  const url = `${APOLLO_BASE}/people/bulk_match?${qs}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'X-Api-Key': APOLLO_API_KEY,
    },
    body: JSON.stringify({ details }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Apollo bulk_match ${res.status}: ${err}`);
  }

  return res.json();
}

function normaliseLead(person) {
  const org = person.organization || {};
  const currentJob = (person.employment_history || []).find((e) => e.current);
  const orgName =
    org.name ||
    currentJob?.organization_name ||
    person.organization_name ||
    '';
  return {
    id:               person.id,
    firstName:        person.first_name || '',
    lastName:         person.last_name  || '',
    email:            person.email      || '',
    title:            person.title      || '',
    linkedinUrl:      person.linkedin_url || '',
    companyName:      orgName,
    companyWebsite:   org.website_url   || '',
    companySize:      org.num_employees || null,
    companyIndustry:  org.industry      || '',
    companyLinkedin:  org.linkedin_url  || '',
    companyTech:      (org.current_technologies || []).map((t) => t.name),
    location:         person.city
                        ? `${person.city}, ${person.state || ''}`
                        : (person.country || ''),
    apolloId:         person.id,
    pulledAt:         new Date().toISOString(),
  };
}

async function main() {
  const maxLeadsOverride = parseMaxLeadsArg();
  const targetCount = maxLeadsOverride ?? icp.leadsPerRun ?? 50;

  console.log(`\n🔍  Target: ${targetCount} leads with revealed emails (Apollo api_search + bulk_match).`);
  if (maxLeadsOverride) console.log(`    (--max-leads override; icp.leadsPerRun is ${icp.leadsPerRun ?? 50})`);
  console.log(`    Search page size: ${PAGE_SIZE} | Bulk chunk: ${BULK_CHUNK}`);
  console.log(`    Titles:     ${(icp.titles || []).slice(0, 3).join(', ')} ...`);
  console.log(`    Employees:  ${(icp.employee_ranges || []).map((r) => `${r.min}–${r.max}`).join(', ')}`);
  console.log(`    Locations:  ${(icp.locations || []).join(', ')}\n`);

  const seenIds = new Set();
  const candidates = [];
  let totalAvailable = 0;
  let searchPage = 1;
  // Extra IDs so a few bulk_match misses still yield targetCount saved leads
  const idSlack = targetCount >= 200 ? Math.min(200, Math.ceil(targetCount * 0.04)) : 10;
  const idTarget = targetCount + idSlack;
  const maxSearchPages = Math.min(500, Math.ceil((idTarget * 3) / PAGE_SIZE) + 5);

  console.log('── Phase 1: api_search (collect IDs with has_email) ──');
  while (candidates.length < idTarget && searchPage <= maxSearchPages) {
    process.stdout.write(`    Search page ${searchPage} ... `);
    try {
      const data = await apiSearchPeople(searchPage);
      const people = data.people || [];
      totalAvailable = data.total_entries ?? data.pagination?.total_entries ?? totalAvailable;

      let added = 0;
      for (const p of people) {
        if (!p.id || !p.has_email) continue;
        if (seenIds.has(p.id)) continue;
        seenIds.add(p.id);
        candidates.push(p);
        added++;
        if (candidates.length >= idTarget) break;
      }

      console.log(`+${added} candidates (total ${candidates.length}, DB ~${totalAvailable})`);

      if (people.length < PAGE_SIZE) break;
      if (candidates.length >= idTarget) break;

      searchPage++;
      await new Promise((r) => setTimeout(r, SEARCH_DELAY_MS));
    } catch (err) {
      console.error(`\n❌  api_search failed: ${err.message}`);
      if (String(err.message).includes('API_INACCESSIBLE') || String(err.message).includes('master')) {
        console.error('    You may need a master API key for api_search (Apollo settings → API keys).');
      }
      process.exit(1);
    }
  }

  if (!candidates.length) {
    console.error('\n❌  No candidates with has_email from search. Check ICP filters and API key.');
    process.exit(1);
  }

  console.log('\n── Phase 2: bulk_match (reveal emails, uses credits) ──');
  const allLeads = [];
  let creditsConsumed = 0;

  for (let i = 0; i < candidates.length && allLeads.length < targetCount; i += BULK_CHUNK) {
    const slice = candidates.slice(i, i + BULK_CHUNK);
    const details = slice.map((p) => ({ id: p.id }));
    process.stdout.write(`    Bulk ${Math.floor(i / BULK_CHUNK) + 1} (${details.length} ids) ... `);

    try {
      const data = await bulkMatchReveal(details);
      if (data.credits_consumed != null) creditsConsumed += data.credits_consumed;
      const matches = data.matches || [];
      let got = 0;
      for (const m of matches) {
        if (!m.email) continue;
        allLeads.push(normaliseLead(m));
        got++;
        if (allLeads.length >= targetCount) break;
      }
      console.log(`✅  ${got} with email (running total: ${allLeads.length})`);
    } catch (err) {
      console.error(`\n❌  bulk_match failed: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, BULK_DELAY_MS));
  }

  const output = {
    meta: {
      pulledAt:         new Date().toISOString(),
      totalAvailable,
      candidatesFound:  candidates.length,
      totalPulled:      allLeads.length,
      targetRequested:  targetCount,
      creditsConsumedReported: creditsConsumed || null,
      icp:              { titles: icp.titles, locations: icp.locations },
    },
    leads: allLeads.slice(0, targetCount),
  };

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(ROOT, 'data', `leads-${timestamp}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`\n✅  Saved ${output.leads.length} leads → ${path.relative(ROOT, outPath)}`);
  if (output.meta.creditsConsumedReported) {
    console.log(`    Apollo reported credits consumed (this run): ${output.meta.creditsConsumedReported}`);
  }
  console.log(`    Run next: npm run enrich\n`);
}

main().catch((err) => {
  console.error('❌  Unhandled error:', err.message);
  process.exit(1);
});
