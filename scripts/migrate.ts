/**
 * scripts/migrate.ts — minimal SQL migration runner.
 *
 * Reads *.sql files from ./migrations in filename order, applies any
 * that haven't been recorded in the _migrations table, each inside its
 * own transaction. Idempotent: already-applied files are skipped.
 *
 * Run with:  pnpm migrate
 * (package.json → "migrate": "node --import tsx scripts/migrate.ts")
 *
 * Secrets come from the environment (Doppler injects them):
 *   doppler run -- pnpm migrate
 */

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`✗ Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const sql = postgres({
  host: requireEnv("INVOICING_DB_HOST"),
  port: Number(process.env.INVOICING_DB_PORT ?? 5432),
  database: requireEnv("INVOICING_DB_NAME"),
  username: requireEnv("INVOICING_DB_USER"),
  password: requireEnv("INVOICING_DB_PASSWORD"),
  // One connection is plenty for a migration run; keeps ordering simple.
  max: 1,
  onnotice: () => {}, // suppress NOTICE chatter (e.g. DROP TRIGGER IF EXISTS)
});

async function ensureMigrationsTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename    text        PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `;
}

async function appliedSet(): Promise<Set<string>> {
  const rows = await sql<
    { filename: string }[]
  >`SELECT filename FROM _migrations`;
  return new Set(rows.map((r) => r.filename));
}

async function main(): Promise<void> {
  await ensureMigrationsTable();
  const done = await appliedSet();

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort(); // 001_, 002_, ... lexical sort == apply order

  if (files.length === 0) {
    console.log("No .sql files found in migrations/. Nothing to do.");
    return;
  }

  let appliedCount = 0;

  for (const file of files) {
    if (done.has(file)) {
      console.log(`• skip   ${file} (already applied)`);
      continue;
    }

    const path = join(MIGRATIONS_DIR, file);
    const ddl = await readFile(path, "utf8");

    process.stdout.write(`→ apply  ${file} ... `);
    try {
      // Each migration runs atomically: the file's SQL + the bookkeeping
      // insert succeed or fail together.
      await sql.begin(async (tx) => {
        await tx.unsafe(ddl);
        await tx`INSERT INTO _migrations (filename) VALUES (${file})`;
      });
      console.log("ok");
      appliedCount++;
    } catch (err) {
      console.log("FAILED");
      console.error(err);
      process.exit(1);
    }
  }

  console.log(
    appliedCount === 0
      ? "\nUp to date — no new migrations."
      : `\nDone — applied ${appliedCount} migration(s).`,
  );
}

main()
  .then(() => sql.end())
  .catch(async (err) => {
    console.error(err);
    await sql.end();
    process.exit(1);
  });
