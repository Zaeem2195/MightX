/**
 * Run pipeline for a single client
 * ──────────────────────────────────
 * Usage:
 *   node scripts/run-client.js example-client
 *   node scripts/run-client.js example-client --no-email   (skip delivery)
 *   node scripts/run-client.js example-client --dry-run    (collect + analyse, no report/email)
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { collectWebsite }    from './collectors/website-monitor.js';
import { collectNews }       from './collectors/news-monitor.js';
import { collectG2 }         from './collectors/g2-monitor.js';
import { collectJobs }       from './collectors/jobs-monitor.js';
import { collectLinkedIn }   from './collectors/linkedin-monitor.js';
import { collectGitHub }     from './collectors/github-monitor.js';
import { collectCrunchbase } from './collectors/crunchbase-monitor.js';
import { runAnalysis }       from './analyse.js';
import { generateReport }    from './generate-report.js';
import { generateClientDashboard } from './generate-dashboard.js';
import { deliverReport }     from './deliver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const clientId = process.argv[2];
const noEmail  = process.argv.includes('--no-email');
const dryRun   = process.argv.includes('--dry-run');

if (!clientId) {
  console.error('❌  Usage: node scripts/run-client.js <client-id>');
  console.error('   Example: node scripts/run-client.js example-client');
  process.exit(1);
}

// ── Load client config ────────────────────────────────────────────────────────
function loadClient(id) {
  const configPath = path.join(ROOT, 'config', 'clients', `${id}.json`);
  if (!fs.existsSync(configPath)) {
    console.error(`❌  Client config not found: ${configPath}`);
    console.error(`   Create a config file based on config/clients/example-client.json`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// ── Collect all signals for all competitors ───────────────────────────────────
async function collectAllSignals(clientId, competitors, additionalCollectors = {}) {
  const signals = [];

  for (const competitor of competitors) {
    console.log(`\n  📡  Collecting signals for: ${competitor.name}`);

    const parallelCollectors = [
      collectWebsite(clientId, competitor),
      collectNews(competitor),
    ];

    if (additionalCollectors.crunchbase && competitor.crunchbaseSlug) {
      parallelCollectors.push(collectCrunchbase(competitor));
    }

    const parallelResults = await Promise.all(parallelCollectors);
    signals.push(...parallelResults);
    await new Promise(r => setTimeout(r, 500));

    const g2 = await collectG2(competitor);
    signals.push(g2);
    await new Promise(r => setTimeout(r, 500));

    if (competitor.jobMonitoring?.enabled !== false) {
      const jobs = await collectJobs(competitor);
      signals.push(jobs);
    }

    if (additionalCollectors.linkedin && competitor.linkedinSlug) {
      await new Promise(r => setTimeout(r, 500));
      const linkedin = await collectLinkedIn(clientId, competitor);
      signals.push(linkedin);
    }

    if (additionalCollectors.github && competitor.githubOrg) {
      await new Promise(r => setTimeout(r, 500));
      const github = await collectGitHub(clientId, competitor);
      signals.push(github);
    }

    await new Promise(r => setTimeout(r, 800));
  }

  // Save raw signals
  const dataDir   = path.join(ROOT, 'data', clientId);
  fs.mkdirSync(dataDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rawPath   = path.join(dataDir, `raw-signals-${timestamp}.json`);
  fs.writeFileSync(rawPath, JSON.stringify({ collectedAt: new Date().toISOString(), signals }, null, 2));
  console.log(`\n📁  Raw signals saved → data/${clientId}/raw-signals-${timestamp}.json`);

  return signals;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║       INTELLIGENCE ENGINE — CLIENT RUN       ║');
  console.log('╚══════════════════════════════════════════════╝');

  const clientConfig = loadClient(clientId);

  if (!clientConfig.active) {
    console.log(`⏭️   Client "${clientConfig.name}" is inactive (active: false). Skipping.`);
    process.exit(0);
  }

  console.log(`\n🏢  Client:      ${clientConfig.name}`);
  console.log(`📧  Deliver to:  ${clientConfig.contactEmail}`);
  console.log(`🔍  Competitors: ${clientConfig.competitors.map(c => c.name).join(', ')}`);
  if (dryRun)   console.log(`🔬  Dry run — will collect and analyse but not generate or send report.`);
  if (noEmail)  console.log(`📵  No-email mode — report will be saved but not sent.`);

  // Step 1 — Collect
  console.log('\n── Step 1/3: Collecting signals ────────────────────────────────');
  const signals = await collectAllSignals(clientId, clientConfig.competitors, clientConfig.additionalCollectors || {});
  console.log(`\n✅  Collected ${signals.length} signal batches across ${clientConfig.competitors.length} competitors.`);

  if (dryRun) {
    console.log('\n🔬  Dry run complete. Stopping before analysis.');
    process.exit(0);
  }

  // Step 2 — Analyse
  console.log('\n── Step 2/3: Analysing signals ─────────────────────────────────');
  const { analyses } = await runAnalysis(clientId, signals, clientConfig);

  // Step 3 — Generate report
  console.log('\n── Step 3/3: Generating & delivering report ────────────────────');
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
      console.log(`    Report was saved to: ${htmlPath}`);
      console.log(`    Open it in a browser or send manually.`);
    }
  } else {
    console.log(`\n📵  Email skipped. Report saved to: ${htmlPath}`);
  }

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║              RUN COMPLETE ✅                  ║');
  console.log('╚══════════════════════════════════════════════╝\n');
}

main().catch(err => {
  console.error('\n❌  Fatal error:', err.message);
  process.exit(1);
});
