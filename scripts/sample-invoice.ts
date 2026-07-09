/**
 * scripts/sample-invoice.ts — render a sample invoice for eyeballing.
 *
 * A dev-only preview tool: builds a fake buyer for a chosen scenario,
 * runs the REAL pricing + rendering pipeline (computeVat → i18n note →
 * renderInvoiceHtml → PDF), and writes the result to a file. No webhook,
 * no database, no Directus, no email — so you can iterate on the template
 * and VAT presentation without booting the whole service.
 *
 * Usage (via the npm script, which runs it through tsx):
 *   npm run sample-invoice                       # reverse charge, FR, PDF
 *   npm run sample-invoice -- --scenario standard --lang pl
 *   npm run sample-invoice -- --scenario export  --lang en --price 75
 *   npm run sample-invoice -- --country PL --lang pl        # PL 23%
 *   npm run sample-invoice -- --html             # write HTML, skip Chromium
 *
 * Flags:
 *   --scenario reverse|standard|export   (default: reverse)
 *   --lang     pl|fr|it|en|de            (default: fr)
 *   --price    <number, VAT-inclusive>   (default: 50)
 *   --country  <ISO2>                    (override the scenario's country)
 *   --out      <path>                    (default: ./sample-<scenario>-<lang>.<ext>)
 *   --html                               (emit .html instead of .pdf; no Playwright)
 *
 * Because this tool only renders, it never needs real secrets. We seed
 * placeholder env values (so config.ts validation passes) BEFORE importing
 * any module that pulls in config, via dynamic import below.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

// ── Placeholder env — this render-only tool connects to nothing ──
const PLACEHOLDER_ENV: Record<string, string> = {
  WEBHOOK_SECRET: "0000000000000000",
  INVOICING_DB_HOST: "localhost",
  INVOICING_DB_NAME: "unused",
  INVOICING_DB_USER: "unused",
  INVOICING_DB_PASSWORD: "unused",
  DIRECTUS_URL: "http://localhost",
  DIRECTUS_TOKEN: "unused",
  FASTMAIL_SMTP_USER: "unused",
  FASTMAIL_APP_PASSWORD: "unused",
  MAIL_FROM: "invoices@example.com",
};
for (const [k, v] of Object.entries(PLACEHOLDER_ENV)) {
  process.env[k] ??= v;
}

// Dynamic imports: must run AFTER the env seeding above, because
// invoice.html.ts → config.ts validates env at import time.
const { computeVat } = await import("../src/lib/vat.js");
const { getT } = await import("../src/lib/i18n.js");
const { renderInvoiceHtml } = await import("../src/templates/invoice.html.js");
type Language = import("../src/types.js").Language;
type Buyer = import("../src/types.js").Buyer;
type ViesResult = import("../src/types.js").ViesResult;

// ── Argument parsing ────────────────────────────────────────────
const argv = process.argv.slice(2);
function opt(name: string, def: string): string {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : def;
}
function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}

const SCENARIOS = ["reverse", "standard", "export"] as const;
type Scenario = (typeof SCENARIOS)[number];
const LANGS: Language[] = ["pl", "fr", "it", "en", "de"];

const scenario = opt("scenario", "reverse") as Scenario;
const lang = opt("lang", "fr") as Language;
const price = Number(opt("price", "50"));
const htmlOnly = flag("html");

if (!SCENARIOS.includes(scenario)) {
  fail(`--scenario must be one of ${SCENARIOS.join(", ")}, got: ${scenario}`);
}
if (!LANGS.includes(lang)) {
  fail(`--lang must be one of ${LANGS.join(", ")}, got: ${lang}`);
}
if (!Number.isFinite(price) || price < 0) {
  fail(`--price must be a non-negative number, got: ${opt("price", "50")}`);
}

// ── Build the scenario's buyer + VIES input ─────────────────────
interface ScenarioDef {
  country: string;
  vies: ViesResult | null;
  buyer: Buyer;
}
const SCENARIO_DEFS: Record<Scenario, ScenarioDef> = {
  reverse: {
    country: "FR",
    vies: { checked: true, valid: true, raw: {} },
    buyer: {
      name: "Domaine des Tests SARL",
      email: "contact@domaine-tests.fr",
      vat_id: "FR40123456824",
      address: {
        street: "12 rue de la Vigne",
        city: "Lyon",
        postal_code: "69002",
        country: "FR",
      },
    },
  },
  standard: {
    country: "FR",
    vies: null,
    buyer: {
      name: "Jean Dupont",
      email: "jean.dupont@example.fr",
      address: {
        street: "8 avenue des Cépages",
        city: "Bordeaux",
        postal_code: "33000",
        country: "FR",
      },
    },
  },
  export: {
    country: "US",
    vies: null,
    buyer: {
      name: "Test Wines LLC",
      email: "orders@testwines.example",
      address: {
        street: "500 Vineyard Ave",
        city: "Napa",
        postal_code: "94558",
        country: "US",
      },
    },
  },
};

const def = SCENARIO_DEFS[scenario];
const countryOverride = opt("country", "").toUpperCase();
const country = countryOverride || def.country;
const buyer: Buyer = {
  ...def.buyer,
  address: { ...def.buyer.address, country },
};

// ── Run the real pipeline ───────────────────────────────────────
const vat = computeVat({ price, buyerCountry: country, vies: def.vies });

// Mirror the webhook's note localisation (vat.ts returns English default).
const t = getT(lang);
const note =
  vat.regime === "eu_reverse"
    ? (t("vat_notes.eu_reverse") as string)
    : vat.regime === "export_zero"
      ? (t("vat_notes.export_zero") as string)
      : null;

const issueDate = new Date();
const dueDate = new Date(issueDate.getTime() + 30 * 24 * 60 * 60 * 1000);

const htmlFinal = renderInvoiceHtml({
  number: `${country}001VG/${issueDate.getFullYear()}`,
  brand: "VG",
  language: lang,
  issueDate,
  dueDate,
  buyer,
  items: [
    {
      name: sampleServiceName(lang),
      description: null,
      quantity: 1,
      unitPriceNet: vat.net,
    },
  ],
  vat: { ...vat, note },
  paymentTermDays: 30,
});

// ── Write output ────────────────────────────────────────────────
const ext = htmlOnly ? "html" : "pdf";
const outPath = path.resolve(
  opt("out", `./sample-${scenario}-${lang}.${ext}`),
);

if (htmlOnly) {
  await writeFile(outPath, htmlFinal, "utf8");
} else {
  const { generateInvoicePdf, closePdfBrowser } = await import(
    "../src/lib/pdf.js"
  );
  try {
    const pdf = await generateInvoicePdf(htmlFinal);
    await writeFile(outPath, pdf);
  } catch (err) {
    console.error("\n✗ PDF generation failed.");
    console.error(
      "  If this is a missing-browser error, install Chromium once:\n" +
        "    npx playwright install chromium\n" +
        "  Or render HTML instead (no browser needed):  --html\n",
    );
    throw err;
  } finally {
    await closePdfBrowser();
  }
}

// ── Summary ─────────────────────────────────────────────────────
console.log(`\n✔ Sample invoice written: ${outPath}\n`);
console.log(`  scenario : ${scenario}  (${country}, lang=${lang})`);
console.log(`  regime   : ${vat.regime}  rate=${vat.rate}%`);
console.log(
  `  amounts  : net ${vat.net}  vat ${vat.vat}  gross ${vat.gross}  EUR`,
);
if (note) console.log(`  note     : ${note}`);
console.log("");

// ── Helpers ─────────────────────────────────────────────────────
function sampleServiceName(l: Language): string {
  const names: Record<Language, string> = {
    pl: "Abonament roczny Vina Gallica",
    fr: "Abonnement annuel Vina Gallica",
    it: "Abbonamento annuale Vina Gallica",
    en: "Vina Gallica annual subscription",
    de: "Vina Gallica Jahresabonnement",
  };
  return names[l];
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
