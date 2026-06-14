/**
 * src/templates/email.html.ts — invoice email template.
 *
 * Pure stringbuilder. Given the invoice's language, number, and payment
 * term, returns { subject, html, text } ready to hand to nodemailer.
 *
 * Why both html and text? Best practice for transactional mail:
 *   • some clients (cli mail readers, screen readers, spam filters)
 *     prefer plaintext;
 *   • a missing text/plain part triggers spam heuristics in many MTAs.
 * nodemailer wraps both into a multipart/alternative MIME envelope.
 *
 * The HTML is deliberately minimal — email clients have wildly
 * inconsistent CSS support, so we use inline styles only and avoid
 * anything fancy. The visual heavy-lifting is in the PDF attachment.
 */

import { getT } from "../lib/i18n.js";
import type { Language } from "../types.js";

export interface InvoiceEmailRenderData {
  language: Language;
  invoiceNumber: string;
  paymentTermDays: number;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderInvoiceEmail(
  data: InvoiceEmailRenderData,
): RenderedEmail {
  const t = getT(data.language);

  const subject = t("email.subject_proforma", { number: data.invoiceNumber });
  const greeting = t("email.greeting");
  const body = t("email.body", {
    number: data.invoiceNumber,
    days: data.paymentTermDays,
  });
  const thanks = t("email.thanks");
  const signature = t("email.signature");

  const text = [greeting, "", body, "", thanks, signature].join("\n");

  // Inline styles only — Gmail strips <style> blocks, Outlook ignores
  // grid/flex, etc. Keep it boring; the PDF is where the design lives.
  const html = `<!DOCTYPE html>
<html lang="${esc(data.language)}">
<head>
<meta charset="UTF-8">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
             style="max-width:600px;background:#ffffff;border-radius:6px;padding:32px;
                    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                    font-size:14px;line-height:1.6;color:#1a1a1a;">
        <tr><td>
          <p style="margin:0 0 16px;">${esc(greeting)}</p>
          <p style="margin:0 0 16px;">${esc(body)}</p>
          <p style="margin:32px 0 0;">
            ${esc(thanks)}<br>
            <span style="color:#555;">${esc(signature)}</span>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html, text };
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
