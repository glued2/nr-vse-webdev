# nr-vse-webdev

A jazzy little 3-page static demo site, served by a minimal Express app and
deployed to Azure App Service via GitHub Actions.

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
- **`server.js`** — A tiny Express server that serves `public/` as static
  files and handles `/`, `/details`, and `/contact` directly. No build step,
  no bundler — just files.
- **`package.json`** — One dependency (`express`), one script: `npm start`.

## Running locally

```bash
npm install
npm start
```

Then visit `http://localhost:8080/`, `/details`, and `/contact`.

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
4. Deploys the app (`package.json`, `server.js`, `public/`) to the App Service
   using `azure/webapps-deploy@v3`.

### One-time repo setup

For the pipeline to work, configure the following in this repo's settings:

**Repository variable:**

| Variable             | Value                                                    |
| --------------------- | -------------------------------------------------------- |
| `AZURE_WEBAPP_NAME`   | The App Service name output (`webAppName`) from the `nr-vse-azure-lab` Bicep deployment |

**Repository secrets** (same names/values pattern as the sibling
`nr-vse-azure-lab` repo, since both authenticate via OIDC to the same Azure AD
app registration):

| Secret                    | Description                          |
| -------------------------- | ------------------------------------- |
| `AZURE_CLIENT_ID`          | App registration (client) ID          |
| `AZURE_TENANT_ID`          | Azure AD tenant ID                    |
| `AZURE_SUBSCRIPTION_ID`    | Target Azure subscription ID          |

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
