#!/usr/bin/env node
// scripts/migrate-old-content.js
//
// ONE-OFF, NOT PUBLICLY EXPOSED migration tool. Copies the PageContent rows
// from the OLD Azure SQL database (sqldb-website-content) to the NEW
// free-tier database (sqldb-website-content-free — whatever
// AZURE_SQL_DATABASE_NAME currently resolves to) on the same logical SQL
// server. Both databases are AAD-only auth; there is no SQL login here, same
// as db.js.
//
// This module exports `runMigration()` so the same logic can be invoked two
// ways:
//   1. As a CLI script (`node scripts/migrate-old-content.js`), run manually
//      from a context that holds the Web App's managed identity (e.g.
//      `az webapp ssh` / the Kudu SSH console).
//   2. From the temporary `POST /internal/migrate-content` route in
//      server.js, for cases where only HTTP access to the deployed site is
//      available (no Azure CLI/SSH access) — see that route for the
//      secret-header gate. That route is itself temporary, one-off tooling;
//      see its comment in server.js for the planned removal.
//
// Neither entry point is required/imported by the app's normal startup path
// beyond the temporary route above, and this script is not run by any
// deploy pipeline or GitHub Actions workflow.
//
// Safe to re-run: upserts by PageKey (UPDATE, falling back to INSERT if no
// row exists yet) into the target database, exactly like db.js's
// setPageContent().

const sql = require("mssql");
const { DefaultAzureCredential } = require("@azure/identity");

const TOKEN_SCOPE = "https://database.windows.net/.default";
const TABLE_NAME = "PageContent";

async function connect(server, databaseName, token) {
  const pool = new sql.ConnectionPool({
    server,
    database: databaseName,
    options: { encrypt: true },
    authentication: {
      type: "azure-active-directory-access-token",
      options: { token },
    },
  });
  await pool.connect();
  return pool;
}

async function readOldRows(pool) {
  const result = await pool
    .request()
    .query(`SELECT PageKey, Title, BodyHtml, UpdatedAt FROM ${TABLE_NAME}`);
  return result.recordset;
}

// Mirrors db.js's ensureSchemaAndSeed()'s table-creation guard, in case the
// target database somehow doesn't have the table yet.
async function ensureTable(pool) {
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
}

// Same UPDATE-then-INSERT-if-no-rows-affected upsert pattern as db.js's
// setPageContent(), so this is safe to run more than once.
async function upsertRow(pool, row) {
  const result = await pool
    .request()
    .input("pageKey", sql.NVarChar(50), row.PageKey)
    .input("title", sql.NVarChar(200), row.Title)
    .input("bodyHtml", sql.NVarChar(sql.MAX), row.BodyHtml).query(`
      UPDATE ${TABLE_NAME}
      SET Title = @title, BodyHtml = @bodyHtml, UpdatedAt = SYSUTCDATETIME()
      WHERE PageKey = @pageKey
    `);

  if (result.rowsAffected[0] === 0) {
    await pool
      .request()
      .input("pageKey", sql.NVarChar(50), row.PageKey)
      .input("title", sql.NVarChar(200), row.Title)
      .input("bodyHtml", sql.NVarChar(sql.MAX), row.BodyHtml).query(`
        INSERT INTO ${TABLE_NAME} (PageKey, Title, BodyHtml)
        VALUES (@pageKey, @title, @bodyHtml)
      `);
  }
}

// Runs the full old-DB-to-new-DB migration and returns a summary object:
// { server, oldDatabase, newDatabase, readRows, writtenRows } where
// readRows/writtenRows are arrays of { pageKey, title, bodyHtmlLength,
// updatedAt }. Accepts an optional `log` function (defaults to
// console.log) so callers (CLI vs. HTTP route) can control where the
// verbose per-row logging goes; errors always throw rather than being
// swallowed, so callers can decide how to report failure.
async function runMigration({ log = console.log } = {}) {
  const server = process.env.AZURE_SQL_SERVER_FQDN;
  // The old database's name isn't (and shouldn't be) a permanent app
  // setting once it's gone, so it defaults to the known value but can be
  // overridden.
  const oldDatabase = process.env.OLD_SQL_DATABASE_NAME || "sqldb-website-content";
  // The new/target database: reuse whatever AZURE_SQL_DATABASE_NAME already
  // resolves to in this environment (the Web App is already configured to
  // point at the new DB), or allow an explicit override.
  const newDatabase = process.env.NEW_SQL_DATABASE_NAME || process.env.AZURE_SQL_DATABASE_NAME;

  if (!server) {
    throw new Error(
      "AZURE_SQL_SERVER_FQDN is not set. This must run in a context that has " +
        "the Web App's app settings and managed identity available."
    );
  }
  if (!newDatabase) {
    throw new Error("AZURE_SQL_DATABASE_NAME (or NEW_SQL_DATABASE_NAME) is not set.");
  }
  if (oldDatabase === newDatabase) {
    throw new Error(
      `OLD_SQL_DATABASE_NAME and the target database both resolve to "${newDatabase}" ` +
        "— refusing to run, this would copy a database onto itself."
    );
  }

  log(`[migrate] server:       ${server}`);
  log(`[migrate] source (old): ${oldDatabase}`);
  log(`[migrate] target (new): ${newDatabase}`);

  const credential = new DefaultAzureCredential();
  const tokenResponse = await credential.getToken(TOKEN_SCOPE);
  if (!tokenResponse || !tokenResponse.token) {
    throw new Error(
      "Failed to acquire an Azure AD access token for Azure SQL. This must " +
        "run as (or impersonating) the Web App's managed identity."
    );
  }
  const token = tokenResponse.token;

  log(`[migrate] connecting to ${oldDatabase}...`);
  const oldPool = await connect(server, oldDatabase, token);
  let rows;
  try {
    rows = await readOldRows(oldPool);
  } finally {
    await oldPool.close();
  }

  log(`[migrate] read ${rows.length} row(s) from ${oldDatabase}:`);
  const readRows = rows.map((row) => ({
    pageKey: row.PageKey,
    title: row.Title,
    bodyHtmlLength: row.BodyHtml ? row.BodyHtml.length : 0,
    updatedAt: row.UpdatedAt,
  }));
  for (const row of readRows) {
    log(
      `[migrate]   PageKey=${row.pageKey} Title=${JSON.stringify(row.title)} ` +
        `BodyHtml.length=${row.bodyHtmlLength} UpdatedAt=${row.updatedAt}`
    );
  }

  if (rows.length === 0) {
    log("[migrate] no rows found in the old database — nothing to migrate.");
    return { server, oldDatabase, newDatabase, readRows, writtenRows: [] };
  }

  log(`[migrate] connecting to ${newDatabase}...`);
  const newPool = await connect(server, newDatabase, token);
  const writtenRows = [];
  try {
    await ensureTable(newPool);
    for (const row of rows) {
      await upsertRow(newPool, row);
      const written = {
        pageKey: row.PageKey,
        title: row.Title,
        bodyHtmlLength: row.BodyHtml ? row.BodyHtml.length : 0,
      };
      writtenRows.push(written);
      log(
        `[migrate] wrote PageKey=${written.pageKey} Title=${JSON.stringify(written.title)} ` +
          `BodyHtml.length=${written.bodyHtmlLength} to ${newDatabase}`
      );
    }
  } finally {
    await newPool.close();
  }

  log(`[migrate] done — migrated ${rows.length} row(s) from ${oldDatabase} to ${newDatabase}.`);

  return { server, oldDatabase, newDatabase, readRows, writtenRows };
}

// CLI entry point — only runs when this file is executed directly (`node
// scripts/migrate-old-content.js`), not when required as a module (e.g. by
// server.js's temporary migration route).
if (require.main === module) {
  runMigration().catch((err) => {
    console.error("[migrate] FAILED:", err);
    process.exitCode = 1;
  });
}

module.exports = { runMigration };
