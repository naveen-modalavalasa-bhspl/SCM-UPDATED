-- Per-company / per-project document number counters (Settings > Document numbering).
-- Safe on a live database: one nullable column, no data change. Existing rows keep
-- scope_key = NULL and keep numbering exactly as they do today.
--
-- MySQL 8 has no ADD COLUMN IF NOT EXISTS; run once, or check first with:
--   SHOW COLUMNS FROM sys_doc_series LIKE 'scope_key';

ALTER TABLE sys_doc_series
    ADD COLUMN scope_key VARCHAR(60) NULL,
    ADD INDEX ix_sys_doc_series_scope_key (scope_key);

-- The live table's unique key is (doc_type, fiscal_year). A per-project counter is a
-- second row for the same doc_type and year, so the key is widened to include the
-- scope. Still unique per doc_type/year/scope — nothing is loosened for the configured
-- series rows themselves, which the admin API also guards in Python.
ALTER TABLE sys_doc_series
    DROP INDEX uq_series,
    ADD UNIQUE KEY uq_series (doc_type, fiscal_year, scope_key);

-- Room for a pattern that names company, project and a date: VARCHAR(50) fits
-- {PREFIX}/{FY}/{SEQ:5} and little else. Widening never truncates.
ALTER TABLE sys_doc_series MODIFY COLUMN pattern VARCHAR(100) NOT NULL;
