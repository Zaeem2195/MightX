/**
 * Analysis Engine — Claude processes all collected signals
 * ─────────────────────────────────────────────────────────
 * Reads raw signals from data/[clientId]/raw-signals-[timestamp].json
 * Sends each signal to Claude for strategic analysis
 * Saves analyses to data/[clientId]/analyses-[timestamp].json
 *
 * Every signal yields one analysis object (never silently dropped).
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { tryParseJSON } from './collectors/_utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL  = 'claude-sonnet-4-6';
const DELAY  = 1000;
/** Large enough for long jobs / funding blobs without mid-string truncation. */
const MAX_TOKENS = 4096;

const STRICT_JSON_SUFFIX = `

CRITICAL — JSON OUTPUT RULES:
- Return ONLY a single JSON object. No markdown fences, no commentary before or after.
- Every string value must be valid JSON: escape internal double quotes as \\" and use \\n for newlines.
- Keep each string field under 800 characters so the response is not truncated mid-string.`;

const JSON_FIX_PREFIX = `Fix the text below into ONE valid JSON object only (no markdown). Required shape:
{"competitorName":"string","signalType":"string","hasSignificantFindings":boolean,"findings":[{"headline":"string","detail":"string","implication":"string","talkTrack":stringOrNull,"urgency":"immediate|this_week|monitor","isTriggerEvent":boolean,"evidenceBasis":"first_party|third_party_press|search_snippet|aggregator|inferred|unknown","sourceConfidence":"high|medium|low"}],"triggerEventSummary":stringOrNull}

INVALID OUTPUT TO FIX:

`;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌  ANTHROPIC_API_KEY missing from .env');
  process.exit(1);
}

const promptTemplate = fs.readFileSync(
  path.join(ROOT, 'prompts', 'signal-analyst.txt'), 'utf8'
);

const MAX_SIGNAL_CHARS = 18000;

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

function buildPrompt(signal, clientContext) {
  let data = signal.data || '';
  if (data.length > MAX_SIGNAL_CHARS) {
    data = `${data.slice(0, MAX_SIGNAL_CHARS)}\n\n[... truncated for model context; full raw signal is in raw-signals export ...]`;
  }
  return promptTemplate
    .replace('{{CLIENT_CONTEXT}}', clientContext)
    .replace('{{COMPETITOR_NAME}}', signal.competitor)
    .replace('{{SIGNAL_TYPE}}', signal.type)
    .replace('{{SIGNAL_DATA}}', data);
}

/**
 * When the model fails JSON, still emit a structured row so the report never loses a signal.
 */
function normalizeAnalysisObject(obj, signal) {
  if (!obj || typeof obj !== 'object') return null;
  if (!Array.isArray(obj.findings)) return null;
  obj.competitorName = obj.competitorName || signal.competitor;
  obj.signalType = obj.signalType || signal.type;
  for (const f of obj.findings) {
    if (!f || typeof f !== 'object') continue;
    if (!f.evidenceBasis) f.evidenceBasis = 'unknown';
    if (!f.sourceConfidence) f.sourceConfidence = 'medium';
  }
  return obj;
}

function buildPipelineFallbackAnalysis(signal, lastError) {
  const preview = String(signal.data || '')
    .replace(/\s+/g, ' ')
    .slice(0, 420);
  return {
    competitorName: signal.competitor,
    signalType: signal.type,
    hasSignificantFindings: false,
    pipelineNote: 'analysis_parse_failed',
    pipelineError: String(lastError || 'Invalid JSON').slice(0, 200),
    findings: [
      {
        headline: `Automated analysis did not complete for ${signal.type} (pipeline)`,
        detail:
          `Raw signal data was collected but the model output could not be parsed as JSON. ` +
          `This is an internal processing limitation for this run — not a competitor event. ` +
          (preview ? `Data preview: ${preview}${preview.length >= 420 ? '…' : ''}` : 'No text preview available.'),
        implication:
          'Skim the raw signal in your dashboard or raw-signals export if this source matters for active deals. Do not change battlecards based solely on this row.',
        talkTrack: null,
        urgency: 'monitor',
        isTriggerEvent: false,
        evidenceBasis: 'pipeline_error',
        sourceConfidence: 'low',
      },
    ],
    triggerEventSummary: null,
  };
}

// ── Analyse one signal with Claude ───────────────────────────────────────────
async function analyseSignal(signal, clientContext) {
  const basePrompt = buildPrompt(signal, clientContext);
  const promptVariants = [basePrompt, basePrompt + STRICT_JSON_SUFFIX];

  let lastRaw = '';
  let lastError = 'Invalid JSON from model';

  for (const prompt of promptVariants) {
    for (let apiAttempt = 0; apiAttempt < 3; apiAttempt++) {
      try {
        const message = await client.messages.create({
          model:      MODEL,
          max_tokens: MAX_TOKENS,
          messages:   [{ role: 'user', content: prompt }],
        });

        const raw = message.content[0]?.text?.trim() || '';
        lastRaw = raw;
        const parsed = tryParseJSON(raw);

        if (parsed.ok) {
          const norm = normalizeAnalysisObject(parsed.value, signal);
          if (norm) {
            return { ok: true, analysis: norm, usedFallback: false };
          }
          lastError = 'Analysis JSON missing findings array';
          break;
        }
        lastError = (parsed.error && parsed.error.message) || 'JSON parse failed after repair attempts';
        break;
      } catch (err) {
        lastError = err.message;
        if (apiAttempt < 2) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }
  }

  // One repair pass: ask model to fix its own broken JSON (short context)
  if (lastRaw && lastRaw.length < 12000) {
    try {
      const fixMsg = await client.messages.create({
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        messages:   [{ role: 'user', content: JSON_FIX_PREFIX + lastRaw }],
      });
      const fixed = fixMsg.content[0]?.text?.trim() || '';
      const parsed = tryParseJSON(fixed);
      if (parsed.ok) {
        const norm = normalizeAnalysisObject(parsed.value, signal);
        if (norm) {
          return { ok: true, analysis: norm, usedFallback: false };
        }
      }
      lastError = 'JSON repair pass failed';
    } catch (err) {
      lastError = err.message;
    }
  }

  return {
    ok: false,
    error: lastError,
    signal,
    analysis: buildPipelineFallbackAnalysis(signal, lastError),
  };
}

// ── Main (can be called directly or imported) ─────────────────────────────────
export async function runAnalysis(clientId, signals, clientConfig) {
  const clientContext = buildClientContext(clientConfig);
  const analyses  = [];
  const failures  = [];
  let parseFailures = 0;

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
      parseFailures++;
      analyses.push(result.analysis);
      failures.push({ ok: false, error: result.error, signal: result.signal });
      process.stdout.write(`⚠️  fallback (${result.error})\n`);
    }

    if (i < signals.length - 1) await new Promise((r) => setTimeout(r, DELAY));
  }

  const dataDir = path.join(ROOT, 'data', clientId);
  fs.mkdirSync(dataDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath   = path.join(dataDir, `analyses-${timestamp}.json`);

  fs.writeFileSync(outPath, JSON.stringify({
    meta: {
      analysedAt: new Date().toISOString(),
      clientId,
      totalSignals: signals.length,
      analysesWritten: analyses.length,
      parseFailures,
    },
    analyses,
    failures,
  }, null, 2));

  console.log(`\n📁  Analyses saved → data/${clientId}/analyses-${timestamp}.json`);
  return { analyses, outPath, meta: { parseFailures, totalSignals: signals.length } };
}
