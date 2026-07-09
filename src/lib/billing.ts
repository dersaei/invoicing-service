/**
 * src/lib/billing.ts — shared billing business rules.
 *
 * Constants that encode business policy (not runtime config): they
 * should require a code review to change, not a Doppler tweak. Shared
 * across the webhook (invoice issuance) and resend routes so the two
 * never drift.
 */

/**
 * Payment term in days. Per project plan: 30-day terms across all
 * subscriptions. Printed on the invoice and referenced in the email body.
 */
export const PAYMENT_TERM_DAYS = 30;

/**
 * Polish standard VAT rate (%). Applied to domestic (PL) buyers and to
 * EU consumers without a valid VAT-EU number. Lives here — a pure module
 * with no env dependency — so `lib/vat.ts` stays unit-testable without
 * booting config, while still having a single source of truth.
 */
export const PL_STANDARD_VAT_RATE = 23;
