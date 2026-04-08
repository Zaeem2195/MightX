/**
 * Apify actor helper — optional premium collectors when APIFY_API_TOKEN is set.
 * Actor IDs use Apify Console format: username/actor-name
 */

import { ApifyClient } from 'apify-client';

/** Actor IDs (see plan / Apify Store). */
export const APIFY_ACTORS = {
  LINKEDIN_COMPANY: 'artificially/linkedin-company-scraper',
  LINKEDIN_POSTS: 'scraper-engine/linkedin-company-post-scraper',
  G2_REVIEWS: 'zen-studio/g2-reviews-scraper',
  GOOGLE_NEWS: 'fabri-lab/apify-google-news-scraper',
  WEBSITE_CHANGE: 'automation-lab/website-change-monitor',
  ARTICLE_EXTRACTOR: 'tugelbay/article-extractor',
  GLASSDOOR_REVIEWS: 'crawlerbros/glassdoor-reviews-scraper',
};

let _client = null;

export function isApifyEnabled() {
  return Boolean(process.env.APIFY_API_TOKEN?.trim());
}

export function getApifyClient() {
  if (!isApifyEnabled()) return null;
  if (!_client) {
    _client = new ApifyClient({ token: process.env.APIFY_API_TOKEN.trim() });
  }
  return _client;
}

/**
 * Run an actor synchronously (wait for finish) and return dataset items.
 * @param {ApifyClient} client
 * @param {string} actorId
 * @param {object} input
 * @param {{ waitSecs?: number, itemLimit?: number, injectDefaultProxy?: boolean }} [opts]
 */
export async function runActorDataset(client, actorId, input, opts = {}) {
  const waitSecs = opts.waitSecs ?? 600;
  const itemLimit = opts.itemLimit ?? 2000;
  const injectDefaultProxy = opts.injectDefaultProxy !== false;

  const runInput = { ...input };
  if (injectDefaultProxy && runInput.proxyConfiguration === undefined) {
    runInput.proxyConfiguration = { useApifyProxy: true };
  }

  const run = await client.actor(actorId).call(runInput, { waitSecs });
  const { items } = await client.dataset(run.defaultDatasetId).listItems({
    clean: true,
    limit: itemLimit,
  });

  return { run, items };
}

export function clipText(s, maxLen) {
  if (!s || typeof s !== 'string') return '';
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen - 1)}…`;
}
