// Express server that serves the static site in public/, with the Intro,
// Details, and Contact page bodies rendered dynamically from Azure SQL
// Database (via the App Service's managed identity — see db.js) instead of
// being fully static. If the database is unreachable (local dev, or a
// transient Azure issue), the original static content baked into each HTML
// file is used as a fallback, so the site never crashes or breaks when SQL
// isn't available.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, "public");

// Azure App Service terminates TLS in front of the app and forwards plain
// HTTP internally — trust its X-Forwarded-Proto header so secure cookies
// still work correctly.
app.set("trust proxy", 1);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_ENABLED = Boolean(ADMIN_PASSWORD);
// No ADMIN_PASSWORD configured -> disable admin editing entirely rather than
// falling back to any hardcoded/default password.
if (!ADMIN_ENABLED) {
  console.warn(
    "[admin] ADMIN_PASSWORD is not set — the /admin content editor is disabled."
  );
}

// The three DB-backed pages: `key` matches the CONTENT marker + PageContent
// row, `file` is the static template that provides layout + fallback
// content, `title` is a friendly label shown in the admin editor only.
const PAGES = [
  { key: "intro", file: "index.html", title: "Intro" },
  { key: "details", file: "details.html", title: "Details" },
  { key: "contact", file: "contact.html", title: "Contact" },
];

function readTemplate(file) {
  return fs.readFileSync(path.join(PUBLIC_DIR, file), "utf8");
}

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

// Renders a DB-backed page: read the static template (layout + fallback
// content), try to swap in the current database content, and always fall
// back gracefully to the static content on any DB error.
async function renderPage(res, page) {
  const template = readTemplate(page.file);
  let html = template;
  try {
    const content = await db.getPageContent(page.key);
    if (content && content.bodyHtml) {
      html = replaceMarkerContent(template, page.key, content.bodyHtml);
    }
  } catch (err) {
    console.warn(
      `[db] Using static fallback content for "${page.key}": ${err.message}`
    );
  }
  res.set("Content-Type", "text/html; charset=utf-8").send(html);
}

// Ensures the PageContent table exists and is seeded with the content
// currently baked into the static templates. Runs once at startup, is fully
// idempotent (never overwrites existing rows), and never crashes the server
// if Azure SQL isn't configured or reachable.
async function seedDatabase() {
  if (!db.isConfigured) {
    console.log(
      "[db] Azure SQL is not configured — pages will use static fallback content."
    );
    return;
  }
  try {
    const seedRows = PAGES.map((page) => {
      const template = readTemplate(page.file);
      return {
        pageKey: page.key,
        title: page.title,
        bodyHtml: extractMarkerContent(template, page.key) || "",
      };
    });
    await db.ensureSchemaAndSeed(seedRows);
    console.log("[db] Schema ensured and seed content applied (idempotent).");
  } catch (err) {
    console.warn(`[db] Failed to ensure schema/seed: ${err.message}`);
  }
}

// Constant-time password comparison so login timing doesn't leak how many
// leading characters matched.
function safeCompare(candidate, expected) {
  const candidateBuf = Buffer.from(String(candidate));
  const expectedBuf = Buffer.from(String(expected));
  if (candidateBuf.length !== expectedBuf.length) {
    crypto.timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return crypto.timingSafeEqual(candidateBuf, expectedBuf);
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

app.get("/", (req, res) => renderPage(res, PAGES[0]));
app.get("/details", (req, res) => renderPage(res, PAGES[1]));
app.get("/contact", (req, res) => renderPage(res, PAGES[2]));

// The old direct-file nav links predate DB-backed rendering; redirect them
// to their dynamic equivalents so DB edits are always reflected regardless
// of which URL a visitor lands on.
app.get("/index.html", (req, res) => res.redirect(301, "/"));
app.get("/details.html", (req, res) => res.redirect(301, "/details"));
app.get("/contact.html", (req, res) => res.redirect(301, "/contact"));

app.get("/play", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "play.html"));
});

app.get("/jump", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "jump.html"));
});

// --- Admin: password-gated content editor -------------------------------
// Not linked from the main site nav; reachable only by knowing the /admin
// URL, and every write requires the ADMIN_PASSWORD-gated session cookie.

app.get("/admin", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

app.get("/admin/status", (req, res) => {
  res.json({
    adminEnabled: ADMIN_ENABLED,
    loggedIn: Boolean(req.session && req.session.isAdmin),
  });
});

app.post("/admin/login", (req, res) => {
  if (!ADMIN_ENABLED) {
    return res
      .status(503)
      .json({ error: "Admin editing is disabled (ADMIN_PASSWORD is not configured)." });
  }
  const { password } = req.body || {};
  if (typeof password === "string" && safeCompare(password, ADMIN_PASSWORD)) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "Incorrect password." });
});

app.post("/admin/logout", (req, res) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy(() => res.json({ ok: true }));
});

function requireAdmin(req, res, next) {
  if (!ADMIN_ENABLED) {
    return res
      .status(503)
      .json({ error: "Admin editing is disabled (ADMIN_PASSWORD is not configured)." });
  }
  if (!req.session || !req.session.isAdmin) {
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
  for (const page of PAGES) {
    const dbEntry = dbContentByKey[page.key];
    if (dbEntry) {
      pages[page.key] = {
        title: dbEntry.title,
        bodyHtml: dbEntry.bodyHtml,
        updatedAt: dbEntry.updatedAt,
        source: "database",
      };
    } else {
      const template = readTemplate(page.file);
      pages[page.key] = {
        title: page.title,
        bodyHtml: extractMarkerContent(template, page.key) || "",
        updatedAt: null,
        source: "static-fallback",
      };
    }
  }

  res.json({ pages, dbAvailable });
});

app.post("/admin/content/:pageKey", requireAdmin, async (req, res) => {
  const page = PAGES.find((p) => p.key === req.params.pageKey);
  if (!page) {
    return res.status(404).json({ error: "Unknown page key." });
  }

  const { bodyHtml, title } = req.body || {};
  if (typeof bodyHtml !== "string" || !bodyHtml.trim()) {
    return res.status(400).json({ error: "bodyHtml is required." });
  }

  const effectiveTitle = typeof title === "string" && title.trim() ? title.trim() : page.title;

  try {
    await db.setPageContent(page.key, effectiveTitle, bodyHtml);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[db] Failed to save content for "${page.key}": ${err.message}`);
    res
      .status(503)
      .json({ error: "Azure SQL is unavailable — changes were not saved." });
  }
});

// Registered last (and with index:false) so it never shadows the dynamic
// "/" route or the .html redirects above — it only serves concrete static
// assets (CSS/JS/images/play & jump pages/admin shell).
app.use(express.static(PUBLIC_DIR, { index: false }));

app.listen(PORT, () => {
  console.log(`nr-vse-webdev listening on port ${PORT}`);
});

// Fire-and-forget: don't block server startup on the database being
// reachable.
seedDatabase();
