/**
 * Collector: Glassdoor review snippet monitor (Apify)
 * ─────────────────────────────────────────────────────
 * Requires APIFY_API_TOKEN. Configure competitor.glassdoorSlug as the full
 * Glassdoor company reviews page URL, e.g.
 * https://www.glassdoor.com/Reviews/Example-Reviews-E12345.htm
 */

import { APIFY_ACTORS, getApifyClient, isApifyEnabled, runActorDataset, clipText } from './_apify.js';

export async function collectGlassdoor(competitor) {
  const { name, glassdoorSlug } = competitor;

  if (!glassdoorSlug || !String(glassdoorSlug).trim()) {
    return {
      type: 'glassdoor',
      competitor: name,
      data: 'No glassdoorSlug configured (full Glassdoor reviews URL).',
    };
  }

  if (!isApifyEnabled()) {
    return {
      type: 'glassdoor',
      competitor: name,
      data: 'Glassdoor signals skipped — set APIFY_API_TOKEN to run the Apify Glassdoor actor.',
    };
  }

  const client = getApifyClient();
  if (!client) {
    return {
      type: 'glassdoor',
      competitor: name,
      data: 'Glassdoor collector could not initialize Apify client.',
    };
  }

  const companyUrl = String(glassdoorSlug).trim();

  let items;
  try {
    ({ items } = await runActorDataset(
      client,
      APIFY_ACTORS.GLASSDOOR_REVIEWS,
      {
        companyUrl,
        maxItems: 10,
        sort: 'DATE',
      },
      { waitSecs: 600, itemLimit: 30, injectDefaultProxy: true }
    ));
  } catch (e) {
    return {
      type: 'glassdoor',
      competitor: name,
      data: `Glassdoor Apify run failed: ${e.message || String(e)}`,
    };
  }

  if (!items?.length) {
    return {
      type: 'glassdoor',
      competitor: name,
      data: `No Glassdoor reviews returned for ${name} (verify glassdoorSlug URL or cookie limits on Apify actor).`,
    };
  }

  const lines = [
    `Source: Apify (${APIFY_ACTORS.GLASSDOOR_REVIEWS})`,
    `Company URL: ${companyUrl}`,
    '',
  ];

  items.slice(0, 10).forEach((r, i) => {
    const rating = r.rating ?? r.overallRating ?? r.overallNumericRating ?? '';
    const title = r.reviewSummary || r.summary || r.headline || r.jobTitle || `Review ${i + 1}`;
    const pros = r.pros || r.liked || '';
    const cons = r.cons || r.disliked || '';
    const advice = r.advice || r.adviceToManagement || '';
    const status = r.employmentStatus || r.jobStatus || '';
    const text = r.reviewText || r.feedback || '';

    lines.push(`— ${i + 1}. ${title}${rating !== '' ? ` (${rating}/5)` : ''}${status ? ` | ${status}` : ''}`);
    if (pros) lines.push(`  Pros: ${clipText(String(pros), 400)}`);
    if (cons) lines.push(`  Cons: ${clipText(String(cons), 400)}`);
    if (advice) lines.push(`  Advice: ${clipText(String(advice), 300)}`);
    if (text && !pros && !cons) lines.push(`  Text: ${clipText(String(text), 600)}`);
    lines.push('');
  });

  return {
    type: 'glassdoor',
    competitor: name,
    data: lines.join('\n').trim(),
  };
}
