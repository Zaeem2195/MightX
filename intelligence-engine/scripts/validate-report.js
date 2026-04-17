/**
 * Report Validation Gate — fail-closed pre-send checks
 * ─────────────────────────────────────────────────────
 * Runs after generate-report.js and BEFORE deliver.js. If any hard check
 * fails, the report is NOT emailed; the operator gets a local alert + an
 * optional Slack ping so they can review before Monday 09:00.
 *
 * What this catches that the generator alone does not:
 * - Empty or degenerate reports (no competitor findings, no useful content)
 * - Too-short output (Claude truncated or model refused)
 * - Broken template — unfilled {{PLACEHOLDER}} tokens in the final HTML
 * - Fact-check rot — most signals failed verification this week
 * - Missing required sections
 *
 * CLI usage (optional — the pipeline imports validateReport directly):
 *   node scripts/validate-report.js <client-id>
 *   node scripts/validate-report.js <client-id> <timestamp>
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const DEFAULTS = {
  // weekly-news thresholds
  minWeekSummaryChars: 40,
  minHtmlChars: 3000,
  factCheckFailureRateBlockThreshold: 0.5,
  minCompetitorSectionsWithFindings: 1,
  // deep-dive thresholds
  minDeepDiveHeadlineChars: 30,
  minDeepDiveExecutiveChars: 60,
  minDeepDiveSections: 2,
  minDeepDiveHtmlChars: 3500,
};

/**
 * Run all validation checks. Pure function — does not send Slack or email.
 *
 * @returns {{
 *   ok: boolean,
 *   errors: string[],
 *   warnings: string[],
 *   checks: Array<{id: string, ok: boolean, level: 'error'|'warning', message: string}>
 * }}
 */
export function validateReport({ reportContent, html, analyses, clientConfig }, overrides = {}) {
  const opts = { ...DEFAULTS, ...overrides };
  const checks = [];

  const record = (id, ok, level, message) => {
    checks.push({ id, ok, level, message });
  };

  if (!reportContent || typeof reportContent !== 'object') {
    record('report_content_exists', false, 'error', 'reportContent is missing or not an object.');
    return finalise(checks);
  }
  record('report_content_exists', true, 'error', 'Report content object present.');

  const artifactType = reportContent.artifactType === 'deep-dive' ? 'deep-dive' : 'weekly-news';
  record('artifact_type', true, 'warning', `Artifact type: ${artifactType}.`);

  if (artifactType === 'deep-dive') {
    const headline = String(reportContent.headlineQuestion || '').trim();
    if (headline.length < opts.minDeepDiveHeadlineChars) {
      record('dd_headline_length', false, 'error',
        `Deep-dive headlineQuestion too short (${headline.length} chars, min ${opts.minDeepDiveHeadlineChars}).`);
    } else {
      record('dd_headline_length', true, 'error', `Deep-dive headlineQuestion ok (${headline.length} chars).`);
    }

    const exec = String(reportContent.executiveAnswer || '').trim();
    if (exec.length < opts.minDeepDiveExecutiveChars) {
      record('dd_executive_length', false, 'error',
        `Deep-dive executiveAnswer too short (${exec.length} chars, min ${opts.minDeepDiveExecutiveChars}).`);
    } else {
      record('dd_executive_length', true, 'error', `Deep-dive executiveAnswer ok (${exec.length} chars).`);
    }

    const sections = Array.isArray(reportContent.sections) ? reportContent.sections : [];
    const usable = sections.filter((s) => s?.title && String(s.body || '').trim().length >= 100);
    if (usable.length < opts.minDeepDiveSections) {
      record('dd_sections_count', false, 'error',
        `Deep-dive has ${usable.length} usable section(s); minimum ${opts.minDeepDiveSections}.`);
    } else {
      record('dd_sections_count', true, 'error', `Deep-dive sections ok (${usable.length} usable).`);
    }

    // Source-citation presence — at least half of sections should cite at least one source.
    const cited = sections.filter((s) => Array.isArray(s?.sources) && s.sources.some((x) => x?.label || x?.url)).length;
    if (sections.length && cited / sections.length < 0.5) {
      record('dd_source_citations', false, 'warning',
        `Only ${cited}/${sections.length} deep-dive sections cite a source — citation discipline slipping.`);
    } else if (sections.length) {
      record('dd_source_citations', true, 'warning', `${cited}/${sections.length} sections cite sources.`);
    }

    for (const requiredField of ['salesPlayThisWeek', 'coverageSummary']) {
      const val = String(reportContent[requiredField] || '').trim();
      if (!val) {
        record(`dd_required_${requiredField}`, false, 'warning',
          `Deep-dive field "${requiredField}" is empty.`);
      } else {
        record(`dd_required_${requiredField}`, true, 'warning',
          `Deep-dive "${requiredField}" populated (${val.length} chars).`);
      }
    }
  } else {
    const weekSummary = String(reportContent.weekSummary || '').trim();
    if (weekSummary.length < opts.minWeekSummaryChars) {
      record(
        'week_summary_length',
        false,
        'error',
        `weekSummary is too short (${weekSummary.length} chars, minimum ${opts.minWeekSummaryChars}).`
      );
    } else {
      record('week_summary_length', true, 'error', `weekSummary length ok (${weekSummary.length} chars).`);
    }

    const competitorSections = Array.isArray(reportContent.competitorSections)
      ? reportContent.competitorSections
      : [];
    const sectionsWithFindings = competitorSections.filter((s) => s?.hasFindings);
    if (sectionsWithFindings.length < opts.minCompetitorSectionsWithFindings) {
      record(
        'competitor_sections_with_findings',
        false,
        'error',
        `Only ${sectionsWithFindings.length} competitor section(s) have hasFindings=true; minimum ${opts.minCompetitorSectionsWithFindings}. If this is intentional, send manually with a note to the client.`
      );
    } else {
      record(
        'competitor_sections_with_findings',
        true,
        'error',
        `${sectionsWithFindings.length} competitor section(s) have findings this week.`
      );
    }

    const configuredCompetitors = Array.isArray(clientConfig?.competitors) ? clientConfig.competitors : [];
    if (configuredCompetitors.length && competitorSections.length === 0) {
      record(
        'competitor_coverage',
        false,
        'error',
        `Client has ${configuredCompetitors.length} competitors configured but report has 0 competitor sections.`
      );
    } else {
      record('competitor_coverage', true, 'warning', 'Report references at least one competitor.');
    }

    for (const requiredField of ['coverageSummary', 'salesPlayThisWeek']) {
      const val = String(reportContent[requiredField] || '').trim();
      if (!val) {
        record(
          `required_field_${requiredField}`,
          false,
          'warning',
          `Field "${requiredField}" is empty. Report will still render but this is a quality signal.`
        );
      } else {
        record(
          `required_field_${requiredField}`,
          true,
          'warning',
          `Field "${requiredField}" populated (${val.length} chars).`
        );
      }
    }
  }

  if (Array.isArray(analyses) && analyses.length > 0) {
    const totalSignals = analyses.length;
    const failed = analyses.filter((a) => a?.verification?.status === 'fact_check_failed').length;
    const fallbacks = analyses.filter((a) => a?.pipelineNote === 'analysis_parse_failed').length;
    const failureRate = totalSignals ? failed / totalSignals : 0;

    if (failureRate >= opts.factCheckFailureRateBlockThreshold) {
      record(
        'fact_check_failure_rate',
        false,
        'error',
        `Fact-check failure rate is ${(failureRate * 100).toFixed(0)}% (${failed}/${totalSignals}); >= ${(opts.factCheckFailureRateBlockThreshold * 100).toFixed(0)}% blocks auto-delivery.`
      );
    } else {
      record(
        'fact_check_failure_rate',
        true,
        'error',
        `Fact-check failure rate ok (${failed}/${totalSignals} = ${(failureRate * 100).toFixed(0)}%).`
      );
    }

    if (fallbacks > 0) {
      record(
        'pipeline_fallbacks',
        true,
        'warning',
        `${fallbacks} signal(s) hit pipeline fallback (JSON parse failure). Not a blocker but worth skimming the raw data.`
      );
    }
  } else {
    record(
      'analyses_present',
      true,
      'warning',
      'No analyses array supplied to validator; skipping verification-rate check.'
    );
  }

  if (typeof html === 'string' && html.length) {
    const minHtml = artifactType === 'deep-dive' ? opts.minDeepDiveHtmlChars : opts.minHtmlChars;
    if (html.length < minHtml) {
      record(
        'html_length',
        false,
        'error',
        `Final HTML is only ${html.length} chars (minimum ${minHtml} for ${artifactType}). Possible truncation or missing sections.`
      );
    } else {
      record('html_length', true, 'error', `HTML length ok (${html.length} chars, ${artifactType}).`);
    }

    const unfilled = html.match(/\{\{[A-Z_][A-Z0-9_]*\}\}/g);
    if (unfilled?.length) {
      const unique = [...new Set(unfilled)];
      record(
        'html_placeholders_filled',
        false,
        'error',
        `Unfilled template placeholders in HTML: ${unique.join(', ')}. Template rendering bug — do not send.`
      );
    } else {
      record('html_placeholders_filled', true, 'error', 'No unfilled template placeholders.');
    }
  } else {
    record('html_provided', true, 'warning', 'No HTML supplied to validator; skipping HTML-level checks.');
  }

  return finalise(checks);
}

function finalise(checks) {
  const errors = checks.filter((c) => !c.ok && c.level === 'error').map((c) => c.message);
  const warnings = checks.filter((c) => !c.ok && c.level === 'warning').map((c) => c.message);
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    checks,
  };
}

/** Optional Slack ping for ops. No-op if OPS_SLACK_WEBHOOK_URL is unset. */
export async function notifyValidationFailure(clientConfig, result, { htmlPath } = {}) {
  const webhook = process.env.OPS_SLACK_WEBHOOK_URL?.trim();
  if (!webhook) return { sent: false, reason: 'no_webhook' };

  const errorLines = result.errors.map((e) => `• ${e}`).join('\n');
  const warningLines = result.warnings.length
    ? `\n\n*Warnings*\n${result.warnings.map((w) => `• ${w}`).join('\n')}`
    : '';

  const payload = {
    text: [
      `:octagonal_sign: *Report validation failed — delivery BLOCKED* for ${clientConfig.name} (${clientConfig.id})`,
      '',
      '*Errors*',
      errorLines || '(no error messages — check logs)',
      warningLines,
      '',
      htmlPath ? `Saved report HTML: \`${htmlPath}\`` : '',
      'Review manually, fix, and re-run `node scripts/deliver.js` if appropriate.',
    ]
      .filter(Boolean)
      .join('\n'),
  };

  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { sent: res.ok, status: res.status };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

function findLatestFile(dir, prefix, suffix) {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
    .sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

function findByTimestamp(dir, prefix, timestamp, suffix) {
  const p = path.join(dir, `${prefix}${timestamp}${suffix}`);
  return fs.existsSync(p) ? p : null;
}

async function runCli() {
  const clientId = process.argv[2];
  const timestamp = process.argv[3];

  if (!clientId) {
    console.error('Usage: node scripts/validate-report.js <client-id> [<timestamp>]');
    process.exit(2);
  }

  const dataDir = path.join(ROOT, 'data', clientId);
  if (!fs.existsSync(dataDir)) {
    console.error(`No data directory for client: ${clientId}`);
    process.exit(2);
  }

  const contentPath = timestamp
    ? findByTimestamp(dataDir, 'report-content-', timestamp, '.json')
    : findLatestFile(dataDir, 'report-content-', '.json');
  const htmlPath = timestamp
    ? findByTimestamp(dataDir, 'report-', timestamp, '.html')
    : findLatestFile(dataDir, 'report-', '.html');
  const analysesPath = timestamp
    ? findByTimestamp(dataDir, 'analyses-', timestamp, '.json')
    : findLatestFile(dataDir, 'analyses-', '.json');

  if (!contentPath) {
    console.error(`No report-content-*.json found for ${clientId}.`);
    process.exit(2);
  }

  const reportContent = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
  const html = htmlPath ? fs.readFileSync(htmlPath, 'utf8') : '';
  let analyses = null;
  if (analysesPath) {
    try {
      const raw = JSON.parse(fs.readFileSync(analysesPath, 'utf8'));
      analyses = Array.isArray(raw) ? raw : raw?.analyses;
    } catch {
      analyses = null;
    }
  }

  const configPath = path.join(ROOT, 'config', 'clients', `${clientId}.json`);
  const clientConfig = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
    : { id: clientId, name: clientId, competitors: [] };

  const result = validateReport({ reportContent, html, analyses, clientConfig });

  console.log(`\nReport validation for ${clientConfig.name} (${clientConfig.id})`);
  console.log(`Report content: ${path.relative(ROOT, contentPath)}`);
  if (htmlPath) console.log(`HTML:           ${path.relative(ROOT, htmlPath)}`);
  if (analysesPath) console.log(`Analyses:       ${path.relative(ROOT, analysesPath)}`);

  for (const check of result.checks) {
    const icon = check.ok ? '  ok ' : check.level === 'error' ? 'FAIL ' : 'warn ';
    console.log(`  [${icon}] ${check.id}: ${check.message}`);
  }

  if (result.ok) {
    console.log(`\nValidation passed${result.warnings.length ? ` with ${result.warnings.length} warning(s)` : ''}.`);
    process.exit(0);
  } else {
    console.log(`\nValidation FAILED: ${result.errors.length} error(s). Do not send.`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('validate-report.js')) {
  runCli().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(2);
  });
}
