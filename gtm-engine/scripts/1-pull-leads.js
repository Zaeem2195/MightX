/**
 * Script 1: Pull ICP-matched leads from Apollo.io
 * ─────────────────────────────────────────────────
 * Reads config/icp.json → calls Apollo People Search API →
 * saves raw leads to data/leads-[timestamp].json
 *
 * Usage: npm run pull-leads
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

// ── Build Apollo employee_ranges filter ───────────────────────────────────────
function buildEmployeeRanges(ranges) {
  return ranges.map(r => `${r.min},${r.max}`);
}

// ── Apollo People Search ──────────────────────────────────────────────────────
async function searchPeople(page = 1) {
  const body = {
    api_key: APOLLO_API_KEY,
    page,
    per_page: 25,
    person_titles: icp.titles,
    organization_num_employees_ranges: buildEmployeeRanges(icp.employee_ranges),
    organization_industry_tag_ids: [],           // populated via keyword match below
    person_locations: icp.locations,
    q_organization_keyword_tags: icp.keywords,
    contact_email_status: ['verified', 'likely to engage'],
  };

  const res = await fetch(`${APOLLO_BASE}/mixed_people/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Apollo API error ${res.status}: ${err}`);
  }

  return res.json();
}

// ── Normalise Apollo person record ────────────────────────────────────────────
function normaliseLead(person) {
  const org = person.organization || {};
  return {
    id:               person.id,
    firstName:        person.first_name || '',
    lastName:         person.last_name  || '',
    email:            person.email      || '',
    title:            person.title      || '',
    linkedinUrl:      person.linkedin_url || '',
    companyName:      org.name          || person.organization_name || '',
    companyWebsite:   org.website_url   || '',
    companySize:      org.num_employees || null,
    companyIndustry:  org.industry      || '',
    companyLinkedin:  org.linkedin_url  || '',
    companyTech:      (org.current_technologies || []).map(t => t.name),
    location:         person.city
                        ? `${person.city}, ${person.state || ''}`
                        : (person.country || ''),
    apolloId:         person.id,
    pulledAt:         new Date().toISOString(),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const targetCount = icp.leadsPerRun || 50;
  const pagesNeeded = Math.ceil(targetCount / 25);

  console.log(`\n🔍  Pulling up to ${targetCount} leads from Apollo...`);
  console.log(`    Titles:     ${icp.titles.slice(0, 3).join(', ')} ...`);
  console.log(`    Employees:  ${icp.employee_ranges.map(r => `${r.min}–${r.max}`).join(', ')}`);
  console.log(`    Locations:  ${icp.locations.join(', ')}\n`);

  const allLeads = [];
  let totalAvailable = 0;

  for (let page = 1; page <= pagesNeeded; page++) {
    process.stdout.write(`    Page ${page}/${pagesNeeded} ... `);

    try {
      const data = await searchPeople(page);
      const people = data.people || data.contacts || [];
      totalAvailable = data.pagination?.total_entries || people.length;

      const normalised = people
        .filter(p => p.email)                   // only keep leads with emails
        .map(normaliseLead);

      allLeads.push(...normalised);
      process.stdout.write(`✅  ${normalised.length} leads (${people.length - normalised.length} skipped — no email)\n`);

      if (people.length < 25) break;            // last page
      if (allLeads.length >= targetCount) break;

      // Respect Apollo rate limits
      await new Promise(r => setTimeout(r, 1200));
    } catch (err) {
      console.error(`\n❌  Failed on page ${page}: ${err.message}`);
      break;
    }
  }

  const output = {
    meta: {
      pulledAt:       new Date().toISOString(),
      totalAvailable,
      totalPulled:    allLeads.length,
      icp:            { titles: icp.titles, locations: icp.locations },
    },
    leads: allLeads.slice(0, targetCount),
  };

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(ROOT, 'data', `leads-${timestamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`\n✅  Saved ${output.leads.length} leads → ${path.relative(ROOT, outPath)}`);
  console.log(`    Run next: npm run enrich\n`);
}

main().catch(err => {
  console.error('❌  Unhandled error:', err.message);
  process.exit(1);
});
