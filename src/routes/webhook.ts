/**
 * src/routes/webhook.ts — POST /webhook/invoice.
 *
 * The heart of the service. Takes a payload from a Directus Flow,
 * verifies its HMAC, walks through the whole pipeline:
 *
 *   1. Verify HMAC signature on the raw body
 *   2. Validate payload with Zod
 *   3. Idempotency: if submission_id already processed, return existing
 *   4. Fetch the service definition from Directus catalog
 *   5. Run VIES check if buyer is EU-non-PL with a VAT-EU id
 *   6. Compute VAT regime + amounts
 *   7. Localise the VAT note (vat.ts returns English default)
 *   8. Allocate next invoice number atomically
 *   9. Render the invoice HTML
 *  10. Generate PDF via Playwright/Chromium
 *  11. Upload PDF to Directus Files
 *  12. Persist invoice row in DB
 *  13. Render + send email via Fastmail SMTP
 *  14. Update invoice status (sent / failed)
 *
 * Every step writes to `audit_log` so a partial run can be reconstructed.
 *
 * HTTP semantics:
 *   200 ok        — full success (issued + sent)
 *   200 partial   — invoice issued but email send failed (manual resend possible)
 *   200 duplicate — submission_id already processed; returns existing record
 *   400           — payload failed Zod validation
 *   401           — missing or invalid HMAC signature
 *   422           — domain error (service not found, VIES rejected, etc.)
 *   500           — unexpected infrastructure failure (caller may retry — idempotency protects)
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { sql } from "../db.js";
import { getT } from "../lib/i18n.js";
import {
  fetchService,
  ServiceInactiveError,
  ServiceNotFoundError,
  uploadInvoicePdf,
} from "../lib/directus.js";
import { sendInvoiceEmail } from "../lib/mail.js";
import { nextInvoiceNumber } from "../lib/numbering.js";
import { generateInvoicePdf } from "../lib/pdf.js";
import { computeVat, isEuCountry, ViesValidationError } from "../lib/vat.js";
import { checkVies } from "../lib/vies.js";
import { renderInvoiceEmail } from "../templates/email.html.js";
import { renderInvoiceHtml } from "../templates/invoice.html.js";
import { WebhookPayloadSchema } from "../types.js";

/**
 * Payment term in days. Per project plan: 30-day terms across all
 * subscriptions. Constant lives here (not in config) because it's a
 * business rule that should require a code review to change, not a
 * Doppler tweak.
 */
const PAYMENT_TERM_DAYS = 30;

/** Header name carrying the HMAC-SHA256 hex digest of the raw body. */
const SIGNATURE_HEADER = "x-invoicing-signature";

interface RequestWithRaw extends FastifyRequest {
  rawBody: Buffer;
}

export const webhookRoute: FastifyPluginAsync = async (fastify) => {
  // ── Raw-body-preserving JSON parser ────────────────────────
  // HMAC must be computed over the bytes that Directus signed, not over
  // a re-serialised JSON (whose whitespace/key-order could differ).
  // We override the default parser to keep both: a Buffer for HMAC,
  // and the parsed object for Zod.
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

  fastify.post("/webhook/invoice", async (request, reply) => {
    const req = request as RequestWithRaw;

    // ── 1. HMAC verification ────────────────────────────────
    const signature = req.headers[SIGNATURE_HEADER];
    if (typeof signature !== "string" || signature.length === 0) {
      return reply.code(401).send({ error: "missing X-Invoicing-Signature" });
    }
    if (!verifyHmac(req.rawBody, signature, config.webhookSecret)) {
      fastify.log.warn(
        { sig_prefix: signature.slice(0, 8) },
        "HMAC verification failed",
      );
      return reply.code(401).send({ error: "invalid signature" });
    }

    // ── 2. Validate payload ─────────────────────────────────
    const parsed = WebhookPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid payload",
        issues: parsed.error.issues,
      });
    }
    const payload = parsed.data;

    const log = fastify.log.child({ submission_id: payload.submission_id });
    log.info(
      { service_code: payload.service_code, language: payload.language },
      "webhook received",
    );

    const audit = async (
      event: string,
      detail: Record<string, unknown> | null,
      invoiceId: string | null = null,
    ): Promise<void> => {
      await sql`
        INSERT INTO audit_log (submission_id, invoice_id, event, detail)
        VALUES (
          ${payload.submission_id},
          ${invoiceId},
          ${event},
          ${detail === null ? null : sql.json(detail as never)}
        )
      `;
    };

    await audit("received", {
      language: payload.language,
      service_code: payload.service_code,
      buyer_country: payload.buyer.address.country,
    });

    // ── 3. Idempotency check ────────────────────────────────
    const existing = await sql<
      { id: string; invoice_number: string; pdf_file_id: string | null }[]
    >`
      SELECT id, invoice_number, pdf_file_id
      FROM invoices
      WHERE submission_id = ${payload.submission_id}
      LIMIT 1
    `;
    if (existing.length > 0) {
      const row = existing[0]!;
      log.info({ invoice_number: row.invoice_number }, "duplicate submission");
      await audit("duplicate", { existing_invoice_id: row.id });
      return reply.code(200).send({
        status: "duplicate",
        invoice_id: row.id,
        invoice_number: row.invoice_number,
        pdf_file_id: row.pdf_file_id,
      });
    }

    try {
      // ── 4. Fetch service from catalog ─────────────────────
      const service = await fetchService(payload.service_code);
      await audit("service_fetched", {
        code: service.code,
        brand: service.brand,
        price_net_eur: service.price_net_eur,
      });

      const netAmount = Number(service.price_net_eur);
      if (!Number.isFinite(netAmount) || netAmount < 0) {
        throw new Error(
          `Catalog has invalid price_net_eur for ${service.code}: ${service.price_net_eur}`,
        );
      }

      // ── 5. VIES (only when buyer is EU-non-PL with VAT-EU id) ──
      let viesResult: Awaited<ReturnType<typeof checkVies>> | null = null;
      const buyerCountry = payload.buyer.address.country;
      if (
        payload.buyer.vat_id &&
        isEuCountry(buyerCountry) &&
        buyerCountry !== "PL"
      ) {
        viesResult = await checkVies(payload.buyer.vat_id);
        await audit("vies_checked", { valid: viesResult.valid });
      }

      // ── 6. Compute VAT ────────────────────────────────────
      // computeVat throws ViesValidationError if VAT-EU was provided
      // but VIES couldn't confirm it (rejected or unreachable).
      const vatComp = computeVat({
        net: netAmount,
        buyerCountry,
        vies: viesResult,
      });

      // ── 7. Localise the VAT note ──────────────────────────
      // vat.ts returns an English default; we replace it with the
      // buyer-language version so what we persist matches what's
      // printed on the PDF.
      const t = getT(payload.language);
      const translatedNote =
        vatComp.regime === "eu_reverse"
          ? (t("vat_notes.eu_reverse") as string)
          : vatComp.regime === "export_zero"
            ? (t("vat_notes.export_zero") as string)
            : null;
      const localisedVat = { ...vatComp, note: translatedNote };

      // ── 8. Allocate the next invoice number (atomic) ──────
      const invoiceNumber = await nextInvoiceNumber({
        brand: service.brand,
        country: buyerCountry,
      });
      await audit("number_allocated", { number: invoiceNumber.number });

      // ── 9. Localise service name and description ──────────
      const localisedName =
        service[`name_${payload.language}` as const] ??
        service.name_en ??
        service.code;
      const localisedDesc =
        service[`description_${payload.language}` as const] ??
        service.description_en ??
        null;

      const issueDate = new Date();
      const dueDate = new Date(
        issueDate.getTime() + PAYMENT_TERM_DAYS * 24 * 60 * 60 * 1000,
      );

      // ── 10. Render invoice HTML ───────────────────────────
      const html = renderInvoiceHtml({
        number: invoiceNumber.number,
        brand: service.brand,
        language: payload.language,
        issueDate,
        dueDate,
        buyer: payload.buyer,
        items: [
          {
            name: localisedName,
            description: localisedDesc,
            quantity: 1,
            unitPriceNet: netAmount,
          },
        ],
        vat: localisedVat,
        paymentTermDays: PAYMENT_TERM_DAYS,
      });

      // ── 11. Generate PDF ──────────────────────────────────
      const pdfBuffer = await generateInvoicePdf(html);
      await audit("pdf_generated", { size: pdfBuffer.length });

      // ── 12. Upload to Directus Files ──────────────────────
      // File name uses underscore (filesystem-safe) instead of slash.
      const pdfFilename = invoiceNumber.number.replace(/\//g, "_") + ".pdf";
      const uploaded = await uploadInvoicePdf(pdfBuffer, pdfFilename);
      await audit("pdf_uploaded", { file_id: uploaded.id });

      // ── 13. Persist invoice row ───────────────────────────
      const inserted = await sql<{ id: string }[]>`
        INSERT INTO invoices (
          submission_id, invoice_number, brand, doc_type, service_code,
          buyer_name, buyer_email, buyer_vat_id, buyer_country, buyer_address,
          currency, amount_net, vat_rate, amount_vat, amount_gross,
          vat_regime, vat_note,
          vies_checked, vies_valid, vies_raw,
          language, issue_date, pdf_file_id, status
        ) VALUES (
          ${payload.submission_id}, ${invoiceNumber.number}, ${service.brand},
          'proforma', ${service.code},
          ${payload.buyer.name}, ${payload.buyer.email},
          ${payload.buyer.vat_id ?? null}, ${buyerCountry},
          ${sql.json(payload.buyer.address as never)},
          'EUR', ${localisedVat.net}, ${localisedVat.rate},
          ${localisedVat.vat}, ${localisedVat.gross},
          ${localisedVat.regime}, ${translatedNote},
          ${viesResult !== null}, ${viesResult?.valid ?? null},
          ${viesResult ? sql.json(viesResult.raw as never) : null},
          ${payload.language}, ${issueDate}, ${uploaded.id}, 'issued'
        )
        RETURNING id
      `;
      const invoiceId = inserted[0]!.id;
      await audit(
        "invoice_persisted",
        { invoice_number: invoiceNumber.number },
        invoiceId,
      );

      // ── 14. Render and send email ─────────────────────────
      const rendered = renderInvoiceEmail({
        language: payload.language,
        invoiceNumber: invoiceNumber.number,
        paymentTermDays: PAYMENT_TERM_DAYS,
      });

      let emailStatus: "sent" | "failed" = "failed";
      let emailWarning: string | null = null;
      try {
        const mailResult = await sendInvoiceEmail({
          to: payload.buyer.email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          pdfBuffer,
          pdfFilename,
        });
        emailStatus = "sent";
        await audit(
          "email_sent",
          { message_id: mailResult.messageId, accepted: mailResult.accepted },
          invoiceId,
        );
        await sql`UPDATE invoices SET status = 'sent' WHERE id = ${invoiceId}`;
      } catch (mailErr) {
        emailWarning =
          mailErr instanceof Error ? mailErr.message : String(mailErr);
        log.error({ err: mailErr }, "email send failed");
        await audit("email_failed", { error: emailWarning }, invoiceId);
        await sql`UPDATE invoices SET status = 'failed' WHERE id = ${invoiceId}`;
      }

      log.info(
        {
          invoice_number: invoiceNumber.number,
          invoice_id: invoiceId,
          email_status: emailStatus,
        },
        "invoice processed",
      );

      return reply.code(200).send({
        status: emailStatus === "sent" ? "ok" : "partial",
        invoice_id: invoiceId,
        invoice_number: invoiceNumber.number,
        pdf_file_id: uploaded.id,
        email_status: emailStatus,
        ...(emailWarning ? { email_warning: emailWarning } : {}),
      });
    } catch (err) {
      // ── Domain errors → 422 ─────────────────────────────
      if (err instanceof ServiceNotFoundError) {
        await audit("service_not_found", { code: payload.service_code });
        return reply.code(422).send({
          error: "service_not_found",
          message: err.message,
        });
      }
      if (err instanceof ServiceInactiveError) {
        await audit("service_inactive", { code: payload.service_code });
        return reply.code(422).send({
          error: "service_inactive",
          message: err.message,
        });
      }
      if (err instanceof ViesValidationError) {
        await audit("vies_validation_failed", {
          message: err.message,
          vies: err.vies.raw,
        });
        return reply.code(422).send({
          error: "vies_validation_failed",
          message: err.message,
        });
      }

      // ── Unexpected: 500, Directus may retry (idempotency protects) ──
      log.error({ err }, "unexpected error during invoice processing");
      await audit("error", {
        error: err instanceof Error ? err.message : String(err),
      });
      return reply.code(500).send({
        error: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
};

/**
 * Constant-time HMAC verification. `timingSafeEqual` requires equal-
 * length buffers, so we length-check first to avoid throwing on
 * mismatched-length attacker input.
 */
function verifyHmac(
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
