// analytics.js — Webalizer-style usage analytics, backed by Azure Table
// Storage and authenticated via the App Service's managed identity (same
// "no secrets anywhere" pattern as db.js/auth.js: DefaultAzureCredential
// fetches an Azure AD token, no storage account key/connection string ever
// exists in this app).
//
// Privacy-by-design: this deliberately stores NO cookies, NO persistent
// per-visitor identifier, and NO IP addresses — nothing here can identify or
// track an individual visitor across requests, so it doesn't trigger
// UK/EU PECR/GDPR cookie-consent requirements. What's stored is purely
// aggregate: a hit count per page/day, a stripped-down referrer (origin +
// path only — no query string, which can carry sensitive tokens/PII), and a
// coarse browser *family* (e.g. "Chrome"), not the raw User-Agent string,
// to minimize fingerprinting data.
//
// Locally (no storage account configured) `isConfigured` is false, so
// server.js's page-hit logging and the /admin Stats tab both degrade
// gracefully instead of crashing.
const crypto = require("crypto");
const { TableClient } = require("@azure/data-tables");
const { DefaultAzureCredential } = require("@azure/identity");

const STORAGE_ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const TABLE_ENDPOINT = STORAGE_ACCOUNT
  ? `https://${STORAGE_ACCOUNT}.table.core.windows.net`
  : null;

const PAGE_HITS_TABLE = "PageHits";
const GAME_EVENTS_TABLE = "GameEvents";
const RECENT_DAYS = 30; // how far back getStatsSummary() looks
const CHART_DAYS = 14; // how many days the hits-by-day bar chart shows

const isConfigured = Boolean(STORAGE_ACCOUNT);

let credential;
function getCredential() {
  if (!credential) {
    credential = new DefaultAzureCredential();
  }
  return credential;
}

let pageHitsClient;
function getPageHitsClient() {
  if (!pageHitsClient) {
    pageHitsClient = new TableClient(TABLE_ENDPOINT, PAGE_HITS_TABLE, getCredential());
  }
  return pageHitsClient;
}

let gameEventsClient;
function getGameEventsClient() {
  if (!gameEventsClient) {
    gameEventsClient = new TableClient(TABLE_ENDPOINT, GAME_EVENTS_TABLE, getCredential());
  }
  return gameEventsClient;
}

// yyyy-MM-dd (UTC) — used as PartitionKey so date-range queries are simple
// lexicographic string comparisons (`PartitionKey ge '2026-06-01'`), and so
// each day's data is naturally grouped into its own partition.
function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

// Strips a referrer down to origin + path — no query string or fragment,
// since those can carry sensitive tokens or other PII that has no business
// being logged. Returns "" for a missing/unparseable referrer.
function sanitizeReferrer(referrer) {
  if (!referrer) return "";
  try {
    const url = new URL(referrer);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

// Coarse browser *family* only (e.g. "Chrome") — deliberately not the raw
// User-Agent string, which is a meaningful fingerprinting signal on its own.
// Order matters: several browsers' UAs contain "Safari"/"Chrome" as a
// compatibility token, so the more specific checks must run first.
function parseBrowserFamily(userAgent) {
  if (!userAgent) return "Other";
  if (/Edg\//.test(userAgent)) return "Edge";
  if (/OPR\//.test(userAgent) || /Opera/.test(userAgent)) return "Opera";
  if (/Chrome\//.test(userAgent)) return "Chrome";
  if (/Firefox\//.test(userAgent)) return "Firefox";
  if (/Safari\//.test(userAgent)) return "Safari";
  return "Other";
}

async function ensureTableExists(client) {
  try {
    await client.createTable();
  } catch (err) {
    // 409 = already exists, which is the expected/common case on every
    // startup after the first — anything else is a real problem.
    if (err.statusCode !== 409) throw err;
  }
}

// Creates the PageHits/GameEvents tables if they don't exist yet. Safe to
// call on every startup (idempotent); never throws — a failure here just
// means analytics writes/reads will also fail (and log a warning) later,
// same graceful-degradation approach as db.js's ensureSchemaAndSeed.
async function ensureTables() {
  if (!isConfigured) return;
  try {
    await Promise.all([
      ensureTableExists(getPageHitsClient()),
      ensureTableExists(getGameEventsClient()),
    ]);
  } catch (err) {
    console.warn(`[analytics] Failed to ensure tables exist: ${err.message}`);
  }
}

// Fire-and-forget from server.js's page routes — must never throw/reject,
// since nothing awaits or catches this at the call site.
async function logPageHit(path, referrer, userAgent) {
  if (!isConfigured) return;
  try {
    await getPageHitsClient().createEntity({
      partitionKey: dateKey(new Date()),
      rowKey: crypto.randomUUID(),
      Path: path,
      Referrer: sanitizeReferrer(referrer),
      BrowserFamily: parseBrowserFamily(userAgent),
    });
  } catch (err) {
    console.warn(`[analytics] Failed to log page hit for "${path}": ${err.message}`);
  }
}

// Called from POST /api/game-event, which awaits this and needs to
// distinguish success from failure (unlike logPageHit) — so this throws on
// failure rather than swallowing errors, same convention as db.js's
// setPageContent, letting the route respond 503.
async function logGameEvent(game, event, score) {
  if (!isConfigured) {
    throw new Error("Analytics is not configured (AZURE_STORAGE_ACCOUNT_NAME env var is not set)");
  }
  const entity = {
    partitionKey: dateKey(new Date()),
    rowKey: crypto.randomUUID(),
    Game: game,
    Event: event,
  };
  if (typeof score === "number" && Number.isFinite(score)) {
    entity.Score = score;
  }
  await getGameEventsClient().createEntity(entity);
}

// Aggregates the last RECENT_DAYS days of PageHits/GameEvents into a single
// summary object for the /admin Stats tab. Simple in-memory reduce over the
// queried entities — plenty for this site's traffic scale, no need for a
// real analytics/rollup pipeline. Throws on failure (e.g. transient storage
// outage) so the /admin/stats route can respond 503, consistent with how
// other admin routes handle a backend being unavailable.
async function getStatsSummary() {
  if (!isConfigured) {
    throw new Error("Analytics is not configured (AZURE_STORAGE_ACCOUNT_NAME env var is not set)");
  }

  const cutoff = dateKey(new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000));

  let totalHits = 0;
  const hitsByPage = {};
  const hitsByDate = {};
  for await (const entity of getPageHitsClient().listEntities({
    queryOptions: { filter: `PartitionKey ge '${cutoff}'` },
  })) {
    totalHits += 1;
    const p = entity.Path || "unknown";
    hitsByPage[p] = (hitsByPage[p] || 0) + 1;
    hitsByDate[entity.partitionKey] = (hitsByDate[entity.partitionKey] || 0) + 1;
  }

  // Always report a full CHART_DAYS-day window (oldest to newest), even for
  // days with zero hits, so the bar chart is a consistent, gap-free strip.
  const hitsByDay = [];
  for (let i = CHART_DAYS - 1; i >= 0; i--) {
    const day = dateKey(new Date(Date.now() - i * 24 * 60 * 60 * 1000));
    hitsByDay.push({ date: day, count: hitsByDate[day] || 0 });
  }

  const gameAgg = {
    blocks: { plays: 0, scores: [] },
    jump: { plays: 0, scores: [] },
  };
  for await (const entity of getGameEventsClient().listEntities({
    queryOptions: { filter: `PartitionKey ge '${cutoff}'` },
  })) {
    const bucket = gameAgg[entity.Game];
    if (!bucket) continue;
    if (entity.Event === "start") {
      bucket.plays += 1;
    } else if (entity.Event === "end" && typeof entity.Score === "number") {
      bucket.scores.push(entity.Score);
    }
  }

  const games = {};
  for (const [key, bucket] of Object.entries(gameAgg)) {
    const { plays, scores } = bucket;
    games[key] = {
      plays,
      highScore: scores.length ? Math.max(...scores) : 0,
      avgScore: scores.length ? Math.round(scores.reduce((sum, s) => sum + s, 0) / scores.length) : 0,
    };
  }

  return { totalHits, hitsByPage, hitsByDay, games };
}

module.exports = {
  isConfigured,
  ensureTables,
  logPageHit,
  logGameEvent,
  getStatsSummary,
};
