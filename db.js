// db.js — Azure SQL Database access, authenticated via the App Service's
// system-assigned managed identity (Azure AD / Entra ID token auth). There is
// no SQL username/password anywhere — locally (where a managed identity is
// not available) all functions gracefully no-op/throw so callers can fall
// back to static content instead of crashing.
const sql = require("mssql");
const { DefaultAzureCredential } = require("@azure/identity");

const SQL_SERVER = process.env.AZURE_SQL_SERVER_FQDN;
const SQL_DATABASE = process.env.AZURE_SQL_DATABASE_NAME;
const TOKEN_SCOPE = "https://database.windows.net/.default";
const TABLE_NAME = "PageContent";

const isConfigured = Boolean(SQL_SERVER && SQL_DATABASE);

let credential;
function getCredential() {
  if (!credential) {
    credential = new DefaultAzureCredential();
  }
  return credential;
}

// Runs `fn(pool)` against a short-lived connection pool authenticated with a
// freshly-fetched managed identity access token, then always closes the pool.
// Using a fresh connection per call (rather than a long-lived cached pool)
// keeps token-expiry handling trivial for this low-traffic demo site.
async function withConnection(fn) {
  if (!isConfigured) {
    throw new Error(
      "Azure SQL is not configured (AZURE_SQL_SERVER_FQDN / AZURE_SQL_DATABASE_NAME env vars are not set)"
    );
  }

  const tokenResponse = await getCredential().getToken(TOKEN_SCOPE);
  if (!tokenResponse || !tokenResponse.token) {
    throw new Error("Failed to acquire an Azure AD access token for Azure SQL");
  }

  const pool = new sql.ConnectionPool({
    server: SQL_SERVER,
    database: SQL_DATABASE,
    options: { encrypt: true },
    authentication: {
      type: "azure-active-directory-access-token",
      options: { token: tokenResponse.token },
    },
  });

  await pool.connect();
  try {
    return await fn(pool);
  } finally {
    await pool.close();
  }
}

// Creates the PageContent table if it doesn't exist, then inserts each seed
// row only if that PageKey isn't already present. Safe to call on every
// startup/deploy — never overwrites content that's already been edited.
async function ensureSchemaAndSeed(seedRows) {
  await withConnection(async (pool) => {
    await pool.request().query(`
      IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = '${TABLE_NAME}')
      BEGIN
        CREATE TABLE ${TABLE_NAME} (
          PageKey NVARCHAR(50) NOT NULL PRIMARY KEY,
          Title NVARCHAR(200) NULL,
          BodyHtml NVARCHAR(MAX) NOT NULL,
          UpdatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
      END
    `);

    for (const row of seedRows) {
      await pool
        .request()
        .input("pageKey", sql.NVarChar(50), row.pageKey)
        .input("title", sql.NVarChar(200), row.title)
        .input("bodyHtml", sql.NVarChar(sql.MAX), row.bodyHtml).query(`
          IF NOT EXISTS (SELECT 1 FROM ${TABLE_NAME} WHERE PageKey = @pageKey)
          INSERT INTO ${TABLE_NAME} (PageKey, Title, BodyHtml)
          VALUES (@pageKey, @title, @bodyHtml)
        `);
    }
  });
}

// Returns { title, bodyHtml, updatedAt } for a page, or null if no row exists.
async function getPageContent(pageKey) {
  return withConnection(async (pool) => {
    const result = await pool
      .request()
      .input("pageKey", sql.NVarChar(50), pageKey)
      .query(
        `SELECT Title, BodyHtml, UpdatedAt FROM ${TABLE_NAME} WHERE PageKey = @pageKey`
      );
    const row = result.recordset[0];
    if (!row) return null;
    return { title: row.Title, bodyHtml: row.BodyHtml, updatedAt: row.UpdatedAt };
  });
}

// Returns a map of pageKey -> { title, bodyHtml, updatedAt } for all rows.
async function getAllPageContent() {
  return withConnection(async (pool) => {
    const result = await pool
      .request()
      .query(`SELECT PageKey, Title, BodyHtml, UpdatedAt FROM ${TABLE_NAME}`);
    const byKey = {};
    for (const row of result.recordset) {
      byKey[row.PageKey] = {
        title: row.Title,
        bodyHtml: row.BodyHtml,
        updatedAt: row.UpdatedAt,
      };
    }
    return byKey;
  });
}

// Upserts a page's content.
async function setPageContent(pageKey, title, bodyHtml) {
  return withConnection(async (pool) => {
    const result = await pool
      .request()
      .input("pageKey", sql.NVarChar(50), pageKey)
      .input("title", sql.NVarChar(200), title)
      .input("bodyHtml", sql.NVarChar(sql.MAX), bodyHtml).query(`
        UPDATE ${TABLE_NAME}
        SET Title = @title, BodyHtml = @bodyHtml, UpdatedAt = SYSUTCDATETIME()
        WHERE PageKey = @pageKey
      `);

    if (result.rowsAffected[0] === 0) {
      await pool
        .request()
        .input("pageKey", sql.NVarChar(50), pageKey)
        .input("title", sql.NVarChar(200), title)
        .input("bodyHtml", sql.NVarChar(sql.MAX), bodyHtml).query(`
          INSERT INTO ${TABLE_NAME} (PageKey, Title, BodyHtml)
          VALUES (@pageKey, @title, @bodyHtml)
        `);
    }
  });
}

// Deletes any rows whose PageKey is in `keys` — used to prune legacy
// whole-page rows left over from before content was split per editable card
// section. Idempotent: a no-op once the rows are already gone. Never throws
// if the table doesn't exist yet (ensureSchemaAndSeed always runs first).
async function pruneLegacyKeys(keys) {
  if (!keys || keys.length === 0) return;
  return withConnection(async (pool) => {
    for (const key of keys) {
      await pool
        .request()
        .input("pageKey", sql.NVarChar(50), key)
        .query(`DELETE FROM ${TABLE_NAME} WHERE PageKey = @pageKey`);
    }
  });
}

module.exports = {
  isConfigured,
  ensureSchemaAndSeed,
  getPageContent,
  getAllPageContent,
  setPageContent,
  pruneLegacyKeys,
};
