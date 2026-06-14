/**
 * src/server.ts — entry point.
 *
 * Boots Fastify, registers routes, wires graceful shutdown.
 *
 * Lifecycle:
 *   start  → validate env (config.ts) → connect pool (db.ts) → listen
 *   stop   → SIGTERM/SIGINT → stop accepting requests → drain in-flight
 *            → close DB pool → exit(0)
 *
 * If shutdown stalls (e.g. a query hangs), a hard timeout kicks in
 * and exits with code 1. This is important for Docker, which will
 * SIGKILL after a grace period anyway — better to exit cleanly first.
 */

import Fastify from "fastify";
import { config } from "./config.js";
import { closeDb } from "./db.js";
import { healthRoute } from "./routes/health.js";

// Hard limit on graceful shutdown: if we can't exit cleanly in this
// many milliseconds, force exit. Slightly less than Docker's default
// 10s stop_grace_period so the process exits before SIGKILL.
const SHUTDOWN_TIMEOUT_MS = 8_000;

async function buildServer() {
  const fastify = Fastify({
    // Built-in pino logger; level comes from env, JSON logs in prod,
    // pretty-printed in dev would need pino-pretty (skip for now —
    // structured logs are fine to read directly).
    logger: {
      level: config.logLevel,
    },
    // Trust X-Forwarded-* headers — required when Fastify sits behind
    // Caddy/Nginx/Traefik on the VPS. Without this, request.ip would
    // be the proxy's IP, not the client's.
    trustProxy: true,
    // Reasonable body limit for webhook payloads (default is 1 MB,
    // we don't expect anything close to that, but 256 KB is plenty
    // and limits a DoS vector if the secret ever leaks).
    bodyLimit: 256 * 1024,
  });

  await fastify.register(healthRoute);

  return fastify;
}

async function main() {
  const fastify = await buildServer();

  // Listen on 0.0.0.0 so Docker port mapping works. Localhost-only
  // would make the container unreachable from outside.
  try {
    await fastify.listen({ port: config.port, host: "0.0.0.0" });
    fastify.log.info({ env: config.env, port: config.port }, "service ready");
  } catch (err) {
    fastify.log.error(err, "failed to start");
    process.exit(1);
  }

  // ── Graceful shutdown ────────────────────────────────────
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return; // ignore repeat signals
    shuttingDown = true;

    fastify.log.info({ signal }, "shutdown initiated");

    // Hard timeout — if anything hangs, force-exit.
    const killer = setTimeout(() => {
      fastify.log.error("shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    killer.unref(); // don't keep the event loop alive on this alone

    try {
      // 1. Stop accepting new connections, wait for in-flight to drain.
      await fastify.close();
      // 2. Drain the DB pool.
      await closeDb();
      fastify.log.info("shutdown complete");
      process.exit(0);
    } catch (err) {
      fastify.log.error(err, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
