# nr-vse-webdev

A jazzy little 3-page demo site, served by a minimal Express app and
deployed to Azure App Service via GitHub Actions. The Intro/Details/Contact
page content is stored in an Azure SQL Database and editable through a
password-gated `/admin` page.

## What's here

- **`public/index.html`** — Intro page. Explains what this site is and links to
  this repo.
- **`public/details.html`** — Details page. Explains how the site (and its
  deployment pipeline) were built with AI assistance using GitHub Copilot, and
  how the Azure infrastructure and pipeline fit together.
- **`public/contact.html`** — Contact page. Links back to the repo owner,
  [github.com/glued2](https://github.com/glued2).
- **`public/styles.css`** / **`public/app.js`** — Shared styling (animated
  gradient background, glassy cards, gradient nav bar) and a small script for
  active-link highlighting, fade-in on load, and the mobile nav toggle.
- **`public/admin.html`** / **`public/admin.css`** / **`public/admin.js`** —
  Password-gated content editor (see [Content admin](#content-admin) below).
  Not linked from the main nav; reachable only at `/admin`.
- **`server.js`** — Express server. Serves `/`, `/details`, `/contact`
  dynamically (page layout comes from the static HTML templates, the editable
  body content comes from Azure SQL — see [Database-backed
  content](#database-backed-content)), plus the `/admin` JSON API, and static
  assets from `public/`. No build step, no bundler.
- **`db.js`** — Azure SQL access module (managed-identity/Azure AD auth only —
  see below).
- **`package.json`** — Dependencies: `express`, `mssql`, `@azure/identity`,
  `express-session`. One script: `npm start`.

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

`/admin` is a password-gated editor for each page's editable card sections
(six in total: two on Intro, three on Details, one on Contact).

- Not advertised in the site's main nav — reachable only by URL + password.
- Login posts to `/admin/login`, checked against the `ADMIN_PASSWORD`
  environment variable (constant-time compare). **If `ADMIN_PASSWORD` isn't
  set, admin editing is disabled entirely** — there is no default/fallback
  password.
- A signed, HTTP-only session cookie (via `express-session`) keeps you logged
  in across all the edit forms; `/admin/logout` clears it.
- Each section has a [Quill](https://quilljs.com) rich-text (WYSIWYG) editor,
  pre-filled from the database (or the static fallback if the DB is
  unavailable), with its own Save button that `POST`s the rendered HTML
  (`quill.root.innerHTML`) to `/admin/content/:pageKey`. Quill's JS/CSS are
  bundled via the `quill` npm package (pinned to `1.3.7`, the last release
  with a prebuilt `dist/` bundle suited to a plain `<script>` tag) and served
  locally from `node_modules` — no CDN.
- All `/admin/*` write routes require the auth cookie (401 otherwise) and
  return a graceful error (503) if Azure SQL can't be reached rather than
  crashing.

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
since saves need the database). Set `ADMIN_PASSWORD` in your shell to try the
`/admin` login flow locally.

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
   (`AZURE_SQL_SERVER_FQDN`, `AZURE_SQL_DATABASE_NAME`, `ADMIN_PASSWORD`) via
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

**Repository secrets** (same names/values pattern as the sibling
`nr-vse-azure-lab` repo, since both authenticate via OIDC to the same Azure AD
app registration):

| Secret                    | Description                          |
| -------------------------- | ------------------------------------- |
| `AZURE_CLIENT_ID`          | App registration (client) ID          |
| `AZURE_TENANT_ID`          | Azure AD tenant ID                    |
| `AZURE_SUBSCRIPTION_ID`    | Target Azure subscription ID          |
| `ADMIN_PASSWORD`           | Password for the `/admin` content editor. Passed through to the App Service as an app setting during deploy. **Required** for `/admin` to work at all — if unset, admin editing stays disabled. |

The deploy workflow also needs the App Service's system-assigned managed
identity (already granted by the `nr-vse-azure-lab` Bicep deployment) to have
an Azure AD user/role on the SQL database with permission to create tables
and read/write `PageContent` — that's configured on the infra side, not here.

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
repo and branch.
