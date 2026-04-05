/**
 * Script 2: Enrich leads with personalization variables
 * ──────────────────────────────────────────────────────
 * Reads latest data/leads-*.json →
 * computes personalization triggers from Apollo data →
 * saves to data/enriched-[timestamp].json
 *
 * Note: Clay free accounts do not include API access.
 * This script replicates Clay-style enrichment logic using
 * Apollo's native data fields (tech stack, company size,
 * industry, seniority). Upgrade Clay to Growth ($149/mo)
 * to add waterfall enrichment, LinkedIn scraping, and
 * intent signals on top of this output.
 *
 * Usage: npm run enrich
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── Load latest leads file ────────────────────────────────────────────────────
function loadLatestLeads() {
  const dataDir = path.join(ROOT, 'data');
  const files = fs.readdirSync(dataDir)
    .filter(f => f.startsWith('leads-') && f.endsWith('.json'))
    .sort()
    .reverse();

  if (!files.length) {
    console.error('❌  No leads file found. Run: npm run pull-leads');
    process.exit(1);
  }

  const latest = path.join(dataDir, files[0]);
  console.log(`📂  Loading: ${files[0]}`);
  return JSON.parse(fs.readFileSync(latest, 'utf8'));
}

// ── Infer pain point trigger from lead data ───────────────────────────────────
function inferPainPoint(lead) {
  const { companySize, companyTech, title, companyIndustry } = lead;

  // Company is in growth stage but no sales automation tooling detected
  const hasSalesTools = (companyTech || []).some(t =>
    ['Outreach', 'Salesloft', 'Apollo', 'HubSpot Sales', 'Gong', 'Chorus'].includes(t)
  );

  // Company likely running manual outbound if no known tools
  if (!hasSalesTools && companySize && companySize >= 50) {
    return `${lead.companyName} appears to be running outbound without dedicated automation tooling — a common bottleneck at your growth stage.`;
  }

  if (title.toLowerCase().includes('revenue') || title.toLowerCase().includes('cro')) {
    return `Revenue leaders at ${companySize ? `${companySize}-person` : 'growing'} SaaS companies consistently cite inconsistent pipeline generation as their top challenge.`;
  }

  if (title.toLowerCase().includes('growth')) {
    return `Scaling outbound without proportionally growing headcount is the core growth challenge for teams your size.`;
  }

  return `Building a predictable outbound pipeline without over-relying on individual SDR performance is a common challenge at ${lead.companyName}'s stage.`;
}

// ── Compute tech stack summary ────────────────────────────────────────────────
function techSummary(tech) {
  if (!tech || !tech.length) return null;
  const notable = tech.filter(t =>
    ['HubSpot', 'Salesforce', 'Outreach', 'Salesloft', 'Apollo', 'ZoomInfo',
     'Marketo', 'Pardot', 'Intercom', 'Drift', 'Segment', 'Amplitude'].includes(t)
  );
  return notable.length ? notable.join(', ') : null;
}

// ── Build personalization context block ───────────────────────────────────────
function buildPersonalisationContext(lead) {
  const icp = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'config', 'icp.json'), 'utf8')
  );

  return {
    // Lead identity
    firstName:       lead.firstName,
    lastName:        lead.lastName,
    fullName:        `${lead.firstName} ${lead.lastName}`.trim(),
    email:           lead.email,
    title:           lead.title,
    linkedinUrl:     lead.linkedinUrl,

    // Company context
    companyName:     lead.companyName,
    companyWebsite:  lead.companyWebsite,
    companySize:     lead.companySize,
    companyIndustry: lead.companyIndustry,
    location:        lead.location,

    // Personalization signals
    techStack:       techSummary(lead.companyTech),
    painPointTrigger: inferPainPoint(lead),
    knownTools:      (lead.companyTech || []).join(', ') || 'not detected',

    // Service context (from ICP config)
    serviceOutcomes:  icp.service.outcomes,
    founderCredential: icp.service.founderCredential,

    // Enrichment metadata
    enrichedAt:      new Date().toISOString(),
    dataSource:      'apollo_native',
  };
}

// ── Validate minimum data quality ─────────────────────────────────────────────
function isUsable(lead) {
  return !!(
    lead.email &&
    lead.firstName &&
    lead.companyName &&
    lead.title
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const raw = loadLatestLeads();
  const leads = raw.leads || [];

  console.log(`\n⚙️   Enriching ${leads.length} leads...\n`);

  const enriched = [];
  const skipped  = [];

  for (const lead of leads) {
    if (!isUsable(lead)) {
      skipped.push({ id: lead.id, reason: 'missing email, name, or company' });
      continue;
    }

    const context = buildPersonalisationContext(lead);
    enriched.push({ ...lead, personalization: context });
    process.stdout.write('.');
  }

  console.log(`\n\n✅  Enriched: ${enriched.length}  |  Skipped: ${skipped.length}`);

  if (skipped.length) {
    console.log('    Skipped leads:', skipped.map(s => s.id).join(', '));
  }

  const output = {
    meta: {
      enrichedAt:    new Date().toISOString(),
      totalEnriched: enriched.length,
      totalSkipped:  skipped.length,
      dataSource:    'apollo_native',
      clayNote:      'Upgrade Clay to Growth ($149/mo) for waterfall enrichment + LinkedIn scraping on top of this data.',
    },
    leads: enriched,
  };

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(ROOT, 'data', `enriched-${timestamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`\n📁  Saved → data/enriched-${timestamp}.json`);
  console.log(`    Run next: npm run generate-copy\n`);
}

main().catch(err => {
  console.error('❌  Error:', err.message);
  process.exit(1);
});
