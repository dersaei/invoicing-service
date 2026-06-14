/**
 * src/config.ts — validated runtime configuration.
 *
 * Reads exclusively from process.env (Doppler injects these via
 * `doppler run -- ...`). Validation happens once at startup: if a
 * required secret is missing or malformed, the process exits with a
 * clear message instead of failing later in some random code path.
 *
 * SELLER / TODO values are placeholders to fill in (see README → TODO).
 */

import { z } from "zod";

const EnvSchema = z.object({
  // App
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  // Webhook HMAC
  WEBHOOK_SECRET: z
    .string()
    .min(16, "WEBHOOK_SECRET must be set (openssl rand -hex 32)"),

  // Invoicing DB
  INVOICING_DB_HOST: z.string().min(1),
  INVOICING_DB_PORT: z.coerce.number().int().positive().default(5432),
  INVOICING_DB_NAME: z.string().min(1),
  INVOICING_DB_USER: z.string().min(1),
  INVOICING_DB_PASSWORD: z.string().min(1),

  // Directus
  DIRECTUS_URL: z.string().url(),
  DIRECTUS_TOKEN: z.string().min(1),

  // Fastmail SMTP
  FASTMAIL_SMTP_HOST: z.string().min(1).default("smtp.fastmail.com"),
  FASTMAIL_SMTP_PORT: z.coerce.number().int().positive().default(465),
  FASTMAIL_SMTP_USER: z.string().min(1),
  FASTMAIL_APP_PASSWORD: z.string().min(1),
  MAIL_FROM: z.string().min(1),

  // VIES
  VIES_ENDPOINT: z
    .string()
    .url()
    .default(
      "https://ec.europa.eu/taxation_customs/vies/services/checkVatService",
    ),
  VIES_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("✗ Invalid environment configuration:\n");
  for (const issue of parsed.error.issues) {
    console.error(`  • ${issue.path.join(".")}: ${issue.message}`);
  }
  console.error(
    "\nHint: are you running through Doppler? Try `doppler run -- <cmd>`.",
  );
  process.exit(1);
}

const env = parsed.data;

// ── Seller identity (TODO: fill in real JDG data — see README) ──
// These are NOT secrets and don't belong in Doppler; they're static
// business facts. Hard-coded here intentionally. Replace placeholders.
const SELLER = {
  legal_name: "TODO_SELLER_LEGAL_NAME",
  regon: "TODO_REGON",
  nip: "TODO_NIP",
  address: {
    street: "TODO_STREET",
    city: "TODO_CITY",
    postal_code: "TODO_POSTAL",
    country: "PL",
  },
  bank: {
    name: "TODO_BANK_NAME",
    iban_eur: "TODO_IBAN_EUR",
    swift: "TODO_SWIFT",
  },
} as const;

// ── VAT constants ────────────────────────────────────────────
const VAT = {
  pl_standard_rate: 23, // %
} as const;

export const config = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === "production",
  port: env.PORT,
  logLevel: env.LOG_LEVEL,

  webhookSecret: env.WEBHOOK_SECRET,

  db: {
    host: env.INVOICING_DB_HOST,
    port: env.INVOICING_DB_PORT,
    database: env.INVOICING_DB_NAME,
    username: env.INVOICING_DB_USER,
    password: env.INVOICING_DB_PASSWORD,
  },

  directus: {
    url: env.DIRECTUS_URL,
    token: env.DIRECTUS_TOKEN,
  },

  mail: {
    host: env.FASTMAIL_SMTP_HOST,
    port: env.FASTMAIL_SMTP_PORT,
    user: env.FASTMAIL_SMTP_USER,
    password: env.FASTMAIL_APP_PASSWORD,
    from: env.MAIL_FROM,
  },

  vies: {
    endpoint: env.VIES_ENDPOINT,
    timeoutMs: env.VIES_TIMEOUT_MS,
  },

  seller: SELLER,
  vat: VAT,
} as const;

export type Config = typeof config;
