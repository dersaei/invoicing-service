/**
 * test/routes-auth.test.ts — HMAC auth + payload validation for the two
 * signed POST routes, via fastify.inject (no DB / SMTP / Directus needed).
 *
 * These paths (401 missing/invalid signature, 400 bad body) all return
 * BEFORE any I/O, so they exercise the real route wiring — the shared
 * raw-body parser, HMAC verification, and Zod validation — without infra.
 * It also guards the refactor that moved the raw-body parser to the root:
 * the webhook must still authenticate.
 *
 * Placeholder env is seeded before importing any config-touching module.
 */

process.env.WEBHOOK_SECRET ??= "test-secret-0123456789abcdef";
process.env.INVOICING_DB_HOST ??= "localhost";
process.env.INVOICING_DB_NAME ??= "unused";
process.env.INVOICING_DB_USER ??= "unused";
process.env.INVOICING_DB_PASSWORD ??= "unused";
process.env.DIRECTUS_URL ??= "http://localhost";
process.env.DIRECTUS_TOKEN ??= "unused";
process.env.FASTMAIL_SMTP_USER ??= "unused";
process.env.FASTMAIL_APP_PASSWORD ??= "unused";
process.env.MAIL_FROM ??= "invoices@example.com";

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";

const SECRET = process.env.WEBHOOK_SECRET!;

const { addRawBodyParser } = await import("../src/lib/hmac.js");
const { webhookRoute } = await import("../src/routes/webhook.js");
const { resendRoute } = await import("../src/routes/resend.js");

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

const app: FastifyInstance = Fastify();
addRawBodyParser(app);
await app.register(webhookRoute);
await app.register(resendRoute);
await app.ready();
after(() => app.close());

const JSON_CT = { "content-type": "application/json" };

describe("POST /invoice/resend — auth & validation", () => {
  it("401 when the signature header is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/invoice/resend",
      headers: JSON_CT,
      payload: '{"invoice_number":"FR001VG/2026"}',
    });
    assert.equal(res.statusCode, 401);
  });

  it("401 when the signature is wrong", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/invoice/resend",
      headers: { ...JSON_CT, "x-invoicing-signature": "deadbeef" },
      payload: '{"invoice_number":"FR001VG/2026"}',
    });
    assert.equal(res.statusCode, 401);
  });

  it("400 when body has neither invoice_number nor invoice_id", async () => {
    const body = "{}";
    const res = await app.inject({
      method: "POST",
      url: "/invoice/resend",
      headers: { ...JSON_CT, "x-invoicing-signature": sign(body) },
      payload: body,
    });
    assert.equal(res.statusCode, 400);
  });

  it("400 when invoice_id is not a UUID", async () => {
    const body = JSON.stringify({ invoice_id: "not-a-uuid" });
    const res = await app.inject({
      method: "POST",
      url: "/invoice/resend",
      headers: { ...JSON_CT, "x-invoicing-signature": sign(body) },
      payload: body,
    });
    assert.equal(res.statusCode, 400);
  });

  it("200-path is NOT reached without a valid signature (defence in depth)", async () => {
    // A well-formed body but no signature must still be rejected at auth.
    const res = await app.inject({
      method: "POST",
      url: "/invoice/resend",
      headers: JSON_CT,
      payload: JSON.stringify({ invoice_id: "11111111-1111-1111-1111-111111111111" }),
    });
    assert.equal(res.statusCode, 401);
  });
});

describe("POST /webhook/invoice — auth still enforced after parser refactor", () => {
  it("401 when the signature header is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhook/invoice",
      headers: JSON_CT,
      payload: "{}",
    });
    assert.equal(res.statusCode, 401);
  });

  it("401 when the signature is wrong", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhook/invoice",
      headers: { ...JSON_CT, "x-invoicing-signature": "bad" },
      payload: "{}",
    });
    assert.equal(res.statusCode, 401);
  });
});
