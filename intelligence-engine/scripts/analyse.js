/**
 * Analysis Engine — Claude processes all collected signals
 * ─────────────────────────────────────────────────────────
 * Reads raw signals from data/[clientId]/raw-signals-[timestamp].json
 * Per signal: (1) Analyst — extracts findings as JSON array; (2) Fact-checker — drops
 * anything not explicitly supported by raw scraped text. Report HTML uses verified analyses.
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
const MODEL  = process.env.ANALYSIS_MODEL?.trim() || 'claude-opus-4-7';
const DELAY  = 1000;
/** Large enough for long jobs / funding blobs without mid-string truncation. */
const MAX_TOKENS = 4096;
const ANALYSIS_THINKING_BUDGET_TOKENS = parseInt(
  process.env.ANALYSIS_THINKING_BUDGET_TOKENS || '',
  10,
) || 12000;

const ANALYST_JSON_SUFFIX = `

CRITICAL — JSON OUTPUT RULES:
- Return ONLY a JSON array [...] of finding objects. No markdown fences, no wrapper object, no commentary.
- Every string value must be valid JSON: escape internal double quotes as \\" and use \\n for newlines.
- Keep each string field under 800 characters so the response is not truncated mid-string.`;

const FACT_CHECKER_JSON_SUFFIX = `

CRITICAL — JSON OUTPUT RULES:
- Return ONLY a JSON array [...] (possibly empty). Same finding object shape as the analyst input. No markdown, no commentary.`;

const JSON_FIX_PREFIX_ANALYST = `Fix the text below into ONE valid JSON array only (no markdown). Each element: headline, detail, implication, talkTrack or null, urgency, isTriggerEvent, evidenceBasis, sourceConfidence.

INVALID OUTPUT TO FIX:

`;

const JSON_FIX_PREFIX_FACT_CHECK = `Fix the text below into ONE valid JSON array only (no markdown). Empty array [] is valid.

INVALID OUTPUT TO FIX:

`;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌  ANTHROPIC_API_KEY missing from .env');
  process.exit(1);
}

const promptTemplate     = fs.readFileSync(path.join(ROOT, 'prompts', 'signal-analyst.txt'), 'utf8');
const factCheckerTemplate = fs.readFileSync(path.join(ROOT, 'prompts', 'signal-fact-checker.txt'), 'utf8');

const MAX_SIGNAL_CHARS = 18000;
const FACT_CHECKER_SYSTEM = [
  'You are a ruthless fact-checker. Output only valid JSON arrays. ',
  'If you cannot verify a claim from the provided raw text, you must drop that finding.',
].join('');

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

function truncateSignalData(data) {
  const d = data || '';
  if (d.length <= MAX_SIGNAL_CHARS) return d;
  return `${d.slice(0, MAX_SIGNAL_CHARS)}\n\n[... truncated for model context; full raw signal is in raw-signals export ...]`;
}

function buildAnalystPrompt(signal, clientContext) {
  const data = truncateSignalData(signal.data);
  return promptTemplate
    .replace('{{CLIENT_CONTEXT}}', clientContext)
    .replace('{{COMPETITOR_NAME}}', signal.competitor)
    .replace('{{SIGNAL_TYPE}}', signal.type)
    .replace('{{SIGNAL_DATA}}', data);
}

function buildFactCheckerPrompt(signal, clientContext, analystFindings) {
  const data = truncateSignalData(signal.data);
  return factCheckerTemplate
    .replace('{{CLIENT_CONTEXT}}', clientContext)
    .replace('{{COMPETITOR_NAME}}', signal.competitor)
    .replace('{{SIGNAL_TYPE}}', signal.type)
    .replace('{{SIGNAL_DATA}}', data)
    .replace('{{ANALYST_FINDINGS_JSON}}', JSON.stringify(analystFindings, null, 2));
}

/** Extract first top-level JSON array (handles leading junk / trailing text). */
function extractFirstJsonArray(s) {
  const start = s.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === '\\' && inStr) {
      esc = true;
      continue;
    }
    if (ch === '"' && !esc) {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function tryParseFindingsArray(raw) {
  const parsed = tryParseJSON(raw);
  if (parsed.ok) {
    const v = parsed.value;
    if (Array.isArray(v)) return { ok: true, findings: v };
    if (v && typeof v === 'object' && Array.isArray(v.findings)) {
      return { ok: true, findings: v.findings };
    }
  }
  const extracted = extractFirstJsonArray(String(raw || ''));
  if (extracted) {
    try {
      const arr = JSON.parse(extracted);
      if (Array.isArray(arr)) return { ok: true, findings: arr };
    } catch {
      /* fall through */
    }
  }
  const err =
    parsed && parsed.ok === false && parsed.error
      ? parsed.error
      : new Error('Not a findings array');
  return { ok: false, error: err };
}

function normalizeFindingItem(f) {
  if (!f || typeof f !== 'object') return null;
  const o = { ...f };
  if (!o.evidenceBasis) o.evidenceBasis = 'unknown';
  if (!o.sourceConfidence) o.sourceConfidence = 'medium';
  if (o.talkTrack === undefined) o.talkTrack = null;
  if (!['immediate', 'this_week', 'monitor'].includes(o.urgency)) o.urgency = 'monitor';
  return o;
}

function normalizeFindingsList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(normalizeFindingItem).filter(Boolean);
}

function computeTriggerSummary(findings) {
  const triggers = findings.filter((f) => f.isTriggerEvent);
  if (!triggers.length) return null;
  return triggers.map((t) => t.headline).filter(Boolean).join(' ');
}

function assembleAnalysis(signal, findings, verification) {
  const hasSignificantFindings = findings.length > 0;
  return {
    competitorName: signal.competitor,
    signalType: signal.type,
    hasSignificantFindings,
    findings,
    triggerEventSummary: computeTriggerSummary(findings),
    verification,
  };
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

// ── Call 1: analyst extracts findings (may include overreach; fact-checker filters) ──
async function runAnalystPhase(signal, clientContext) {
  const basePrompt = buildAnalystPrompt(signal, clientContext);
  const variants = [basePrompt, basePrompt + ANALYST_JSON_SUFFIX];
  let lastRaw = '';
  let lastError = 'Invalid JSON from analyst';

  for (const prompt of variants) {
    for (let apiAttempt = 0; apiAttempt < 3; apiAttempt++) {
      try {
        const request = {
          model:      MODEL,
          max_tokens: MAX_TOKENS,
          messages:   [{ role: 'user', content: prompt }],
        };
        if (ANALYSIS_THINKING_BUDGET_TOKENS > 0) {
          request.thinking = {
            type: 'enabled',
            budget_tokens: ANALYSIS_THINKING_BUDGET_TOKENS,
          };
        }
        const message = await client.messages.create({
          ...request,
        });
        const raw = message.content[0]?.text?.trim() || '';
        lastRaw = raw;
        const parsed = tryParseFindingsArray(raw);
        if (parsed.ok) {
          return { ok: true, findings: normalizeFindingsList(parsed.findings) };
        }
        lastError = (parsed.error && parsed.error.message) || 'Analyst output not a findings array';
        break;
      } catch (err) {
        lastError = err.message;
        if (apiAttempt < 2) await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  if (lastRaw && lastRaw.length < 12000) {
    try {
      const fixRequest = {
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        messages:   [{ role: 'user', content: JSON_FIX_PREFIX_ANALYST + lastRaw }],
      };
      if (ANALYSIS_THINKING_BUDGET_TOKENS > 0) {
        fixRequest.thinking = {
          type: 'enabled',
          budget_tokens: ANALYSIS_THINKING_BUDGET_TOKENS,
        };
      }
      const fixMsg = await client.messages.create({
        ...fixRequest,
      });
      const fixed = fixMsg.content[0]?.text?.trim() || '';
      const parsed = tryParseFindingsArray(fixed);
      if (parsed.ok) {
        return { ok: true, findings: normalizeFindingsList(parsed.findings) };
      }
      lastError = 'Analyst JSON repair pass failed';
    } catch (err) {
      lastError = err.message;
    }
  }

  return { ok: false, error: lastError };
}

// ── Call 2: fact-checker keeps only claims grounded in raw signal text ──
async function runFactCheckerPhase(signal, clientContext, analystFindings) {
  if (!analystFindings.length) {
    return { ok: true, findings: [] };
  }

  const basePrompt = buildFactCheckerPrompt(signal, clientContext, analystFindings);
  const variants = [basePrompt, basePrompt + FACT_CHECKER_JSON_SUFFIX];
  let lastRaw = '';
  let lastError = 'Invalid JSON from fact-checker';

  for (const prompt of variants) {
    for (let apiAttempt = 0; apiAttempt < 3; apiAttempt++) {
      try {
        const request = {
          model:      MODEL,
          max_tokens: MAX_TOKENS,
          system:     FACT_CHECKER_SYSTEM,
          messages:   [{ role: 'user', content: prompt }],
        };
        if (ANALYSIS_THINKING_BUDGET_TOKENS > 0) {
          request.thinking = {
            type: 'enabled',
            budget_tokens: ANALYSIS_THINKING_BUDGET_TOKENS,
          };
        }
        const message = await client.messages.create({
          ...request,
        });
        const raw = message.content[0]?.text?.trim() || '';
        lastRaw = raw;
        const parsed = tryParseFindingsArray(raw);
        if (parsed.ok) {
          return { ok: true, findings: normalizeFindingsList(parsed.findings) };
        }
        lastError = (parsed.error && parsed.error.message) || 'Fact-checker output not a findings array';
        break;
      } catch (err) {
        lastError = err.message;
        if (apiAttempt < 2) await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  if (lastRaw && lastRaw.length < 12000) {
    try {
      const fixRequest = {
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        system:     FACT_CHECKER_SYSTEM,
        messages:   [{ role: 'user', content: JSON_FIX_PREFIX_FACT_CHECK + lastRaw }],
      };
      if (ANALYSIS_THINKING_BUDGET_TOKENS > 0) {
        fixRequest.thinking = {
          type: 'enabled',
          budget_tokens: ANALYSIS_THINKING_BUDGET_TOKENS,
        };
      }
      const fixMsg = await client.messages.create({
        ...fixRequest,
      });
      const fixed = fixMsg.content[0]?.text?.trim() || '';
      const parsed = tryParseFindingsArray(fixed);
      if (parsed.ok) {
        return { ok: true, findings: normalizeFindingsList(parsed.findings) };
      }
      lastError = 'Fact-checker JSON repair pass failed';
    } catch (err) {
      lastError = err.message;
    }
  }

  return { ok: false, error: lastError };
}

async function analyseSignal(signal, clientContext) {
  const analystResult = await runAnalystPhase(signal, clientContext);
  if (!analystResult.ok) {
    return {
      ok: false,
      error: analystResult.error,
      signal,
      analysis: buildPipelineFallbackAnalysis(signal, analystResult.error),
    };
  }

  await new Promise((r) => setTimeout(r, 400));

  const checked = await runFactCheckerPhase(signal, clientContext, analystResult.findings);
  const analystCount = analystResult.findings.length;

  if (!checked.ok) {
    const verification = {
      status: 'fact_check_failed',
      analystFindings: analystCount,
      verifiedFindings: 0,
      droppedCount: null,
      error: String(checked.error || '').slice(0, 240),
    };
    return {
      ok: true,
      analysis: assembleAnalysis(signal, [], verification),
      usedFallback: false,
    };
  }

  const verified = checked.findings;
  const verification = {
    status: 'ok',
    analystFindings: analystCount,
    verifiedFindings: verified.length,
    droppedCount: Math.max(0, analystCount - verified.length),
  };

  return {
    ok: true,
    analysis: assembleAnalysis(signal, verified, verification),
    usedFallback: false,
  };
}

// ── Main (can be called directly or imported) ─────────────────────────────────
export async function runAnalysis(clientId, signals, clientConfig) {
  const clientContext = buildClientContext(clientConfig);
  const analyses  = [];
  const failures  = [];
  let parseFailures = 0;
  let factCheckFailures = 0;
  let totalAnalystFindings = 0;
  let totalVerifiedFindings = 0;

  console.log(`\n🧠  Analysing ${signals.length} signals via Claude (analyst → fact-checker)...`);

  for (let i = 0; i < signals.length; i++) {
    const signal = signals[i];
    process.stdout.write(`    [${i + 1}/${signals.length}] ${signal.competitor} / ${signal.type} ... `);

    const result = await analyseSignal(signal, clientContext);

    if (result.ok) {
      analyses.push(result.analysis);
      const count = result.analysis.findings?.length || 0;
      const v = result.analysis.verification;
      if (v?.status === 'fact_check_failed') {
        factCheckFailures++;
        totalAnalystFindings += v.analystFindings || 0;
        process.stdout.write(`⚠️  fact-check failed — 0 verified (${v.error})\n`);
      } else if (v && typeof v.analystFindings === 'number') {
        totalAnalystFindings += v.analystFindings;
        totalVerifiedFindings += count;
        process.stdout.write(`✅  (${v.analystFindings} → ${count} verified)\n`);
      } else {
        totalVerifiedFindings += count;
        process.stdout.write(`✅  (${count} finding${count !== 1 ? 's' : ''})\n`);
      }
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
      factCheckFailures,
    },
    analyses,
    failures,
  }, null, 2));

  const droppedTotal = Math.max(0, totalAnalystFindings - totalVerifiedFindings);
  console.log(`\n📊  Verification summary:`);
  console.log(`    Analyst findings: ${totalAnalystFindings}  →  Verified: ${totalVerifiedFindings}  →  Dropped: ${droppedTotal}`);
  if (parseFailures > 0)     console.log(`    ⚠️  Analyst parse failures: ${parseFailures}`);
  if (factCheckFailures > 0) console.log(`    ⚠️  Fact-check failures:    ${factCheckFailures}`);
  console.log(`\n📁  Analyses saved → data/${clientId}/analyses-${timestamp}.json`);
  return { analyses, outPath, meta: { parseFailures, factCheckFailures, totalSignals: signals.length } };
}
