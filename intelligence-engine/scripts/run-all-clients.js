/**
 * Run pipeline for ALL active clients
 * ────────────────────────────────────
 * Called by the n8n cron workflow every Monday at 6am.
 * Loops through every active client config and runs the full pipeline.
 *
 * Usage:
 *   node scripts/run-all-clients.js
 *   node scripts/run-all-clients.js --no-email
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');
const noEmail   = process.argv.includes('--no-email');

function loadAllClients() {
  const dir = path.join(ROOT, 'config', 'clients');
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json') && f !== 'example-client.json')
    .map(f => {
      const config = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return { id: config.id || f.replace('.json', ''), config };
    })
    .filter(c => c.config.active !== false);
}

async function main() {
  const clients = loadAllClients();

  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║       INTELLIGENCE ENGINE — ALL CLIENTS RUN       ║');
  console.log('╚═══════════════════════════════════════════════════╝');
  console.log(`\n🗓️   ${new Date().toISOString()}`);
  console.log(`📋  Active clients: ${clients.length}`);
  clients.forEach(c => console.log(`    - ${c.config.name} (${c.id})`));

  const results = { passed: [], failed: [] };

  for (const { id, config } of clients) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`▶  Running: ${config.name} (${id})`);
    console.log('═'.repeat(60));

    const args = ['scripts/run-client.js', id];
    if (noEmail) args.push('--no-email');

    const result = spawnSync('node', args, {
      stdio: 'inherit',
      env: process.env,
      cwd: ROOT,
    });

    if (result.status === 0) {
      results.passed.push(config.name);
    } else {
      results.failed.push(config.name);
      console.error(`\n⚠️   Client "${config.name}" failed. Continuing with remaining clients.`);
    }

    // Brief pause between clients
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║              ALL CLIENTS COMPLETE                  ║');
  console.log('╚═══════════════════════════════════════════════════╝');
  console.log(`\n✅  Passed: ${results.passed.join(', ') || 'none'}`);
  if (results.failed.length) {
    console.log(`❌  Failed: ${results.failed.join(', ')}`);
  }
  console.log();
}

main().catch(err => {
  console.error('❌  Fatal error:', err.message);
  process.exit(1);
});
