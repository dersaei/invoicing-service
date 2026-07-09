/**
 * src/lib/vat.ts — VAT regime resolution and amount calculation.
 *
 * Pure logic. Given (price, buyer country, VIES result) returns the
 * VAT regime to apply, the rate, the calculated amounts, and the legal
 * note that must appear on the invoice.
 *
 * PRICING MODEL — VAT-INCLUSIVE (gross-target). The `price` passed in
 * is the final amount the customer pays, identical for every buyer
 * (a flat sticker price). VAT is extracted *out of* that price for
 * standard-rate buyers, not added on top:
 *   - standard rate 23% → net = price / 1.23, vat = price − net
 *   - 0% regimes        → net = gross = price, vat = 0
 * So a reverse-charge buyer and a domestic buyer both pay `price`;
 * only the split between net and VAT differs.
 *
 * VAT regimes (per README):
 *   ┌───────────────────────────┬────────┬──────────────────────────┐
 *   │ Buyer location            │ VAT-EU │ Treatment                │
 *   ├───────────────────────────┼────────┼──────────────────────────┤
 *   │ PL                        │ any    │ pl_standard, 23%         │
 *   │ EU non-PL                 │ valid  │ eu_reverse, 0% + note    │
 *   │ EU non-PL                 │ none   │ pl_standard, 23%         │
 *   │ outside EU                │ any    │ export_zero, 0% + note   │
 *   └───────────────────────────┴────────┴──────────────────────────┘
 *
 * Hard-fail policy from README: if the buyer provided a VAT-EU number
 * but VIES rejected it OR VIES was unreachable, we throw rather than
 * silently fall back to 23%. The webhook route maps this to HTTP 422
 * so a human can intervene. Charging 23% to someone who legitimately
 * has a VAT-EU number would be wrong; charging 0% to someone whose
 * number we can't confirm would also be wrong.
 *
 * Adnotacje (notes) are returned in English here as a stable default.
 * Localised wording is the template/i18n module's responsibility; the
 * webhook will overwrite `note` with the translated version before
 * persisting it in `invoices.vat_note`.
 */

import type { VatComputation, VatRegime, ViesResult } from "../types.js";

/** Polish VAT seller country — hard-coded; this service is for a PL JDG. */
const SELLER_COUNTRY = "PL";

/**
 * EU member states by ISO 3166-1 alpha-2, as of 2026. UK is NOT here
 * (Brexit). Note: VIES uses 'EL' for Greece while ISO uses 'GR' —
 * that translation happens in vies.ts, not here.
 */
const EU_COUNTRIES: ReadonlySet<string> = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
]);

/** Thrown when VAT-EU was provided but cannot be confirmed via VIES. */
export class ViesValidationError extends Error {
  public readonly vies: ViesResult;
  constructor(message: string, vies: ViesResult) {
    super(message);
    this.name = "ViesValidationError";
    this.vies = vies;
  }
}

export interface ComputeVatOpts {
  /**
   * Final price in EUR the customer pays — VAT-INCLUSIVE (gross target).
   * The same flat value for every buyer; for standard-rate buyers the
   * net and VAT are derived by extracting VAT out of this amount.
   * Must be a non-negative finite number.
   */
  price: number;
  /** Buyer's ISO 3166-1 alpha-2 country code, uppercase. */
  buyerCountry: string;
  /**
   * Result of the VIES check, or `null` if the buyer did not provide
   * a VAT-EU number at all (private consumer, or B2B without ID).
   *
   * Semantics:
   *   null              → no VAT-EU number was provided
   *   {valid: true}     → confirmed valid → eligible for reverse charge
   *   {valid: false}    → confirmed invalid → throw ViesValidationError
   *   {valid: null}     → VIES unreachable → throw ViesValidationError
   */
  vies: ViesResult | null;
}

/**
 * Resolve the VAT regime and compute amounts.
 *
 * Throws `ViesValidationError` if the buyer is in the EU (non-PL),
 * provided a VAT-EU number, and VIES did not confirm it valid.
 */
export function computeVat(opts: ComputeVatOpts): VatComputation {
  const { price, buyerCountry, vies } = opts;

  if (!/^[A-Z]{2}$/.test(buyerCountry)) {
    throw new Error(
      `buyerCountry must be 2 uppercase ISO letters, got: ${JSON.stringify(buyerCountry)}`,
    );
  }
  if (!Number.isFinite(price) || price < 0) {
    throw new Error(`price must be a non-negative finite number, got: ${price}`);
  }

  // ── Branch 1: domestic PL → always 23%, no annotation ────
  if (buyerCountry === SELLER_COUNTRY) {
    return buildResult({ regime: "pl_standard", rate: 23, price, note: null });
  }

  const isEu = EU_COUNTRIES.has(buyerCountry);

  // ── Branch 2: EU non-PL with a VAT-EU number ─────────────
  if (isEu && vies !== null) {
    if (vies.checked && vies.valid === true) {
      return buildResult({
        regime: "eu_reverse",
        rate: 0,
        price,
        note:
          "Reverse charge — VAT to be accounted for by the recipient " +
          "(Article 196, Council Directive 2006/112/EC).",
      });
    }
    // Hard fail: VIES said invalid, or VIES was unreachable.
    throw new ViesValidationError(
      vies.valid === false
        ? "Buyer's VAT-EU number was rejected by VIES."
        : "VIES service unreachable; cannot apply reverse charge.",
      vies,
    );
  }

  // ── Branch 3: EU non-PL without VAT-EU number → consumer ─
  // Per README: French companies without TVA intracommunautaire are
  // treated as consumers at 23% PL VAT. Same logic for any EU country.
  if (isEu) {
    return buildResult({ regime: "pl_standard", rate: 23, price, note: null });
  }

  // ── Branch 4: outside EU → export, 0% with annotation ────
  return buildResult({
    regime: "export_zero",
    rate: 0,
    price,
    note: "Export of services outside the European Union — VAT 0%.",
  });
}

/** True iff the given ISO 3166-1 alpha-2 code is an EU member state. */
export function isEuCountry(iso2: string): boolean {
  return EU_COUNTRIES.has(iso2);
}

// ── Internals ────────────────────────────────────────────────

function buildResult(p: {
  regime: VatRegime;
  rate: number;
  /** VAT-inclusive final price; net and VAT are extracted out of it. */
  price: number;
  note: string | null;
}): VatComputation {
  const gross = round2(p.price);
  // Extract VAT out of the gross price. For rate 0 this yields net === gross
  // and vat === 0. Computing vat as (gross − net) guarantees the three
  // figures always reconcile exactly (net + vat === gross), with no drift.
  const net = round2(gross / (1 + p.rate / 100));
  const vat = round2(gross - net);
  return { regime: p.regime, rate: p.rate, net, vat, gross, note: p.note };
}

/**
 * Round to 2 decimals using half-away-from-zero (the Polish VAT
 * convention). The `+ Number.EPSILON` corrects for the rare cases
 * where floating-point representation would otherwise round down a
 * value like 1.005 (which is internally 1.00499...).
 *
 * Inputs in this service are amounts up to about 12 digits — well
 * within IEEE 754 double precision, so a dedicated decimal library
 * would be overkill.
 */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
