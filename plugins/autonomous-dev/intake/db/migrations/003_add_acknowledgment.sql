-- 003_add_acknowledgment.sql
-- v2 → v3: adds daemon-acknowledgment columns to the requests table.
-- Used by the consumer-side handoff (SPEC-012-1-03) to track which
-- requests have been picked up by the daemon's read loop.
--
-- Idempotent: safe to apply multiple times via the migration runner
-- (which inserts a row in _migrations on first apply).

-- acknowledged_at: ISO 8601 UTC timestamp set by acknowledger.ts when
-- the daemon successfully reads + claims the request.
ALTER TABLE requests ADD COLUMN acknowledged_at TEXT DEFAULT NULL;

-- acknowledged_by: daemon instance id (forensics for multi-daemon
-- scenarios). Allowed to be NULL if the request has not been ack'd.
ALTER TABLE requests ADD COLUMN acknowledged_by TEXT DEFAULT NULL;

-- Index for the daemon's poll query: "find next unacked request, FIFO
-- by created_at, tiebreak by priority desc" (per SPEC-012-1-03 §"Poll
-- new requests"). Partial index keeps the working set small — we only
-- ever care about UNACKED rows for poll.
CREATE INDEX IF NOT EXISTS idx_requests_unacked
  ON requests(created_at, priority)
  WHERE acknowledged_at IS NULL;
