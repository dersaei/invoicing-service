/**
 * src/lib/i18n.ts — i18next initialisation + locale-aware formatters.
 *
 * Strategy: load all 5 locales statically at module init (they're
 * small JSON files bundled with the app, no async backend needed).
 * Exports a `getT(lang)` that returns a fixed-language translator,
 * plus `formatCurrency` / `formatDate` using Intl with proper locales.
 *
 * Why not use i18next's global state directly? Because the same
 * service may render two invoices in different languages in
 * overlapping async contexts (one webhook still finishing while the
 * next arrives). A globally-set `lng` would be a race condition.
 * `getFixedT` is per-call and safe.
 */

import i18next, { type TFunction } from "i18next";
import type { Language } from "../types.js";
import pl from "../locales/pl.json" with { type: "json" };
import fr from "../locales/fr.json" with { type: "json" };
import it from "../locales/it.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };
import de from "../locales/de.json" with { type: "json" };

/**
 * Intl locale identifiers per supported language. These drive number
 * and date formatting (decimal separator, currency symbol position,
 * date order). Polish uses ',' decimal + '€' suffix; French uses
 * narrow no-break space as thousands separator; etc.
 */
const INTL_LOCALES: Record<Language, string> = {
  pl: "pl-PL",
  fr: "fr-FR",
  it: "it-IT",
  en: "en-GB", // British English — 24h clock, DMY date, sensible defaults
  de: "de-DE",
};

// ── Initialisation (synchronous; no backend) ─────────────────
// i18next.init() returns a Promise even with inline resources, but
// resolves on the same tick when there's no async backend to wait
// for. We fire it once at module load and trust that any caller
// (which is always inside an async webhook handler) reaches us
// long after this microtask has settled.
i18next.init({
  lng: "en",
  fallbackLng: "en",
  supportedLngs: ["pl", "fr", "it", "en", "de"],
  resources: {
    pl: { translation: pl },
    fr: { translation: fr },
    it: { translation: it },
    en: { translation: en },
    de: { translation: de },
  },
  interpolation: {
    // We're rendering into HTML for PDF *and* into plaintext for emails.
    // Letting i18next HTML-escape here would corrupt the plaintext path.
    // The PDF template will escape on insertion (template responsibility).
    escapeValue: false,
  },
});

/**
 * Return a translator function locked to a specific language.
 *
 *   const t = getT('fr');
 *   t('invoice.title_proforma');             // "Facture pro forma"
 *   t('payment.term_days', { days: 30 });    // "30 jours à compter..."
 */
export function getT(lang: Language): TFunction {
  return i18next.getFixedT(lang);
}

/**
 * Format an EUR amount per the given locale's conventions.
 *   formatCurrency(1234.5, 'pl')  → "1234,50 €"  (or "1 234,50 €" depending on ICU)
 *   formatCurrency(1234.5, 'en')  → "€1,234.50"
 *   formatCurrency(1234.5, 'de')  → "1.234,50 €"
 */
export function formatCurrency(amount: number, lang: Language): string {
  return new Intl.NumberFormat(INTL_LOCALES[lang], {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Format a date per the locale (numeric short form: DD.MM.YYYY,
 * DD/MM/YYYY, etc.). Used for issue_date, due_date on the invoice.
 */
export function formatDate(date: Date, lang: Language): string {
  return new Intl.DateTimeFormat(INTL_LOCALES[lang], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Longer datetime format (for footer timestamps). */
export function formatDateTime(date: Date, lang: Language): string {
  return new Intl.DateTimeFormat(INTL_LOCALES[lang], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
