-- ─────────────────────────────────────────────────────────────
--  001_initial.sql — invoicing-service schema
--  Postgres 18.x. Run via `pnpm migrate` (scripts/migrate.ts).
-- ─────────────────────────────────────────────────────────────

-- ── ENUMs ────────────────────────────────────────────────────
-- Brands across the three sites sharing this service.
DO $$ BEGIN
  CREATE TYPE brand_t AS ENUM ('VG', 'PV', 'SR');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Document type. Only proforma for now, but the counter and the
-- numbering scheme are keyed on it so future doc types slot in.
DO $$ BEGIN
  CREATE TYPE doc_type_t AS ENUM ('proforma');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- VAT treatment actually applied to an issued invoice.
DO $$ BEGIN
  CREATE TYPE vat_regime_t AS ENUM (
    'pl_standard',     -- 23% PL (domestic, or EU consumer w/o valid VAT-EU)
    'eu_reverse',      -- 0% reverse charge, valid VAT-EU non-PL
    'export_zero'      -- 0% export, outside EU
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Lifecycle status of an invoice row.
DO $$ BEGIN
  CREATE TYPE invoice_status_t AS ENUM (
    'issued',          -- record persisted, number assigned, PDF generated
    'sent',            -- email dispatched to buyer
    'failed'           -- something downstream failed; needs attention
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── counters ─────────────────────────────────────────────────
-- One row per (brand, doc_type, year). The sequence is shared
-- across countries — country is only a display prefix on the
-- number, not part of the counter key.
-- Atomic increment via INSERT ... ON CONFLICT DO UPDATE RETURNING.
CREATE TABLE IF NOT EXISTS counters (
  brand        brand_t      NOT NULL,
  doc_type     doc_type_t   NOT NULL,
  year         integer      NOT NULL,
  last_value   integer      NOT NULL DEFAULT 0,
  updated_at   timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (brand, doc_type, year)
);

-- ── invoices ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Idempotency anchor: one Directus submission → at most one invoice.
  submission_id   text          NOT NULL UNIQUE,

  -- Human-facing number, e.g. 'FR001VG/2026'. Unique once assigned.
  invoice_number  text          NOT NULL UNIQUE,

  brand           brand_t       NOT NULL,
  doc_type        doc_type_t    NOT NULL DEFAULT 'proforma',
  service_code    text          NOT NULL,

  -- Buyer snapshot (denormalised on purpose: an invoice must remain
  -- faithful to what was billed even if catalog/buyer data changes).
  buyer_name      text          NOT NULL,
  buyer_email     text          NOT NULL,
  buyer_vat_id    text,
  buyer_country   char(2)       NOT NULL,            -- ISO 3166-1 alpha-2
  buyer_address   jsonb         NOT NULL,            -- {street,city,postal_code,country}

  -- Money. EUR throughout, but currency is explicit for safety.
  currency        char(3)       NOT NULL DEFAULT 'EUR',
  amount_net      numeric(12,2) NOT NULL,
  vat_rate        numeric(5,2)  NOT NULL,            -- e.g. 23.00 or 0.00
  amount_vat      numeric(12,2) NOT NULL,
  amount_gross    numeric(12,2) NOT NULL,
  vat_regime      vat_regime_t  NOT NULL,
  vat_note        text,                              -- adnotacja (reverse charge / export)

  -- VIES evidence when reverse charge was applied.
  vies_checked    boolean       NOT NULL DEFAULT false,
  vies_valid      boolean,
  vies_raw        jsonb,

  language        char(2)       NOT NULL,            -- fr|it|en|pl|de
  issue_date      date          NOT NULL DEFAULT current_date,

  -- Directus Files reference for the generated PDF.
  pdf_file_id     text,

  status          invoice_status_t NOT NULL DEFAULT 'issued',

  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoices_created_at  ON invoices (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_brand_year  ON invoices (brand, issue_date);
CREATE INDEX IF NOT EXISTS idx_invoices_status      ON invoices (status);

-- ── audit_log ────────────────────────────────────────────────
-- Append-only trail per submission. Every meaningful step writes
-- a row so a failed/partial run can be reconstructed.
CREATE TABLE IF NOT EXISTS audit_log (
  id             bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submission_id  text          NOT NULL,
  invoice_id     uuid          REFERENCES invoices (id) ON DELETE SET NULL,
  event          text          NOT NULL,            -- e.g. 'received','vies_ok','pdf_done','mailed','error'
  detail         jsonb,
  created_at     timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_submission ON audit_log (submission_id, created_at);

-- ── updated_at trigger ───────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_invoices_updated_at ON invoices;
CREATE TRIGGER trg_invoices_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
