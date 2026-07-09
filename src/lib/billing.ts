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
