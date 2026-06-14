-- ─────────────────────────────────────────────────────────────
--  002_vies_cache.sql — VIES result cache (24h TTL)
--
--  VIES is the EU's central VAT-EU validation service. It's slow
--  (often 1-5s per query) and intermittently flaky. We cache positive
--  AND negative definitive results for 24 hours.
--
--  Transient failures (VIES unreachable, timeout, 5xx) are NOT cached
--  — when VIES comes back, the next request goes through.
--
--  Key uses the VIES country code (EL for Greece, not ISO's GR),
--  matching the format we send to VIES.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vies_cache (
  country_code  char(2)     NOT NULL,
  vat_number    text        NOT NULL,
  valid         boolean     NOT NULL,
  raw           jsonb       NOT NULL,
  checked_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (country_code, vat_number)
);

-- For periodic cleanup of stale entries (optional cron job).
CREATE INDEX IF NOT EXISTS idx_vies_cache_age ON vies_cache (checked_at);