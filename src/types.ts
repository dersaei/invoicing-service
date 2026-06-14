/**
 * src/types.ts — Zod schemas + shared domain types.
 *
 * The webhook payload schema here is the single source of truth for
 * what Directus must send. `WebhookPayload` is inferred from it, so the
 * route handler and the rest of the pipeline stay in sync automatically.
 */

import { z } from "zod";

// ── Enumerations (mirror the DB ENUMs in 001_initial.sql) ────
export const BrandEnum = z.enum(["VG", "PV", "SR"]);
export type Brand = z.infer<typeof BrandEnum>;

export const BillingCycleEnum = z.enum(["annual", "monthly", "one_time"]);
export type BillingCycle = z.infer<typeof BillingCycleEnum>;

// Supported invoice languages. DB stores char(2); 'de' is allowed at the
// catalog level (name_de/description_de exist) even though locale files
// for it may be added later.
export const LanguageEnum = z.enum(["fr", "it", "en", "pl", "de"]);
export type Language = z.infer<typeof LanguageEnum>;

export const VatRegimeEnum = z.enum([
  "pl_standard",
  "eu_reverse",
  "export_zero",
]);
export type VatRegime = z.infer<typeof VatRegimeEnum>;

// ── Webhook payload ──────────────────────────────────────────
// ISO 3166-1 alpha-2, upper-cased. We normalise rather than reject
// lowercase so the Directus Flow author doesn't have to be precise.
const CountryCode = z
  .string()
  .trim()
  .length(2, "country must be a 2-letter ISO code")
  .transform((s) => s.toUpperCase());

export const BuyerAddressSchema = z.object({
  street: z.string().trim().min(1),
  city: z.string().trim().min(1),
  postal_code: z.string().trim().min(1),
  country: CountryCode,
});
export type BuyerAddress = z.infer<typeof BuyerAddressSchema>;

export const BuyerSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().email(),
  // VAT-EU identifier, optional. Kept as raw string here; VIES module
  // is responsible for parsing country prefix + number and validating.
  vat_id: z.string().trim().min(1).optional(),
  address: BuyerAddressSchema,
});
export type Buyer = z.infer<typeof BuyerSchema>;

export const WebhookPayloadSchema = z.object({
  submission_id: z.string().trim().min(1),
  service_code: z.string().trim().min(1),
  language: LanguageEnum,
  buyer: BuyerSchema,
});
export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;

// ── Catalog (Directus `services` collection) ─────────────────
// Shape of a service row as returned by the Directus SDK. Localised
// name/description fields are nullable per the collection definition.
export interface ServiceRecord {
  code: string;
  brand: Brand;
  billing_cycle: BillingCycle;
  price_net_eur: string; // decimal comes back as string; parse with care
  name_pl: string | null;
  name_fr: string | null;
  name_it: string | null;
  name_en: string | null;
  name_de: string | null;
  description_pl: string | null;
  description_fr: string | null;
  description_it: string | null;
  description_en: string | null;
  description_de: string | null;
  active: boolean;
}

// ── VAT computation result ───────────────────────────────────
export interface VatComputation {
  regime: VatRegime;
  rate: number; // percentage, e.g. 23 or 0
  net: number;
  vat: number;
  gross: number;
  note: string | null; // adnotacja for reverse charge / export
}

// ── VIES check result ────────────────────────────────────────
export interface ViesResult {
  checked: boolean;
  valid: boolean | null; // null when the service was unreachable
  raw: unknown;
}
