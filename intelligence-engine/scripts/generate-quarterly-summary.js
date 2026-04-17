/**
 * Quarterly Impact Summary Generator
 * ────────────────────────────────────
 * Reads all report-content JSON files from the past quarter,
 * generates a summary of signals detected, trigger events,
 * and key competitive moves via Claude.
 *
 * Usage:
 *   node scripts/generate-quarterly-summary.js <client-id>
 *   node scripts/generate-quarterly-summary.js <client-id> --quarter Q1-2026
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.QUARTERLY_SUMMARY_MODEL?.trim() || 'claude-opus-4-7';
const QUARTERLY_SUMMARY_THINKING_BUDGET_TOKENS = parseInt(
  process.env.QUARTERLY_SUMMARY_THINKING_BUDGET_TOKENS || '',
  10,
) || 14000;

const clientId = process.argv[2];
const quarterArg = process.argv.find(a => a.startsWith('--quarter'))
  ? process.argv[process.argv.indexOf('--quarter') + 1]
  : null;

if (!clientId) {
  console.error('Usage: node scripts/generate-quarterly-summary.js <client-id> [--quarter Q1-2026]');
  process.exit(1);
}

function getQuarterBounds(quarterStr) {
  if (quarterStr) {
    const [q, year] = quarterStr.split('-');
    const quarterNum = parseInt(q.replace('Q', ''));
    const startMonth = (quarterNum - 1) * 3;
    const start = new Date(parseInt(year), startMonth, 1);
    const end = new Date(parseInt(year), startMonth + 3, 0, 23, 59, 59);
    return { start, end, label: quarterStr };
  }

  const now = new Date();
  const currentQuarter = Math.floor(now.getMonth() / 3);
  const prevQuarter = currentQuarter === 0 ? 3 : currentQuarter - 1;
  const year = currentQuarter === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const startMonth = prevQuarter * 3;
  const start = new Date(year, startMonth, 1);
  const end = new Date(year, startMonth + 3, 0, 23, 59, 59);
  const label = `Q${prevQuarter + 1}-${year}`;
  return { start, end, label };
}

function loadReportsInRange(clientId, start, end) {
  const dataDir = path.join(ROOT, 'data', clientId);
  if (!fs.existsSync(dataDir)) return [];

  return fs.readdirSync(dataDir)
    .filter(f => f.startsWith('report-content-') && f.endsWith('.json'))
    .map(f => {
      const dateStr = f.replace('report-content-', '').replace('.json', '').replace(/-/g, (m, i) => i <= 9 ? '-' : ':');
      const parsed = new Date(dateStr.slice(0, 10));
      return { file: f, date: parsed, path: path.join(dataDir, f) };
    })
    .filter(r => r.date >= start && r.date <= end)
    .sort((a, b) => a.date - b.date)
    .map(r => {
      try {
        return { ...r, content: JSON.parse(fs.readFileSync(r.path, 'utf8')) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function loadClientConfig(clientId) {
  const configPath = path.join(ROOT, 'config', 'clients', `${clientId}.json`);
  if (!fs.existsSync(configPath)) {
    console.error(`Client config not found: ${configPath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function extractStats(reports) {
  let totalFindings = 0;
  let triggerEvents = 0;
  const competitorMentions = {};
  const triggerSummaries = [];
  const topFindings = [];

  for (const report of reports) {
    const content = report.content;

    if (content.topAlert?.exists) {
      triggerEvents++;
      triggerSummaries.push({
        date: report.date.toLocaleDateString(),
        headline: content.topAlert.headline,
        detail: content.topAlert.detail,
      });
    }

    if (content.triggerEmails?.exists) triggerEvents++;

    for (const section of content.competitorSections || []) {
      const name = section.competitorName;
      if (!competitorMentions[name]) competitorMentions[name] = 0;

      if (section.hasFindings && section.findings?.length) {
        competitorMentions[name] += section.findings.length;
        totalFindings += section.findings.length;

        for (const f of section.findings) {
          topFindings.push({
            date: report.date.toLocaleDateString(),
            competitor: name,
            headline: f.headline,
            implication: f.implication,
          });
        }
      }
    }
  }

  return { totalFindings, triggerEvents, competitorMentions, triggerSummaries, topFindings };
}

async function generateSummaryWithClaude(clientConfig, stats, quarter, reportCount) {
  const prompt = `You are writing a quarterly impact summary for a competitive intelligence service.

CLIENT: ${clientConfig.name}
QUARTER: ${quarter}
REPORTS DELIVERED: ${reportCount}

STATISTICS:
- Total findings across all reports: ${stats.totalFindings}
- Trigger events detected: ${stats.triggerEvents}
- Competitor activity breakdown: ${JSON.stringify(stats.competitorMentions)}

TRIGGER EVENTS:
${JSON.stringify(stats.triggerSummaries, null, 2)}

TOP FINDINGS (sample):
${JSON.stringify(stats.topFindings.slice(0, 20), null, 2)}

WIN STORIES LOGGED:
${JSON.stringify(clientConfig.retention?.winStories || [], null, 2)}

Write a quarterly impact summary. Structure:

1. EXECUTIVE SUMMARY (3-4 sentences): What did we catch this quarter? What was the single most important finding?
2. BY THE NUMBERS: Key stats in a scannable format.
3. TOP 5 MOST SIGNIFICANT FINDINGS: Ranked by strategic importance with dates.
4. COMPETITOR ACTIVITY RANKING: Which competitors were most active and what that signals.
5. TRIGGER EVENTS RECAP: Every trigger event with what action was recommended.
6. VALUE DELIVERED: Connect findings to sales outcomes. If win stories exist, reference them. If none, suggest the client track wins influenced by the briefings.
7. LOOKING AHEAD: What to watch next quarter based on patterns detected.

OUTPUT: Return a single JSON object:
{
  "quarterLabel": "...",
  "executiveSummary": "...",
  "byTheNumbers": { "reportsDelivered": N, "totalFindings": N, "triggerEvents": N, "competitorsTracked": N },
  "topFindings": [ { "rank": 1, "date": "...", "competitor": "...", "headline": "...", "whyItMatters": "..." } ],
  "competitorRanking": [ { "name": "...", "activityLevel": "high|medium|low", "summary": "..." } ],
  "triggerRecap": [ { "date": "...", "headline": "...", "recommendedAction": "..." } ],
  "valueStatement": "...",
  "lookingAhead": [ "..." ]
}`;

  const request = {
    model: MODEL,
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  };
  if (QUARTERLY_SUMMARY_THINKING_BUDGET_TOKENS > 0) {
    request.thinking = {
      type: 'enabled',
      budget_tokens: QUARTERLY_SUMMARY_THINKING_BUDGET_TOKENS,
    };
  }

  const message = await anthropic.messages.create({
    ...request,
  });

  const raw = message.content[0]?.text?.trim() || '';
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

function buildHTML(clientConfig, summary) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Quarterly Impact Summary — ${clientConfig.name} — ${summary.quarterLabel}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: #f4f4f5; color: #111827; font-size: 15px; line-height: 1.6; }
    .wrapper { max-width: 680px; margin: 32px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .header { background: #1e1b4b; padding: 28px 36px; color: #fff; }
    .header .label { font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: #a5b4fc; margin-bottom: 6px; }
    .header h1 { font-size: 20px; font-weight: 600; color: #e0e7ff; margin-bottom: 4px; }
    .header .sub { font-size: 13px; color: #818cf8; }
    .body { padding: 32px 36px; }
    .section { margin-bottom: 28px; }
    .section-title { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 16px; }
    .summary-box { background: #f8fafc; border-left: 3px solid #6366f1; padding: 14px 16px; border-radius: 0 6px 6px 0; font-size: 14px; line-height: 1.7; color: #1e293b; }
    .stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
    .stat-card { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; text-align: center; }
    .stat-number { font-size: 28px; font-weight: 700; color: #4f46e5; }
    .stat-label { font-size: 12px; color: #6b7280; margin-top: 4px; }
    .finding-item { border: 1px solid #e5e7eb; border-radius: 6px; padding: 14px 16px; margin-bottom: 10px; }
    .finding-rank { font-size: 11px; font-weight: 700; color: #4f46e5; text-transform: uppercase; }
    .finding-headline { font-size: 14px; font-weight: 600; color: #111827; margin: 4px 0; }
    .finding-detail { font-size: 13px; color: #4b5563; }
    .finding-meta { font-size: 12px; color: #9ca3af; margin-top: 6px; }
    .value-box { background: #f0fdf4; border: 1px solid #bbf7d0; border-left: 4px solid #22c55e; padding: 14px 16px; border-radius: 0 6px 6px 0; font-size: 14px; color: #14532d; line-height: 1.65; }
    .watch-list { list-style: none; }
    .watch-list li { padding: 7px 0; border-bottom: 1px solid #f3f4f6; font-size: 13px; color: #4b5563; }
    .watch-list li::before { content: "→  "; color: #6366f1; font-weight: 700; }
    .footer { background: #f9fafb; border-top: 1px solid #e5e7eb; padding: 20px 36px; font-size: 12px; color: #9ca3af; text-align: center; }
  </style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <div class="label">Quarterly Impact Summary</div>
    <h1>${clientConfig.name}</h1>
    <div class="sub">${summary.quarterLabel}</div>
  </div>
  <div class="body">
    <div class="section">
      <div class="section-title">Executive Summary</div>
      <div class="summary-box">${summary.executiveSummary}</div>
    </div>
    <div class="section">
      <div class="section-title">By The Numbers</div>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-number">${summary.byTheNumbers.reportsDelivered}</div><div class="stat-label">Reports Delivered</div></div>
        <div class="stat-card"><div class="stat-number">${summary.byTheNumbers.totalFindings}</div><div class="stat-label">Findings Identified</div></div>
        <div class="stat-card"><div class="stat-number">${summary.byTheNumbers.triggerEvents}</div><div class="stat-label">Trigger Events</div></div>
        <div class="stat-card"><div class="stat-number">${summary.byTheNumbers.competitorsTracked}</div><div class="stat-label">Competitors Tracked</div></div>
      </div>
    </div>
    <div class="section">
      <div class="section-title">Top Findings This Quarter</div>
      ${(summary.topFindings || []).map(f => `
      <div class="finding-item">
        <div class="finding-rank">#${f.rank} — ${f.competitor}</div>
        <div class="finding-headline">${f.headline}</div>
        <div class="finding-detail">${f.whyItMatters}</div>
        <div class="finding-meta">${f.date}</div>
      </div>`).join('')}
    </div>
    <div class="section">
      <div class="section-title">Value Delivered</div>
      <div class="value-box">${summary.valueStatement}</div>
    </div>
    <div class="section">
      <div class="section-title">Looking Ahead</div>
      <ul class="watch-list">
        ${(summary.lookingAhead || []).map(item => `<li>${item}</li>`).join('')}
      </ul>
    </div>
  </div>
  <div class="footer">
    Quarterly Impact Summary — Generated by your AI Intelligence Engine<br/>
    Questions? Reply to this email.
  </div>
</div>
</body>
</html>`;
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║     QUARTERLY IMPACT SUMMARY GENERATOR       ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const clientConfig = loadClientConfig(clientId);
  const { start, end, label } = getQuarterBounds(quarterArg);

  console.log(`🏢  Client:  ${clientConfig.name}`);
  console.log(`📅  Quarter: ${label} (${start.toLocaleDateString()} — ${end.toLocaleDateString()})`);

  const reports = loadReportsInRange(clientId, start, end);
  console.log(`📊  Reports found in range: ${reports.length}`);

  if (!reports.length) {
    console.log('\n⚠️   No reports found for this quarter. Nothing to summarise.');
    process.exit(0);
  }

  const stats = extractStats(reports);
  console.log(`📈  Total findings: ${stats.totalFindings} | Trigger events: ${stats.triggerEvents}`);

  console.log('\n🧠  Generating quarterly summary via Claude...');
  const summary = await generateSummaryWithClaude(clientConfig, stats, label, reports.length);

  const html = buildHTML(clientConfig, summary);

  const dataDir = path.join(ROOT, 'data', clientId);
  fs.mkdirSync(dataDir, { recursive: true });
  const htmlPath = path.join(dataDir, `quarterly-summary-${label}.html`);
  const jsonPath = path.join(dataDir, `quarterly-summary-${label}.json`);

  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

  // Update client config with last summary date
  const configPath = path.join(ROOT, 'config', 'clients', `${clientId}.json`);
  if (clientConfig.retention) {
    clientConfig.retention.lastQuarterlySummary = label;
    fs.writeFileSync(configPath, JSON.stringify(clientConfig, null, 2));
  }

  console.log(`\n✅  Quarterly summary generated:`);
  console.log(`📁  HTML → data/${clientId}/quarterly-summary-${label}.html`);
  console.log(`📁  JSON → data/${clientId}/quarterly-summary-${label}.json`);
  console.log(`\nOpen the HTML file in a browser to preview, then send to the client.\n`);
}

main().catch(err => {
  console.error('\n❌  Error:', err.message);
  process.exit(1);
});
