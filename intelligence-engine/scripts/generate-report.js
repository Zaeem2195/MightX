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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL  = 'claude-sonnet-4-6';

const reportPrompt   = fs.readFileSync(path.join(ROOT, 'prompts', 'report-writer.txt'), 'utf8');
const htmlTemplate   = fs.readFileSync(path.join(ROOT, 'templates', 'report.html'), 'utf8');

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

  const prompt = reportPrompt
    .replace('{{CLIENT_NAME}}', clientConfig.name)
    .replace('{{REPORT_WEEK}}', week)
    .replace('{{TONE}}', clientConfig.reportPreferences?.tone || 'strategic and direct')
    .replace('{{CLIENT_CONTEXT}}', context)
    .replace('{{ALL_ANALYSES}}', JSON.stringify(analyses, null, 2));

  const message = await client.messages.create({
    model:      MODEL,
    max_tokens: 2500,
    messages:   [{ role: 'user', content: prompt }],
  });

  const raw     = message.content[0]?.text?.trim() || '';
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

// ── Build Top Alert HTML block ────────────────────────────────────────────────
function renderTopAlert(alert) {
  if (!alert?.exists) return '';
  return `
    <div class="section">
      <div class="alert-box">
        <div class="alert-label">⚡ Trigger Alert — ${alert.urgency === 'immediate' ? 'Act Today' : 'Act This Week'}</div>
        <div class="alert-headline">${alert.headline}</div>
        <div class="alert-detail">${alert.detail}</div>
      </div>
    </div>`;
}

// ── Build Competitor Sections HTML ────────────────────────────────────────────
function renderCompetitorSections(sections) {
  if (!sections?.length) return '<p class="no-findings">No significant competitor activity this week.</p>';

  return sections.map(section => {
    if (!section.hasFindings) return '';

    const findings = (section.findings || []).map(f => `
      <div class="finding">
        <div class="finding-headline">${f.headline}</div>
        <div class="finding-detail">${f.detail}</div>
        ${f.implication ? `<span class="finding-implication">${f.implication}</span>` : ''}
        ${f.repTalkTrack ? `<div class="finding-talk-track"><strong>Rep talk track:</strong> ${f.repTalkTrack}</div>` : ''}
      </div>`).join('');

    return `
      <div class="competitor-block">
        <div class="competitor-header">
          <span class="competitor-name">${section.competitorName}</span>
          <span class="competitor-summary">${section.summaryLine || ''}</span>
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
      <div class="play-box">${copy}</div>
    </div>`;
}

// ── Build Trigger Emails HTML block ──────────────────────────────────────────
function renderTriggerEmails(triggerEmails) {
  if (!triggerEmails?.exists || !triggerEmails.emails?.length) return '';

  const emailBlocks = triggerEmails.emails.map(e => `
    <div class="email-block">
      <div class="email-label">${e.label}</div>
      <div class="email-subject">${e.subject}</div>
      <div class="email-body">${e.body}</div>
    </div>`).join('');

  return `
    <div class="section">
      <div class="section-title">Trigger Emails — Ready to Send</div>
      <p style="font-size:13px; color:#6b7280; margin-bottom:16px;">${triggerEmails.context || ''}</p>
      ${emailBlocks}
    </div>`;
}

// ── Inject content into HTML template ────────────────────────────────────────
function buildHTML(clientConfig, reportContent) {
  const week  = weekString();
  const watch = (reportContent.watchNextWeek || [])
    .map(item => `<li>${item}</li>`)
    .join('');

  return htmlTemplate
    .replace(/{{CLIENT_NAME}}/g,    clientConfig.name)
    .replace('{{REPORT_WEEK}}',     week)
    .replace('{{WEEK_SUMMARY}}',    reportContent.weekSummary || '')
    .replace('{{TOP_ALERT_SECTION}}', renderTopAlert(reportContent.topAlert))
    .replace('{{COMPETITOR_SECTIONS}}', renderCompetitorSections(reportContent.competitorSections))
    .replace('{{SALES_PLAY}}',      reportContent.salesPlayThisWeek || '')
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

  // Flag trigger events for logging
  const hasTrigger = reportContent.topAlert?.exists || reportContent.triggerEmails?.exists;

  console.log(`✅  Report generated${hasTrigger ? ' — TRIGGER EVENT DETECTED ⚡' : ''}`);
  console.log(`📁  HTML  → data/${clientId}/report-${timestamp}.html`);

  return { html, reportContent, htmlPath };
}
