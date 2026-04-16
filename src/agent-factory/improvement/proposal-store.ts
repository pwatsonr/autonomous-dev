/**
 * Proposal Store with JSONL persistence and SQLite indexing
 * (SPEC-005-3-5, Task 11).
 *
 * Dual storage (same pattern as metrics):
 *   - JSONL primary: `data/proposals.jsonl` (full AgentProposal per line)
 *   - SQLite secondary: `proposals` table in `data/agent-metrics.db`
 *     (metadata for querying; full definitions stored in JSONL only)
 *
 * Status transition rules are enforced in-code. Invalid transitions
 * throw an error.
 *
 * Exports: `ProposalStore`
 */

import * as fs from 'fs';
import * as path from 'path';

import type { AgentProposal, ProposalStatus } from './types';

// ---------------------------------------------------------------------------
// Optional better-sqlite3 import (same pattern as metrics/sqlite-store.ts)
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type Database = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

let BetterSqlite3: ((...args: unknown[]) => Database) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  BetterSqlite3 = require('better-sqlite3');
} catch {
  // Module not available; SQLite operations will throw.
}

// ---------------------------------------------------------------------------
// SQL DDL
// ---------------------------------------------------------------------------

const CREATE_PROPOSALS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS proposals (
  proposal_id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  current_version TEXT NOT NULL,
  proposed_version TEXT NOT NULL,
  version_bump TEXT NOT NULL,
  weakness_report_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  meta_review_id TEXT,
  evaluation_id TEXT,
  rationale TEXT NOT NULL,
  diff TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposals_agent ON proposals(agent_name);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_created ON proposals(created_at);
`;

// ---------------------------------------------------------------------------
// Status transition map
// ---------------------------------------------------------------------------

/**
 * Valid status transitions. Each key maps to the set of statuses it
 * can transition to. Terminal states (meta_rejected, rejected, promoted)
 * have no outgoing transitions.
 */
const VALID_TRANSITIONS: ReadonlyMap<ProposalStatus, ReadonlySet<ProposalStatus>> = new Map([
  ['pending_meta_review', new Set<ProposalStatus>(['meta_approved', 'meta_rejected', 'pending_human_review'])],
  ['meta_approved', new Set<ProposalStatus>(['validating'])],
  ['validating', new Set<ProposalStatus>(['validated_positive', 'validated_negative'])],
  ['validated_positive', new Set<ProposalStatus>(['promoted', 'rejected'])],
  ['validated_negative', new Set<ProposalStatus>(['rejected'])],
  ['meta_rejected', new Set<ProposalStatus>([])],
  ['rejected', new Set<ProposalStatus>([])],
  ['promoted', new Set<ProposalStatus>([])],
  ['pending_human_review', new Set<ProposalStatus>([])],
]);

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

export interface ProposalStoreLogger {
  warn(message: string): void;
}

const defaultLogger: ProposalStoreLogger = {
  warn: (msg: string) => console.warn(`[proposal-store] ${msg}`),
};

// ---------------------------------------------------------------------------
// ProposalStore
// ---------------------------------------------------------------------------

export class ProposalStore {
  private readonly jsonlPath: string;
  private readonly logger: ProposalStoreLogger;
  private db: Database | null = null;

  /**
   * @param jsonlPath   Path to the proposals JSONL file.
   * @param sqliteDbPath Path to the SQLite database file (shared with metrics).
   * @param logger      Optional logger for non-fatal warnings.
   */
  constructor(
    jsonlPath: string,
    sqliteDbPath: string,
    logger?: ProposalStoreLogger,
  ) {
    this.jsonlPath = path.resolve(jsonlPath);
    this.logger = logger ?? defaultLogger;

    // Initialize SQLite if available
    if (BetterSqlite3) {
      try {
        const dir = path.dirname(path.resolve(sqliteDbPath));
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        this.db = new (BetterSqlite3 as any)(path.resolve(sqliteDbPath));
        this.db.pragma('journal_mode = WAL');
        this.db.exec(CREATE_PROPOSALS_TABLE_SQL);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to initialize SQLite for proposals: ${message}`);
        this.db = null;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Create
  // -----------------------------------------------------------------------

  /**
   * Append a new proposal to both JSONL and SQLite.
   *
   * The full `AgentProposal` (including definition content) is stored
   * in JSONL. Only metadata (no definition content) is stored in SQLite.
   */
  append(proposal: AgentProposal): void {
    // JSONL: append full proposal
    this.appendToJsonl(proposal);

    // SQLite: insert metadata
    if (this.db) {
      try {
        this.db.prepare(`
          INSERT INTO proposals (
            proposal_id, agent_name, current_version, proposed_version,
            version_bump, weakness_report_id, status, created_at,
            meta_review_id, evaluation_id, rationale, diff
          ) VALUES (
            @proposal_id, @agent_name, @current_version, @proposed_version,
            @version_bump, @weakness_report_id, @status, @created_at,
            @meta_review_id, @evaluation_id, @rationale, @diff
          )
        `).run({
          proposal_id: proposal.proposal_id,
          agent_name: proposal.agent_name,
          current_version: proposal.current_version,
          proposed_version: proposal.proposed_version,
          version_bump: proposal.version_bump,
          weakness_report_id: proposal.weakness_report_id,
          status: proposal.status,
          created_at: proposal.created_at,
          meta_review_id: proposal.meta_review_id ?? null,
          evaluation_id: proposal.evaluation_id ?? null,
          rationale: proposal.rationale,
          diff: proposal.diff,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to insert proposal into SQLite: ${message}`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Read
  // -----------------------------------------------------------------------

  /**
   * Retrieve a proposal by its ID.
   *
   * Reads from JSONL (full proposal with definitions).
   */
  getById(proposalId: string): AgentProposal | null {
    const proposals = this.readAllFromJsonl();
    return proposals.find((p) => p.proposal_id === proposalId) ?? null;
  }

  /**
   * Retrieve all proposals for a given agent, optionally filtered by status.
   */
  getByAgent(agentName: string, status?: ProposalStatus): AgentProposal[] {
    const proposals = this.readAllFromJsonl();
    return proposals.filter((p) => {
      if (p.agent_name !== agentName) return false;
      if (status !== undefined && p.status !== status) return false;
      return true;
    });
  }

  /**
   * Retrieve all proposals with a given status.
   */
  getByStatus(status: ProposalStatus): AgentProposal[] {
    const proposals = this.readAllFromJsonl();
    return proposals.filter((p) => p.status === status);
  }

  /**
   * Retrieve proposals created within a date range (inclusive).
   *
   * @param since  ISO 8601 start date (inclusive).
   * @param until  ISO 8601 end date (inclusive).
   */
  getByDateRange(since: string, until: string): AgentProposal[] {
    const proposals = this.readAllFromJsonl();
    return proposals.filter((p) => p.created_at >= since && p.created_at <= until);
  }

  /**
   * Retrieve the most recently created proposal for a given agent.
   */
  getLatestForAgent(agentName: string): AgentProposal | null {
    const agentProposals = this.getByAgent(agentName);
    if (agentProposals.length === 0) return null;

    // Sort by created_at descending, return the first
    agentProposals.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return agentProposals[0];
  }

  // -----------------------------------------------------------------------
  // Update
  // -----------------------------------------------------------------------

  /**
   * Transition a proposal's status, enforcing the state machine rules.
   *
   * @throws Error if the transition is invalid (terminal state or
   *         disallowed from-to pair).
   */
  updateStatus(proposalId: string, newStatus: ProposalStatus): void {
    const proposals = this.readAllFromJsonl();
    const index = proposals.findIndex((p) => p.proposal_id === proposalId);

    if (index === -1) {
      throw new Error(`Proposal '${proposalId}' not found`);
    }

    const proposal = proposals[index];
    const currentStatus = proposal.status;

    // Validate transition
    const allowedTransitions = VALID_TRANSITIONS.get(currentStatus);
    if (!allowedTransitions || !allowedTransitions.has(newStatus)) {
      throw new Error(
        `Invalid status transition for proposal '${proposalId}': ` +
          `${currentStatus} -> ${newStatus}`,
      );
    }

    // Update in-memory
    proposal.status = newStatus;

    // Rewrite JSONL
    this.rewriteJsonl(proposals);

    // Update SQLite
    if (this.db) {
      try {
        this.db.prepare(
          'UPDATE proposals SET status = ? WHERE proposal_id = ?',
        ).run(newStatus, proposalId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to update proposal status in SQLite: ${message}`);
      }
    }
  }

  /**
   * Set the meta-review ID on a proposal.
   */
  setMetaReviewId(proposalId: string, reviewId: string): void {
    const proposals = this.readAllFromJsonl();
    const index = proposals.findIndex((p) => p.proposal_id === proposalId);

    if (index === -1) {
      throw new Error(`Proposal '${proposalId}' not found`);
    }

    proposals[index].meta_review_id = reviewId;

    // Rewrite JSONL
    this.rewriteJsonl(proposals);

    // Update SQLite
    if (this.db) {
      try {
        this.db.prepare(
          'UPDATE proposals SET meta_review_id = ? WHERE proposal_id = ?',
        ).run(reviewId, proposalId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to update meta_review_id in SQLite: ${message}`);
      }
    }
  }

  /**
   * Set the evaluation ID on a proposal.
   */
  setEvaluationId(proposalId: string, evaluationId: string): void {
    const proposals = this.readAllFromJsonl();
    const index = proposals.findIndex((p) => p.proposal_id === proposalId);

    if (index === -1) {
      throw new Error(`Proposal '${proposalId}' not found`);
    }

    proposals[index].evaluation_id = evaluationId;

    // Rewrite JSONL
    this.rewriteJsonl(proposals);

    // Update SQLite
    if (this.db) {
      try {
        this.db.prepare(
          'UPDATE proposals SET evaluation_id = ? WHERE proposal_id = ?',
        ).run(evaluationId, proposalId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to update evaluation_id in SQLite: ${message}`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Close the SQLite database connection if open.
   */
  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // Ignore close errors during shutdown
      }
      this.db = null;
    }
  }

  // -----------------------------------------------------------------------
  // JSONL helpers
  // -----------------------------------------------------------------------

  /**
   * Append a single proposal to the JSONL file.
   */
  private appendToJsonl(proposal: AgentProposal): void {
    this.ensureJsonlDirectory();
    const line = JSON.stringify(proposal) + '\n';
    fs.appendFileSync(this.jsonlPath, line, { encoding: 'utf-8' });
  }

  /**
   * Read all proposals from the JSONL file.
   *
   * Malformed lines are silently skipped (with a warning).
   */
  private readAllFromJsonl(): AgentProposal[] {
    if (!fs.existsSync(this.jsonlPath)) {
      return [];
    }

    const content = fs.readFileSync(this.jsonlPath, 'utf-8');
    const lines = content.split('\n');
    const proposals: AgentProposal[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '') continue;

      try {
        const parsed = JSON.parse(line) as AgentProposal;
        proposals.push(parsed);
      } catch {
        this.logger.warn(
          `Skipping malformed line ${i + 1} in ${this.jsonlPath}: ${line.substring(0, 80)}...`,
        );
      }
    }

    return proposals;
  }

  /**
   * Rewrite the entire JSONL file with the given proposals.
   *
   * Used for status updates and field modifications where in-place
   * update is required.
   */
  private rewriteJsonl(proposals: AgentProposal[]): void {
    this.ensureJsonlDirectory();
    const content = proposals.map((p) => JSON.stringify(p)).join('\n') + '\n';
    fs.writeFileSync(this.jsonlPath, content, { encoding: 'utf-8' });
  }

  /**
   * Ensure the parent directory for the JSONL file exists.
   */
  private ensureJsonlDirectory(): void {
    const dir = path.dirname(this.jsonlPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
