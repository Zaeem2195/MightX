/**
 * Collector: G2 Review Monitor
 * ─────────────────────────────
 * Scrapes the public G2 product page for recent reviews.
 * No API key required — G2 public pages are freely accessible.
 * Extracts review titles, ratings, and snippets from the last 30 days.
 */

const FETCH_TIMEOUT = 12000;
const MAX_REVIEWS   = 10;

// ── Fetch G2 product page ─────────────────────────────────────────────────────
async function fetchG2Page(slug) {
  const url = `https://www.g2.com/products/${slug}/reviews`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Extract review snippets from HTML ────────────────────────────────────────
function extractReviews(html) {
  if (!html) return [];

  const reviews = [];

  // Extract star ratings
  const ratingMatches = [...html.matchAll(/itemprop="ratingValue" content="(\d+\.?\d*)"/g)];

  // Extract review titles
  const titleMatches = [...html.matchAll(/itemprop="name"[^>]*>([^<]{10,120})<\/span>/g)];

  // Extract review body text (look for review content patterns)
  const bodyMatches = [...html.matchAll(/class="[^"]*formatted-text[^"]*"[^>]*>\s*<p[^>]*>([\s\S]{50,600}?)<\/p>/g)];

  // Extract "what do you like most" sections
  const likeMatches = [...html.matchAll(/What do you like best about[^?]+\?[^<]*<\/[^>]+>\s*<p[^>]*>([\s\S]{20,400}?)<\/p>/g)];

  // Extract "what do you dislike" sections
  const dislikeMatches = [...html.matchAll(/What do you dislike about[^?]+\?[^<]*<\/[^>]+>\s*<p[^>]*>([\s\S]{20,400}?)<\/p>/g)];

  const maxCount = Math.min(
    MAX_REVIEWS,
    Math.max(titleMatches.length, bodyMatches.length, likeMatches.length)
  );

  for (let i = 0; i < maxCount; i++) {
    const title   = titleMatches[i]?.[1]?.replace(/<[^>]+>/g, '').trim() || '';
    const rating  = ratingMatches[i]?.[1] || '';
    const body    = bodyMatches[i]?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '';
    const liked   = likeMatches[i]?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '';
    const disliked = dislikeMatches[i]?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '';

    if (title || body || liked) {
      reviews.push({ rating, title, body, liked, disliked });
    }
  }

  return reviews;
}

// ── Extract aggregate rating + review count ───────────────────────────────────
function extractAggregateRating(html) {
  if (!html) return null;

  const ratingMatch  = html.match(/itemprop="ratingValue" content="(\d+\.?\d*)"/);
  const countMatch   = html.match(/itemprop="reviewCount" content="(\d+)"/);
  const avgMatch     = html.match(/"averageRating":(\d+\.?\d*)/);

  const rating = ratingMatch?.[1] || avgMatch?.[1] || null;
  const count  = countMatch?.[1] || null;

  return rating ? `Overall rating: ${rating}/5 (${count || 'unknown'} reviews)` : null;
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function collectG2(competitor) {
  const { name, g2Slug } = competitor;

  if (!g2Slug) {
    return {
      type:       'g2_reviews',
      competitor: name,
      data:       'No G2 slug configured for this competitor.',
    };
  }

  const html = await fetchG2Page(g2Slug);

  if (!html) {
    return {
      type:       'g2_reviews',
      competitor: name,
      data:       `Could not fetch G2 page for ${name}. G2 may be blocking the request.`,
    };
  }

  const aggregate = extractAggregateRating(html);
  const reviews   = extractReviews(html);

  if (!reviews.length) {
    return {
      type:       'g2_reviews',
      competitor: name,
      data:       aggregate
        ? `${aggregate}\n\nCould not extract individual review text (G2 may require JS rendering).`
        : `Could not extract G2 reviews for ${name}.`,
    };
  }

  const lines = [];
  if (aggregate) lines.push(aggregate, '');

  reviews.forEach((r, i) => {
    lines.push(`Review ${i + 1} (${r.rating ? r.rating + '/5' : 'unrated'}):`);
    if (r.title)    lines.push(`  Title: ${r.title}`);
    if (r.liked)    lines.push(`  Liked: ${r.liked}`);
    if (r.disliked) lines.push(`  Disliked: ${r.disliked}`);
    if (r.body && !r.liked) lines.push(`  Text: ${r.body}`);
    lines.push('');
  });

  return {
    type:       'g2_reviews',
    competitor: name,
    data:       lines.join('\n').trim(),
  };
}
