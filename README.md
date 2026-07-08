# nr-vse-webdev

A jazzy little 3-page demo site, served by a minimal Express app and
deployed to Azure App Service via GitHub Actions. The Intro/Details/Contact
page content is stored in an Azure SQL Database and editable through an
Entra ID-gated `/admin` page.

## What's here

- **`public/index.html`** — Intro page. Explains what this site is and links to
  this repo.
- **`public/details.html`** — Details page. Explains how the site (and its
  deployment pipeline) were built with AI assistance using GitHub Copilot, and
  how the Azure infrastructure and pipeline fit together.
- **`public/contact.html`** — Contact page. Links back to the repo owner,
  [github.com/glued2](https://github.com/glued2).
- **`public/play.html`** / **`public/jump.html`** — Two small standalone
  browser games ("Play: Blocks" and "Play: Jump" in the nav), served via the
  `/play` and `/jump` routes in `server.js`. Static, not DB-backed.
- **`public/styles.css`** / **`public/app.js`** — Shared styling (animated
  gradient background, glassy cards, gradient nav bar) and a small script for
  active-link highlighting, fade-in on load, and the mobile nav toggle. The
  nav bar (Intro / Details / Contact / Play: Blocks / Play: Jump / Admin) is
  identical across every page, including `/admin`, so `app.js`'s active-link
  highlighting and mobile toggle work everywhere without extra code.
- **`public/admin.html`** / **`public/admin.css`** / **`public/admin.js`** —
  Microsoft Entra ID-gated content editor (see [Content admin](#content-admin)
  below). Linked from the main nav (as "Admin") but not privileged to view —
  only to sign in; actual access is enforced entirely by Entra ID. `/admin`
  shows the same full site nav as every other page; once signed in, the
  "Admin" nav item itself swaps to a "Signed in as {name} · Sign out"
  indicator (driven by the existing `/admin/status` poll, no separate
  endpoint) that links to `/auth/logout`.
- **`server.js`** — Express server. Serves `/`, `/details`, `/contact`
  dynamically (page layout comes from the static HTML templates, the editable
  body content comes from Azure SQL — see [Database-backed
  content](#database-backed-content)), the `/auth/*` Entra sign-in routes, the
  `/admin` JSON API, and static assets from `public/`. No build step, no
  bundler.
- **`db.js`** — Azure SQL access module (managed-identity/Azure AD auth only —
  see below).
- **`auth.js`** — Microsoft Entra ID sign-in module (workload identity
  federation, zero client secrets — see [Content admin](#content-admin)
  below).
- **`package.json`** — Dependencies: `express`, `mssql`, `@azure/identity`,
  `@azure/msal-node`, `express-session`. One script: `npm start`.

## Database-backed content

The Intro/Details/Contact page bodies live in a `PageContent` table
(`PageKey`, `Title`, `BodyHtml`, `UpdatedAt`) in an Azure SQL Database
provisioned by the companion
[`glued2/nr-vse-azure-lab`](https://github.com/glued2/nr-vse-azure-lab) infra
repo. Each static HTML file still provides the hero and per-card chrome
(layout/nav/styling), with only the editable *inner* content of each
`<div class="card">` — its heading, paragraphs, lists, links — wrapped in
`<!-- CONTENT:<key>:start/end -->` markers; `server.js` swaps in the current
database content on each request. Content is split **per card**, one
`PageKey` row per editable section (e.g. `intro-what`, `intro-next`,
`details-copilot`, `details-infra`, `details-pipeline`, `contact-github`)
rather than one row per whole page — this is deliberate: the admin editor
uses a Quill rich-text (WYSIWYG) editor, which can only produce/preserve
generic semantic HTML (headings, paragraphs, links, lists), not this site's
custom `.hero`/`.card`/`.btn`/`.pill` structure. Keeping that structural
chrome out of the DB-backed/editable region means an admin edit can never
strip or break the page's visual layout.

- **Authentication is managed-identity only** — there is no SQL username or
  password anywhere. `db.js` uses `@azure/identity`'s `DefaultAzureCredential`
  to fetch an Azure AD access token for the App Service's system-assigned
  managed identity (scope `https://database.windows.net/.default`), then
  passes it to the `mssql` driver via
  `authentication.type: 'azure-active-directory-access-token'`.
- **Schema/seed is idempotent** — on every startup, the server ensures the
  `PageContent` table exists (`IF NOT EXISTS`) and seeds it from the static
  templates' current content, but only inserts a row `IF NOT EXISTS` for that
  `PageKey` — it never overwrites content that's already been edited. It also
  prunes any leftover legacy whole-page rows (`intro`/`details`/`contact`,
  from before content was split per card section).
- **Graceful fallback everywhere** — if Azure SQL isn't configured (no
  `AZURE_SQL_SERVER_FQDN`/`AZURE_SQL_DATABASE_NAME`) or isn't reachable (local
  dev, or a transient outage), every route falls back to the static content
  baked into the HTML file instead of crashing or erroring.

## Content admin

`/admin` is a Microsoft Entra ID-gated editor for each page's editable card
sections (six in total: two on Intro, three on Details, one on Contact).

- Linked from the main site nav ("Admin"). It's fine to advertise the URL:
  Entra ID (not app code) decides who can actually sign in.
- Sign-in is the standard OAuth2/OIDC **authorization code flow**: `/admin`
  shows a "Sign in with Microsoft" link to `GET /auth/login`, which redirects
  to Microsoft's authorize endpoint; `GET /auth/callback` completes the flow
  and stores a minimal identity (`name`, `username`, `oid`) in the session.
- **Zero client secret.** The Entra App Registration's credential is a
  federated trust to this App Service's **User-Assigned Managed Identity**
  (workload identity federation) instead of a stored secret. At runtime,
  `auth.js` fetches a short-lived managed identity token for the fixed
  audience `api://AzureADTokenExchange/.default` and hands it to
  `@azure/msal-node`'s `ConfidentialClientApplication` as an async
  `clientAssertion` callback — MSAL calls this itself, on demand, every time
  it needs a freshly-signed assertion, so nothing is cached or stored
  long-term. This mirrors the SQL connection's "no password anywhere"
  pattern, just for a different Azure AD credential type.
- **No allow-list/role check in app code.** The Entra Enterprise Application
  has "Assignment required = Yes"; the environment owner assigns which
  users/groups may sign in. An unassigned user is rejected by Entra itself
  during sign-in (`AADSTS50105`) before `/auth/callback` is ever reached —
  the app only checks "did the auth code flow complete successfully at all"
  (i.e. `req.session.user` is set).
- **If Entra isn't fully configured** (`ENTRA_CLIENT_ID` /
  `ENTRA_TENANT_ID` / `AZURE_ADMIN_UAMI_CLIENT_ID` env vars), admin editing is
  disabled entirely with a clear message — there is no insecure fallback.
- `GET /auth/logout` destroys the local session **and** redirects to Entra's
  own logout endpoint, for a full sign-out rather than just a local cookie
  clear.
- Each section has a [Quill](https://quilljs.com) rich-text (WYSIWYG) editor,
  pre-filled from the database (or the static fallback if the DB is
  unavailable), with its own Save button that `POST`s the rendered HTML
  (`quill.root.innerHTML`) to `/admin/content/:pageKey`. Quill's JS/CSS are
  bundled via the `quill` npm package (pinned to `1.3.7`, the last release
  with a prebuilt `dist/` bundle suited to a plain `<script>` tag) and served
  locally from `node_modules` — no CDN.
- All `/admin/*` write routes require an authenticated session (401
  otherwise) and return a graceful error (503) if Azure SQL can't be reached
  rather than crashing.
- `/admin` renders the exact same nav bar as every other page (Intro /
  Details / Contact / Play: Blocks / Play: Jump / Admin). Its own "Admin" nav
  item is dynamic: signed out (or Entra not configured), it's a plain link to
  `/admin`; signed in, `admin.js` swaps it for "Signed in as **{name}** · Sign
  out" (linking to `/auth/logout`), driven by the same `/admin/status` check
  the page already performs on load — no extra endpoint.

## Running locally

```bash
npm install
npm start
```

Then visit `http://localhost:8080/`, `/details`, `/contact`, and `/admin`.

Without `AZURE_SQL_SERVER_FQDN`/`AZURE_SQL_DATABASE_NAME` set (the normal
local case — there's no local Azure managed identity to authenticate with),
the site automatically falls back to the static content baked into each HTML
file, and `/admin` shows that same fallback content (read-only in practice,
since saves need the database). Without `ENTRA_CLIENT_ID` /
`ENTRA_TENANT_ID` / `AZURE_ADMIN_UAMI_CLIENT_ID` set, `/admin` shows a "sign-in
disabled" message instead of a sign-in link — a full real sign-in can't be
tested locally without live Entra ID + managed identity connectivity, but you
can set test values for these three env vars and confirm `/auth/login`
redirects to the correct `login.microsoftonline.com` URL (building that
redirect doesn't require real Azure connectivity).

## Deployment

The site deploys to a low-cost **Azure Linux App Service** (B1 Basic tier,
`NODE|20-lts` runtime) that is provisioned as Infrastructure-as-Code (Bicep)
in the companion repo
[`glued2/nr-vse-azure-lab`](https://github.com/glued2/nr-vse-azure-lab). That
Bicep deployment outputs the generated App Service name (`webAppName`) — the
real name includes a `uniqueString` suffix, so it's never hardcoded here. That
App Service is provisioned in the `swedencentral` region and is tagged
`Delete=auto` — it's ephemeral and gets torn down and recreated nightly by
the infra repo's workflows, so site content doesn't survive a recreation.
After each nightly rebuild, re-run this repo's deploy workflow (manual
`workflow_dispatch` is fine) to redeploy the site.

Deployment is handled by
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which runs on
every push to `main` (touching `public/**`, `server.js`, `package.json`, or
the workflow itself) or on manual `workflow_dispatch`. The workflow:

1. Checks out the repo and sets up Node.js 20.
2. Installs dependencies (`npm install`).
3. Logs into Azure using **OIDC federated authentication** — no client
   secrets or publish profiles are stored in this repo.
4. Configures the App Service's application settings
   (`AZURE_SQL_SERVER_FQDN`, `AZURE_SQL_DATABASE_NAME`, `ENTRA_CLIENT_ID`,
   `ENTRA_TENANT_ID`, `AZURE_ADMIN_UAMI_CLIENT_ID`) via
   `az webapp config appsettings set`.
5. Deploys the app (`package.json`, `server.js`, `public/`) to the App Service
   using `azure/webapps-deploy@v3`.

### One-time repo setup

For the pipeline to work, configure the following in this repo's settings:

**Repository variables:**

| Variable                   | Value                                                    |
| --------------------------- | -------------------------------------------------------- |
| `AZURE_WEBAPP_NAME`         | The App Service name output (`webAppName`) from the `nr-vse-azure-lab` Bicep deployment |
| `AZURE_SQL_SERVER_FQDN`     | The Azure SQL logical server FQDN from the `nr-vse-azure-lab` Bicep deployment (e.g. `sql-vse-lab-xxxxx.database.windows.net`) |
| `AZURE_SQL_DATABASE_NAME`   | The Azure SQL database name from the `nr-vse-azure-lab` Bicep deployment |
| `ENTRA_CLIENT_ID`           | The Entra ID App Registration's client (application) ID used for `/admin` sign-in |
| `ENTRA_TENANT_ID`           | The Entra ID tenant ID |
| `AZURE_ADMIN_UAMI_CLIENT_ID` | The client ID of the User-Assigned Managed Identity the App Registration federates with (from the `nr-vse-azure-lab` Bicep deployment) |

These are ordinary repository **variables**, not secrets — a client ID and
tenant ID aren't sensitive on their own (they're visible in the redirect URL
of every sign-in attempt), and there's no client secret to protect since this
app uses workload identity federation instead.

**Repository secrets** (same names/values pattern as the sibling
`nr-vse-azure-lab` repo, since both authenticate via OIDC to the same Azure AD
app registration):

| Secret                    | Description                          |
| -------------------------- | ------------------------------------- |
| `AZURE_CLIENT_ID`          | App registration (client) ID          |
| `AZURE_TENANT_ID`          | Azure AD tenant ID                    |
| `AZURE_SUBSCRIPTION_ID`    | Target Azure subscription ID          |

The deploy workflow also needs the App Service's system-assigned managed
identity (already granted by the `nr-vse-azure-lab` Bicep deployment) to have
an Azure AD user/role on the SQL database with permission to create tables
and read/write `PageContent` — that's configured on the infra side, not here.
It separately needs the **user-assigned** managed identity referenced by
`AZURE_ADMIN_UAMI_CLIENT_ID` to be assigned to this App Service and federated
with the Entra App Registration (issuer = tenant's v2.0 issuer, subject = the
UAMI's object ID, audience `api://AzureADTokenExchange`) — also configured on
the infra side.

**One-time Azure AD setup:** the App Registration used for OIDC needs a
federated credential for this repo. Either reuse the App Registration from
`nr-vse-azure-lab` and add another federated credential, or create a new App
Registration — either way, the credential's subject must be:

```
repo:glued2/nr-vse-webdev:ref:refs/heads/main
```

with audience `api://AzureADTokenExchange`.

## Why no secrets?

Auth to Azure uses OpenID Connect (OIDC) federated credentials instead of a
long-lived client secret or publish profile — the GitHub Actions token is
exchanged for a short-lived Azure AD token at run time, scoped to this exact
repo and branch. The same "no stored secret" philosophy carries through to
the app's own Azure dependencies: the SQL connection uses the App Service's
managed identity (no SQL password ever exists), and `/admin` sign-in uses
workload identity federation (no Entra client secret ever exists) — see
[Content admin](#content-admin) above.
