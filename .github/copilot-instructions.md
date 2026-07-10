# Copilot instructions for nr-vse-webdev

## What this repo is

A jazzy little 3-page demo site (Intro / Details / Contact), served by a
minimal Express app and deployed to Azure App Service. No build step, no
bundler, no frontend framework — static HTML/CSS/JS templates behind a thin
Express server, with page body content stored in an Azure SQL Database and
editable via a Microsoft Entra ID-gated `/admin` page, which also surfaces a
privacy-preserving usage analytics dashboard backed by Azure Table Storage.

## Structure

- `public/index.html`, `public/details.html`, `public/contact.html` — the
  three page templates. Layout/nav/styling, the hero, and each
  `<div class="card">` wrapper are static; only the *inner* content of each
  card (heading, paragraphs, lists, links) is wrapped in
  `<!-- CONTENT:<key>:start/end -->` marker comments and swapped for the
  current Azure SQL content at request time (falling back to the static
  content in the file if the DB is unavailable). Content is split per card
  (one `PageKey`/marker per editable section, e.g. `intro-what`,
  `details-infra`) rather than one blob per page, since the admin editor is a
  Quill rich-text (WYSIWYG) editor that can only produce generic semantic
  HTML — keeping the hero/card chrome out of the editable region means an
  edit can never break the page's visual structure.
  `public/styles.css` and `public/app.js` provide shared nav/styling
  (gradient background, glassy cards, nav bar, active-link highlighting,
  mobile nav toggle) across all pages. The nav is identical everywhere —
  Intro / Details / Contact / Play: Blocks / Play: Jump / Play: Eat / Build
  Log / Admin, in that
  order, "Admin" always last — including on `/admin` itself.
- `public/play.html`, `public/jump.html`, `public/eat.html` — three small
  standalone browser
  games ("Play: Blocks" / "Play: Jump" / "Play: Eat" in the nav), served via
  the `/play`,
  `/jump`, and `/eat` routes in `server.js`. Static, not DB-backed. Their game
  scripts (`public/tetris.js`, `public/jump.js`, `public/eat.js`)
  fire-and-forget `POST
  /api/game-event` on game start and game-over (with score) for the usage
  analytics dashboard — see "Usage analytics" below. `eat.js` is an original
  maze-chomp game (grid movement, dot/power-pellet eating, chase-AI ghosts) —
  deliberately built with wholly original geometric art (hand-drawn
  circles/arcs on canvas) rather than any copyrighted character/sprite
  designs, in the same "inspired by, not copied from" spirit as
  Blocks (Tetris-like) and Jump (Chrome-dino-like). `tetris.js` levels up
  every `LINES_PER_LEVEL` (5) cleared lines, with fall speed following a
  percentage-decay curve (`dropIntervalForLevel()`: `BASE_DROP_INTERVAL *
  DROP_INTERVAL_DECAY^(level-1)`, floored at `MIN_DROP_INTERVAL`) rather than
  a flat linear step-down, so speed keeps meaningfully increasing at higher
  levels instead of hitting a floor and going flat. `eat.js`'s maze is
  procedurally regenerated each game/level (`generateMaze()` →
  `scatterPillars()`): candidate pillar positions are drawn from a
  `QUADRANT_STRATA x QUADRANT_STRATA` grid of sub-regions (nearest-center
  sub-region filled first) rather than a single uniform-random sample, so
  wall density stays even across the whole grid — including the true center
  — instead of leaving a pillar-free plaza; every candidate layout is
  verified via flood fill to be fully connected with at least one loop
  (`mazeIsConnectedWithLoops()`) before being accepted, regenerating with
  fresh random placement otherwise. Power pellets
  (`pickPowerCells()`/`quadrantsForPowerCells()`) are placed one per quadrant
  at randomized, spaced-out positions rather than fixed corners, and
  `maybeRegeneratePowerPellet()` converts a regular dot back into a power
  pellet (via `pickRegenPowerCell()`, reusing the same spacing/exclusion
  rules) once more than half of the current game/level's power pellets have
  been eaten, so the supply never fully runs dry mid-level. All three games
  are mobile/touch-playable: `jump.js`'s existing canvas `pointerdown`
  handler already doubles as tap-to-jump on touch devices (Pointer Events
  unify mouse/touch), and its canvas was already responsive
  (`width:100%`/`aspect-ratio` in `jump.css`); `tetris.js`/`play.html` and
  `eat.js`/`eat.html` gained on-screen touch controls — a left/rotate/right +
  soft-drop/hard-drop button row for Blocks, a 4-button D-pad for Eat — that
  call the exact same functions (`move()`/`rotate()`/`softDrop()`/
  `hardDrop()`, and a shared `handleDirectionInput()` in `eat.js`) as the
  existing keydown handlers, so there's a single source of truth for game
  logic regardless of input method. The touch controls are shown via a
  `@media (max-width: 640px), (pointer: coarse)` query (matching real phones
  and Playwright's mobile emulation) and hidden by default on desktop/mouse.
- `public/admin.html` / `public/admin.css` / `public/admin.js` — Microsoft
  Entra ID-gated content editor, one Quill editor card per editable section,
  plus a "Stats" tab showing the usage analytics dashboard (hits-by-page
  table, CSS-only bar chart for hits-by-day, games table). The two tabs
  (Content/Stats) are a simple show/hide toggle, no routing library.
  Linked from the main nav ("Admin") since access is enforced entirely by
  Entra ID, not by keeping the URL secret. Renders the same full site nav as
  every other page; the "Admin" nav item itself is dynamic — `admin.js`
  swaps it for a "Signed in as {name} · Sign out" indicator (linking to
  `/auth/logout`) once `/admin/status` reports `loggedIn: true`, and back to
  a plain "Admin" link when signed out. Vanilla JS talking to the JSON
  API on `/admin/*` in `server.js`; Quill's JS/CSS are bundled via the
  `quill` npm package (pinned to `1.3.7`, the last release with a prebuilt
  `dist/` bundle) and served from `node_modules` via a `/vendor/quill`
  static route — no CDN.
- `public/build-log.html` — the "Build Log" page (see "Build log" below),
  server-rendered by `GET /build-log` in `server.js` from `buildlog.js`'s
  cached GitHub API data. Reuses the same `<!-- CONTENT:build-log:start/end
  -->` marker mechanism as the DB-backed sections, but is deliberately NOT
  registered in `SECTIONS` — its content is always live from GitHub, never
  editable via `/admin`.
- `buildlog.js` — fetches recently merged pull requests from this repo (see
  "Build log" below). Exposes `getBuildLog()` (never
  throws), `REPOS`, `CACHE_TTL_MS`.
- `server.js` — Express server: `express.static` (with `index:false`) serves
  `public/`, plus explicit `GET /`, `/details`, `/contact` routes that render
  DB-backed content into the static templates (and fire-and-forget log a
  page hit for analytics), `301` redirects from the old
  `/index.html`/`/details.html`/`/contact.html` paths, `/play` and `/jump`
  routes (also logging page hits), the `/auth/login`, `/auth/callback`,
  `/auth/logout` Entra sign-in routes, `POST /api/game-event` (unauthenticated
  — any visitor playing a game can post a start/end event), and the `/admin`
  page + JSON API (status/content/stats).
- `db.js` — Azure SQL access (see below). Exposes `isConfigured`,
  `ensureSchemaAndSeed`, `getPageContent`, `getAllPageContent`,
  `setPageContent`, `pruneLegacyKeys`.
- `auth.js` — Microsoft Entra ID sign-in (see below). Exposes `isConfigured`,
  `getAuthCodeUrl`, `acquireTokenByCode`, `logoutUrl`.
- `analytics.js` — Azure Table Storage access for usage analytics (see
  "Usage analytics" below). Exposes `isConfigured`, `ensureTables`,
  `logPageHit` (never throws — fire-and-forget safe), `logGameEvent`,
  `getStatsSummary`.
- `package.json` — dependencies: `express`, `mssql`, `@azure/identity`,
  `@azure/msal-node`, `@azure/data-tables`, `express-session`, `quill`. One
  script: `npm start` (`node server.js`).

## Database-backed content & admin page

- Content lives in a `PageContent` table (`PageKey`, `Title`, `BodyHtml`,
  `UpdatedAt`) in an Azure SQL Database provisioned by the companion
  `nr-vse-azure-lab` infra repo. One row per editable card *section*, not per
  whole page (see `SECTIONS` in `server.js`) — e.g. Intro has two sections
  (`intro-what`, `intro-next`), Details has three, Contact has one.
- **Auth is managed-identity only — never a SQL password.** `db.js` uses
  `@azure/identity`'s `DefaultAzureCredential` to get an Azure AD token for
  the App Service's system-assigned managed identity (scope
  `https://database.windows.net/.default`) and passes it to `mssql` via
  `authentication.type: 'azure-active-directory-access-token'`. A fresh
  short-lived connection pool is opened per DB call (simplest way to avoid
  token-expiry/refresh complexity for this low-traffic demo).
- Schema creation + seeding (from the static templates' current content) runs
  fire-and-forget on server startup, guarded by `IF NOT EXISTS` at both the
  table and per-row level — safe to run on every deploy, never overwrites
  edited content. Startup also prunes any leftover legacy whole-page rows
  (`intro`/`details`/`contact`, from before content was split per section)
  via `db.pruneLegacyKeys`.
- **Local dev has no real Azure SQL access.** When
  `AZURE_SQL_SERVER_FQDN`/`AZURE_SQL_DATABASE_NAME` are unset, or any DB call
  fails, every route/handler catches the error and falls back to the static
  content baked into the HTML file — the server must never crash or error out
  because SQL is unreachable.
- `/admin` is gated by Microsoft Entra ID sign-in (OAuth2/OIDC authorization
  code flow via `@azure/msal-node`), not a password. See "Entra ID admin
  sign-in" below for the full mechanism. Each section is edited via a Quill
  rich-text editor (not a raw-HTML textarea) — Quill only preserves generic
  semantic HTML, which is exactly why the surrounding `.hero`/`.card` chrome
  must stay outside the `CONTENT:<key>` markers.

## Entra ID admin sign-in

- `/admin` authentication uses the standard OAuth2/OIDC **authorization code
  flow**: `GET /auth/login` redirects to Microsoft's authorize endpoint,
  `GET /auth/callback` exchanges the returned code for tokens and stores a
  minimal identity (`name`, `username`, `oid`) in `req.session.user`,
  `GET /auth/logout` destroys the session and redirects to Entra's own
  logout endpoint for a full sign-out.
- **Zero client secret — ever.** The Entra App Registration's credential is a
  federated trust to a **User-Assigned Managed Identity** (workload identity
  federation), not a stored secret. `auth.js` fetches a short-lived managed
  identity token (via `@azure/identity`'s `ManagedIdentityCredential`,
  configured with the UAMI's client ID) for the fixed audience
  `api://AzureADTokenExchange/.default`, and passes it to
  `@azure/msal-node`'s `ConfidentialClientApplication` as an async
  `clientAssertion` callback (not a static string) — MSAL invokes the
  callback itself, fresh, every time it needs a signed assertion. This
  mirrors `db.js`'s "no password anywhere" pattern for a different Azure AD
  credential type.
- **No allow-list/role check in app code.** The Entra Enterprise Application
  has "Assignment required = Yes"; who may sign in is decided entirely by
  Entra ID (an unassigned user is rejected with `AADSTS50105` before
  `/auth/callback` ever runs). `requireAdmin` and `/admin/status` only check
  whether `req.session.user` is set.
- Configured via three env vars, all required for `auth.isConfigured` to be
  true (if any is missing, admin editing is disabled entirely, same
  fail-closed philosophy as the old `ADMIN_PASSWORD` check):
  `ENTRA_CLIENT_ID` (App Registration client ID), `ENTRA_TENANT_ID` (tenant
  ID), `AZURE_ADMIN_UAMI_CLIENT_ID` (the federated UAMI's client ID).
- The redirect URI is derived per-request
  (`${req.protocol}://${req.get("host")}/auth/callback`) rather than stored
  as its own env var, since the App Registration's registered redirect URI
  already matches the App Service's real (Bicep-generated) hostname.
- Building the `/auth/login` redirect URL does **not** require real Azure
  connectivity (MSAL only invokes the `clientAssertion` callback when
  actually exchanging a code, not when building the authorize URL) — this is
  what makes it possible to verify the redirect shape locally without a real
  managed identity.

## Usage analytics

- `analytics.js` mirrors `db.js`/`auth.js`'s graceful-degradation pattern:
  `isConfigured` is true only when `AZURE_STORAGE_ACCOUNT_NAME` is set; all
  functions catch their own errors rather than let a failure crash a request.
  Uses `@azure/data-tables`'s `TableClient` with `@azure/identity`'s
  `DefaultAzureCredential` against
  `https://{AZURE_STORAGE_ACCOUNT_NAME}.table.core.windows.net` — no
  connection string or storage account key anywhere, same "no secrets"
  philosophy as SQL and Entra sign-in.
- **Privacy by design — this is a hard constraint, not a nice-to-have.** No
  cookies, no persistent visitor identifier of any kind, no IP address
  storage. Only aggregate data is logged: hit counts, request paths,
  referrers sanitized to origin+path only (`sanitizeReferrer()` strips query
  strings/fragments, which can carry sensitive tokens), and a coarse browser
  family (`parseBrowserFamily()` — `Chrome`/`Firefox`/`Safari`/`Edge`/`Other`,
  never the raw User-Agent string). This avoids triggering UK/EU
  PECR/GDPR cookie-consent requirements. Do not add any field that could
  re-identify or track an individual visitor across requests.
- Two Table Storage tables, both partitioned by UTC date (`yyyy-MM-dd`,
  `PartitionKey`) so "last N days" queries are simple OData range filters:
  - `PageHits` — `Path`, `Referrer`, `BrowserFamily`. Written by
    `analytics.logPageHit()`, called fire-and-forget from the `/`,
    `/details`, `/contact`, `/play`, `/jump`, `/eat` route handlers only (not
    static
    assets, not `/admin/*`, not `/auth/*`, not `/api/game-event` itself).
  - `GameEvents` — `Game` (`blocks`/`jump`/`eat`), `Event` (`start`/`end`), `Score`
    (present only on `end`). Written by `analytics.logGameEvent()` via
    `POST /api/game-event`, called from `public/tetris.js`'s `restart()`/
    `spawnNext()`, `public/jump.js`'s `start()`/`endGame()`, and
    `public/eat.js`'s `start()`/`endGame()`.
  - `createTable()` throws 409 if a table already exists — `ensureTables()`
    catches and ignores that specific error (Table Storage has no native
    "create if not exists"), rethrowing anything else. This is the Table
    Storage equivalent of `db.js`'s `IF NOT EXISTS` idempotency.
- **Error-handling is deliberately split**: `logPageHit()` never throws
  (fire-and-forget, no caller awaits it — an unhandled rejection here could
  crash the process) but `logGameEvent()`/`getStatsSummary()` do throw, since
  their callers (`POST /api/game-event`, `GET /admin/stats`) `await` +
  `try/catch` and translate failures into a `503`.
- `GET /admin/stats` is gated by the same `requireAdmin` middleware as the
  content editor; it returns `{configured: false}` if analytics isn't set up,
  or aggregates the last 30 days into `{ totalHits, hitsByPage, hitsByDay
  (14-day array), games: { blocks, jump, eat } }`.
- **Local dev has no real Table Storage access.** When
  `AZURE_STORAGE_ACCOUNT_NAME` is unset, or any call fails: page-hit logging
  silently no-ops, `POST /api/game-event` responds `503` (the game JS ignores
  the failure and keeps playing), and the Stats tab shows "Analytics not
  configured" instead of erroring.

## Build log

- `GET /build-log` (`public/build-log.html` + `buildlog.js`) shows recent
  merged pull requests for this repo, so visitors can see the actual
  development activity behind the "built via AI collaboration" narrative on
  the Details page.
- **Deliberately secretless, same as everything else in this project**:
  `buildlog.js` calls the GitHub REST API (`GET
  /repos/{owner}/{repo}/pulls?state=closed...`) fully unauthenticated — no
  PAT, no GitHub App, no stored credential of any kind — just a required
  `User-Agent` header (GitHub rejects unauthenticated requests without one).
- **In-memory cache, `CACHE_TTL_MS` = 15 minutes.** Results are sorted by
  `merged_at` descending and cached; a request only re-hits the GitHub API
  once the cache has expired, keeping total API usage to about 1 request per
  15 minutes regardless of site traffic — comfortably under GitHub's 60
  req/hour unauthenticated-per-IP limit.
- **Graceful degradation, per repo.** `buildlog.REPOS` is fetched via
  `Promise.allSettled` (not `Promise.all`), so if more repos are ever added,
  one failing/rate-limited repo wouldn't blank out the others' data. If a
  refresh fails entirely and no prior cache exists, the page shows a friendly
  "Build history is temporarily unavailable" message — never a raw error or
  crash. If a refresh fails but a previous cache exists, the last known-good
  data is served instead (marked stale in a log line, not shown to the
  visitor).
- **`buildlog.REPOS` currently lists only `glued2/nr-vse-webdev`.** The
  companion infra repos (`nr-vse-azure-lab`, `nr-azure-lab-workflows`, see
  "Cross-repo relationship" below) are **private**, and unauthenticated
  GitHub API requests against a private repo return `404` — this is a
  deliberate, informed choice to stay fully secretless rather than a bug.
  They could be added back to `REPOS` if/when those repos are made public.

## Conventions

- Keep it simple: don't introduce a bundler, framework, or build step for
  what's meant to stay a minimal, dependency-light demo.
- Any new DB-backed card/section should follow the existing pattern: wrap
  only its inner content (heading, paragraphs, lists, links — never the
  surrounding `.hero`/`.card` chrome) in `CONTENT:<key>` markers, add a
  corresponding `SECTIONS` entry in `server.js`, and add a matching admin
  editor card in `public/admin.html` (the admin JS is generic/data-attribute
  driven, so no `admin.js` changes are needed for a new section).
- Any purely static new page should still follow the pre-existing pattern:
  add the HTML file under `public/`, add an explicit route in `server.js`,
  and reuse `styles.css`/`app.js` for nav/styling consistency.
- **Never hardcode the Azure App Service name** anywhere in code or workflows
  — it's generated by Bicep with a `uniqueString` suffix and must only be
  referenced via the `AZURE_WEBAPP_NAME` GitHub Actions repository variable.
- Similarly, never hardcode the Azure SQL server FQDN, database name, Entra
  client/tenant IDs, the admin managed identity client ID, or the storage
  account name — always read `AZURE_SQL_SERVER_FQDN`,
  `AZURE_SQL_DATABASE_NAME`, `ENTRA_CLIENT_ID`, `ENTRA_TENANT_ID`,
  `AZURE_ADMIN_UAMI_CLIENT_ID`, and `AZURE_STORAGE_ACCOUNT_NAME` from
  environment variables. There is no admin password to hardcode — Entra ID
  sign-in replaced it entirely.

## Deployment target

Deploys to an **Azure Linux App Service** (B1 Basic tier, `NODE|20-lts`
runtime) provisioned via Bicep in the companion repo
[`glued2/nr-vse-azure-lab`](https://github.com/glued2/nr-vse-azure-lab)
(`infra/modules/webapp.bicep`). Notable details:

- The App Service is deployed into **`swedencentral`** (not `uksouth`), due to
  a regional quota issue hit during rollout.
- It's tagged `Delete=auto` — it's **ephemeral** and gets torn down nightly,
  then recreated by the infra repo's cleanup/deploy workflows. Site content
  does not survive a recreation, so this repo's deploy pipeline
  (`.github/workflows/deploy.yml`) generally needs to be re-run (manual
  `workflow_dispatch` is fine) after each nightly infra recreation.

## Deploy pipeline

`.github/workflows/deploy.yml` triggers on push to `main` (for
`public/**`, `server.js`, `package.json`, or the workflow file) and on
`workflow_dispatch`. It uses **OIDC federated auth** (`azure/login`) — no
stored secrets or publish profiles. It's self-contained, not a
`workflow_call` into any reusable workflow.

Required repo config:

- Secrets `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` —
  shared with the `nr-vse-azure-lab` App Registration.
- Variable `AZURE_WEBAPP_NAME` — set to the Bicep-generated App Service name.
- Variables `AZURE_SQL_SERVER_FQDN` / `AZURE_SQL_DATABASE_NAME` — the Azure
  SQL logical server FQDN and database name from the `nr-vse-azure-lab` Bicep
  deployment. Also pushed into App Service application settings on deploy.
- Variables `ENTRA_CLIENT_ID` / `ENTRA_TENANT_ID` /
  `AZURE_ADMIN_UAMI_CLIENT_ID` — the Entra App Registration's client ID and
  tenant, and the federated User-Assigned Managed Identity's client ID (the
  last one comes from the `nr-vse-azure-lab` Bicep deployment). Ordinary repo
  variables, not secrets — there's no client secret in this flow to protect.
  Also pushed into App Service application settings on deploy.
- Variable `AZURE_STORAGE_ACCOUNT_NAME` — the Azure Storage account name
  (Table Storage) from the `nr-vse-azure-lab` Bicep deployment, used for
  usage analytics. Ordinary repo variable, not a secret — same pattern as the
  SQL FQDN/DB name. Also pushed into App Service application settings on
  deploy.

## Cross-repo relationship

- Infra (Bicep) lives in [`glued2/nr-vse-azure-lab`](https://github.com/glued2/nr-vse-azure-lab)
  (**private**).
- Shared/reusable CI/CD workflow logic for that infra repo lives in
  [`glued2/nr-azure-lab-workflows`](https://github.com/glued2/nr-azure-lab-workflows)
  (**private**).
- This repo only contains site content and its own simple deploy workflow —
  it does **not** consume those reusable workflows.
- Both of those repos being private is why `buildlog.REPOS` (see "Build log"
  above) only lists `nr-vse-webdev` — unauthenticated GitHub API calls
  against a private repo return `404`, so there'd be no benefit to listing
  the other two while they stay private.
