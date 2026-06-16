/**
 * src/lib/mail.ts — Fastmail SMTP sender (nodemailer).
 *
 * One pooled SMTP transport per process, lazy-initialised. Reused across
 * webhooks so we don't pay the TLS handshake cost on every email.
 *
 * Why Fastmail? It's already the user's mail provider, supports SMTP
 * with app passwords (no OAuth dance), reliable EU delivery. Auth uses
 * an app-specific password from Fastmail settings (NOT the main login).
 *
 * Lifecycle mirrors db.ts and pdf.ts:
 *   first call  → open SMTP pool
 *   later calls → reuse pool
 *   SIGTERM     → server.ts calls closeMailer() → drain + close
 *
 * Errors propagate to the caller. The webhook route catches them,
 * marks the invoice row as 'failed', and logs — we don't want to retry
 * silently because that risks double-sending.
 */

import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config.js";

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (transporter === null) {
    transporter = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      // Port 465 = implicit TLS from the start. Port 587 would be
      // STARTTLS (secure: false + requireTLS: true). We default to 465.
      secure: config.mail.port === 465,
      auth: {
        user: config.mail.user,
        pass: config.mail.password,
      },
      // Connection pool: reuse TLS sockets across messages. Fastmail
      // is generous with concurrent connections but 3 is plenty for
      // this service's burst pattern.
      pool: true,
      maxConnections: 3,
      maxMessages: 100, // recycle each connection after 100 messages
    });
  }
  return transporter;
}

/**
 * Verify the SMTP connection + credentials without sending a message.
 * Called once at startup so a bad login (wrong user, expired app
 * password) surfaces immediately in the boot logs instead of silently
 * waiting until the first invoice fails to send.
 *
 * Returns true on success, false on failure — never throws. The caller
 * decides whether a failure is fatal; here we treat mail as a degradable
 * step (a failed send yields a 'partial' invoice, not a lost one), so we
 * only want to warn loudly, not block the whole service from starting.
 */
export async function verifyMailer(): Promise<boolean> {
  try {
    await getTransporter().verify();
    return true;
  } catch {
    return false;
  }
}

export interface SendInvoiceEmailOpts {
  /** Buyer's email address. */
  to: string;
  /** Localised subject from renderInvoiceEmail. */
  subject: string;
  /** HTML body. */
  html: string;
  /** Plaintext alternative (same content). */
  text: string;
  /** PDF bytes from generateInvoicePdf. */
  pdfBuffer: Uint8Array;
  /** Filename to show in the email client, e.g. "FR001VG_2026.pdf". */
  pdfFilename: string;
}

export interface SendInvoiceEmailResult {
  /** Server-assigned Message-Id header — useful for log correlation. */
  messageId: string;
  /** SMTP server response, mostly for debugging. */
  response: string;
  /** Recipients accepted by the SMTP server. */
  accepted: string[];
  /** Recipients rejected by the SMTP server (e.g. bad address). */
  rejected: string[];
}

/**
 * Send a proforma invoice email with the PDF attached. Throws on
 * transport-level failures (connection, auth, network) — never silently.
 *
 * Note that `accepted`/`rejected` come from the SMTP handshake and don't
 * mean the message was actually delivered to the inbox — only that the
 * SMTP server accepted/rejected the recipient. Bounces after that
 * point arrive asynchronously.
 */
export async function sendInvoiceEmail(
  opts: SendInvoiceEmailOpts,
): Promise<SendInvoiceEmailResult> {
  const t = getTransporter();
  const info = await t.sendMail({
    from: config.mail.from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    attachments: [
      {
        filename: opts.pdfFilename,
        content: Buffer.from(opts.pdfBuffer),
        contentType: "application/pdf",
      },
    ],
  });
  return {
    messageId: info.messageId,
    response: info.response,
    accepted: info.accepted.map(String),
    rejected: info.rejected.map(String),
  };
}

/**
 * Close the SMTP pool. Called from server.ts during graceful shutdown.
 * Idempotent — safe to call even if no transport was ever created.
 *
 * `transporter.close()` is sync and just closes any open sockets in
 * the pool. There's no draining to await — in-flight `sendMail()`
 * promises will resolve or reject on their own.
 */
export async function closeMailer(): Promise<void> {
  if (transporter === null) return;
  const current = transporter;
  transporter = null;
  current.close();
}
