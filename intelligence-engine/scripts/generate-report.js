/**
 * Report Generator — Claude writes the HTML briefing
 * ────────────────────────────────────────────────────
 * Takes all analyses → Claude synthesises into structured report JSON →
 * Injects into HTML template → saves final HTML report
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
const REPORT_MAX_TOKENS = 8192;

const REPORT_JSON_SUFFIX = `

CRITICAL — OUTPUT RULES:
- Return ONLY one JSON object. No markdown fences.
- Escape all double quotes inside strings as \\".
- Keep each string field concise so the full JSON fits in one response.`;

const reportPrompt   = fs.readFileSync(path.join(ROOT, 'prompts', 'report-writer.txt'), 'utf8');
const htmlTemplate   = fs.readFileSync(path.join(ROOT, 'templates', 'report.html'), 'utf8');

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
async function writeReportContent(clientConfig, analyses) {
  const week    = weekString();
  const context = buildClientContext(clientConfig);
  const pipelineMeta = buildPipelineMeta(analyses);

  const basePrompt = reportPrompt
    .replace('{{CLIENT_NAME}}', clientConfig.name)
    .replace('{{REPORT_WEEK}}', week)
    .replace('{{TONE}}', clientConfig.reportPreferences?.tone || 'strategic and direct')
    .replace('{{CLIENT_CONTEXT}}', context)
    .replace('{{PIPELINE_META}}', formatPipelineMetaForPrompt(pipelineMeta))
    .replace('{{ALL_ANALYSES}}', JSON.stringify(analyses, null, 2));

  const variants = [basePrompt, basePrompt + REPORT_JSON_SUFFIX];

  for (const prompt of variants) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const message = await client.messages.create({
          model:      MODEL,
          max_tokens: REPORT_MAX_TOKENS,
          messages:   [{ role: 'user', content: prompt }],
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

// ── Build Top Alert HTML block ────────────────────────────────────────────────
function renderTopAlert(alert) {
  if (!alert?.exists) return '';
  return `
    <div class="section">
      <div class="alert-box">
        <div class="alert-label">⚡ Trigger Alert — ${alert.urgency === 'immediate' ? 'Act Today' : 'Act This Week'}</div>
        <div class="alert-headline">${escapeHtml(alert.headline)}</div>
        <div class="alert-detail">${escapeHtml(alert.detail)}</div>
      </div>
    </div>`;
}

function renderCoverageSection(coverageSummary) {
  if (!coverageSummary) return '';
  return `
    <div class="section">
      <div class="section-title">Coverage &amp; Method</div>
      <div class="summary-box" style="border-left-color:#64748b;">${escapeHtml(coverageSummary)}</div>
    </div>`;
}

function renderDataGapsSection(gaps) {
  if (!gaps?.length) return '';
  const items = gaps.map((g) => `<li>${escapeHtml(g)}</li>`).join('');
  return `
    <div class="section">
      <div class="section-title">Data Gaps This Week</div>
      <ul class="watch-list">${items}</ul>
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
      <div class="section-title">Enablement Update This Week</div>
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
      <div class="section-title">Trigger Emails — Ready to Send</div>
      <p style="font-size:13px; color:#6b7280; margin-bottom:16px;">${escapeHtml(triggerEmails.context || '')}</p>
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
    .replace('{{COVERAGE_SECTION}}', renderCoverageSection(reportContent.coverageSummary))
    .replace('{{DATA_GAPS_SECTION}}', renderDataGapsSection(reportContent.dataGapsThisWeek))
    .replace('{{TOP_ALERT_SECTION}}', renderTopAlert(reportContent.topAlert))
    .replace('{{COMPETITOR_SECTIONS}}', renderCompetitorSections(reportContent.competitorSections))
    .replace('{{SALES_PLAY}}',      escapeHtml(reportContent.salesPlayThisWeek || ''))
    .replace('{{ENABLEMENT_UPDATE_SECTION}}', renderEnablementUpdate(reportContent.enablementUpdate))
    .replace('{{TRIGGER_EMAILS_SECTION}}', renderTriggerEmails(reportContent.triggerEmails))
    .replace('{{WATCH_LIST_ITEMS}}', watch);
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function generateReport(clientId, analyses, clientConfig) {
  console.log('\n📝  Generating weekly report via Claude...');

  const reportContent = await writeReportContent(clientConfig, analyses);
  const html          = buildHTML(clientConfig, reportContent);

  const dataDir  = path.join(ROOT, 'data', clientId);
  fs.mkdirSync(dataDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const htmlPath  = path.join(dataDir, `report-${timestamp}.html`);
  const jsonPath  = path.join(dataDir, `report-content-${timestamp}.json`);

  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(jsonPath, JSON.stringify(reportContent, null, 2));

  const hasTrigger = reportContent.topAlert?.exists || reportContent.triggerEmails?.exists;

  console.log(`✅  Report generated${hasTrigger ? ' — TRIGGER EVENT DETECTED ⚡' : ''}`);
  console.log(`📁  HTML  → data/${clientId}/report-${timestamp}.html`);

  return { html, reportContent, htmlPath };
}
