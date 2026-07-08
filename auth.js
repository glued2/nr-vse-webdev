// auth.js — Microsoft Entra ID sign-in for the /admin editor, using the
// standard OAuth2 authorization-code flow via @azure/msal-node.
//
// There is NO client secret anywhere: the App Registration's credential is a
// federated trust to this App Service's User-Assigned Managed Identity
// (workload identity federation), configured on the Entra/infra side. At
// runtime, instead of a stored client secret, we fetch a short-lived managed
// identity access token (scope `api://AzureADTokenExchange/.default` — the
// fixed audience Entra expects for this exact "managed identity as a
// federated credential" pattern, NOT a normal Graph/ARM scope) and hand it to
// MSAL as the confidential client's `clientAssertion`. MSAL invokes our
// callback itself, on demand, every time it needs a fresh signed assertion —
// so nothing is cached long-term here.
//
// Locally (no managed identity available) `isConfigured` is false, so
// server.js gracefully disables the /admin editor instead of crashing.
const { ConfidentialClientApplication } = require("@azure/msal-node");
const { ManagedIdentityCredential } = require("@azure/identity");

const CLIENT_ID = process.env.ENTRA_CLIENT_ID;
const TENANT_ID = process.env.ENTRA_TENANT_ID;
const UAMI_CLIENT_ID = process.env.AZURE_ADMIN_UAMI_CLIENT_ID;

// See https://learn.microsoft.com/entra/workload-id/workload-identity-federation-config-app-trust-managed-identity
const TOKEN_EXCHANGE_SCOPE = "api://AzureADTokenExchange/.default";
const SCOPES = ["openid", "profile"];

const isConfigured = Boolean(CLIENT_ID && TENANT_ID && UAMI_CLIENT_ID);

let managedIdentityCredential;
function getManagedIdentityCredential() {
  if (!managedIdentityCredential) {
    managedIdentityCredential = new ManagedIdentityCredential({ clientId: UAMI_CLIENT_ID });
  }
  return managedIdentityCredential;
}

// Called by MSAL itself (not by our own code directly) whenever it needs a
// freshly-signed client assertion to authenticate as the confidential
// client — this is what replaces a stored client secret.
async function getClientAssertion() {
  const token = await getManagedIdentityCredential().getToken(TOKEN_EXCHANGE_SCOPE);
  if (!token || !token.token) {
    throw new Error("Failed to acquire a managed identity token for the Entra client assertion");
  }
  return token.token;
}

let msalClient;
function getMsalClient() {
  if (!isConfigured) {
    throw new Error(
      "Entra sign-in is not configured (ENTRA_CLIENT_ID / ENTRA_TENANT_ID / AZURE_ADMIN_UAMI_CLIENT_ID env vars are not set)"
    );
  }
  if (!msalClient) {
    msalClient = new ConfidentialClientApplication({
      auth: {
        clientId: CLIENT_ID,
        authority: `https://login.microsoftonline.com/${TENANT_ID}`,
        clientAssertion: getClientAssertion,
      },
    });
  }
  return msalClient;
}

// Builds the Microsoft sign-in redirect URL to kick off the authorization
// code flow. `state` should be a per-attempt random value the caller stores
// in the session and verifies on callback (CSRF protection).
async function getAuthCodeUrl(redirectUri, state) {
  return getMsalClient().getAuthCodeUrl({ scopes: SCOPES, redirectUri, state });
}

// Exchanges the authorization code from the callback for tokens, returning a
// minimal identity object suitable for storing in the session. Assignment
// (who is allowed to sign in at all) is enforced entirely by Entra ID itself
// (the Enterprise Application has "Assignment required" = Yes) — an
// unassigned user is rejected by Microsoft during sign-in (AADSTS50105)
// before this code ever runs, so no additional allow-list/role check is
// needed here.
async function acquireTokenByCode(code, redirectUri) {
  const response = await getMsalClient().acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri,
  });
  const claims = response.idTokenClaims || {};
  return {
    name: (response.account && response.account.name) || claims.name || claims.preferred_username || "Signed-in user",
    username: (response.account && response.account.username) || claims.preferred_username || claims.upn || "",
    oid: claims.oid || (response.account && response.account.homeAccountId) || "",
  };
}

// Builds the Entra logout URL for a full sign-out (not just clearing our own
// session cookie).
function logoutUrl(postLogoutRedirectUri) {
  if (!TENANT_ID) return postLogoutRedirectUri;
  const base = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/logout`;
  return `${base}?post_logout_redirect_uri=${encodeURIComponent(postLogoutRedirectUri)}`;
}

module.exports = {
  isConfigured,
  getAuthCodeUrl,
  acquireTokenByCode,
  logoutUrl,
};
