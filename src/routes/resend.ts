/**
 * src/routes/resend.ts — POST /invoice/resend.
 *
 * Re-sends the email for an already-issued invoice. This exists for the
 * "partial" case: the invoice was issued and its PDF stored, but the
 * SMTP send failed (or the buyer lost the email). Rather than
 * regenerating anything, we re-attach the exact PDF that was originally
 * uploaded to Directus Files and send it again.
 *
 * Identify the invoice by `invoice_number` OR `invoice_id` in the body
 * (not the path — the printed number contains a "/"). Auth is the same
 * HMAC-SHA256 scheme as the webhook, so a Directus Flow can trigger it
 * with the signing code it already has.
 *
 * HTTP semantics:
 *   200 sent               — email dispatched
 *   400                    — payload failed validation
 *   401                    — missing / invalid HMAC signature
 *   404 invoice_not_found  — no invoice matches
 *   422 pdf_unavailable    — invoice has no stored PDF to attach
 *   502 resend_failed      — download or SMTP send failed (retryable)
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { sql } from "../db.js";
import { PAYMENT_TERM_DAYS } from "../lib/billing.js";
import { downloadInvoicePdf } from "../lib/directus.js";
import { formatErrorMessage } from "../lib/errors.js";
import {
  SIGNATURE_HEADER,
  verifyHmac,
  type RequestWithRaw,
} from "../lib/hmac.js";
import { sendInvoiceEmail } from "../lib/mail.js";
import { renderInvoiceEmail } from "../templates/email.html.js";
import { LanguageEnum } from "../types.js";

const ResendPayloadSchema = z
  .object({
    invoice_number: z.string().trim().min(1).optional(),
    invoice_id: z.string().trim().uuid().optional(),
  })
  .refine((d) => Boolean(d.invoice_number || d.invoice_id), {
    message: "one of invoice_number or invoice_id is required",
  });

interface InvoiceRow {
  id: string;
  invoice_number: string;
  buyer_email: string;
  language: string;
  pdf_file_id: string | null;
  submission_id: string;
}

export const resendRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post("/invoice/resend", async (request, reply) => {
    const req = request as RequestWithRaw;

    // ── 1. HMAC verification ────────────────────────────────
    const signature = req.headers[SIGNATURE_HEADER];
    if (typeof signature !== "string" || signature.length === 0) {
      return reply.code(401).send({ error: "missing X-Invoicing-Signature" });
    }
    if (!verifyHmac(req.rawBody, signature, config.webhookSecret)) {
      fastify.log.warn(
        { sig_prefix: signature.slice(0, 8) },
        "HMAC verification failed (resend)",
      );
      return reply.code(401).send({ error: "invalid signature" });
    }

    // ── 2. Validate payload ─────────────────────────────────
    const parsed = ResendPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid payload",
        issues: parsed.error.issues,
      });
    }
    const { invoice_number, invoice_id } = parsed.data;

    // ── 3. Look up the invoice ──────────────────────────────
    const rows = await sql<InvoiceRow[]>`
      SELECT id, invoice_number, buyer_email, language, pdf_file_id, submission_id
      FROM invoices
      WHERE ${
        invoice_id
          ? sql`id = ${invoice_id}`
          : sql`invoice_number = ${invoice_number!}`
      }
      LIMIT 1
    `;
    if (rows.length === 0) {
      return reply.code(404).send({ error: "invoice_not_found" });
    }
    const inv = rows[0]!;
    const log = fastify.log.child({ invoice_number: inv.invoice_number });

    if (!inv.pdf_file_id) {
      return reply.code(422).send({
        error: "pdf_unavailable",
        message: "Invoice has no stored PDF; cannot resend.",
      });
    }

    const audit = async (
      event: string,
      detail: Record<string, unknown> | null,
    ): Promise<void> => {
      await sql`
        INSERT INTO audit_log (submission_id, invoice_id, event, detail)
        VALUES (
          ${inv.submission_id}, ${inv.id}, ${event},
          ${detail === null ? null : sql.json(detail as never)}
        )
      `;
    };

    try {
      // ── 4. Download the original PDF from Directus Files ──
      const pdfBuffer = await downloadInvoicePdf(inv.pdf_file_id);
      const pdfFilename = inv.invoice_number.replace(/\//g, "_") + ".pdf";

      // ── 5. Render the email in the invoice's language ─────
      const language = LanguageEnum.parse(inv.language.trim());
      const rendered = renderInvoiceEmail({
        language,
        invoiceNumber: inv.invoice_number,
        paymentTermDays: PAYMENT_TERM_DAYS,
      });

      // ── 6. Send ───────────────────────────────────────────
      const result = await sendInvoiceEmail({
        to: inv.buyer_email,
        invoiceNumber: inv.invoice_number,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        pdfBuffer,
        pdfFilename,
      });

      await sql`UPDATE invoices SET status = 'sent' WHERE id = ${inv.id}`;
      await audit("email_resent", {
        message_id: result.messageId,
        accepted: result.accepted,
      });
      log.info(
        { message_id: result.messageId, accepted: result.accepted },
        "invoice email resent",
      );

      return reply.code(200).send({
        status: "sent",
        invoice_id: inv.id,
        invoice_number: inv.invoice_number,
        accepted: result.accepted,
      });
    } catch (err) {
      const message = formatErrorMessage(err);
      log.error({ err }, "resend failed");
      await audit("email_resend_failed", { error: message });
      return reply.code(502).send({ error: "resend_failed", message });
    }
  });
};
