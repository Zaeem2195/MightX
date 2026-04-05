/**
 * Collector: GitHub / Changelog Monitor
 * ───────────────────────────────────────
 * Monitors competitor public GitHub activity and changelog pages for:
 * - Recent releases and version bumps
 * - Commit frequency trends (increasing = active development)
 * - New public repositories (signals new product lines)
 * - Changelog page changes (for closed-source competitors)
 *
 * Uses the public GitHub API (no auth required, 60 req/hr rate limit)
 * and competitor changelog/release-notes page scraping.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

const FETCH_TIMEOUT = 10000;
const LOOKBACK_DAYS = 10;

async function fetchJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'IntelligenceBot/1.0',
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IntelligenceBot/1.0)' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isRecent(dateStr) {
  if (!dateStr) return false;
  try {
    return new Date(dateStr) >= new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  } catch {
    return false;
  }
}

async function fetchGitHubReleases(org) {
  const repos = await fetchJSON(`https://api.github.com/orgs/${org}/repos?sort=pushed&per_page=10`);
  if (!repos || !Array.isArray(repos)) return [];

  const releases = [];

  for (const repo of repos.slice(0, 5)) {
    const repoReleases = await fetchJSON(`https://api.github.com/repos/${org}/${repo.name}/releases?per_page=5`);
    if (!repoReleases || !Array.isArray(repoReleases)) continue;

    for (const rel of repoReleases) {
      if (isRecent(rel.published_at)) {
        releases.push({
          repo: repo.name,
          tag: rel.tag_name,
          name: rel.name || rel.tag_name,
          date: rel.published_at,
          body: (rel.body || '').slice(0, 500),
          url: rel.html_url,
        });
      }
    }
    await new Promise(r => setTimeout(r, 300));
  }

  return releases;
}

async function fetchRecentRepos(org) {
  const repos = await fetchJSON(`https://api.github.com/orgs/${org}/repos?sort=created&per_page=10`);
  if (!repos || !Array.isArray(repos)) return [];

  return repos
    .filter(r => isRecent(r.created_at) && !r.fork)
    .map(r => ({
      name: r.name,
      description: r.description || 'No description',
      language: r.language,
      created: r.created_at,
      url: r.html_url,
    }));
}

async function fetchOrgActivity(org) {
  const events = await fetchJSON(`https://api.github.com/orgs/${org}/events?per_page=30`);
  if (!events || !Array.isArray(events)) return { pushCount: 0, activeRepos: [] };

  const recentPushes = events.filter(e => e.type === 'PushEvent' && isRecent(e.created_at));
  const activeRepos = [...new Set(recentPushes.map(e => e.repo?.name?.split('/')[1]).filter(Boolean))];

  return { pushCount: recentPushes.length, activeRepos: activeRepos.slice(0, 8) };
}

async function fetchChangelogPage(website) {
  const changelogPaths = ['/changelog', '/release-notes', '/whats-new', '/updates', '/blog/changelog'];

  for (const p of changelogPaths) {
    const url = website.replace(/\/$/, '') + p;
    const html = await fetchText(url);
    if (!html || html.length < 500) continue;

    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 3000);

    return { url, text };
  }
  return null;
}

function snapshotPath(clientId, competitorName) {
  const dir = path.join(ROOT, 'data', clientId, 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const slug = competitorName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  return path.join(dir, `${slug}-github.json`);
}

function loadSnapshot(clientId, competitorName) {
  const p = snapshotPath(clientId, competitorName);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveSnapshot(clientId, competitorName, data) {
  fs.writeFileSync(snapshotPath(clientId, competitorName), JSON.stringify(data, null, 2));
}

export async function collectGitHub(clientId, competitor) {
  const { name, githubOrg, website } = competitor;

  if (!githubOrg && !website) {
    return { type: 'github', competitor: name, data: 'No GitHub org or website configured.' };
  }

  const findings = [];

  if (githubOrg) {
    const [releases, newRepos, activity] = await Promise.all([
      fetchGitHubReleases(githubOrg),
      fetchRecentRepos(githubOrg),
      fetchOrgActivity(githubOrg),
    ]);

    if (releases.length) {
      findings.push(`Recent releases (last ${LOOKBACK_DAYS} days):`);
      for (const rel of releases) {
        findings.push(`  - ${rel.repo} ${rel.tag} "${rel.name}" (${new Date(rel.date).toLocaleDateString()})`);
        if (rel.body) {
          const summary = rel.body.split('\n').filter(l => l.trim()).slice(0, 3).join('; ');
          findings.push(`    Notes: ${summary}`);
        }
      }
      findings.push('');
    }

    if (newRepos.length) {
      findings.push('New public repositories:');
      for (const repo of newRepos) {
        findings.push(`  - ${repo.name}: ${repo.description} (${repo.language || 'unknown lang'})`);
      }
      findings.push('');
    }

    if (activity.pushCount > 0) {
      findings.push(`Development activity: ${activity.pushCount} push events in the last ${LOOKBACK_DAYS} days across repos: ${activity.activeRepos.join(', ')}`);
    }

    const previous = loadSnapshot(clientId, name);
    saveSnapshot(clientId, name, {
      releases: releases.length,
      newRepos: newRepos.length,
      pushCount: activity.pushCount,
      savedAt: new Date().toISOString(),
    });

    if (previous && previous.pushCount > 0) {
      const change = activity.pushCount - previous.pushCount;
      if (Math.abs(change) > 5) {
        const direction = change > 0 ? 'increased' : 'decreased';
        findings.push(`\nDevelopment velocity ${direction} by ${Math.abs(change)} push events compared to previous check.`);
      }
    }
  }

  if (website) {
    const changelog = await fetchChangelogPage(website);
    if (changelog) {
      findings.push(`\nChangelog/release notes found at ${changelog.url} (first 200 chars):`);
      findings.push(changelog.text.slice(0, 200));
    }
  }

  if (!findings.length) {
    return {
      type: 'github',
      competitor: name,
      data: `No significant GitHub/changelog activity detected for ${name}.`,
    };
  }

  return {
    type: 'github',
    competitor: name,
    data: findings.join('\n').trim(),
  };
}
