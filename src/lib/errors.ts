/**
 * src/lib/errors.ts — shared error-message extraction.
 *
 * Turns any thrown value into a human-readable string for logs and HTTP
 * responses. Shared by the webhook and resend routes.
 */

/**
 * Extract a human-readable message from any thrown value:
 *  - Error instance      → .message
 *  - Directus SDK error  → .errors[0].message  (plain object, not Error)
 *  - anything else       → JSON.stringify (falls back to String())
 *
 * Without this, Directus SDK rejections (plain objects, not Error
 * instances) stringify to "[object Object]" in logs and 500 responses.
 */
export function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (
    err !== null &&
    typeof err === "object" &&
    "errors" in err &&
    Array.isArray((err as { errors: unknown }).errors)
  ) {
    const errors = (err as { errors: Array<{ message?: string }> }).errors;
    if (errors.length > 0 && typeof errors[0]?.message === "string") {
      return errors[0].message;
    }
  }
  try {
    const json = JSON.stringify(err);
    // JSON.stringify(undefined) === undefined, and a bare "{}" tells us
    // nothing — fall back to String() so we never emit a useless message.
    if (json && json !== "{}") return json;
  } catch {
    /* circular ref or BigInt — fall through to String() */
  }
  return String(err);
}
