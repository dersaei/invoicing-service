/**
 * src/templates/invoice.html.ts — pro-forma invoice HTML renderer.
 *
 * Pure stringbuilder. No I/O, no async, no Playwright — just takes a
 * RenderData object and returns a complete, self-contained HTML
 * document ready for `page.setContent(...)` in the PDF generator.
 *
 * Localisation: all visible strings come from i18n.ts; amounts and
 * dates are formatted via `formatCurrency` / `formatDate` so each
 * locale gets its own decimal separator, currency position, etc.
 *
 * Safety: every user-supplied value is HTML-escaped via `esc()`.
 * The only un-escaped substitutions are values from our own modules
 * (i18n strings, formatted numbers/dates — all known-safe).
 *
 * Layout: single-column A4. Header (brand + invoice meta), two-up
 * parties block (seller / buyer), single-row items table, totals
 * box, VAT note (when applicable), payment details, footer.
 */

import { config } from "../config.js";
import {
  formatCurrency,
  formatDate,
  formatDateTime,
  getT,
} from "../lib/i18n.js";
import type { Brand, Buyer, Language, VatComputation } from "../types.js";

export interface InvoiceItem {
  /** Pre-localised name (e.g. svc.name_fr resolved at orchestration time). */
  name: string;
  /** Optional longer description, rendered below the name in small print. */
  description: string | null;
  /** Typically 1 for our service-line products, but we render the column. */
  quantity: number;
  /** Net unit price in EUR. */
  unitPriceNet: number;
}

export interface InvoiceRenderData {
  /** Printed number, e.g. "FR001VG/2026". */
  number: string;
  brand: Brand;
  language: Language;
  issueDate: Date;
  dueDate: Date;
  buyer: Buyer;
  items: InvoiceItem[];
  /** Result from lib/vat.ts. `note` is already localised by caller. */
  vat: VatComputation;
  /** Payment term in days, used for the email and as a derived display. */
  paymentTermDays: number;
}

/**
 * Render a complete HTML document for the given invoice data.
 */
export function renderInvoiceHtml(data: InvoiceRenderData): string {
  const t = getT(data.language);
  const lang = data.language;
  const seller = config.seller;

  const itemsHtml = data.items
    .map((item, i) => {
      const lineNet = item.quantity * item.unitPriceNet;
      const descLine = item.description
        ? `<br><small class="desc">${esc(item.description)}</small>`
        : "";
      return `
        <tr>
          <td class="num">${i + 1}</td>
          <td>${esc(item.name)}${descLine}</td>
          <td class="num">${item.quantity}</td>
          <td class="num">${esc(formatCurrency(item.unitPriceNet, lang))}</td>
          <td class="num">${data.vat.rate}%</td>
          <td class="num">${esc(formatCurrency(lineNet, lang))}</td>
        </tr>`;
    })
    .join("");

  const vatIdRow = data.buyer.vat_id
    ? `<div class="id-line">${esc(t("parties.vat_eu"))}: ${esc(data.buyer.vat_id)}</div>`
    : "";

  const vatNoteBlock = data.vat.note
    ? `<section class="vat-note">${esc(data.vat.note)}</section>`
    : "";

  return `<!DOCTYPE html>
<html lang="${esc(lang)}">
<head>
<meta charset="UTF-8">
<title>${esc(t("invoice.title_proforma"))} ${esc(data.number)}</title>
<style>${CSS}</style>
</head>
<body>

<header class="header">
  <div class="brand">Spiżarnia Regio</div>
  <div class="invoice-meta">
    <div class="title">${esc(t("invoice.title_proforma"))}</div>
    <div class="number">${esc(data.number)}</div>
    <dl>
      <dt>${esc(t("invoice.issue_date"))}</dt>
      <dd>${esc(formatDate(data.issueDate, lang))}</dd>
      <dt>${esc(t("invoice.due_date"))}</dt>
      <dd>${esc(formatDate(data.dueDate, lang))}</dd>
    </dl>
  </div>
</header>

<section class="parties">
  <div class="party">
    <h2>${esc(t("parties.seller"))}</h2>
    <div class="name">${esc(seller.legal_name)}</div>
    <div class="addr">
      ${esc(seller.address.street)}<br>
      ${esc(seller.address.postal_code)} ${esc(seller.address.city)}<br>
      ${esc(seller.address.country)}
    </div>
    <div class="ids">
      <div class="id-line">${esc(t("parties.nip"))}: ${esc(seller.nip)}</div>
      <div class="id-line">${esc(t("parties.regon"))}: ${esc(seller.regon)}</div>
    </div>
  </div>
  <div class="party">
    <h2>${esc(t("parties.buyer"))}</h2>
    <div class="name">${esc(data.buyer.name)}</div>
    <div class="addr">
      ${esc(data.buyer.address.street)}<br>
      ${esc(data.buyer.address.postal_code)} ${esc(data.buyer.address.city)}<br>
      ${esc(data.buyer.address.country)}
    </div>
    <div class="ids">${vatIdRow}</div>
  </div>
</section>

<table class="items">
  <thead>
    <tr>
      <th class="num" style="width:5%">${esc(t("items.no"))}</th>
      <th>${esc(t("items.name"))}</th>
      <th class="num" style="width:8%">${esc(t("items.qty"))}</th>
      <th class="num" style="width:16%">${esc(t("items.unit_price_net"))}</th>
      <th class="num" style="width:10%">${esc(t("items.vat_rate"))}</th>
      <th class="num" style="width:16%">${esc(t("items.amount_net"))}</th>
    </tr>
  </thead>
  <tbody>${itemsHtml}</tbody>
</table>

<div class="summary">
  <table>
    <tr>
      <td class="label">${esc(t("totals.total_net"))}</td>
      <td class="value">${esc(formatCurrency(data.vat.net, lang))}</td>
    </tr>
    <tr>
      <td class="label">${esc(t("totals.total_vat"))} (${data.vat.rate}%)</td>
      <td class="value">${esc(formatCurrency(data.vat.vat, lang))}</td>
    </tr>
    <tr class="total">
      <td class="label">${esc(t("totals.total_gross"))}</td>
      <td class="value">${esc(formatCurrency(data.vat.gross, lang))}</td>
    </tr>
  </table>
</div>

${vatNoteBlock}

<section class="payment">
  <h2>${esc(t("payment.title"))}</h2>
  <dl>
    <dt>${esc(t("payment.bank"))}</dt><dd>${esc(seller.bank.name)}</dd>
    <dt>${esc(t("payment.iban"))}</dt><dd>${esc(seller.bank.iban_eur)}</dd>
    <dt>${esc(t("payment.bic"))}</dt><dd>${esc(seller.bank.bic)}</dd>
    <dt>${esc(t("invoice.due_date"))}</dt>
    <dd>${esc(formatDate(data.dueDate, lang))} — ${esc(t("payment.term_days", { days: data.paymentTermDays }))}</dd>
  </dl>
</section>

<footer class="page-footer">
  <span>${esc(data.number)}</span>
  <span>${esc(t("footer.generated_at", { datetime: formatDateTime(new Date(), lang) }))}</span>
</footer>

</body>
</html>`;
}

// ── HTML escaping ────────────────────────────────────────────

function esc(s: string | number | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── CSS ──────────────────────────────────────────────────────
// All styles inline to keep the HTML self-contained — Playwright's
// page.setContent doesn't follow @import or external links by default.
// Fonts fall back to system stacks; when assets/fonts/ is populated
// we'll add @font-face rules referencing file:// URLs.
const CSS = `
  @page { size: A4; margin: 18mm 16mm 22mm 16mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    font-size: 10pt;
    color: #1a1a1a;
    line-height: 1.5;
  }
  .serif {
    font-family: 'Cormorant Garamond', Georgia, 'Times New Roman', serif;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding-bottom: 18px;
    border-bottom: 2px solid #1a1a1a;
    margin-bottom: 24px;
  }
  .header .brand {
    font-family: 'Cormorant Garamond', Georgia, serif;
    font-size: 22pt;
    font-weight: 600;
    letter-spacing: 0.5px;
    line-height: 1.1;
  }
  .invoice-meta { text-align: right; }
  .invoice-meta .title {
    font-family: 'Cormorant Garamond', Georgia, serif;
    font-size: 15pt;
    font-weight: 500;
    color: #444;
  }
  .invoice-meta .number {
    font-size: 13pt;
    font-weight: 600;
    margin-bottom: 8px;
  }
  .invoice-meta dl {
    margin: 6px 0 0;
    display: grid;
    grid-template-columns: auto auto;
    gap: 2px 12px;
    font-size: 9pt;
    text-align: left;
    justify-content: end;
  }
  .invoice-meta dt { color: #666; font-weight: 500; }
  .invoice-meta dd { margin: 0; }

  .parties {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
    margin-bottom: 26px;
  }
  .party h2 {
    font-family: 'Cormorant Garamond', Georgia, serif;
    font-size: 10pt;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    color: #666;
    margin: 0 0 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid #d8d8d8;
  }
  .party .name { font-weight: 600; font-size: 11pt; margin-bottom: 4px; }
  .party .addr { color: #333; line-height: 1.5; }
  .party .ids { margin-top: 6px; font-size: 9pt; color: #555; }
  .party .id-line { margin-top: 2px; }

  table.items {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 18px;
  }
  table.items thead {
    background: #f5f5f5;
    border-top: 2px solid #1a1a1a;
    border-bottom: 1px solid #1a1a1a;
  }
  table.items th {
    text-align: left;
    font-weight: 500;
    font-size: 9pt;
    padding: 9px 6px;
    color: #333;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  table.items th.num,
  table.items td.num { text-align: right; }
  table.items tbody td {
    padding: 11px 6px;
    border-bottom: 1px solid #eee;
    vertical-align: top;
  }
  table.items td .desc {
    color: #777;
    font-size: 9pt;
  }

  .summary {
    margin-left: auto;
    width: 50%;
    max-width: 290px;
    margin-bottom: 24px;
  }
  .summary table { width: 100%; border-collapse: collapse; }
  .summary td { padding: 5px 6px; }
  .summary td.label { color: #555; }
  .summary td.value { text-align: right; font-variant-numeric: tabular-nums; }
  .summary tr.total {
    font-weight: 600;
    font-size: 12pt;
    border-top: 2px solid #1a1a1a;
  }
  .summary tr.total td { padding-top: 10px; padding-bottom: 4px; }

  .vat-note {
    background: #fafafa;
    border-left: 3px solid #888;
    padding: 12px 14px;
    font-size: 9.5pt;
    color: #333;
    margin: 16px 0 24px;
  }

  .payment {
    border-top: 1px solid #ddd;
    padding-top: 16px;
    margin-bottom: 24px;
  }
  .payment h2 {
    font-family: 'Cormorant Garamond', Georgia, serif;
    font-size: 10pt;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    color: #666;
    margin: 0 0 10px;
  }
  .payment dl {
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: 4px 12px;
    font-size: 9.5pt;
    margin: 0;
  }
  .payment dt { color: #666; }
  .payment dd { margin: 0; }

  .page-footer {
    margin-top: 30px;
    padding-top: 8px;
    border-top: 1px solid #e0e0e0;
    font-size: 8pt;
    color: #999;
    display: flex;
    justify-content: space-between;
  }
`;
