/**
 * test/vat.test.ts — money logic for computeVat (VAT-inclusive pricing).
 *
 * The catalog price is the flat, VAT-INCLUSIVE amount every buyer pays.
 * These tests lock in that (a) gross always equals the input price,
 * (b) net + vat always reconciles to gross with no drift, and (c) each
 * buyer situation resolves to the correct regime / rate / annotation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeVat, isEuCountry, ViesValidationError } from "../src/lib/vat.js";
import type { ViesResult } from "../src/types.js";

const viesValid: ViesResult = { checked: true, valid: true, raw: {} };
const viesInvalid: ViesResult = { checked: true, valid: false, raw: {} };
const viesUnreachable: ViesResult = { checked: true, valid: null, raw: {} };

describe("computeVat — regimes", () => {
  it("PL buyer → pl_standard 23%, VAT extracted out of the price", () => {
    const r = computeVat({ price: 50, buyerCountry: "PL", vies: null });
    assert.equal(r.regime, "pl_standard");
    assert.equal(r.rate, 23);
    assert.equal(r.net, 40.65);
    assert.equal(r.vat, 9.35);
    assert.equal(r.gross, 50);
    assert.equal(r.note, null);
  });

  it("PL buyer stays 23% even with a valid VIES id (domestic wins first)", () => {
    const r = computeVat({ price: 50, buyerCountry: "PL", vies: viesValid });
    assert.equal(r.regime, "pl_standard");
    assert.equal(r.rate, 23);
  });

  it("EU non-PL + valid VAT-EU → eu_reverse 0%, net = gross, reverse-charge note", () => {
    const r = computeVat({ price: 50, buyerCountry: "FR", vies: viesValid });
    assert.equal(r.regime, "eu_reverse");
    assert.equal(r.rate, 0);
    assert.equal(r.net, 50);
    assert.equal(r.vat, 0);
    assert.equal(r.gross, 50);
    assert.match(r.note ?? "", /reverse charge/i);
    assert.match(r.note ?? "", /196/);
  });

  it("EU non-PL WITHOUT a VAT-EU number → treated as consumer, pl_standard 23%", () => {
    const r = computeVat({ price: 50, buyerCountry: "FR", vies: null });
    assert.equal(r.regime, "pl_standard");
    assert.equal(r.rate, 23);
    assert.equal(r.net, 40.65);
    assert.equal(r.vat, 9.35);
    assert.equal(r.gross, 50);
  });

  it("outside EU → export_zero 0%, net = gross, export note", () => {
    const r = computeVat({ price: 50, buyerCountry: "US", vies: null });
    assert.equal(r.regime, "export_zero");
    assert.equal(r.rate, 0);
    assert.equal(r.net, 50);
    assert.equal(r.vat, 0);
    assert.equal(r.gross, 50);
    assert.match(r.note ?? "", /export/i);
  });
});

describe("computeVat — VIES hard-fail policy", () => {
  it("EU non-PL + VIES rejected → throws ViesValidationError (never silently 23%)", () => {
    assert.throws(
      () => computeVat({ price: 50, buyerCountry: "FR", vies: viesInvalid }),
      ViesValidationError,
    );
  });

  it("EU non-PL + VIES unreachable → throws ViesValidationError", () => {
    assert.throws(
      () => computeVat({ price: 50, buyerCountry: "FR", vies: viesUnreachable }),
      ViesValidationError,
    );
  });
});

describe("computeVat — reconciliation invariant (net + vat === gross)", () => {
  const prices = [0, 0.01, 1.23, 2.46, 9.99, 49.99, 50, 100, 123.45, 999.99];
  for (const price of prices) {
    it(`price ${price}: gross === price and net + vat === gross`, () => {
      for (const buyerCountry of ["PL", "FR", "US"]) {
        const vies = buyerCountry === "FR" ? viesValid : null;
        const r = computeVat({ price, buyerCountry, vies });
        assert.equal(r.gross, round2(price), `gross for ${buyerCountry}`);
        assert.equal(
          round2(r.net + r.vat),
          r.gross,
          `net+vat must equal gross for ${buyerCountry} @ ${price}`,
        );
        assert.ok(r.vat >= 0, "vat is non-negative");
      }
    });
  }
});

describe("computeVat — input validation", () => {
  it("rejects a non-2-letter country code", () => {
    assert.throws(() => computeVat({ price: 50, buyerCountry: "FRA", vies: null }));
    assert.throws(() => computeVat({ price: 50, buyerCountry: "fr", vies: null }));
  });

  it("rejects a negative or non-finite price", () => {
    assert.throws(() => computeVat({ price: -1, buyerCountry: "PL", vies: null }));
    assert.throws(() => computeVat({ price: NaN, buyerCountry: "PL", vies: null }));
    assert.throws(() =>
      computeVat({ price: Infinity, buyerCountry: "PL", vies: null }),
    );
  });
});

describe("isEuCountry", () => {
  it("recognises EU members and rejects non-members", () => {
    assert.equal(isEuCountry("FR"), true);
    assert.equal(isEuCountry("PL"), true);
    assert.equal(isEuCountry("DE"), true);
    assert.equal(isEuCountry("GB"), false); // Brexit
    assert.equal(isEuCountry("US"), false);
    assert.equal(isEuCountry("CH"), false);
  });
});

/** Local mirror of vat.ts rounding, for the expected-gross assertion. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
