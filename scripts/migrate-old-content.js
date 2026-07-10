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
// This script is NOT required/imported by server.js and is NOT run by any
// deploy pipeline or GitHub Actions workflow — it must be run manually,
// exactly once, from a context that holds the Web App's system-assigned
// managed identity (which is the SQL Server's AAD Administrator, so it has
// full rights over every database on the server, including the old one).
// The GitHub Actions OIDC service principal has no SQL data-plane rights
// and deliberately isn't being granted any just for this — see the PR
// description for the `az webapp ssh` / Kudu SSH console run instructions.
//
// Safe to re-run: upserts by PageKey (UPDATE, falling back to INSERT if no
// row exists yet) into the target database, exactly like db.js's
// setPageContent().

const sql = require("mssql");
const { DefaultAzureCredential } = require("@azure/identity");

const SQL_SERVER = process.env.AZURE_SQL_SERVER_FQDN;
// The old database's name isn't (and shouldn't be) a permanent app setting
// once it's gone, so it defaults to the known value but can be overridden.
const OLD_DATABASE = process.env.OLD_SQL_DATABASE_NAME || "sqldb-website-content";
// The new/target database: reuse whatever AZURE_SQL_DATABASE_NAME already
// resolves to in this environment (the Web App is already configured to
// point at the new DB), or allow an explicit override.
const NEW_DATABASE = process.env.NEW_SQL_DATABASE_NAME || process.env.AZURE_SQL_DATABASE_NAME;
const TOKEN_SCOPE = "https://database.windows.net/.default";
const TABLE_NAME = "PageContent";

async function connect(databaseName, token) {
  const pool = new sql.ConnectionPool({
    server: SQL_SERVER,
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

async function main() {
  if (!SQL_SERVER) {
    throw new Error(
      "AZURE_SQL_SERVER_FQDN is not set. Run this from a context that has the " +
        "Web App's app settings available (e.g. `az webapp ssh` into the " +
        "deployed Web App) — see the PR description for exact steps."
    );
  }
  if (!NEW_DATABASE) {
    throw new Error("AZURE_SQL_DATABASE_NAME (or NEW_SQL_DATABASE_NAME) is not set.");
  }
  if (OLD_DATABASE === NEW_DATABASE) {
    throw new Error(
      `OLD_SQL_DATABASE_NAME and the target database both resolve to "${NEW_DATABASE}" ` +
        "— refusing to run, this would copy a database onto itself."
    );
  }

  console.log(`[migrate] server:       ${SQL_SERVER}`);
  console.log(`[migrate] source (old): ${OLD_DATABASE}`);
  console.log(`[migrate] target (new): ${NEW_DATABASE}`);

  const credential = new DefaultAzureCredential();
  const tokenResponse = await credential.getToken(TOKEN_SCOPE);
  if (!tokenResponse || !tokenResponse.token) {
    throw new Error(
      "Failed to acquire an Azure AD access token for Azure SQL. This script " +
        "must run as (or impersonating) the Web App's managed identity — e.g. " +
        "via `az webapp ssh`, not from a plain local shell or GitHub Actions."
    );
  }
  const token = tokenResponse.token;

  console.log(`[migrate] connecting to ${OLD_DATABASE}...`);
  const oldPool = await connect(OLD_DATABASE, token);
  let rows;
  try {
    rows = await readOldRows(oldPool);
  } finally {
    await oldPool.close();
  }

  console.log(`[migrate] read ${rows.length} row(s) from ${OLD_DATABASE}:`);
  for (const row of rows) {
    console.log(
      `[migrate]   PageKey=${row.PageKey} Title=${JSON.stringify(row.Title)} ` +
        `BodyHtml.length=${row.BodyHtml ? row.BodyHtml.length : 0} UpdatedAt=${row.UpdatedAt}`
    );
  }

  if (rows.length === 0) {
    console.log("[migrate] no rows found in the old database — nothing to migrate.");
    return;
  }

  console.log(`[migrate] connecting to ${NEW_DATABASE}...`);
  const newPool = await connect(NEW_DATABASE, token);
  try {
    await ensureTable(newPool);
    for (const row of rows) {
      await upsertRow(newPool, row);
      console.log(
        `[migrate] wrote PageKey=${row.PageKey} Title=${JSON.stringify(row.Title)} ` +
          `BodyHtml.length=${row.BodyHtml ? row.BodyHtml.length : 0} to ${NEW_DATABASE}`
      );
    }
  } finally {
    await newPool.close();
  }

  console.log(
    `[migrate] done — migrated ${rows.length} row(s) from ${OLD_DATABASE} to ${NEW_DATABASE}.`
  );
}

main().catch((err) => {
  console.error("[migrate] FAILED:", err);
  process.exitCode = 1;
});
