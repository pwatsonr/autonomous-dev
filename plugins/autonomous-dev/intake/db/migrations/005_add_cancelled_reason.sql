-- Add cancelled_reason column to requests table for PLAN-039
-- Tracks why a request was cancelled (user action vs system reconciliation)

ALTER TABLE requests ADD COLUMN cancelled_reason TEXT;