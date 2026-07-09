/**
 * test/vat-id.test.ts — parseVatId (pure parsing; no network / DB touched).
 *
 * parseVatId lives in the dependency-free vat-id.js module, so this test
 * runs without booting config/DB. It carries the tricky normalisation
 * logic (whitespace/dashes, uppercasing, the GR→EL quirk) worth pinning.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseVatId } from "../src/lib/vat-id.js";

describe("parseVatId", () => {
  it("splits the 2-letter prefix from the number", () => {
    assert.deepEqual(parseVatId("FR12345678901"), {
      countryCode: "FR",
      vatNumber: "12345678901",
    });
  });

  it("strips spaces and dashes and uppercases", () => {
    assert.deepEqual(parseVatId("fr 123 456 78901"), {
      countryCode: "FR",
      vatNumber: "12345678901",
    });
    assert.deepEqual(parseVatId("de-123456789"), {
      countryCode: "DE",
      vatNumber: "123456789",
    });
  });

  it("maps Greece ISO 'GR' to the VIES prefix 'EL'", () => {
    assert.equal(parseVatId("GR123456789").countryCode, "EL");
    assert.equal(parseVatId("EL123456789").countryCode, "EL");
  });

  it("keeps alphanumeric VAT numbers (some countries use letters)", () => {
    assert.deepEqual(parseVatId("IE1234567AW"), {
      countryCode: "IE",
      vatNumber: "1234567AW",
    });
  });

  it("throws on malformed identifiers", () => {
    assert.throws(() => parseVatId("123456789")); // no country prefix
    assert.throws(() => parseVatId("F123")); // single-letter prefix
    assert.throws(() => parseVatId("FR")); // prefix only, no number
    assert.throws(() => parseVatId("")); // empty
  });
});
