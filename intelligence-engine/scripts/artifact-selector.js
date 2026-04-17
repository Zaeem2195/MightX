/**
 * Artifact Selector
 * ──────────────────
 * Decides which deliverable the client gets this week:
 *
 *   "weekly-news"  — the standard Monday briefing (findings, trigger emails,
 *                    sales play, watch list). Produced by generate-report.js.
 *
 *   "deep-dive"    — a silent-week fallback. Instead of emailing "not much
 *                    happened", we ship a deliberately different artifact
 *                    grounded in the rolling 30-90 days of data we already
 *                    have. Topic rotates through a configurable list so the
 *                    client never sees the same deep-dive twice in a row.
 *
 * Inputs:
 *   - richness result from scripts/signal-richness.js (tier + score)
 *   - prior artifacts log (data/<clientId>/artifact-history.json)
 *   - client config overrides:
 *       reportPreferences.deepDiveRotation = [
 *         'positioning-teardown', 'pricing-forensics', 'hiring-signals',
 *         'scenario-essay', 'meta-analysis'
 *       ]
 *       reportPreferences.forceArtifact = 'weekly-news' | 'deep-dive'
 *       reportPreferences.deepDiveFocus = 'positioning-teardown'  // pin topic
 *
 * Output shape:
 *   {
 *     artifactType:        'weekly-news' | 'deep-dive',
 *     deepDiveTopic:       string | null,
 *     reason:              string,
 *     history:             Array<{ timestamp, artifactType, deepDiveTopic|null, tier, score }>,
 *   }
 *
 * Side effect: updates the history file (caller passes the dataDir).
 */

import fs from 'fs';
import path from 'path';

const DEFAULT_DEEP_DIVE_TOPICS = [
  'positioning-teardown',   // dissect one competitor's homepage / pricing / messaging from scratch
  'pricing-forensics',      // 30-90 day Wayback + sitemap reconstruction of pricing moves
  'hiring-signals',         // synthesise jobs data into a roadmap read-through
  'scenario-essay',         // "if competitor X does Y in the next 90 days, how should sales respond?"
  'meta-analysis',          // cross-competitor trends the client can cite on calls
];

const HISTORY_FILENAME = 'artifact-history.json';

function loadHistory(dataDir) {
  const p = path.join(dataDir, HISTORY_FILENAME);
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveHistory(dataDir, history) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, HISTORY_FILENAME), JSON.stringify(history, null, 2));
}

function pickNextDeepDiveTopic(rotation, history, pinned) {
  if (pinned && rotation.includes(pinned)) return pinned;
  if (!rotation.length) return null;

  const priorDeepDives = history
    .filter((h) => h.artifactType === 'deep-dive' && h.deepDiveTopic)
    .map((h) => h.deepDiveTopic);

  if (!priorDeepDives.length) return rotation[0];

  const last = priorDeepDives[priorDeepDives.length - 1];
  const lastIdx = rotation.indexOf(last);
  if (lastIdx === -1) return rotation[0];
  return rotation[(lastIdx + 1) % rotation.length];
}

/**
 * @param {object} args
 * @param {string} args.clientId
 * @param {string} args.dataDir           — data/<clientId>/
 * @param {object} args.richness          — output of scoreSignalRichness
 * @param {object} args.clientConfig
 * @param {boolean} [args.persist=true]   — write back to artifact-history.json
 */
export function selectArtifactType({ clientId, dataDir, richness, clientConfig, persist = true }) {
  const prefs = clientConfig?.reportPreferences || {};
  const history = loadHistory(dataDir);
  const rotation = Array.isArray(prefs.deepDiveRotation) && prefs.deepDiveRotation.length
    ? prefs.deepDiveRotation
    : DEFAULT_DEEP_DIVE_TOPICS;

  let artifactType;
  let reason;

  if (prefs.forceArtifact === 'weekly-news' || prefs.forceArtifact === 'deep-dive') {
    artifactType = prefs.forceArtifact;
    reason = `forced by clientConfig.reportPreferences.forceArtifact = ${prefs.forceArtifact}`;
  } else {
    artifactType = richness?.recommendedArtifact === 'deep-dive' ? 'deep-dive' : 'weekly-news';
    reason =
      artifactType === 'deep-dive'
        ? `silent week (richness tier = ${richness?.tier}, score = ${richness?.score}); switching to deep-dive rotation so the client does not receive a thin 'not much happened' email`
        : `normal/rich week (richness tier = ${richness?.tier}, score = ${richness?.score}); delivering standard weekly briefing`;
  }

  const deepDiveTopic =
    artifactType === 'deep-dive'
      ? pickNextDeepDiveTopic(rotation, history, prefs.deepDiveFocus)
      : null;

  if (persist) {
    history.push({
      timestamp: new Date().toISOString(),
      artifactType,
      deepDiveTopic,
      tier: richness?.tier || 'unknown',
      score: richness?.score ?? null,
    });
    saveHistory(dataDir, history.slice(-52)); // keep last year (weekly cadence)
  }

  return { artifactType, deepDiveTopic, reason, history };
}

export { DEFAULT_DEEP_DIVE_TOPICS };
