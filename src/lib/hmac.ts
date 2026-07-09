/**
 * src/lib/hmac.ts — shared raw-body preservation + HMAC verification.
 *
 * Both POST routes (webhook, resend) authenticate the same way: an
 * HMAC-SHA256 hex digest of the exact request bytes, in the
 * `X-Invoicing-Signature` header, keyed on WEBHOOK_SECRET.
 *
 * The signature must be computed over the bytes Directus signed, not a
 * re-serialised JSON (whose whitespace / key order could differ). So we
 * install a content-type parser that keeps both a Buffer (for HMAC) and
 * the parsed object (for Zod). Registered ONCE at the root instance so
 * every child route inherits it — Fastify forbids two parsers for the
 * same content type in one encapsulation context.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

/** Header carrying the HMAC-SHA256 hex digest of the raw body. */
export const SIGNATURE_HEADER = "x-invoicing-signature";

/** Request augmented with the raw body bytes by `addRawBodyParser`. */
export interface RequestWithRaw extends FastifyRequest {
  rawBody: Buffer;
}

/**
 * Install the raw-body-preserving JSON parser on the given instance.
 * Call once at the root, before registering routes.
 */
export function addRawBodyParser(fastify: FastifyInstance): void {
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      (req as RequestWithRaw).rawBody = body as Buffer;
      try {
        done(null, JSON.parse((body as Buffer).toString("utf8")));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );
}

/**
 * Constant-time HMAC verification. `timingSafeEqual` requires equal-
 * length buffers, so we length-check first to avoid throwing on
 * mismatched-length attacker input.
 */
export function verifyHmac(
  rawBody: Buffer,
  signature: string,
  secret: string,
): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (expected.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}
