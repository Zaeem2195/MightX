/**
 * Resume pipeline from a saved raw-signals JSON (skip collect / no Apify re-run)
 * ────────────────────────────────────────────────────────────────────────────
 * Use after a successful collect step failed at analysis/report (e.g. bad API key).
 *
 * Usage:
 *   node scripts/resume-from-raw.js <client-id>
 *   node scripts/resume-from-raw.js <client-id> path/to/raw-signals-2026-04-10T16-30-25.json
 *   node scripts/resume-from-raw.js demo-salesloft --no-email
 *
 * If the path is omitted, uses the newest data/<client-id>/raw-signals-*.json by mtime.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { runAnalysis } from './analyse.js';
import { generateReport } from './generate-report.js';
import { generateClientDashboard } from './generate-dashboard.js';
import { deliverReport } from './deliver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function loadClient(id) {
  const configPath = path.join(ROOT, 'config', 'clients', `${id}.json`);
  if (!fs.existsSync(configPath)) {
    console.error(`❌  Client config not found: ${configPath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function parseArgs(argv) {
  const rest = argv.slice(2).filter((a) => a !== '--no-email');
  const noEmail = argv.includes('--no-email');
  const clientId = rest[0];
  const rawPathArg = rest[1];
  return { clientId, rawPathArg, noEmail };
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

function loadRawSignals(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(ROOT, filePath);
  if (!fs.existsSync(abs)) {
    console.error(`❌  Raw signals file not found: ${abs}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const signals = raw.signals;
  if (!Array.isArray(signals)) {
    console.error('❌  File must be a JSON object with a "signals" array (same format as run-client output).');
    process.exit(1);
  }
  return { abs, signals, collectedAt: raw.collectedAt };
}

async function main() {
  const { clientId, rawPathArg, noEmail } = parseArgs(process.argv);

  if (!clientId) {
    console.error('❌  Usage: node scripts/resume-from-raw.js <client-id> [path/to/raw-signals.json]');
    console.error('   Omit path to use the newest data/<client-id>/raw-signals-*.json');
    process.exit(1);
  }

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   RESUME FROM RAW SIGNALS (skip collect)     ║');
  console.log('╚══════════════════════════════════════════════╝');

  const clientConfig = loadClient(clientId);

  if (!clientConfig.active) {
    console.log(`⏭️   Client "${clientConfig.name}" is inactive (active: false). Skipping.`);
    process.exit(0);
  }

  let rawFile;
  if (rawPathArg) {
    rawFile = loadRawSignals(rawPathArg);
  } else {
    const latest = findLatestRawSignalsFile(clientId);
    if (!latest) {
      console.error(`❌  No raw-signals-*.json under data/${clientId}/. Run run-client first or pass a file path.`);
      process.exit(1);
    }
    rawFile = loadRawSignals(latest);
  }

  const { abs: rawPath, signals, collectedAt } = rawFile;

  console.log(`\n🏢  Client:         ${clientConfig.name}`);
  console.log(`📂  Raw signals:    ${path.relative(ROOT, rawPath)}`);
  if (collectedAt) console.log(`📅  Collected at:   ${collectedAt}`);
  console.log(`📊  Signal batches: ${signals.length}`);
  console.log(`📧  Deliver to:     ${clientConfig.contactEmail}`);
  if (noEmail) console.log(`📵  No-email mode — report will be saved but not sent.`);

  console.log('\n── Step 1/2: Analysing signals (from file) ─────────────────────');
  const { analyses } = await runAnalysis(clientId, signals, clientConfig);

  console.log('\n── Step 2/2: Generating & delivering report ────────────────────');
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
  console.log('║              RESUME COMPLETE ✅               ║');
  console.log('╚══════════════════════════════════════════════╝\n');
}

main().catch((err) => {
  console.error('\n❌  Fatal error:', err.message);
  process.exit(1);
});
