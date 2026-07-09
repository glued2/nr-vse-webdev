// Express server that serves the static site in public/, with the Intro,
// Details, and Contact page bodies rendered dynamically from Azure SQL
// Database (via the App Service's managed identity — see db.js) instead of
// being fully static. If the database is unreachable (local dev, or a
// transient Azure issue), the original static content baked into each HTML
// file is used as a fallback, so the site never crashes or breaks when SQL
// isn't available. Also logs privacy-preserving usage analytics (page hits,
// game plays) to Azure Table Storage — see analytics.js — surfaced in the
// /admin Stats tab.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const db = require("./db");
const auth = require("./auth");
const analytics = require("./analytics");
const buildLog = require("./buildlog");

const app = express();
const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, "public");

// Azure App Service terminates TLS in front of the app and forwards plain
// HTTP internally — trust its X-Forwarded-Proto header so secure cookies
// still work correctly.
app.set("trust proxy", 1);

// No ENTRA_CLIENT_ID/ENTRA_TENANT_ID/AZURE_ADMIN_UAMI_CLIENT_ID configured ->
// disable admin editing entirely rather than falling back to any insecure
// default. See auth.js for how sign-in works (Entra ID, no client secret).
if (!auth.isConfigured) {
  console.warn(
    "[auth] Entra sign-in is not fully configured (ENTRA_CLIENT_ID / ENTRA_TENANT_ID / AZURE_ADMIN_UAMI_CLIENT_ID) — the /admin content editor is disabled."
  );
}

// No AZURE_STORAGE_ACCOUNT_NAME configured -> usage analytics is disabled
// entirely (no page-hit/game-event logging, Stats tab shows a "not
// configured" message) rather than crashing. See analytics.js for the
// privacy-by-design rationale (no cookies, no IP addresses, no persistent
// visitor identifiers).
if (!analytics.isConfigured) {
  console.log(
    "[analytics] Azure Table Storage is not configured (AZURE_STORAGE_ACCOUNT_NAME) — usage analytics is disabled."
  );
}

// The DB-backed content sections: `key` matches the CONTENT marker + a
// PageContent row, `file` is the static template that provides the page
// layout/hero/card chrome + fallback content, `title` is a friendly label
// shown in the admin editor only. Each section corresponds to one editable
// card's inner content (heading, paragraphs, lists, links) — the surrounding
// hero and `<div class="card">` chrome stays static in the template so a
// rich-text (Quill) edit can never strip/break the page's visual structure.
const SECTIONS = [
  { key: "intro-what", file: "index.html", title: "Intro — What is this?" },
  { key: "intro-next", file: "index.html", title: "Intro — Where to next?" },
  { key: "details-copilot", file: "details.html", title: "Details — Built with GitHub Copilot" },
  { key: "details-infra", file: "details.html", title: "Details — The infrastructure" },
  { key: "details-pipeline", file: "details.html", title: "Details — The deployment pipeline" },
  { key: "contact-github", file: "contact.html", title: "Contact — Find me on GitHub" },
];

// Legacy PageKey values from before content was split per-card (one row per
// whole page, including the hero and every card in a single HTML blob). No
// longer read anywhere; pruned from the database on startup so a stale/
// accidentally-mangled row (e.g. one that got flattened by an earlier Quill
// save) doesn't linger unused. Safe/idempotent — a no-op once already pruned.
const LEGACY_KEYS = ["intro", "details", "contact"];

function readTemplate(file) {
  return fs.readFileSync(path.join(PUBLIC_DIR, file), "utf8");
}

// Groups SECTIONS by their template file, e.g. { "index.html": [intro-what,
// intro-next], "details.html": [details-copilot, ...], ... } so a page
// render only needs one DB round-trip regardless of how many editable
// sections it contains.
const SECTIONS_BY_FILE = SECTIONS.reduce((acc, section) => {
  (acc[section.file] = acc[section.file] || []).push(section);
  return acc;
}, {});

function markerTags(key) {
  return {
    start: `<!-- CONTENT:${key}:start -->`,
    end: `<!-- CONTENT:${key}:end -->`,
  };
}

// Pulls the HTML currently sitting between a page's content markers in its
// static template — this doubles as both the seed content and the fallback
// content used whenever the database is unavailable.
function extractMarkerContent(html, key) {
  const { start, end } = markerTags(key);
  const startIdx = html.indexOf(start);
  const endIdx = html.indexOf(end);
  if (startIdx === -1 || endIdx === -1) return null;
  return html.slice(startIdx + start.length, endIdx).trim();
}

function replaceMarkerContent(html, key, newInner) {
  const { start, end } = markerTags(key);
  const startIdx = html.indexOf(start);
  const endIdx = html.indexOf(end);
  if (startIdx === -1 || endIdx === -1) return html;
  const before = html.slice(0, startIdx + start.length);
  const after = html.slice(endIdx);
  return `${before}\n${newInner}\n${after}`;
}

// Renders a DB-backed page: read the static template (hero/card chrome +
// per-section fallback content), try to swap in each section's current
// database content, and always fall back gracefully to the static content
// (per-section) on any DB error.
async function renderPage(res, file) {
  const template = readTemplate(file);
  let html = template;
  const sections = SECTIONS_BY_FILE[file] || [];
  if (sections.length > 0) {
    try {
      const allContent = await db.getAllPageContent();
      for (const section of sections) {
        const entry = allContent[section.key];
        if (entry && entry.bodyHtml) {
          html = replaceMarkerContent(html, section.key, entry.bodyHtml);
        }
      }
    } catch (err) {
      console.warn(`[db] Using static fallback content for "${file}": ${err.message}`);
    }
  }
  res.set("Content-Type", "text/html; charset=utf-8").send(html);
}

// Ensures the PageContent table exists and is seeded with the content
// currently baked into the static templates (one row per editable card
// section). Runs once at startup, is fully idempotent (never overwrites
// existing rows), and never crashes the server if Azure SQL isn't configured
// or reachable. Also prunes any leftover legacy whole-page rows.
async function seedDatabase() {
  if (!db.isConfigured) {
    console.log(
      "[db] Azure SQL is not configured — pages will use static fallback content."
    );
    return;
  }
  try {
    const templateCache = {};
    const seedRows = SECTIONS.map((section) => {
      const template = templateCache[section.file] || (templateCache[section.file] = readTemplate(section.file));
      return {
        pageKey: section.key,
        title: section.title,
        bodyHtml: extractMarkerContent(template, section.key) || "",
      };
    });
    await db.ensureSchemaAndSeed(seedRows);
    await db.pruneLegacyKeys(LEGACY_KEYS);
    console.log("[db] Schema ensured and seed content applied (idempotent).");
  } catch (err) {
    console.warn(`[db] Failed to ensure schema/seed: ${err.message}`);
  }
}

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    name: "nrvse.sid",
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: "auto",
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    },
  })
);

// Fire-and-forget usage logging for the actual page routes only (not static
// assets, not /admin/* or /auth/*, not /api/game-event) — analytics.js
// itself never throws/rejects here, so this is safe to call without
// awaiting and can never slow down or break a response.
function recordPageHit(req) {
  analytics.logPageHit(req.path, req.get("Referer"), req.get("User-Agent"));
}

app.get("/", (req, res) => {
  recordPageHit(req);
  renderPage(res, "index.html");
});
app.get("/details", (req, res) => {
  recordPageHit(req);
  renderPage(res, "details.html");
});
app.get("/contact", (req, res) => {
  recordPageHit(req);
  renderPage(res, "contact.html");
});

// The old direct-file nav links predate DB-backed rendering; redirect them
// to their dynamic equivalents so DB edits are always reflected regardless
// of which URL a visitor lands on.
app.get("/index.html", (req, res) => res.redirect(301, "/"));
app.get("/details.html", (req, res) => res.redirect(301, "/details"));
app.get("/contact.html", (req, res) => res.redirect(301, "/contact"));

app.get("/play", (req, res) => {
  recordPageHit(req);
  res.sendFile(path.join(PUBLIC_DIR, "play.html"));
});

app.get("/jump", (req, res) => {
  recordPageHit(req);
  res.sendFile(path.join(PUBLIC_DIR, "jump.html"));
});

app.get("/eat", (req, res) => {
  recordPageHit(req);
  res.sendFile(path.join(PUBLIC_DIR, "eat.html"));
});

// --- Build Log: recent merged PRs across this project's repos -----------
// Server-rendered (not a static sendFile) since the content comes live from
// the GitHub REST API — see buildlog.js for the fetch/cache logic. Reuses
// the same CONTENT:<key> marker mechanism as the DB-backed sections (a
// generic string-replace utility, not tied to the SECTIONS/admin-editor
// list), but "build-log" is deliberately NOT registered in SECTIONS: this
// content isn't editable via /admin, it's always driven live from GitHub.

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderBuildLogEntriesHtml(entries) {
  if (!entries.length) {
    return `<p class="build-log-notice">No merged pull requests found yet.</p>`;
  }
  const rows = entries
    .map((e) => {
      const mergedDisplay = new Date(e.mergedAt).toISOString().slice(0, 10);
      return `      <tr>
        <td><span class="repo-badge">${escapeHtml(e.repo)}</span></td>
        <td><a href="${escapeHtml(e.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(e.title)}</a></td>
        <td>#${e.number}</td>
        <td>${mergedDisplay}</td>
      </tr>`;
    })
    .join("\n");
  return `<table class="build-log-table">
    <thead>
      <tr><th>Repo</th><th>Title</th><th>PR</th><th>Merged</th></tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>`;
}

app.get("/build-log", async (req, res) => {
  recordPageHit(req);
  const template = readTemplate("build-log.html");
  let inner;
  try {
    const { entries, stale, error } = await buildLog.getBuildLog();
    inner = renderBuildLogEntriesHtml(entries);
    if (stale) {
      const notice = entries.length
        ? "Showing the last known history — live GitHub data is temporarily unavailable."
        : "Build history is temporarily unavailable — please check back soon.";
      console.warn(`[build-log] Serving stale/empty data: ${error}`);
      inner = `<p class="build-log-notice">${notice}</p>\n${entries.length ? inner : ""}`;
    }
  } catch (err) {
    console.warn(`[build-log] Unexpected failure rendering build log: ${err.message}`);
    inner = `<p class="build-log-notice">Build history is temporarily unavailable — please check back soon.</p>`;
  }
  const html = replaceMarkerContent(template, "build-log", inner);
  res.set("Content-Type", "text/html; charset=utf-8").send(html);
});

// --- Game analytics: fire-and-forget events from play.html/jump.html -----
// Not gated by requireAdmin (any visitor playing a game can post here) and
// not counted as a page hit itself — this is purely game telemetry (start/
// end + score), stored in its own GameEvents table by analytics.js. Never
// breaks gameplay: analytics.js validates + writes, and any failure here
// just means analytics.logGameEvent() throws so we can respond 503 — the
// game clients themselves treat this endpoint as fire-and-forget and ignore
// the response either way.
const GAME_EVENT_GAMES = ["blocks", "jump", "eat"];
const GAME_EVENT_TYPES = ["start", "end"];

app.post("/api/game-event", async (req, res) => {
  if (!analytics.isConfigured) {
    return res.status(503).json({ error: "Analytics is not configured." });
  }

  const { game, event, score } = req.body || {};
  if (!GAME_EVENT_GAMES.includes(game)) {
    return res.status(400).json({ error: "Unknown game." });
  }
  if (!GAME_EVENT_TYPES.includes(event)) {
    return res.status(400).json({ error: "Unknown event." });
  }

  let numericScore;
  if (score !== undefined && score !== null) {
    if (typeof score !== "number" || !Number.isFinite(score)) {
      return res.status(400).json({ error: "score must be a finite number." });
    }
    numericScore = score;
  }

  try {
    await analytics.logGameEvent(game, event, numericScore);
    res.status(204).end();
  } catch (err) {
    console.warn(`[analytics] Failed to log game event: ${err.message}`);
    res.status(503).json({ error: "Analytics is unavailable — event was not recorded." });
  }
});

// --- Entra ID sign-in (authorization code flow) --------------------------
// No client secret anywhere — see auth.js. The App Registration trusts this
// App Service's user-assigned managed identity via workload identity
// federation instead.

function buildRedirectUri(req) {
  return `${req.protocol}://${req.get("host")}/auth/callback`;
}

app.get("/auth/login", async (req, res) => {
  if (!auth.isConfigured) {
    return res.status(503).send("Entra sign-in is not configured on this server.");
  }
  try {
    // Random per-attempt value stored in the session and checked on
    // callback, so a forged/replayed callback request can't complete a
    // sign-in on someone else's behalf (CSRF protection).
    const state = crypto.randomBytes(16).toString("hex");
    req.session.authState = state;
    const url = await auth.getAuthCodeUrl(buildRedirectUri(req), state);
    res.redirect(url);
  } catch (err) {
    console.error(`[auth] Failed to start sign-in: ${err.message}`);
    res.status(500).send("Failed to start sign-in.");
  }
});

app.get("/auth/callback", async (req, res) => {
  if (!auth.isConfigured) {
    return res.status(503).send("Entra sign-in is not configured on this server.");
  }
  if (req.query.error) {
    // e.g. AADSTS50105 when a user isn't assigned to the Enterprise
    // Application — Entra itself rejects them before this code runs.
    console.warn(
      `[auth] Sign-in failed: ${req.query.error} - ${req.query.error_description || ""}`
    );
    return res.redirect("/admin?error=access_denied");
  }
  const expectedState = req.session.authState;
  delete req.session.authState;
  if (!req.query.state || req.query.state !== expectedState) {
    return res.status(400).send("Invalid sign-in state.");
  }
  try {
    const user = await auth.acquireTokenByCode(req.query.code, buildRedirectUri(req));
    req.session.user = user;
    res.redirect("/admin");
  } catch (err) {
    console.error(`[auth] Sign-in callback failed: ${err.message}`);
    res.redirect("/admin?error=sign_in_failed");
  }
});

app.get("/auth/logout", (req, res) => {
  const postLogoutRedirectUri = `${req.protocol}://${req.get("host")}/`;
  if (!req.session) {
    return res.redirect(auth.logoutUrl(postLogoutRedirectUri));
  }
  req.session.destroy(() => {
    res.redirect(auth.logoutUrl(postLogoutRedirectUri));
  });
});

// --- Admin: Entra-gated content editor ------------------------------------
// Linked from the main nav on every page (as "Admin"), swapping to a
// "Signed in as {name} · Sign out" indicator once signed in — access itself
// is still enforced entirely by every write requiring a session established
// by signing in with Microsoft Entra ID (see /auth/* above), not by keeping
// the URL secret.

app.get("/admin", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

app.get("/admin/status", (req, res) => {
  const user = req.session && req.session.user;
  res.json({
    adminEnabled: auth.isConfigured,
    loggedIn: Boolean(user),
    user: user ? { name: user.name, username: user.username } : null,
  });
});

function requireAdmin(req, res, next) {
  if (!auth.isConfigured) {
    return res
      .status(503)
      .json({ error: "Admin editing is disabled (Entra sign-in is not configured)." });
  }
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  next();
}

app.get("/admin/content", requireAdmin, async (req, res) => {
  let dbContentByKey = {};
  let dbAvailable = true;
  try {
    dbContentByKey = await db.getAllPageContent();
  } catch (err) {
    dbAvailable = false;
    console.warn(`[db] Could not load content for admin editor: ${err.message}`);
  }

  const pages = {};
  for (const section of SECTIONS) {
    const dbEntry = dbContentByKey[section.key];
    if (dbEntry) {
      pages[section.key] = {
        title: dbEntry.title,
        bodyHtml: dbEntry.bodyHtml,
        updatedAt: dbEntry.updatedAt,
        source: "database",
      };
    } else {
      const template = readTemplate(section.file);
      pages[section.key] = {
        title: section.title,
        bodyHtml: extractMarkerContent(template, section.key) || "",
        updatedAt: null,
        source: "static-fallback",
      };
    }
  }

  res.json({ pages, dbAvailable });
});

app.post("/admin/content/:pageKey", requireAdmin, async (req, res) => {
  const section = SECTIONS.find((s) => s.key === req.params.pageKey);
  if (!section) {
    return res.status(404).json({ error: "Unknown page key." });
  }

  const { bodyHtml, title } = req.body || {};
  if (typeof bodyHtml !== "string" || !bodyHtml.trim()) {
    return res.status(400).json({ error: "bodyHtml is required." });
  }

  const effectiveTitle = typeof title === "string" && title.trim() ? title.trim() : section.title;

  try {
    await db.setPageContent(section.key, effectiveTitle, bodyHtml);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[db] Failed to save content for "${section.key}": ${err.message}`);
    res
      .status(503)
      .json({ error: "Azure SQL is unavailable — changes were not saved." });
  }
});

// Webalizer-style usage stats for the /admin "Stats" tab — page hits (by
// page, by day) and game plays/scores, aggregated from Azure Table Storage.
// See analytics.js for the privacy-by-design rationale (no cookies, no IP
// addresses, no persistent visitor identifiers — purely aggregate counts).
app.get("/admin/stats", requireAdmin, async (req, res) => {
  if (!analytics.isConfigured) {
    return res.json({ configured: false });
  }
  try {
    const summary = await analytics.getStatsSummary();
    res.json({ configured: true, ...summary });
  } catch (err) {
    console.warn(`[analytics] Failed to load stats summary: ${err.message}`);
    res
      .status(503)
      .json({ configured: true, error: "Analytics storage is unavailable right now." });
  }
});

// Serves the Quill rich-text editor's pre-built JS/CSS straight from the npm
// package (installed via node_modules, no CDN, no manual vendoring/copy
// step) — used only by public/admin.html.
app.use(
  "/vendor/quill",
  express.static(path.join(__dirname, "node_modules", "quill", "dist"))
);

// Registered last (and with index:false) so it never shadows the dynamic
// "/" route or the .html redirects above — it only serves concrete static
// assets (CSS/JS/images/play & jump pages/admin shell).
app.use(express.static(PUBLIC_DIR, { index: false }));

app.listen(PORT, () => {
  console.log(`nr-vse-webdev listening on port ${PORT}`);
});

// Fire-and-forget: don't block server startup on the database or analytics
// storage being reachable.
seedDatabase();
analytics.ensureTables();
