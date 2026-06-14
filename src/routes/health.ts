/**
 * src/routes/health.ts — GET /health
 *
 * Deep health check: verifies the process is alive AND that the
 * database answers a `SELECT 1`. Used by Docker healthcheck and any
 * external monitoring.
 *
 * Response semantics:
 *   200 OK         — process up, DB reachable           → {status: 'ok', ...}
 *   503 Unavailable — process up, DB unreachable         → {status: 'degraded', ...}
 *
 * We intentionally NEVER throw from this handler: a failed DB ping
 * is a normal expected condition (e.g. DB restarting), reported via
 * HTTP status, not a 500.
 */

import type { FastifyPluginAsync } from "fastify";
import { pingDb } from "../db.js";
import { config } from "../config.js";

export const healthRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/health", async (_request, reply) => {
    const dbOk = await pingDb();

    const body = {
      status: dbOk ? "ok" : "degraded",
      database: dbOk ? "ok" : "down",
      env: config.env,
      uptime_s: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };

    return reply.code(dbOk ? 200 : 503).send(body);
  });
};
