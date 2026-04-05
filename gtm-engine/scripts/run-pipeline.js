/**
 * Pipeline Runner — chains all 4 steps end to end
 * ─────────────────────────────────────────────────
 * Pull leads → Enrich → Generate copy → Push to Instantly
 *
 * Stops between steps if errors are detected.
 * Copy generation step pauses for human review confirmation
 * before pushing to Instantly.
 *
 * Usage: npm run pipeline
 * Skip review prompt: npm run pipeline -- --auto-approve
 */

import { spawnSync } from 'child_process';
import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const AUTO       = process.argv.includes('--auto-approve');

const STEPS = [
  { name: '1. Pull Leads from Apollo',     script: '1-pull-leads.js'     },
  { name: '2. Enrich Leads',               script: '2-enrich-leads.js'   },
  { name: '3. Generate Copy via Claude',   script: '3-generate-copy.js'  },
  { name: '4. Push to Instantly',          script: '4-push-instantly.js' },
];

function run(script) {
  const result = spawnSync(
    'node',
    [path.join(__dirname, script)],
    { stdio: 'inherit', env: process.env }
  );
  return result.status === 0;
}

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, ans => { rl.close(); resolve(ans.trim().toLowerCase()); });
  });
}

async function main() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║        GTM ENGINE — FULL PIPELINE      ║');
  console.log('╚════════════════════════════════════════╝\n');

  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i];
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`▶  Step ${i + 1}/4: ${step.name}`);
    console.log(`${'─'.repeat(50)}\n`);

    // Human review gate before pushing to Instantly
    if (step.script === '4-push-instantly.js' && !AUTO) {
      console.log('⚠️   REVIEW GATE: Open data/copy-*.json and check at least 5–10 emails.');
      console.log('    If you\'re happy with the copy quality, type YES to continue.\n');
      const answer = await ask('    Proceed with push to Instantly? [yes/no]: ');
      if (answer !== 'yes' && answer !== 'y') {
        console.log('\n🛑  Push cancelled. Run "npm run push-instantly" manually when ready.\n');
        process.exit(0);
      }
    }

    const ok = run(step.script);

    if (!ok) {
      console.error(`\n❌  Step failed: ${step.name}`);
      console.error('    Fix the error above and re-run from this step manually.\n');
      process.exit(1);
    }
  }

  console.log('\n╔════════════════════════════════════════╗');
  console.log('║         PIPELINE COMPLETE ✅            ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('\n  Leads are live in Instantly. Next steps:');
  console.log('  1. Confirm campaign is active in Instantly dashboard');
  console.log('  2. Import n8n/gtm-reply-handler.json into n8n');
  console.log('  3. Set Instantly reply webhook → your n8n webhook URL');
  console.log('  4. Replies will auto-classify; hot leads alert you in Slack\n');
}

main().catch(err => {
  console.error('❌  Pipeline error:', err.message);
  process.exit(1);
});
