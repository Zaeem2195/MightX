/**
 * Analysis Engine — Claude processes all collected signals
 * ─────────────────────────────────────────────────────────
 * Reads raw signals from data/[clientId]/raw-signals-[timestamp].json
 * Sends each signal to Claude for strategic analysis
 * Saves analyses to data/[clientId]/analyses-[timestamp].json
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL  = 'claude-sonnet-4-6';
const DELAY  = 1000;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌  ANTHROPIC_API_KEY missing from .env');
  process.exit(1);
}

const promptTemplate = fs.readFileSync(
  path.join(ROOT, 'prompts', 'signal-analyst.txt'), 'utf8'
);

// ── Build client context string ───────────────────────────────────────────────
function buildClientContext(clientConfig) {
  const c = clientConfig.context;
  return [
    `Client product: ${c.clientProduct}`,
    `Target customer: ${c.clientICP}`,
    `Client differentiators: ${c.clientDifferentiators.join(', ')}`,
    `Client weaknesses: ${c.clientWeaknesses?.join(', ') || 'none specified'}`,
  ].join('\n');
}

// ── Analyse one signal with Claude ───────────────────────────────────────────
async function analyseSignal(signal, clientContext, attempt = 0) {
  const prompt = promptTemplate
    .replace('{{CLIENT_CONTEXT}}', clientContext)
    .replace('{{COMPETITOR_NAME}}', signal.competitor)
    .replace('{{SIGNAL_TYPE}}', signal.type)
    .replace('{{SIGNAL_DATA}}', signal.data);

  try {
    const message = await client.messages.create({
      model:      MODEL,
      max_tokens: 600,
      messages:   [{ role: 'user', content: prompt }],
    });

    const raw     = message.content[0]?.text?.trim() || '';
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    return { ok: true, analysis: JSON.parse(cleaned) };
  } catch (err) {
    if (attempt < 2) {
      await new Promise(r => setTimeout(r, 2000));
      return analyseSignal(signal, clientContext, attempt + 1);
    }
    return { ok: false, error: err.message, signal };
  }
}

// ── Main (can be called directly or imported) ─────────────────────────────────
export async function runAnalysis(clientId, signals, clientConfig) {
  const clientContext = buildClientContext(clientConfig);
  const analyses  = [];
  const failures  = [];

  console.log(`\n🧠  Analysing ${signals.length} signals via Claude...`);

  for (let i = 0; i < signals.length; i++) {
    const signal = signals[i];
    process.stdout.write(`    [${i + 1}/${signals.length}] ${signal.competitor} / ${signal.type} ... `);

    const result = await analyseSignal(signal, clientContext);

    if (result.ok) {
      analyses.push(result.analysis);
      const count = result.analysis.findings?.length || 0;
      process.stdout.write(`✅  (${count} finding${count !== 1 ? 's' : ''})\n`);
    } else {
      failures.push(result);
      process.stdout.write(`❌  ${result.error}\n`);
    }

    if (i < signals.length - 1) await new Promise(r => setTimeout(r, DELAY));
  }

  // Save analyses
  const dataDir = path.join(ROOT, 'data', clientId);
  fs.mkdirSync(dataDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath   = path.join(dataDir, `analyses-${timestamp}.json`);

  fs.writeFileSync(outPath, JSON.stringify({
    meta: { analysedAt: new Date().toISOString(), clientId, total: analyses.length, failures: failures.length },
    analyses,
    failures,
  }, null, 2));

  console.log(`\n📁  Analyses saved → data/${clientId}/analyses-${timestamp}.json`);
  return { analyses, outPath };
}
