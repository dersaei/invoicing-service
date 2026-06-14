/**
 * src/lib/numbering.ts — atomic invoice numbering.
 *
 * Format: <COUNTRY><NNN><BRAND>/<YEAR>
 *   e.g. 'FR001VG/2026', 'IT042PV/2026', 'PL007SR/2026'
 *
 * Counter is keyed on (brand, doc_type, year). The buyer's country is
 * only a display prefix on the printed number — it does NOT split the
 * sequence. So a French VG invoice and an Italian VG invoice share the
 * same VG/proforma/2026 counter and will be 001 and 002 respectively.
 *
 * Atomicity comes from `INSERT ... ON CONFLICT DO UPDATE RETURNING` on
 * the `counters` table. Postgres serialises concurrent writes to the
 * same row, so even 100 parallel requests will receive 100 distinct
 * sequence numbers with no gaps and no duplicates.
 *
 * Year boundary: we use Europe/Warsaw, not UTC. The seller is a Polish
 * sole proprietorship; tax year boundaries follow local time, not
 * server time (the VPS runs UTC). Without this, an invoice issued at
 * 00:30 CET on 1 January would be filed under the previous year.
 */

import { sql } from "../db.js";
import type { Brand } from "../types.js";

// Mirrors the doc_type_t ENUM in 001_initial.sql. Only one value for
// now; this type can be widened (e.g. 'invoice', 'corrective') once
// other document types are introduced — together with the matching
// `ALTER TYPE doc_type_t ADD VALUE ...` migration.
export type DocType = "proforma";

export interface NextNumberOpts {
  brand: Brand;
  /** ISO 3166-1 alpha-2, uppercase. The buyer's country, shown as prefix. */
  country: string;
  /** Defaults to 'proforma'. */
  docType?: DocType;
  /** Defaults to the current year in Europe/Warsaw. Override only in tests. */
  year?: number;
}

export interface InvoiceNumber {
  /** The printed number, e.g. 'FR001VG/2026'. */
  number: string;
  /** The numeric sequence within (brand, docType, year). Starts at 1. */
  sequence: number;
  year: number;
  brand: Brand;
  country: string;
  docType: DocType;
}

/**
 * Allocate the next invoice number atomically. Increments the counter
 * row for (brand, docType, year) and returns the formatted string.
 *
 * Throws if `country` is not exactly two uppercase letters.
 */
export async function nextInvoiceNumber(
  opts: NextNumberOpts,
): Promise<InvoiceNumber> {
  const { brand, country } = opts;
  const docType: DocType = opts.docType ?? "proforma";
  const year = opts.year ?? currentYearWarsaw();

  if (!/^[A-Z]{2}$/.test(country)) {
    throw new Error(
      `country must be 2 uppercase ISO letters, got: ${JSON.stringify(country)}`,
    );
  }

  const rows = await sql<{ last_value: number }[]>`
    INSERT INTO counters (brand, doc_type, year, last_value)
    VALUES (${brand}, ${docType}, ${year}, 1)
    ON CONFLICT (brand, doc_type, year)
    DO UPDATE SET last_value = counters.last_value + 1, updated_at = now()
    RETURNING last_value
  `;

  const sequence = rows[0]!.last_value;
  const number = formatInvoiceNumber({ country, sequence, brand, year });

  return { number, sequence, year, brand, country, docType };
}

/**
 * Pure formatting helper: builds the printed number from parts.
 * Exported so the same logic can be reused (e.g. in tests, reporting).
 *
 * The sequence is zero-padded to 3 digits. If sequence exceeds 999 the
 * number widens naturally (e.g. '1234'); we don't truncate or wrap.
 */
export function formatInvoiceNumber(parts: {
  country: string;
  sequence: number;
  brand: Brand;
  year: number;
}): string {
  const padded = String(parts.sequence).padStart(3, "0");
  return `${parts.country}${padded}${parts.brand}/${parts.year}`;
}

/**
 * Current year in Europe/Warsaw, regardless of server timezone.
 * Uses Intl rather than a date library — Node has full ICU built-in
 * since v13, so no extra dependency is needed.
 */
function currentYearWarsaw(): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
  });
  return Number.parseInt(fmt.format(new Date()), 10);
}
