/**
 * src/server.ts — entry point.
 *
 * Boots Fastify, registers routes, wires graceful shutdown.
 *
 * Lifecycle:
 *   start  → validate env (config.ts) → connect pool (db.ts) → listen
 *   stop   → SIGTERM/SIGINT → stop accepting requests → drain in-flight
 *            → close DB pool + Chromium + SMTP → exit(0)
 *
 * If shutdown stalls (e.g. a query hangs), a hard timeout kicks in
 * and exits with code 1. This is important for Docker, which will
 * SIGKILL after a grace period anyway — better to exit cleanly first.
 */

import Fastify from "fastify";
import { config } from "./config.js";
import { closeDb } from "./db.js";
import { closeMailer, verifyMailer } from "./lib/mail.js";
import { closePdfBrowser } from "./lib/pdf.js";
import { healthRoute } from "./routes/health.js";
import { webhookRoute } from "./routes/webhook.js";

const SHUTDOWN_TIMEOUT_MS = 8_000;

async function buildServer() {
  const fastify = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  await fastify.register(healthRoute);
  await fastify.register(webhookRoute);

  return fastify;
}

async function main() {
  const fastify = await buildServer();

  try {
    await fastify.listen({ port: config.port, host: "0.0.0.0" });
    fastify.log.info({ env: config.env, port: config.port }, "service ready");
  } catch (err) {
    fastify.log.error(err, "failed to start");
    process.exit(1);
  }

  // ── SMTP preflight ───────────────────────────────────────
  // Non-fatal: a bad login shouldn't block PDF upload / DB writes,
  // but we want it screaming in the boot logs, not discovered on the
  // first invoice. Email failures still degrade gracefully to 'partial'.
  if (await verifyMailer()) {
    fastify.log.info(
      { host: config.mail.host, port: config.mail.port, user: config.mail.user },
      "SMTP connection verified",
    );
  } else {
    fastify.log.error(
      { host: config.mail.host, port: config.mail.port, user: config.mail.user },
      "SMTP verification FAILED — emails will not send until fixed " +
        "(check FASTMAIL_SMTP_USER must be the main account login, and " +
        "FASTMAIL_APP_PASSWORD must be a valid app password)",
    );
  }

  // ── Graceful shutdown ────────────────────────────────────
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    fastify.log.info({ signal }, "shutdown initiated");

    const killer = setTimeout(() => {
      fastify.log.error("shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    killer.unref();

    try {
      // 1. Stop accepting new connections, drain in-flight requests.
      await fastify.close();
      // 2. Close the slow ones first so the timeout catches their hangs:
      //    Chromium and SMTP pool. DB pool is cheap to close.
      await closePdfBrowser();
      await closeMailer();
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
