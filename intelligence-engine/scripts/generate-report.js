/**
 * Report Generator — Claude writes the HTML briefing
 * ────────────────────────────────────────────────────
 * Takes all analyses → Claude synthesises into structured report JSON →
 * Injects into HTML template → saves final HTML report
 *
 * Outputs (monorepo):
 * - Primary: intelligence-engine/data/<clientId>/report-*.html + report-content-*.json
 * - Mirror:  brief-app/public/<clientId>-report-*.html + brief-app/data/<clientId>/report-content-*.json
 *   (so Vercel can deploy `brief-app` alone with static HTML + JSON for `/brief` — see brief-app/lib/brief-loader.ts)
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { tryParseJSON } from './collectors/_utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
/** Monorepo sibling: mirrored artifacts for Vercel (`brief-app` root as deploy target). */
const BRIEF_APP_ROOT = path.join(ROOT, '..', 'brief-app');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL  = process.env.REPORT_MODEL?.trim() || 'claude-opus-4-7';
const REPORT_MAX_TOKENS = 8192;
const REPORT_THINKING_BUDGET_TOKENS = parseInt(
  process.env.REPORT_THINKING_BUDGET_TOKENS || '',
  10,
) || 16000;

const REPORT_JSON_SUFFIX = `

CRITICAL — OUTPUT RULES:
- Return ONLY one JSON object. No markdown fences.
- Escape all double quotes inside strings as \\".
- Keep each string field concise so the full JSON fits in one response.`;

const reportPrompt    = fs.readFileSync(path.join(ROOT, 'prompts', 'report-writer.txt'), 'utf8');
const deepDivePrompt  = fs.readFileSync(path.join(ROOT, 'prompts', 'deep-dive-writer.txt'), 'utf8');
const htmlTemplate    = fs.readFileSync(path.join(ROOT, 'templates', 'report.html'), 'utf8');
const deepDiveTemplate = fs.readFileSync(path.join(ROOT, 'templates', 'report-deep-dive.html'), 'utf8');

const ROLLING_HISTORY_WEEKS = parseInt(process.env.ROLLING_HISTORY_WEEKS || '', 10) || 8;

function escapeHtml(s) {
  if (s == null || s === '') return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildPipelineMeta(analyses) {
  const byType = {};
  let fallbackCount = 0;
  const fallbackList = [];
  let factCheckFailed = 0;
  const factCheckFailedList = [];
  for (const a of analyses || []) {
    const t = a.signalType || 'unknown';
    byType[t] = (byType[t] || 0) + 1;
    if (a.pipelineNote === 'analysis_parse_failed') {
      fallbackCount++;
      fallbackList.push(`${a.competitorName || '?'}/${t}`);
    }
    if (a.verification?.status === 'fact_check_failed') {
      factCheckFailed++;
      factCheckFailedList.push(`${a.competitorName || '?'}/${t}`);
    }
  }
  const typeLine = Object.keys(byType)
    .sort()
    .map((k) => `${k}: ${byType[k]}`)
    .join('; ');
  return {
    totalSignals: (analyses || []).length,
    pipelineFallbackCount: fallbackCount,
    signalTypesTallies: typeLine || 'none',
    pipelineFallbackExamples: fallbackList.slice(0, 12),
    factCheckFailed,
    factCheckFailedExamples: factCheckFailedList.slice(0, 12),
  };
}

function formatPipelineMetaForPrompt(meta) {
  const factLine =
    meta.factCheckFailed > 0
      ? `Fact-check phase failed (no verified findings kept): ${meta.factCheckFailed} — ${meta.factCheckFailedExamples.join(', ')}`
      : 'Fact-check phase: all signals completed (or analyst empty / N/A).';
  return [
    `Total analysed signal rows: ${meta.totalSignals}`,
    `Automated analysis fallbacks (JSON parse): ${meta.pipelineFallbackCount}`,
    factLine,
    `Signals by type: ${meta.signalTypesTallies}`,
    meta.pipelineFallbackExamples.length
      ? `Fallback rows (competitor/type): ${meta.pipelineFallbackExamples.join(', ')}`
      : 'No pipeline fallbacks this run.',
  ].join('\n');
}

// ── Format week string ────────────────────────────────────────────────────────
function weekString() {
  const now   = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - now.getDay() + 1);   // Monday
  return start.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * Load the most recent prior report-content JSON for a client so Claude can
 * produce a "What changed since last week" section grounded in what we
 * actually told the client last Monday. Returns null if no prior report.
 */
function loadPriorReportContent(clientId) {
  const dataDir = path.join(ROOT, 'data', clientId);
  if (!fs.existsSync(dataDir)) return null;

  const files = fs
    .readdirSync(dataDir)
    .filter((f) => f.startsWith('report-content-') && f.endsWith('.json'))
    .sort();

  if (!files.length) return null;

  const latest = files[files.length - 1];
  try {
    const raw = fs.readFileSync(path.join(dataDir, latest), 'utf8');
    return { file: latest, content: JSON.parse(raw) };
  } catch {
    return null;
  }
}

/**
 * Compact the prior report into a small text block Claude can use for
 * continuity without blowing the prompt budget. We include only the fields
 * that matter for "what did we tell them last week".
 */
function formatPriorReportForPrompt(prior) {
  if (!prior?.content) return 'No prior report on file for this client.';

  const c = prior.content;
  const lines = [];
  lines.push(`Prior report file: ${prior.file}`);

  if (c.weekSummary) {
    lines.push('');
    lines.push('Prior week summary:');
    lines.push(c.weekSummary);
  }

  if (c.topAlert?.exists && c.topAlert?.headline) {
    lines.push('');
    lines.push(`Prior top alert: ${c.topAlert.headline}`);
    if (c.topAlert.detail) lines.push(c.topAlert.detail);
  }

  if (Array.isArray(c.competitorSections) && c.competitorSections.length) {
    lines.push('');
    lines.push('Prior competitor summary lines:');
    for (const s of c.competitorSections) {
      if (!s?.hasFindings) continue;
      const head = s.competitorName || '?';
      const summary = s.summaryLine || '';
      lines.push(`- ${head}: ${summary}`);
      const findingHeads = (s.findings || [])
        .map((f) => f?.headline)
        .filter(Boolean)
        .slice(0, 3);
      for (const h of findingHeads) {
        lines.push(`    • ${h}`);
      }
    }
  }

  if (Array.isArray(c.watchNextWeek) && c.watchNextWeek.length) {
    lines.push('');
    lines.push('Prior "watch next week" items:');
    for (const w of c.watchNextWeek.slice(0, 8)) lines.push(`- ${w}`);
  }

  return lines.join('\n');
}

/**
 * Load the last N report-content JSON files for this client (excluding the
 * freshest "prior" which is handled separately). Returns ordered oldest→newest
 * so the reader can see momentum over time. Never throws — missing files just
 * produce an empty list.
 */
function loadRollingHistory(clientId, weeks = ROLLING_HISTORY_WEEKS) {
  const dataDir = path.join(ROOT, 'data', clientId);
  if (!fs.existsSync(dataDir)) return [];

  const files = fs
    .readdirSync(dataDir)
    .filter((f) => f.startsWith('report-content-') && f.endsWith('.json'))
    .sort();

  const slice = files.slice(Math.max(0, files.length - weeks));
  const out = [];
  for (const f of slice) {
    try {
      const raw = fs.readFileSync(path.join(dataDir, f), 'utf8');
      out.push({ file: f, content: JSON.parse(raw) });
    } catch {
      /* ignore unreadable file */
    }
  }
  return out;
}

/**
 * Deterministic pattern detection over the rolling history. We run this
 * locally (not via Claude) so the client-visible "recurring themes" and
 * "momentum shifts" cannot be hallucinated by the model and have clear
 * provenance: they are literally counts over the prior reports.
 *
 * @returns {{
 *   recurringThemes: Array<{ competitor: string, count: number, weeks: string[] }>,
 *   quietCompetitors: Array<{ competitor: string, silentWeeks: number }>,
 *   weekCount: number,
 * }}
 */
function computeLocalPatterns(rollingHistory) {
  if (!rollingHistory.length) {
    return { recurringThemes: [], quietCompetitors: [], weekCount: 0 };
  }

  const weekCount = rollingHistory.length;
  const competitorActivity = new Map();  // name → [{weekIdx, findingsCount, summaryLine}]
  const competitorHeadlineCounts = new Map(); // competitor+headline theme → {count, weeks}

  rollingHistory.forEach((r, idx) => {
    const sections = Array.isArray(r.content?.competitorSections) ? r.content.competitorSections : [];
    for (const s of sections) {
      const name = String(s?.competitorName || '').trim();
      if (!name) continue;

      const findingsCount = Array.isArray(s?.findings) ? s.findings.length : 0;

      if (!competitorActivity.has(name)) competitorActivity.set(name, []);
      competitorActivity.get(name).push({
        weekIdx: idx,
        findingsCount,
        hasFindings: !!s?.hasFindings,
        summaryLine: s?.summaryLine || '',
        file: r.file,
      });

      if (!Array.isArray(s?.findings)) continue;
      for (const f of s.findings) {
        const headline = String(f?.headline || '').toLowerCase();
        // Extract rough theme: first 4 significant words of headline
        const theme = headline
          .replace(/[^\w\s]/g, ' ')
          .split(/\s+/)
          .filter((w) => w.length > 3)
          .slice(0, 3)
          .join(' ');
        if (!theme) continue;

        const key = `${name}|${theme}`;
        if (!competitorHeadlineCounts.has(key)) {
          competitorHeadlineCounts.set(key, { competitor: name, theme, count: 0, weeks: [] });
        }
        const entry = competitorHeadlineCounts.get(key);
        entry.count += 1;
        entry.weeks.push(r.file);
      }
    }
  });

  const recurringThemes = [...competitorHeadlineCounts.values()]
    .filter((e) => e.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  const quietCompetitors = [];
  for (const [name, activity] of competitorActivity.entries()) {
    const lastLoudIdx = [...activity].reverse().find((a) => a.hasFindings)?.weekIdx;
    if (lastLoudIdx === undefined) continue; // never loud in window
    const silentWeeks = weekCount - 1 - lastLoudIdx;
    // count requires: they WERE loud at some point, and have gone 2+ weeks silent
    if (silentWeeks >= 2) {
      quietCompetitors.push({ competitor: name, silentWeeks });
    }
  }

  return { recurringThemes, quietCompetitors, weekCount };
}

function formatRollingHistoryForPrompt(rollingHistory, patterns) {
  if (!rollingHistory.length) return 'No rolling history on file — this is among the first runs for this client.';

  const lines = [];
  lines.push(`Weeks on file: ${rollingHistory.length}`);
  lines.push('');
  lines.push('Compact per-week digest (oldest → newest):');
  for (const r of rollingHistory) {
    const c = r.content || {};
    lines.push(`- [${r.file}] summary: ${String(c.weekSummary || '').slice(0, 200)}`);
    const topAlert = c.topAlert?.exists && c.topAlert?.headline ? ` · top alert: ${c.topAlert.headline}` : '';
    if (topAlert) lines.push(`   ${topAlert.trim()}`);
  }

  if (patterns.recurringThemes.length) {
    lines.push('');
    lines.push('Computed recurring themes (competitor + approx theme, count over the window):');
    for (const t of patterns.recurringThemes) {
      lines.push(`- ${t.competitor} — "${t.theme}" appeared ${t.count} weeks (${t.weeks.length} files)`);
    }
  }
  if (patterns.quietCompetitors.length) {
    lines.push('');
    lines.push('Computed "quiet" competitors (were loud, silent for 2+ weeks):');
    for (const q of patterns.quietCompetitors) {
      lines.push(`- ${q.competitor} — silent ${q.silentWeeks} weeks`);
    }
  }
  lines.push('');
  lines.push('Use this only to spot patterns or momentum. Do not rehash findings the reader already saw.');
  return lines.join('\n');
}

function formatRichnessForPrompt(richness) {
  if (!richness) return 'Richness scorer did not run this week.';
  return [
    `Tier: ${richness.tier} (score ${richness.score})`,
    `Trigger points: ${richness.breakdown?.triggerPoints ?? 0}`,
    `Verified findings: ${richness.breakdown?.findingPoints ?? 0} pts across ${richness.breakdown?.distinctCompetitorsWithFindings ?? 0} competitor(s) and ${richness.breakdown?.distinctSignalTypesWithFindings ?? 0} signal type(s)`,
    `Recommended artifact: ${richness.recommendedArtifact}`,
  ].join('\n');
}

// ── Build client context string ───────────────────────────────────────────────
function buildClientContext(cfg) {
  const c = cfg.context;
  return [
    `Product: ${c.clientProduct}`,
    `ICP: ${c.clientICP}`,
    `Differentiators: ${c.clientDifferentiators.join(', ')}`,
    `Weaknesses: ${c.clientWeaknesses?.join(', ') || 'none specified'}`,
  ].join('\n');
}

// ── Ask Claude to write the report ────────────────────────────────────────────
async function writeReportContent(clientConfig, analyses, priorReport, rollingHistory, richness) {
  const week    = weekString();
  const context = buildClientContext(clientConfig);
  const pipelineMeta = buildPipelineMeta(analyses);
  const priorReportBlock = formatPriorReportForPrompt(priorReport);
  const patterns = computeLocalPatterns(rollingHistory || []);
  const rollingBlock = formatRollingHistoryForPrompt(rollingHistory || [], patterns);
  const richnessBlock = formatRichnessForPrompt(richness);

  const basePrompt = reportPrompt
    .replace('{{CLIENT_NAME}}', clientConfig.name)
    .replace('{{REPORT_WEEK}}', week)
    .replace('{{TONE}}', clientConfig.reportPreferences?.tone || 'strategic and direct')
    .replace('{{CLIENT_CONTEXT}}', context)
    .replace('{{PIPELINE_META}}', formatPipelineMetaForPrompt(pipelineMeta))
    .replace('{{PRIOR_WEEK_REPORT}}', priorReportBlock)
    .replace('{{ROLLING_HISTORY}}', rollingBlock)
    .replace('{{RICHNESS_SUMMARY}}', richnessBlock)
    .replace('{{ALL_ANALYSES}}', JSON.stringify(analyses, null, 2));

  const variants = [basePrompt, basePrompt + REPORT_JSON_SUFFIX];

  for (const prompt of variants) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const request = {
          model:      MODEL,
          max_tokens: REPORT_MAX_TOKENS,
          messages:   [{ role: 'user', content: prompt }],
        };
        if (REPORT_THINKING_BUDGET_TOKENS > 0) {
          request.thinking = {
            type: 'enabled',
            budget_tokens: REPORT_THINKING_BUDGET_TOKENS,
          };
        }
        const message = await client.messages.create({
          ...request,
        });

        const raw = message.content[0]?.text?.trim() || '';
        const parsed = tryParseJSON(raw);
        if (parsed.ok) {
          const v = parsed.value;
          if (!v.coverageSummary) {
            v.coverageSummary =
              pipelineMeta.pipelineFallbackCount > 0
                ? `This week ${pipelineMeta.totalSignals} signal batches were analysed; ${pipelineMeta.pipelineFallbackCount} required a pipeline fallback — see Data gaps.`
                : `This week ${pipelineMeta.totalSignals} signal batches were analysed successfully across all configured sources.`;
          }
          if (!Array.isArray(v.dataGapsThisWeek)) v.dataGapsThisWeek = [];
          if (!Array.isArray(v.mondayActionPlan)) v.mondayActionPlan = [];
          if (!Array.isArray(v.objectionHandling)) v.objectionHandling = [];
          if (!Array.isArray(v.accountTargeting)) v.accountTargeting = [];
          if (!v.mondayActionPlan.length && v.salesPlayThisWeek) {
            v.mondayActionPlan.push({
              priority: 'P1',
              owner: 'Sales Manager',
              action: 'Share the weekly sales play with reps before pipeline review.',
              whyNow: 'The report identified a useful sales play but did not break it into owner-level actions.',
              assetOrTalkTrack: v.salesPlayThisWeek,
            });
          }
          if (!priorReport) {
            v.changesSinceLastWeek = { exists: false };
          } else if (!v.changesSinceLastWeek || typeof v.changesSinceLastWeek !== 'object') {
            v.changesSinceLastWeek = { exists: false };
          }
          const haveEnoughHistory = (rollingHistory || []).length >= 2;
          if (!haveEnoughHistory) {
            v.rollingHistory = { exists: false };
          } else if (!v.rollingHistory || typeof v.rollingHistory !== 'object') {
            v.rollingHistory = { exists: false };
          }
          if (pipelineMeta.pipelineFallbackCount > 0) {
            const fb = `Pipeline: automated JSON parse failed for ${pipelineMeta.pipelineFallbackCount} signal(s) — raw data available in exports; human skim recommended.`;
            if (!v.dataGapsThisWeek.some((g) => String(g).includes('Pipeline'))) {
              v.dataGapsThisWeek.push(fb);
            }
          }
          if (pipelineMeta.factCheckFailed > 0) {
            const fb = `Verification: fact-check step could not produce verified findings for ${pipelineMeta.factCheckFailed} signal batch(es) — re-run analysis or human-review raw signals for those competitors.`;
            if (!v.dataGapsThisWeek.some((g) => String(g).includes('Verification: fact-check'))) {
              v.dataGapsThisWeek.push(fb);
            }
          }
          return v;
        }
        break;
      } catch {
        if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  throw new Error('Could not parse valid report JSON from model after retries');
}

// ── Deep-dive writer (silent-week fallback) ──────────────────────────────────
const DEEP_DIVE_TOPIC_LABELS = {
  'positioning-teardown': 'Positioning Teardown',
  'pricing-forensics':    'Pricing Forensics',
  'hiring-signals':       'Hiring Signals Read-Through',
  'scenario-essay':       'Scenario Essay',
  'meta-analysis':        'Cross-Competitor Meta-Analysis',
};

function deepDiveTopicLabel(topic) {
  return DEEP_DIVE_TOPIC_LABELS[topic] || 'Deep Dive';
}

async function writeDeepDiveContent(clientConfig, analyses, priorReport, rollingHistory, richness, topic) {
  const week    = weekString();
  const context = buildClientContext(clientConfig);
  const pipelineMeta = buildPipelineMeta(analyses);
  const priorReportBlock = formatPriorReportForPrompt(priorReport);
  const patterns = computeLocalPatterns(rollingHistory || []);
  const rollingBlock = formatRollingHistoryForPrompt(rollingHistory || [], patterns);
  const richnessBlock = formatRichnessForPrompt(richness);

  const topicSafe = topic && DEEP_DIVE_TOPIC_LABELS[topic] ? topic : 'meta-analysis';

  const basePrompt = deepDivePrompt
    .replace('{{CLIENT_NAME}}', clientConfig.name)
    .replace('{{REPORT_WEEK}}', week)
    .replace('{{TONE}}', clientConfig.reportPreferences?.tone || 'strategic and direct')
    .replace('{{DEEP_DIVE_TOPIC}}', topicSafe)
    .replace('{{CLIENT_CONTEXT}}', context)
    .replace('{{PIPELINE_META}}', formatPipelineMetaForPrompt(pipelineMeta))
    .replace('{{RICHNESS_SUMMARY}}', richnessBlock)
    .replace('{{PRIOR_WEEK_REPORT}}', priorReportBlock)
    .replace('{{ROLLING_HISTORY}}', rollingBlock)
    .replace('{{ALL_ANALYSES}}', JSON.stringify(analyses, null, 2));

  const variants = [basePrompt, basePrompt + REPORT_JSON_SUFFIX];

  for (const prompt of variants) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const request = {
          model:      MODEL,
          max_tokens: REPORT_MAX_TOKENS,
          messages:   [{ role: 'user', content: prompt }],
        };
        if (REPORT_THINKING_BUDGET_TOKENS > 0) {
          request.thinking = { type: 'enabled', budget_tokens: REPORT_THINKING_BUDGET_TOKENS };
        }
        const message = await client.messages.create({ ...request });
        const raw = message.content[0]?.text?.trim() || '';
        const parsed = tryParseJSON(raw);
        if (parsed.ok) {
          const v = parsed.value;
          if (!Array.isArray(v.sections)) v.sections = [];
          if (!Array.isArray(v.strategicRecommendations)) v.strategicRecommendations = [];
          if (!Array.isArray(v.watchNextWeek)) v.watchNextWeek = [];
          if (!Array.isArray(v.dataGapsThisWeek)) v.dataGapsThisWeek = [];
          return v;
        }
        break;
      } catch {
        if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  throw new Error('Could not parse valid deep-dive JSON from model after retries');
}

function renderDeepDiveSections(sections) {
  if (!sections?.length) {
    return '<div class="deep-section"><div class="body-text"><em>No analysis sections were produced. Check the raw JSON for details.</em></div></div>';
  }
  return sections.map((s) => {
    const sources = Array.isArray(s?.sources) ? s.sources.filter(Boolean) : [];
    const sourceHtml = sources.length
      ? `<div class="sources"><strong>Sources:</strong> ${
          sources.map((src) => {
            const label = escapeHtml(src?.label || 'Source');
            const date = src?.date ? ` · ${escapeHtml(src.date)}` : '';
            return src?.url
              ? `<a href="${escapeHtml(src.url)}" target="_blank" rel="noopener">${label}</a>${date}`
              : `${label}${date}`;
          }).join(' · ')
        }</div>`
      : '';
    // body may contain minimal HTML — we trust the prompt enforcement, but run a
    // light-weight tag whitelist to prevent scripts.
    const safeBody = String(s?.body || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '');
    return `
      <div class="deep-section">
        <h3>${escapeHtml(s?.title || 'Section')}</h3>
        <div class="body-text">${safeBody}</div>
        ${sourceHtml}
      </div>`;
  }).join('');
}

function renderRecList(items, { className = 'recs' } = {}) {
  if (!items?.length) return '<li><em>None provided.</em></li>';
  return items.filter(Boolean).map((i) => `<li>${escapeHtml(i)}</li>`).join('');
}

function buildDeepDiveHTML(clientConfig, content, topic) {
  const week  = weekString();
  const watch = renderRecList(content.watchNextWeek || [], { className: 'watch-list' });
  const recs  = renderRecList(content.strategicRecommendations || []);

  const dataGapsSection = Array.isArray(content.dataGapsThisWeek) && content.dataGapsThisWeek.length
    ? `
      <div class="section">
        <div class="section-title">Data Gaps</div>
        <ul class="watch-list">${content.dataGapsThisWeek.map((g) => `<li>${escapeHtml(g)}</li>`).join('')}</ul>
      </div>`
    : '';

  return deepDiveTemplate
    .replace(/{{CLIENT_NAME}}/g,         escapeHtml(clientConfig.name))
    .replace('{{REPORT_WEEK}}',          escapeHtml(week))
    .replace('{{DEEP_DIVE_TOPIC_LABEL}}', escapeHtml(deepDiveTopicLabel(topic)))
    .replace('{{HEADLINE_QUESTION}}',    escapeHtml(content.headlineQuestion || 'What is the most important thing we should know from the last 30 days?'))
    .replace('{{EXECUTIVE_ANSWER}}',     escapeHtml(content.executiveAnswer || ''))
    .replace('{{WHY_NOW}}',              escapeHtml(content.whyNow || ''))
    .replace('{{DEEP_SECTIONS}}',        renderDeepDiveSections(content.sections))
    .replace('{{RECOMMENDATIONS}}',      recs)
    .replace('{{SALES_PLAY}}',           escapeHtml(content.salesPlayThisWeek || ''))
    .replace('{{WATCH_LIST}}',           watch)
    .replace('{{DATA_GAPS_SECTION}}',    dataGapsSection)
    .replace('{{COVERAGE_SUMMARY}}',     escapeHtml(content.coverageSummary || ''));
}

// ── Build Top Alert HTML block ────────────────────────────────────────────────
function renderTopAlert(alert) {
  if (!alert?.exists) return '';
  return `
    <div class="section">
      <div class="alert-box">
        <div class="alert-label">&dagger; Trigger Alert &middot; ${alert.urgency === 'immediate' ? 'Act Today' : 'Act This Week'}</div>
        <div class="alert-headline">${escapeHtml(alert.headline)}</div>
        <div class="alert-detail">${escapeHtml(alert.detail)}</div>
      </div>
    </div>`;
}

function renderChangesSinceLastWeek(changes) {
  if (!changes?.exists) return '';

  const progressed = Array.isArray(changes.progressed) ? changes.progressed.filter(Boolean) : [];
  const stillWatching = Array.isArray(changes.stillWatching) ? changes.stillWatching.filter(Boolean) : [];
  const newThisWeek = Array.isArray(changes.newThisWeek) ? changes.newThisWeek.filter(Boolean) : [];

  if (!progressed.length && !stillWatching.length && !newThisWeek.length) return '';

  const group = (label, items) => {
    if (!items.length) return '';
    const lis = items.map((i) => `<li>${escapeHtml(i)}</li>`).join('');
    return `
      <div style="margin-top:16px;">
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif; font-size:10px; font-weight:700; letter-spacing:0.18em; text-transform:uppercase; color:#5b5f66; margin-bottom:8px;">${label}</div>
        <ul class="watch-list">${lis}</ul>
      </div>`;
  };

  return `
    <div class="section">
      <div class="section-title"><span>What Changed Since Last Week</span></div>
      ${group('Progressed or resolved', progressed)}
      ${group('Still watching (no new signal)', stillWatching)}
      ${group('New this week', newThisWeek)}
    </div>`;
}

function renderRollingHistory(rh) {
  if (!rh?.exists) return '';
  const recurring = Array.isArray(rh.recurringThemes) ? rh.recurringThemes.filter(Boolean) : [];
  const momentum  = Array.isArray(rh.momentumShifts)  ? rh.momentumShifts.filter(Boolean)  : [];
  const quiet     = Array.isArray(rh.quietCompetitors) ? rh.quietCompetitors.filter(Boolean) : [];
  if (!recurring.length && !momentum.length && !quiet.length) return '';

  const group = (label, items) => {
    if (!items.length) return '';
    const lis = items.map((i) => `<li>${escapeHtml(i)}</li>`).join('');
    return `
      <div style="margin-top:16px;">
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif; font-size:10px; font-weight:700; letter-spacing:0.18em; text-transform:uppercase; color:#5b5f66; margin-bottom:8px;">${label}</div>
        <ul class="watch-list">${lis}</ul>
      </div>`;
  };

  return `
    <div class="section">
      <div class="section-title"><span>30-Day Momentum</span></div>
      <div class="summary-box" style="font-style:italic; font-size:16px;">
        Patterns visible only across multiple weeks &mdash; not reprints of this week's findings.
      </div>
      ${group('Recurring themes (2+ weeks)', recurring)}
      ${group('Momentum shifts', momentum)}
      ${group('Quiet competitors (were loud, now silent 2+ weeks)', quiet)}
    </div>`;
}

function renderCoverageSection(coverageSummary) {
  if (!coverageSummary) return '';
  return `
    <div class="section">
      <div class="section-title"><span>Coverage &amp; Method</span></div>
      <div class="summary-box" style="font-style:italic; font-size:15px; border-left-color:#8b8f96;">${escapeHtml(coverageSummary)}</div>
    </div>`;
}

function renderDataGapsSection(gaps) {
  if (!gaps?.length) return '';
  const items = gaps.map((g) => `<li>${escapeHtml(g)}</li>`).join('');
  return `
    <div class="section">
      <div class="section-title"><span>Data Gaps This Week</span></div>
      <ul class="watch-list">${items}</ul>
    </div>`;
}

function renderMondayActionPlan(actions) {
  const rows = Array.isArray(actions)
    ? actions.filter((a) => a && (a.action || a.assetOrTalkTrack || a.whyNow))
    : [];
  if (!rows.length) return '';

  const cards = rows.map((a) => `
    <div class="action-card">
      <div class="action-topline">
        <span class="priority-pill">${escapeHtml(a.priority || 'P1')}</span>
        <span class="owner-pill">${escapeHtml(a.owner || 'Owner')}</span>
      </div>
      <div class="action-title">${escapeHtml(a.action || '')}</div>
      ${a.whyNow ? `<div class="action-why"><span class="field-label">Why now</span> ${escapeHtml(a.whyNow)}</div>` : ''}
      ${a.assetOrTalkTrack ? `<div class="action-asset"><span class="field-label">Use</span> ${escapeHtml(a.assetOrTalkTrack)}</div>` : ''}
    </div>`).join('');

  return `
    <div class="section">
      <div class="section-title"><span>Monday Action Plan</span></div>
      <div class="action-grid">${cards}</div>
    </div>`;
}

function renderObjectionHandling(items) {
  const rows = Array.isArray(items)
    ? items.filter((i) => i && (i.objection || i.recommendedResponse))
    : [];
  if (!rows.length) return '';

  const cards = rows.map((i) => `
    <div class="objection-card">
      <div class="objection-topline">
        <span class="owner-pill">${escapeHtml(i.competitor || 'Category-wide')}</span>
        <span class="confidence-pill">${escapeHtml(i.confidence || 'Medium')}</span>
      </div>
      <div class="objection-title">${escapeHtml(i.objection || '')}</div>
      ${i.recommendedResponse ? `<div class="objection-response"><span class="field-label">Response</span> ${escapeHtml(i.recommendedResponse)}</div>` : ''}
      ${i.proofPoint ? `<div class="objection-proof"><span class="field-label">Proof</span> ${escapeHtml(i.proofPoint)}</div>` : ''}
    </div>`).join('');

  return `
    <div class="section">
      <div class="section-title"><span>Objection Handling</span></div>
      <div class="objection-list">${cards}</div>
    </div>`;
}

function renderAccountTargeting(items) {
  const rows = Array.isArray(items)
    ? items.filter((i) => i && (i.segment || i.outboundAngle))
    : [];
  if (!rows.length) return '';

  const cards = rows.map((i) => `
    <div class="targeting-card">
      <div class="targeting-topline">
        <span class="owner-pill">Target Segment</span>
      </div>
      <div class="targeting-title">${escapeHtml(i.segment || '')}</div>
      ${i.whyThisSegment ? `<div class="targeting-why"><span class="field-label">Why</span> ${escapeHtml(i.whyThisSegment)}</div>` : ''}
      ${i.outboundAngle ? `<div class="targeting-angle"><span class="field-label">Angle</span> ${escapeHtml(i.outboundAngle)}</div>` : ''}
      ${i.signalToReference ? `<div class="targeting-signal"><span class="field-label">Signal</span> ${escapeHtml(i.signalToReference)}</div>` : ''}
    </div>`).join('');

  return `
    <div class="section">
      <div class="section-title"><span>Account Targeting Angles</span></div>
      <div class="targeting-list">${cards}</div>
    </div>`;
}

// ── Build Competitor Sections HTML ────────────────────────────────────────────
function renderCompetitorSections(sections) {
  if (!sections?.length) return '<p class="no-findings">No significant competitor activity this week.</p>';

  return sections.map(section => {
    if (!section.hasFindings) return '';

    const findings = (section.findings || []).map(f => `
      <div class="finding">
        <div class="finding-headline">${escapeHtml(f.headline)}</div>
        ${f.sourceNote ? `<div class="finding-source-note">${escapeHtml(f.sourceNote)}</div>` : ''}
        <div class="finding-detail">${escapeHtml(f.detail)}</div>
        ${f.implication ? `<span class="finding-implication">${escapeHtml(f.implication)}</span>` : ''}
        ${f.repTalkTrack ? `<div class="finding-talk-track"><strong>Rep talk track:</strong> ${escapeHtml(f.repTalkTrack)}</div>` : ''}
      </div>`).join('');

    return `
      <div class="competitor-block">
        <div class="competitor-header">
          <span class="competitor-name">${escapeHtml(section.competitorName)}</span>
          <span class="competitor-summary">${escapeHtml(section.summaryLine || '')}</span>
        </div>
        ${findings || '<div class="finding"><span class="no-findings">No significant activity.</span></div>'}
      </div>`;
  }).join('');
}

// ── Build Enablement Update HTML block ────────────────────────────────────────
function renderEnablementUpdate(copy) {
  if (!copy) return '';
  return `
    <div class="section">
      <div class="section-title"><span>Enablement Update · This Week</span></div>
      <div class="play-box">${escapeHtml(copy)}</div>
    </div>`;
}

// ── Build Trigger Emails HTML block ──────────────────────────────────────────
function renderTriggerEmails(triggerEmails) {
  if (!triggerEmails?.exists || !triggerEmails.emails?.length) return '';

  const emailBlocks = triggerEmails.emails.map(e => `
    <div class="email-block">
      <div class="email-label">${escapeHtml(e.label)}</div>
      <div class="email-subject">${escapeHtml(e.subject)}</div>
      <div class="email-body">${escapeHtml(e.body)}</div>
    </div>`).join('');

  return `
    <div class="section">
      <div class="section-title"><span>Trigger Emails · Ready to Send</span></div>
      <p style="font-family:'Instrument Serif','Source Serif 4',Georgia,serif; font-size:15px; font-style:italic; color:#5b5f66; margin-bottom:18px; line-height:1.6;">${escapeHtml(triggerEmails.context || '')}</p>
      ${emailBlocks}
    </div>`;
}

// ── Inject content into HTML template ────────────────────────────────────────
function buildHTML(clientConfig, reportContent) {
  const week  = weekString();
  const watch = (reportContent.watchNextWeek || [])
    .map(item => `<li>${escapeHtml(item)}</li>`)
    .join('');

  return htmlTemplate
    .replace(/{{CLIENT_NAME}}/g,    escapeHtml(clientConfig.name))
    .replace('{{REPORT_WEEK}}',     escapeHtml(week))
    .replace('{{WEEK_SUMMARY}}',    escapeHtml(reportContent.weekSummary || ''))
    .replace('{{CHANGES_SINCE_LAST_WEEK_SECTION}}', renderChangesSinceLastWeek(reportContent.changesSinceLastWeek))
    .replace('{{ROLLING_HISTORY_SECTION}}', renderRollingHistory(reportContent.rollingHistory))
    .replace('{{COVERAGE_SECTION}}', renderCoverageSection(reportContent.coverageSummary))
    .replace('{{DATA_GAPS_SECTION}}', renderDataGapsSection(reportContent.dataGapsThisWeek))
    .replace('{{TOP_ALERT_SECTION}}', renderTopAlert(reportContent.topAlert))
    .replace('{{MONDAY_ACTION_PLAN_SECTION}}', renderMondayActionPlan(reportContent.mondayActionPlan))
    .replace('{{OBJECTION_HANDLING_SECTION}}', renderObjectionHandling(reportContent.objectionHandling))
    .replace('{{ACCOUNT_TARGETING_SECTION}}', renderAccountTargeting(reportContent.accountTargeting))
    .replace('{{COMPETITOR_SECTIONS}}', renderCompetitorSections(reportContent.competitorSections))
    .replace('{{SALES_PLAY}}',      escapeHtml(reportContent.salesPlayThisWeek || ''))
    .replace('{{ENABLEMENT_UPDATE_SECTION}}', renderEnablementUpdate(reportContent.enablementUpdate))
    .replace('{{TRIGGER_EMAILS_SECTION}}', renderTriggerEmails(reportContent.triggerEmails))
    .replace('{{WATCH_LIST_ITEMS}}', watch);
}

/**
 * Copy the same HTML + report-content JSON into `brief-app` so a Vercel deploy
 * (root = brief-app) can serve static HTML and `/brief` can read JSON without
 * reaching back into intelligence-engine on the server.
 *
 * - HTML → brief-app/public/<clientId>-report-<timestamp>.html
 * - JSON → brief-app/data/<clientId>/report-content-<timestamp>.json
 */
function mirrorReportArtifactsToBriefApp(clientId, timestamp, html, reportContent) {
  if (!fs.existsSync(BRIEF_APP_ROOT)) {
    console.warn(
      `\n⚠️  brief-app not found at ${BRIEF_APP_ROOT} — skipping mirror (expected monorepo layout).`,
    );
    return;
  }

  const publicDir = path.join(BRIEF_APP_ROOT, 'public');
  const mirrorDataDir = path.join(BRIEF_APP_ROOT, 'data', clientId);
  fs.mkdirSync(publicDir, { recursive: true });
  fs.mkdirSync(mirrorDataDir, { recursive: true });

  const publicHtmlName = `${clientId}-report-${timestamp}.html`;
  const publicHtmlPath = path.join(publicDir, publicHtmlName);
  fs.writeFileSync(publicHtmlPath, html);

  const mirrorJsonPath = path.join(mirrorDataDir, `report-content-${timestamp}.json`);
  fs.writeFileSync(mirrorJsonPath, JSON.stringify(reportContent, null, 2));

  console.log(`📁  (brief-app) HTML  → public/${publicHtmlName}`);
  console.log(`📁  (brief-app) JSON → data/${clientId}/report-content-${timestamp}.json`);
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * Produce the Monday artifact and mirror it for brief-app.
 *
 * @param {string} clientId
 * @param {Array}  analyses
 * @param {object} clientConfig
 * @param {object} [options]
 * @param {'weekly-news'|'deep-dive'} [options.artifactType='weekly-news']
 * @param {string} [options.deepDiveTopic]   — required when artifactType = 'deep-dive'
 * @param {object} [options.richness]        — output of scoreSignalRichness (passed through to prompt)
 */
export async function generateReport(clientId, analyses, clientConfig, options = {}) {
  const artifactType = options.artifactType === 'deep-dive' ? 'deep-dive' : 'weekly-news';
  const deepDiveTopic = options.deepDiveTopic || null;
  const richness = options.richness || null;

  const priorReport = loadPriorReportContent(clientId);
  const rollingHistory = loadRollingHistory(clientId, ROLLING_HISTORY_WEEKS);

  if (priorReport) {
    console.log(`🔁  Prior report loaded for continuity: ${priorReport.file}`);
  } else {
    console.log('🆕  No prior report on file — first week for this client.');
  }
  if (rollingHistory.length) {
    console.log(`🗂️   Rolling history loaded: ${rollingHistory.length} prior report(s).`);
  }

  let reportContent;
  let html;
  if (artifactType === 'deep-dive') {
    console.log(`\n📝  Silent week detected → generating DEEP-DIVE artifact (topic: ${deepDiveTopic || 'auto'}) via Claude...`);
    reportContent = await writeDeepDiveContent(clientConfig, analyses, priorReport, rollingHistory, richness, deepDiveTopic);
    html = buildDeepDiveHTML(clientConfig, reportContent, deepDiveTopic);
  } else {
    console.log('\n📝  Generating weekly report via Claude...');
    reportContent = await writeReportContent(clientConfig, analyses, priorReport, rollingHistory, richness);
    html = buildHTML(clientConfig, reportContent);
  }

  reportContent.artifactType = artifactType;
  if (deepDiveTopic) reportContent.deepDiveTopic = deepDiveTopic;
  if (richness) reportContent.richness = richness;

  const dataDir  = path.join(ROOT, 'data', clientId);
  fs.mkdirSync(dataDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const htmlPath  = path.join(dataDir, `report-${timestamp}.html`);
  const jsonPath  = path.join(dataDir, `report-content-${timestamp}.json`);

  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(jsonPath, JSON.stringify(reportContent, null, 2));

  mirrorReportArtifactsToBriefApp(clientId, timestamp, html, reportContent);

  const hasTrigger = reportContent.topAlert?.exists || reportContent.triggerEmails?.exists;

  console.log(`✅  ${artifactType === 'deep-dive' ? 'Deep-dive' : 'Report'} generated${hasTrigger ? ' — TRIGGER EVENT DETECTED ⚡' : ''}`);
  console.log(`📁  HTML  → data/${clientId}/report-${timestamp}.html`);

  return { html, reportContent, htmlPath, artifactType };
}
