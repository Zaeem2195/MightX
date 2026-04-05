/**
 * Client Dashboard Generator
 * ────────────────────────────
 * Reads all historical report data for a client and generates
 * a self-contained HTML dashboard showing:
 *   - Report archive with key findings
 *   - Signal timeline (trigger events over time)
 *   - Competitor activity heatmap
 *   - Trend data (G2 ratings, hiring velocity)
 *
 * Usage:
 *   node scripts/generate-dashboard.js <client-id>
 *   node scripts/generate-dashboard.js <client-id> --all   (regenerate for all clients)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const clientIdArg = process.argv[2];
const allClients = process.argv.includes('--all');

if (!clientIdArg && !allClients) {
  console.error('Usage: node scripts/generate-dashboard.js <client-id>');
  console.error('       node scripts/generate-dashboard.js --all');
  process.exit(1);
}

function loadClientConfig(clientId) {
  const configPath = path.join(ROOT, 'config', 'clients', `${clientId}.json`);
  if (!fs.existsSync(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function loadAllReports(clientId) {
  const dataDir = path.join(ROOT, 'data', clientId);
  if (!fs.existsSync(dataDir)) return [];

  return fs.readdirSync(dataDir)
    .filter(f => f.startsWith('report-content-') && f.endsWith('.json'))
    .sort()
    .map(f => {
      try {
        const content = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
        const dateStr = f.replace('report-content-', '').replace('.json', '');
        return { file: f, dateStr, content };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function buildTimelineEvents(reports) {
  const events = [];
  for (const report of reports) {
    const c = report.content;
    const date = report.dateStr.slice(0, 10);

    if (c.topAlert?.exists) {
      events.push({ date, type: 'trigger', headline: c.topAlert.headline, detail: c.topAlert.detail });
    }

    for (const section of c.competitorSections || []) {
      if (section.hasFindings) {
        for (const f of section.findings || []) {
          events.push({ date, type: 'finding', competitor: section.competitorName, headline: f.headline, implication: f.implication || '' });
        }
      }
    }
  }
  return events;
}

function buildCompetitorStats(reports) {
  const stats = {};
  for (const report of reports) {
    for (const section of report.content.competitorSections || []) {
      const name = section.competitorName;
      if (!stats[name]) stats[name] = { name, totalFindings: 0, weeksActive: 0, triggerEvents: 0 };
      if (section.hasFindings) {
        stats[name].weeksActive++;
        stats[name].totalFindings += (section.findings || []).length;
      }
    }
  }
  return Object.values(stats).sort((a, b) => b.totalFindings - a.totalFindings);
}

function buildDashboardHTML(clientConfig, reports, events, competitorStats) {
  const clientName = clientConfig.name;
  const totalReports = reports.length;
  const totalFindings = competitorStats.reduce((sum, c) => sum + c.totalFindings, 0);
  const totalTriggers = events.filter(e => e.type === 'trigger').length;

  const recentReports = reports.slice(-12).reverse();
  const recentEvents = events.slice(-30).reverse();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Intelligence Dashboard — ${clientName}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: #0f172a; color: #e2e8f0; font-size: 14px; line-height: 1.6; }
    .container { max-width: 1100px; margin: 0 auto; padding: 24px; }
    .header { margin-bottom: 32px; }
    .header .label { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #64748b; }
    .header h1 { font-size: 24px; font-weight: 600; color: #f1f5f9; margin: 4px 0; }
    .header .sub { font-size: 13px; color: #94a3b8; }
    .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 32px; }
    .stat-card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 20px; }
    .stat-card .number { font-size: 32px; font-weight: 700; color: #818cf8; }
    .stat-card .label { font-size: 12px; color: #94a3b8; margin-top: 4px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 32px; }
    .panel { background: #1e293b; border: 1px solid #334155; border-radius: 8px; overflow: hidden; }
    .panel-header { padding: 16px 20px; border-bottom: 1px solid #334155; }
    .panel-header h2 { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #cbd5e1; }
    .panel-body { padding: 16px 20px; max-height: 500px; overflow-y: auto; }
    .full-width { grid-column: 1 / -1; }
    .timeline-item { padding: 12px 0; border-bottom: 1px solid #1e293b; }
    .timeline-item:last-child { border-bottom: none; }
    .timeline-date { font-size: 11px; color: #64748b; font-weight: 600; }
    .timeline-badge { display: inline-block; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 8px; border-radius: 4px; margin-left: 8px; }
    .badge-trigger { background: #451a03; color: #fb923c; }
    .badge-finding { background: #1e1b4b; color: #a5b4fc; }
    .timeline-headline { font-size: 13px; color: #e2e8f0; margin-top: 4px; font-weight: 500; }
    .timeline-detail { font-size: 12px; color: #94a3b8; margin-top: 2px; }
    .report-item { padding: 12px 0; border-bottom: 1px solid #1e293b; cursor: default; }
    .report-item:last-child { border-bottom: none; }
    .report-date { font-size: 12px; color: #818cf8; font-weight: 600; }
    .report-summary { font-size: 13px; color: #cbd5e1; margin-top: 4px; }
    .report-play { font-size: 12px; color: #4ade80; margin-top: 4px; font-style: italic; }
    .competitor-row { display: flex; align-items: center; padding: 10px 0; border-bottom: 1px solid #1e293b; }
    .competitor-row:last-child { border-bottom: none; }
    .competitor-name { font-size: 13px; font-weight: 600; color: #e2e8f0; width: 140px; }
    .competitor-bar-container { flex: 1; height: 24px; background: #0f172a; border-radius: 4px; overflow: hidden; margin: 0 12px; }
    .competitor-bar { height: 100%; background: linear-gradient(90deg, #6366f1, #818cf8); border-radius: 4px; display: flex; align-items: center; padding-left: 8px; }
    .competitor-bar span { font-size: 11px; color: #fff; font-weight: 600; }
    .competitor-weeks { font-size: 12px; color: #64748b; width: 80px; text-align: right; }
    .footer { text-align: center; padding: 24px; font-size: 12px; color: #475569; }
    @media (max-width: 768px) { .stats-row { grid-template-columns: repeat(2, 1fr); } .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="label">Competitive Intelligence Dashboard</div>
    <h1>${clientName}</h1>
    <div class="sub">Last updated: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
  </div>

  <div class="stats-row">
    <div class="stat-card"><div class="number">${totalReports}</div><div class="label">Reports Delivered</div></div>
    <div class="stat-card"><div class="number">${totalFindings}</div><div class="label">Findings Identified</div></div>
    <div class="stat-card"><div class="number">${totalTriggers}</div><div class="label">Trigger Events</div></div>
    <div class="stat-card"><div class="number">${competitorStats.length}</div><div class="label">Competitors Tracked</div></div>
  </div>

  <div class="grid">
    <div class="panel">
      <div class="panel-header"><h2>Recent Reports</h2></div>
      <div class="panel-body">
        ${recentReports.map(r => `
        <div class="report-item">
          <div class="report-date">${r.dateStr.slice(0, 10)}</div>
          <div class="report-summary">${r.content.weekSummary || 'No summary available'}</div>
          ${r.content.salesPlayThisWeek ? `<div class="report-play">${r.content.salesPlayThisWeek.slice(0, 150)}${r.content.salesPlayThisWeek.length > 150 ? '...' : ''}</div>` : ''}
        </div>`).join('') || '<p style="color:#64748b;padding:12px 0;">No reports yet.</p>'}
      </div>
    </div>

    <div class="panel">
      <div class="panel-header"><h2>Competitor Activity</h2></div>
      <div class="panel-body">
        ${competitorStats.map(c => {
          const maxFindings = Math.max(...competitorStats.map(s => s.totalFindings), 1);
          const barWidth = Math.max((c.totalFindings / maxFindings) * 100, 5);
          return `
        <div class="competitor-row">
          <div class="competitor-name">${c.name}</div>
          <div class="competitor-bar-container">
            <div class="competitor-bar" style="width:${barWidth}%"><span>${c.totalFindings}</span></div>
          </div>
          <div class="competitor-weeks">${c.weeksActive} weeks</div>
        </div>`;
        }).join('') || '<p style="color:#64748b;padding:12px 0;">No data yet.</p>'}
      </div>
    </div>

    <div class="panel full-width">
      <div class="panel-header"><h2>Signal Timeline</h2></div>
      <div class="panel-body">
        ${recentEvents.map(e => `
        <div class="timeline-item">
          <span class="timeline-date">${e.date}</span>
          <span class="timeline-badge ${e.type === 'trigger' ? 'badge-trigger' : 'badge-finding'}">${e.type}</span>
          ${e.competitor ? `<span style="font-size:11px;color:#94a3b8;margin-left:6px;">${e.competitor}</span>` : ''}
          <div class="timeline-headline">${e.headline}</div>
          ${e.detail || e.implication ? `<div class="timeline-detail">${e.detail || e.implication}</div>` : ''}
        </div>`).join('') || '<p style="color:#64748b;padding:12px 0;">No events recorded yet. Signals will appear here after the first report.</p>'}
      </div>
    </div>
  </div>

  <div class="footer">
    Competitive Intelligence Dashboard — Auto-generated by your AI Intelligence Engine
  </div>
</div>
</body>
</html>`;
}

function generateDashboard(clientId) {
  const clientConfig = loadClientConfig(clientId);
  if (!clientConfig) {
    console.error(`❌  Client config not found: ${clientId}`);
    return false;
  }

  if (clientConfig.reportPreferences?.includeDashboard === false) {
    console.log(`⏭️   Dashboard disabled for ${clientConfig.name}. Skipping.`);
    return true;
  }

  const reports = loadAllReports(clientId);
  const events = buildTimelineEvents(reports);
  const competitorStats = buildCompetitorStats(reports);

  const html = buildDashboardHTML(clientConfig, reports, events, competitorStats);

  const dataDir = path.join(ROOT, 'data', clientId);
  fs.mkdirSync(dataDir, { recursive: true });
  const dashboardPath = path.join(dataDir, 'dashboard.html');
  fs.writeFileSync(dashboardPath, html);

  console.log(`✅  ${clientConfig.name}: data/${clientId}/dashboard.html (${reports.length} reports, ${events.length} events)`);
  return true;
}

function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║         CLIENT DASHBOARD GENERATOR            ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  if (allClients) {
    const clientsDir = path.join(ROOT, 'config', 'clients');
    const files = fs.readdirSync(clientsDir)
      .filter(f => f.endsWith('.json') && f !== 'example-client.json');

    console.log(`Generating dashboards for ${files.length} client(s)...\n`);
    let success = 0;
    for (const f of files) {
      const id = f.replace('.json', '');
      if (generateDashboard(id)) success++;
    }
    console.log(`\n✅  Done. ${success}/${files.length} dashboards generated.\n`);
  } else {
    generateDashboard(clientIdArg);
    console.log();
  }
}

main();
