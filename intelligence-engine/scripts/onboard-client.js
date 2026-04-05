/**
 * Interactive Client Onboarding
 * ──────────────────────────────
 * Walks through client setup via stdin prompts, generates config JSON,
 * and optionally runs the first report for quality review.
 *
 * Usage:
 *   node scripts/onboard-client.js
 *   node scripts/onboard-client.js --skip-report   (config only, no test run)
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CLIENTS_DIR = path.join(ROOT, 'config', 'clients');
const skipReport = process.argv.includes('--skip-report');

const TIER_DEFAULTS = {
  starter:  { monthlyRate: 800,  setupFee: 1000, maxCompetitors: 2, includeTriggerEmails: false, includeDashboard: false },
  standard: { monthlyRate: 1500, setupFee: 2000, maxCompetitors: 3, includeTriggerEmails: true,  includeDashboard: false },
  growth:   { monthlyRate: 2500, setupFee: 2500, maxCompetitors: 6, includeTriggerEmails: true,  includeDashboard: true  },
  strategic:{ monthlyRate: 4000, setupFee: 3500, maxCompetitors: 10,includeTriggerEmails: true,  includeDashboard: true  },
};

function createRL() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function collectCompetitor(rl, index) {
  console.log(`\n  ── Competitor ${index + 1} ──`);
  const name = await ask(rl, '  Name: ');
  if (!name.trim()) return null;

  const website     = await ask(rl, '  Website URL (e.g. https://www.outreach.io): ');
  const g2Slug      = await ask(rl, '  G2 slug (e.g. "outreach" from g2.com/products/outreach): ');
  const linkedinSlug = await ask(rl, '  LinkedIn slug (e.g. "outreach-inc"): ');
  const githubOrg   = await ask(rl, '  GitHub org (leave blank if none): ');
  const crunchbaseSlug = await ask(rl, '  Crunchbase slug (leave blank if none): ');
  const newsKw      = await ask(rl, '  News keywords (comma-separated, e.g. "Outreach funding, Outreach layoffs"): ');

  return {
    name: name.trim(),
    website: website.trim() || null,
    g2Slug: g2Slug.trim() || null,
    linkedinSlug: linkedinSlug.trim() || null,
    githubOrg: githubOrg.trim() || null,
    crunchbaseSlug: crunchbaseSlug.trim() || null,
    newsKeywords: newsKw.split(',').map(k => k.trim()).filter(Boolean),
  };
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║       CLIENT ONBOARDING — INTERACTIVE        ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const rl = createRL();

  try {
    const name = await ask(rl, 'Client company name: ');
    const slug = slugify(name);
    const configPath = path.join(CLIENTS_DIR, `${slug}.json`);

    if (fs.existsSync(configPath)) {
      const overwrite = await ask(rl, `\n⚠️  Config already exists: ${slug}.json. Overwrite? (y/n): `);
      if (overwrite.toLowerCase() !== 'y') {
        console.log('Cancelled.');
        rl.close();
        return;
      }
    }

    const contactEmail = await ask(rl, 'Primary contact email: ');
    const ccEmails     = await ask(rl, 'CC emails (comma-separated, or blank): ');
    const championName = await ask(rl, 'Champion name (buyer contact): ');
    const championTitle = await ask(rl, 'Champion title (e.g. VP of Sales): ');

    console.log('\nTiers: starter ($800/mo) | standard ($1,500/mo) | growth ($2,500/mo) | strategic ($4,000/mo)');
    let tier = (await ask(rl, 'Tier [growth]: ')).toLowerCase().trim() || 'growth';
    if (!TIER_DEFAULTS[tier]) {
      console.log(`Unknown tier "${tier}", defaulting to growth.`);
      tier = 'growth';
    }
    const td = TIER_DEFAULTS[tier];

    const billingCycle = (await ask(rl, 'Billing cycle (monthly/annual) [monthly]: ')).trim() || 'monthly';

    console.log('\n── Client Context ──');
    const product       = await ask(rl, 'What does the client sell? (1 sentence): ');
    const icp           = await ask(rl, 'Who does the client sell to? (ICP): ');
    const differentiators = await ask(rl, 'Differentiators (comma-separated): ');
    const weaknesses    = await ask(rl, 'Known weaknesses (comma-separated, or blank): ');

    console.log('\n── Competitors ──');
    console.log(`Tier "${tier}" supports up to ${td.maxCompetitors} competitors.`);
    console.log('Enter each competitor. Press Enter with empty name to stop.\n');

    const competitors = [];
    for (let i = 0; i < td.maxCompetitors; i++) {
      const comp = await collectCompetitor(rl, i);
      if (!comp) break;
      competitors.push(comp);
    }

    if (!competitors.length) {
      console.log('\n❌  At least one competitor is required.');
      rl.close();
      return;
    }

    const tone = (await ask(rl, '\nReport tone [strategic and direct — written for a senior sales leader]: ')).trim()
      || 'strategic and direct — written for a senior sales leader';

    const config = {
      id: slug,
      name: name.trim(),
      contactEmail: contactEmail.trim(),
      reportCcEmails: ccEmails.split(',').map(e => e.trim()).filter(Boolean),
      active: true,
      tier,
      billing: {
        cycle: billingCycle,
        monthlyRate: td.monthlyRate,
        setupFee: td.setupFee,
        startDate: new Date().toISOString().slice(0, 10),
      },
      context: {
        clientProduct: product.trim(),
        clientICP: icp.trim(),
        clientDifferentiators: differentiators.split(',').map(d => d.trim()).filter(Boolean),
        clientWeaknesses: weaknesses.split(',').map(w => w.trim()).filter(Boolean),
      },
      competitors,
      jobMonitoring: {
        enabled: true,
        roles: ['AI', 'machine learning', 'product manager', 'engineer', 'sales'],
      },
      additionalCollectors: {
        linkedin: competitors.some(c => c.linkedinSlug),
        github: competitors.some(c => c.githubOrg),
        crunchbase: competitors.some(c => c.crunchbaseSlug),
      },
      reportPreferences: {
        tone,
        maxCompetitorsInReport: td.maxCompetitors,
        includeTriggerEmails: td.includeTriggerEmails,
        triggerEmailCount: 3,
        includeDashboard: td.includeDashboard,
      },
      retention: {
        winStories: [],
        lastQuarterlySummary: null,
        championName: championName.trim(),
        championTitle: championTitle.trim(),
        renewalDate: null,
        healthStatus: 'healthy',
      },
    };

    fs.mkdirSync(CLIENTS_DIR, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║           CLIENT CONFIG CREATED ✅             ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log(`\n📁  Saved to: config/clients/${slug}.json`);
    console.log(`🏢  Client:   ${name.trim()}`);
    console.log(`📧  Email:    ${contactEmail.trim()}`);
    console.log(`💰  Tier:     ${tier} ($${td.monthlyRate}/mo)`);
    console.log(`🔍  Tracking: ${competitors.map(c => c.name).join(', ')}`);

    if (!skipReport) {
      const runTest = await ask(rl, '\nRun a test report now? (y/n) [y]: ');
      if (runTest.toLowerCase() !== 'n') {
        rl.close();
        console.log(`\nRunning: node scripts/run-client.js ${slug} --no-email\n`);
        const { spawnSync } = await import('child_process');
        spawnSync('node', ['scripts/run-client.js', slug, '--no-email'], {
          stdio: 'inherit',
          env: process.env,
          cwd: ROOT,
        });
        return;
      }
    }

    console.log('\nNext steps:');
    console.log(`  1. Review the config: config/clients/${slug}.json`);
    console.log(`  2. Run a test report: node scripts/run-client.js ${slug} --no-email`);
    console.log(`  3. Check the output: data/${slug}/report-*.html`);
    console.log(`  4. When satisfied, the Monday cron will include this client automatically.\n`);

    rl.close();
  } catch (err) {
    rl.close();
    throw err;
  }
}

main().catch(err => {
  console.error('\n❌  Error:', err.message);
  process.exit(1);
});
