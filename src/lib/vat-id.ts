/**
 * src/lib/vat-id.ts — pure VAT-EU identifier parsing.
 *
 * Extracted from vies.ts so it can be unit-tested without pulling in the
 * DB pool / config (which validate env at import time). No I/O here —
 * just string normalisation and the Greece GR→EL quirk.
 */

export interface ParsedVatId {
  /** Country code in VIES form (EL for Greece). */
  countryCode: string;
  /** Alphanumeric part after the 2-letter prefix. */
  vatNumber: string;
}

/**
 * Parse a raw VAT-EU identifier (e.g. "FR 123 456 78901", "fr-12345")
 * into VIES-compatible parts. Strips spaces and dashes, uppercases,
 * splits the 2-letter prefix from the rest, maps GR → EL for Greece.
 *
 * Throws if the input doesn't match the expected shape.
 */
export function parseVatId(raw: string): ParsedVatId {
  const cleaned = raw.toUpperCase().replace(/[\s\-]/g, "");
  const m = /^([A-Z]{2})([A-Z0-9]+)$/.exec(cleaned);
  if (!m) {
    throw new Error(`malformed VAT-EU identifier: ${JSON.stringify(raw)}`);
  }
  const iso = m[1]!;
  const viesCountry = iso === "GR" ? "EL" : iso;
  return { countryCode: viesCountry, vatNumber: m[2]! };
}
