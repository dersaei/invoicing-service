/**
 * src/db.ts — Postgres client (Porsager).
 *
 * One pool per process. Imported wherever a query is needed:
 *     import { sql } from './db.js';
 *     const rows = await sql`SELECT 1`;
 *
 * Tagged template literals provide built-in parameterisation — values
 * interpolated with ${} are sent as bound parameters, not concatenated
 * into SQL. Use sql.unsafe() only for trusted DDL (e.g. migrations).
 */

import postgres from "postgres";
import { config } from "./config.js";

export const sql = postgres({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  username: config.db.username,
  password: config.db.password,

  // Sensible pool defaults for a single-node webhook service. The
  // workload is short bursts (one webhook → handful of queries), not
  // sustained throughput, so a small pool is plenty.
  max: 10,
  idle_timeout: 30, // seconds: close idle connections after 30s
  connect_timeout: 10, // seconds: fail fast if DB is unreachable

  // Quiet down NOTICE messages from Postgres (we log what we care about).
  onnotice: () => {},
});

/**
 * Cheap liveness/readiness probe. Returns true if the DB answers a
 * `SELECT 1` within the connection timeout, false otherwise.
 * Used by the /health endpoint and by the Docker healthcheck.
 */
export async function pingDb(): Promise<boolean> {
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/**
 * Gracefully drain the pool on shutdown so in-flight queries can
 * finish. Called from server.ts on SIGINT/SIGTERM.
 */
export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
