// buildlog.js — fetches recently merged pull requests for this site's GitHub
// repo, for the "Build Log" page. Deliberately secretless: unauthenticated
// GitHub REST API requests only (no PAT, no GitHub App, no stored credential
// of any kind), same "no secrets" philosophy as db.js/auth.js/analytics.js —
// just backed by a public, unauthenticated API instead of a
// managed-identity-gated Azure resource.
//
// GitHub allows 60 unauthenticated requests/hour per source IP. To stay
// comfortably under that regardless of site traffic, results are cached in
// memory for CACHE_TTL_MS and only refreshed on expiry — worst case this is
// 1 request every 15 minutes, ~4/hour, no matter how many visitors hit the
// page in between.
//
// REPOS only lists this repo (nr-vse-webdev) — the companion infra repos
// (nr-vse-azure-lab, nr-azure-lab-workflows) are private, and unauthenticated
// GitHub API requests against a private repo return 404. They could be added
// back here if/when those repos are made public; until then, adding them
// would only produce logged fetch failures with no benefit.
const REPOS = [{ owner: "glued2", repo: "nr-vse-webdev" }];

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const PER_REPO_FETCH_COUNT = 20;
const MAX_ENTRIES = 30;
// GitHub's API requires a User-Agent header even for unauthenticated
// requests, or it rejects the request outright.
const USER_AGENT = "dev.g2t.co.uk-buildlog";

let cache = {
  entries: null, // null until the first successful refresh
  fetchedAt: 0,
};

async function fetchMergedPRs(owner, repo) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${PER_REPO_FETCH_COUNT}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status} for ${owner}/${repo}`);
  }
  const data = await res.json();
  return data
    .filter((pr) => pr.merged_at)
    .map((pr) => ({
      owner,
      repo,
      number: pr.number,
      title: pr.title,
      mergedAt: pr.merged_at,
      url: pr.html_url,
    }));
}

// Fetches every configured repo independently (Promise.allSettled, not
// Promise.all) so one repo being unreachable/rate-limited doesn't discard
// any others' results — partial data is strictly better than none for a
// "build log". (Currently REPOS has just one entry, but this keeps the
// degrade-gracefully behavior ready if more repos are added later.)
async function refreshCache() {
  const results = await Promise.allSettled(REPOS.map((r) => fetchMergedPRs(r.owner, r.repo)));
  const combined = [];
  let anySucceeded = false;
  results.forEach((result, i) => {
    const { owner, repo } = REPOS[i];
    if (result.status === "fulfilled") {
      anySucceeded = true;
      combined.push(...result.value);
    } else {
      console.warn(`[build-log] Failed to fetch merged PRs for ${owner}/${repo}: ${result.reason.message}`);
    }
  });
  if (!anySucceeded) {
    throw new Error("All repo fetches failed.");
  }
  combined.sort((a, b) => new Date(b.mergedAt) - new Date(a.mergedAt));
  cache = { entries: combined.slice(0, MAX_ENTRIES), fetchedAt: Date.now() };
  console.log(`[build-log] Refreshed cache from GitHub API: ${cache.entries.length} merged PRs.`);
  return cache.entries;
}

// Returns { entries, stale, error } and never throws — callers never need
// their own try/catch to stay crash-safe (same pattern as
// analytics.getStatsSummary()'s callers, just resolved defensively here
// instead of relying on the caller to catch).
//   - entries: the merged-PR list to render (empty array if nothing is
//     available yet).
//   - stale: true if this data is not freshly fetched (either it's an older
//     cached copy served after a failed refresh, or refresh failed and no
//     cache exists at all).
//   - error: the last refresh error's message, if any.
async function getBuildLog() {
  const now = Date.now();
  const cacheIsFresh = cache.entries && now - cache.fetchedAt < CACHE_TTL_MS;
  if (cacheIsFresh) {
    console.log(`[build-log] Serving ${cache.entries.length} cached entries (age ${Math.round((now - cache.fetchedAt) / 1000)}s, no GitHub API call).`);
    return { entries: cache.entries, stale: false, error: null };
  }
  try {
    const entries = await refreshCache();
    return { entries, stale: false, error: null };
  } catch (err) {
    if (cache.entries) {
      console.warn(`[build-log] Refresh failed (${err.message}) — serving last known-good cached data.`);
      return { entries: cache.entries, stale: true, error: err.message };
    }
    console.warn(`[build-log] Refresh failed (${err.message}) — no cached data available yet.`);
    return { entries: [], stale: true, error: err.message };
  }
}

module.exports = { getBuildLog, REPOS, CACHE_TTL_MS };
