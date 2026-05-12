-- Add type column to requests table for PLAN-039
-- Request types: feature, bug, infra, refactor, hotfix

ALTER TABLE requests ADD COLUMN type TEXT NOT NULL DEFAULT 'feature'
  CHECK (type IN ('feature', 'bug', 'infra', 'refactor', 'hotfix'));

CREATE INDEX idx_requests_type ON requests(type);
CREATE INDEX idx_requests_type_status ON requests(type, status, created_at);