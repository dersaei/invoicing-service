/**
 * src/lib/vies.ts — EU VIES VAT-EU validation client with DB cache.
 *
 * VIES (VAT Information Exchange System) is the EU's central registry
 * for confirming that a VAT-EU identifier is valid. We call it via its
 * public SOAP endpoint; results are cached in the `vies_cache` table
 * for 24 hours to avoid hitting the service (which is slow and flaky)
 * on every webhook.
 *
 * Greece quirk: ISO 3166-1 alpha-2 calls Greece 'GR', but VIES uses
 * 'EL' as the prefix on Greek VAT-EU numbers. `parseVatId` returns
 * the VIES-side code, and the same code is used as the cache key.
 *
 * Result semantics align with `lib/vat.ts`:
 *   {checked: true, valid: true,  raw} → VIES confirmed valid
 *   {checked: true, valid: false, raw} → VIES confirmed invalid
 *   {checked: true, valid: null,  raw} → could not reach VIES
 *
 * `valid === null` causes lib/vat.ts to throw, which the webhook
 * route maps to HTTP 422 (per README): we never silently degrade.
 */

import { sql } from "../db.js";
import { config } from "../config.js";
import type { ViesResult } from "../types.js";

const VIES_NS = "urn:ec.europa.eu:taxud:vies:services:checkVat:types";
const CACHE_TTL = "24 hours";

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

/**
 * Verify a VAT-EU number against VIES, caching definitive results.
 *
 * On cache hit (entry younger than 24h) returns the cached result
 * without touching the network. On miss, calls VIES, persists the
 * result if it's definitive (valid is true or false), and returns it.
 * Transient failures are NOT cached — they remain retryable.
 */
export async function checkVies(vatIdRaw: string): Promise<ViesResult> {
  const { countryCode, vatNumber } = parseVatId(vatIdRaw);

  // ── Cache hit? ────────────────────────────────────────────
  const cached = await sql<{ valid: boolean; raw: unknown }[]>`
    SELECT valid, raw
    FROM vies_cache
    WHERE country_code = ${countryCode}
      AND vat_number = ${vatNumber}
      AND checked_at > now() - interval '${sql.unsafe(CACHE_TTL)}'
    LIMIT 1
  `;
  if (cached.length > 0) {
    return { checked: true, valid: cached[0]!.valid, raw: cached[0]!.raw };
  }

  // ── Cache miss → live call ────────────────────────────────
  const live = await callViesSoap(countryCode, vatNumber);

  // Only persist definitive answers. Network errors stay retryable.
  if (live.valid !== null) {
    await sql`
      INSERT INTO vies_cache (country_code, vat_number, valid, raw)
      VALUES (${countryCode}, ${vatNumber}, ${live.valid}, ${sql.json(live.raw as never)})
      ON CONFLICT (country_code, vat_number)
      DO UPDATE SET valid = EXCLUDED.valid, raw = EXCLUDED.raw, checked_at = now()
    `;
  }

  return live;
}

// ── Network layer ────────────────────────────────────────────

async function callViesSoap(
  countryCode: string,
  vatNumber: string,
): Promise<ViesResult> {
  const body = buildSoapEnvelope(countryCode, vatNumber);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.vies.timeoutMs);

  try {
    const res = await fetch(config.vies.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: "",
        Accept: "text/xml",
      },
      body,
      signal: controller.signal,
    });

    const text = await res.text();

    if (!res.ok) {
      return {
        checked: true,
        valid: null,
        raw: { httpStatus: res.status, bodyExcerpt: text.slice(0, 500) },
      };
    }

    return parseViesResponse(text);
  } catch (err) {
    const raw =
      err instanceof Error
        ? { errorName: err.name, errorMessage: err.message }
        : { error: String(err) };
    return { checked: true, valid: null, raw };
  } finally {
    clearTimeout(timer);
  }
}

function buildSoapEnvelope(countryCode: string, vatNumber: string): string {
  // countryCode is [A-Z]{2}, vatNumber is [A-Z0-9]+ — both safe to
  // inline without XML-escaping (parseVatId enforces the regex).
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"`,
    `               xmlns:urn="${VIES_NS}">`,
    `  <soap:Header/>`,
    `  <soap:Body>`,
    `    <urn:checkVat>`,
    `      <urn:countryCode>${countryCode}</urn:countryCode>`,
    `      <urn:vatNumber>${vatNumber}</urn:vatNumber>`,
    `    </urn:checkVat>`,
    `  </soap:Body>`,
    `</soap:Envelope>`,
  ].join("\n");
}

/**
 * Extract the result from a VIES SOAP response.
 *
 * We use regexes rather than a full XML parser: the VIES envelope
 * has been stable for over a decade, the elements we care about
 * are simple and unambiguous, and avoiding a parser dependency
 * keeps the surface area small. We still return the raw payload
 * for debugging via the `raw` field of every cached row.
 */
function parseViesResponse(xml: string): ViesResult {
  // SOAP fault (typical strings: "SERVICE_UNAVAILABLE", "MS_UNAVAILABLE",
  // "INVALID_INPUT", "TIMEOUT", "GLOBAL_MAX_CONCURRENT_REQ").
  const faultMatch =
    /<(?:[a-z0-9]+:)?faultstring[^>]*>([^<]*)<\/(?:[a-z0-9]+:)?faultstring>/i.exec(
      xml,
    );
  if (faultMatch) {
    return {
      checked: true,
      valid: null,
      raw: { fault: faultMatch[1] },
    };
  }

  // Standard response: <ns2:valid>true|false</ns2:valid>
  const validMatch =
    /<(?:[a-z0-9]+:)?valid[^>]*>(true|false)<\/(?:[a-z0-9]+:)?valid>/i.exec(
      xml,
    );
  if (!validMatch) {
    return {
      checked: true,
      valid: null,
      raw: { error: "unexpected response shape", sample: xml.slice(0, 500) },
    };
  }

  const isValid = validMatch[1] === "true";
  const name = extractTag(xml, "name");
  const address = extractTag(xml, "address");
  const reqDate = extractTag(xml, "requestDate");

  return {
    checked: true,
    valid: isValid,
    raw: { valid: isValid, name, address, requestDate: reqDate },
  };
}

function extractTag(xml: string, tagName: string): string | null {
  const re = new RegExp(
    `<(?:[a-z0-9]+:)?${tagName}[^>]*>([^<]*)<\\/(?:[a-z0-9]+:)?${tagName}>`,
    "i",
  );
  const m = re.exec(xml);
  return m?.[1] ?? null;
}
