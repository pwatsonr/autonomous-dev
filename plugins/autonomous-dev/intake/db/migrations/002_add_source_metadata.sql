-- 002_add_source_metadata.sql
-- v1 → v2: adds source-tracking metadata columns to the requests table.
-- Idempotent: safe to apply multiple times via the migration runner.

-- Add source column (NOT NULL, default 'cli' for v1 backward-compat).
-- Existing v1 rows automatically receive source='cli'.
ALTER TABLE requests ADD COLUMN source TEXT NOT NULL DEFAULT 'cli'
  CHECK (source IN (
    'cli',
    'claude-app',
    'discord',
    'slack',
    'production-intelligence',
    'portal'
  ));

-- Add adapter_metadata column (TEXT JSON; default empty object).
-- Existing v1 rows automatically receive '{}'.
ALTER TABLE requests ADD COLUMN adapter_metadata TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(adapter_metadata));

-- Index for per-source audit + reconciliation queries.
CREATE INDEX IF NOT EXISTS idx_requests_source ON requests(source);

-- Composite index for "active requests by source" queries used by
-- reconciliation CLI (PLAN-012-3) and per-channel dashboards.
CREATE INDEX IF NOT EXISTS idx_requests_source_status
  ON requests(source, status, created_at);
