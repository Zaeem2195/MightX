/**
 * Signal Richness Scorer
 * ───────────────────────
 * Quantifies how much genuine competitive movement a week produced, so the
 * pipeline can decide which artifact to ship:
 *
 *   RICH    → produce the full weekly briefing as usual.
 *   NORMAL  → weekly briefing, but the rolling 30-day section will carry
 *             more weight (we'll lean on pattern detection to add value).
 *   SILENT  → the week genuinely had no news. Instead of shipping a thin
 *             "not much happened" email, run-client.js switches to a
 *             "deep-dive" artifact (positioning teardown, pricing forensics,
 *             scenario essay, etc.) — see scripts/artifact-selector.js.
 *
 * Scoring (additive):
 *   +5  for any trigger event (isTriggerEvent === true) on any signal
 *   +2  per verified finding whose sourceConfidence is "high"
 *   +1  per verified finding whose sourceConfidence is "medium"
 *   +0.5 per verified finding whose sourceConfidence is "low"
 *   +2  per distinct competitor that produced at least one verified finding
 *   +1  per distinct signal-type that produced at least one verified finding
 *
 * Penalties:
 *   −1  per pipeline fallback (signal where analyst JSON parse failed)
 *   −2  if more than half of all analyses hit fact_check_failed
 *
 * Default thresholds are deliberately generous: we'd rather produce a full
 * weekly briefing on a borderline week than inadvertently downgrade a rich
 * week to a deep-dive. Operators can override thresholds in client config
 * via `reportPreferences.richnessThresholds = { silent, normal }`.
 */

const DEFAULT_THRESHOLDS = {
  silent: 6,   // score below this → silent week
  normal: 14,  // score at/above this → rich week
};

const SIGNIFICANT_SIGNAL_TYPES = [
  'website',
  'news',
  'g2',
  'jobs',
  'linkedin',
  'glassdoor',
  'github',
  'crunchbase',
  'pricing_archive',
  'sec_filings',
  'sitemap',
  'reddit',
  'hackernews',
];

function confidenceWeight(conf) {
  const c = String(conf || '').toLowerCase();
  if (c === 'high')   return 2;
  if (c === 'medium') return 1;
  if (c === 'low')    return 0.5;
  return 0.5; // unspecified → treat as low
}

/**
 * @param {Array} analyses — the output of runAnalysis(); each row has
 *   { competitorName, signalType, findings: [...], verification, pipelineNote }
 * @param {object} [opts]
 *   @param {{silent:number, normal:number}} [opts.thresholds]
 * @returns {{
 *   tier: 'silent'|'normal'|'rich',
 *   score: number,
 *   breakdown: object,
 *   perCompetitor: Record<string, { score: number, findings: number, triggers: number }>,
 *   perSignalType: Record<string, { findings: number, triggers: number }>,
 *   reasons: string[],
 *   recommendedArtifact: 'weekly-news'|'deep-dive',
 * }}
 */
export function scoreSignalRichness(analyses, opts = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
  const list = Array.isArray(analyses) ? analyses : [];

  let triggerPoints = 0;
  let findingPoints = 0;
  const competitors = new Map();
  const signalTypes = new Map();
  let pipelineFallbacks = 0;
  let factCheckFailed = 0;

  for (const a of list) {
    if (a?.pipelineNote === 'analysis_parse_failed') pipelineFallbacks++;
    if (a?.verification?.status === 'fact_check_failed') factCheckFailed++;

    const findings = Array.isArray(a?.findings) ? a.findings : [];
    const competitor = String(a?.competitorName || 'Unknown');
    const type = String(a?.signalType || 'unknown');

    if (!competitors.has(competitor)) {
      competitors.set(competitor, { score: 0, findings: 0, triggers: 0 });
    }
    if (!signalTypes.has(type)) {
      signalTypes.set(type, { findings: 0, triggers: 0 });
    }

    for (const f of findings) {
      const cConf = confidenceWeight(f?.sourceConfidence);
      findingPoints += cConf;
      competitors.get(competitor).findings += 1;
      signalTypes.get(type).findings += 1;
      competitors.get(competitor).score += cConf;

      if (f?.isTriggerEvent === true) {
        triggerPoints += 5;
        competitors.get(competitor).triggers += 1;
        signalTypes.get(type).triggers += 1;
      }
    }
  }

  const distinctCompetitorsWithFindings = [...competitors.values()].filter((c) => c.findings > 0).length;
  const distinctSignalTypesWithFindings = [...signalTypes.values()].filter((t) => t.findings > 0).length;
  const breadthPoints =
    distinctCompetitorsWithFindings * 2 +
    distinctSignalTypesWithFindings * 1;

  const penalty =
    pipelineFallbacks * -1 +
    (list.length > 0 && factCheckFailed / list.length > 0.5 ? -2 : 0);

  const rawScore = triggerPoints + findingPoints + breadthPoints + penalty;
  const score = Math.max(0, Math.round(rawScore * 10) / 10);

  let tier = 'normal';
  if (score < thresholds.silent && triggerPoints === 0) tier = 'silent';
  else if (score >= thresholds.normal || triggerPoints > 0) tier = 'rich';

  const reasons = [];
  if (triggerPoints > 0) reasons.push(`${triggerPoints / 5} trigger event(s) detected (+${triggerPoints})`);
  reasons.push(`${Math.round(findingPoints * 10) / 10} points from ${list.reduce((acc, a) => acc + (a?.findings?.length || 0), 0)} verified findings`);
  reasons.push(`breadth: ${distinctCompetitorsWithFindings} competitor(s) × ${distinctSignalTypesWithFindings} signal type(s) = +${breadthPoints}`);
  if (pipelineFallbacks) reasons.push(`penalty: ${pipelineFallbacks} pipeline fallback(s)`);
  if (factCheckFailed) reasons.push(`${factCheckFailed} signal batch(es) failed fact-check`);

  const recommendedArtifact = tier === 'silent' ? 'deep-dive' : 'weekly-news';

  return {
    tier,
    score,
    breakdown: {
      triggerPoints,
      findingPoints: Math.round(findingPoints * 10) / 10,
      breadthPoints,
      penalty,
      distinctCompetitorsWithFindings,
      distinctSignalTypesWithFindings,
      pipelineFallbacks,
      factCheckFailed,
      thresholds,
    },
    perCompetitor: Object.fromEntries(competitors),
    perSignalType: Object.fromEntries(signalTypes),
    reasons,
    recommendedArtifact,
  };
}

export const SIGNIFICANT_TYPES = SIGNIFICANT_SIGNAL_TYPES;
