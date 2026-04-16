/**
 * Agent Registry core (SPEC-005-1-2, Task 4).
 *
 * Central in-memory catalog of all validated agents. Orchestrates the
 * full loading sequence: scan -> verify -> parse -> validate -> uniqueness
 * -> register, and exposes lifecycle management (freeze/unfreeze, state
 * transitions, task-based discovery).
 *
 * Implements the `IAgentRegistry` interface defined in types.ts.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  ParsedAgent,
  AgentRecord,
  AgentState,
  RegistryLoadResult,
  RankedAgent,
  IAgentRegistry,
  ValidationContext,
} from './types';

import { parseAgentFile } from './parser';
import { validateAgentWithContext } from './validator';
import { checkIntegrity } from './integrity';
import type { ValidationResult } from './types';

// Re-export for convenience
export type { RegistryLoadResult };

// ---------------------------------------------------------------------------
// Security logging (mirrors integrity.ts pattern)
// ---------------------------------------------------------------------------

function logRegistryEvent(eventType: string, details: Record<string, unknown>): void {
  const event = {
    timestamp: new Date().toISOString(),
    eventType,
    ...details,
  };
  process.stderr.write(`[REGISTRY] ${JSON.stringify(event)}\n`);
}

// ---------------------------------------------------------------------------
// Valid state transitions (SPEC-005-4-5, Task 14)
// ---------------------------------------------------------------------------

/**
 * State machine defining valid agent lifecycle transitions.
 *
 * - REGISTERED -> ACTIVE, FROZEN
 * - ACTIVE -> FROZEN, UNDER_REVIEW
 * - FROZEN -> ACTIVE
 * - UNDER_REVIEW -> VALIDATING, ACTIVE (rejected/cancelled)
 * - VALIDATING -> PROMOTED, REJECTED, CANARY (CANARY from PLAN-005-5)
 * - CANARY -> PROMOTED, REJECTED (from PLAN-005-5)
 * - PROMOTED -> ACTIVE (transient state)
 * - REJECTED -> ACTIVE (returns to active)
 */
const VALID_TRANSITIONS: Record<AgentState, AgentState[]> = {
  'REGISTERED':   ['ACTIVE', 'FROZEN'],
  'ACTIVE':       ['FROZEN', 'UNDER_REVIEW'],
  'FROZEN':       ['ACTIVE'],
  'UNDER_REVIEW': ['VALIDATING', 'ACTIVE'],
  'VALIDATING':   ['PROMOTED', 'REJECTED', 'CANARY'],
  'CANARY':       ['PROMOTED', 'REJECTED'],
  'PROMOTED':     ['ACTIVE'],
  'REJECTED':     ['ACTIVE'],
};

// ---------------------------------------------------------------------------
// AgentRegistry
// ---------------------------------------------------------------------------

/**
 * The Agent Registry: in-memory catalog of validated agent definitions.
 *
 * Usage:
 * ```ts
 * const registry = new AgentRegistry();
 * const result = await registry.load('./agents');
 * const agent = registry.get('code-executor');
 * ```
 */
export class AgentRegistry implements IAgentRegistry {
  /** Agent records keyed by agent name. */
  private agents: Map<string, AgentRecord> = new Map();

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /**
   * Load agents from the given directory through the full 6-step pipeline.
   *
   * Steps:
   *   1. Scan: glob `agents/*.md` to discover files.
   *   2. Verify: run integrity checker; remove rejected files.
   *   3. Parse: run parser on each verified file; remove files with errors.
   *   4. Validate: run validator on each parsed agent; remove invalid ones.
   *   5. Uniqueness: final uniqueness check (safety net over RULE_001).
   *   6. Register: insert into the in-memory map with appropriate state.
   *
   * @param agentsDir  Path to the directory containing agent `.md` files.
   * @returns          RegistryLoadResult with counts and error details.
   */
  async load(agentsDir: string): Promise<RegistryLoadResult> {
    const startTime = Date.now();
    const resolvedDir = path.resolve(agentsDir);
    const errors: Array<{ file: string; reason: string }> = [];

    // Step 1: Scan — discover all .md files
    const mdFiles = this.scanAgentFiles(resolvedDir);
    if (mdFiles.length === 0) {
      return {
        loaded: 0,
        rejected: 0,
        errors: [],
        duration_ms: Date.now() - startTime,
      };
    }

    // Step 2: Verify — run integrity checker
    const integrityResult = checkIntegrity(resolvedDir);
    const verifiedPaths = new Set(integrityResult.passed.map((r) => r.filePath));

    // Collect rejection errors from integrity
    for (const rejected of integrityResult.rejected) {
      errors.push({
        file: rejected.filePath,
        reason: `integrity: ${rejected.reason ?? 'unknown'}`,
      });
    }

    // Filter to only verified files
    const verifiedFiles = mdFiles.filter((f) => verifiedPaths.has(f));

    // Step 3: Parse — run parser on each verified file
    const parsedAgents: Array<{ filePath: string; agent: ParsedAgent; diskHash: string }> = [];

    for (const filePath of verifiedFiles) {
      const parseResult = parseAgentFile(filePath);
      if (!parseResult.success || !parseResult.agent) {
        const reasons = parseResult.errors.map((e) => e.message).join('; ');
        errors.push({ file: filePath, reason: `parse: ${reasons}` });
        continue;
      }

      // Compute disk hash for the record
      const content = fs.readFileSync(filePath, 'utf-8');
      const diskHash = crypto.createHash('sha256').update(content).digest('hex');

      parsedAgents.push({ filePath, agent: parseResult.agent, diskHash });
    }

    // Step 4: Validate — run validator on each parsed agent
    const existingNames = new Set<string>();
    const validatedAgents: Array<{ filePath: string; agent: ParsedAgent; diskHash: string }> = [];

    for (const entry of parsedAgents) {
      const ctx: ValidationContext = {
        existingNames,
        filename: path.basename(entry.filePath),
      };

      const validationResult: ValidationResult = validateAgentWithContext(entry.agent, ctx);
      if (!validationResult.valid) {
        const reasons = validationResult.errors.map((e) => `${e.rule}: ${e.message}`).join('; ');
        errors.push({ file: entry.filePath, reason: `validation: ${reasons}` });
        continue;
      }

      existingNames.add(entry.agent.name);
      validatedAgents.push(entry);
    }

    // Step 5: Uniqueness check — safety net over RULE_001
    const seenNames = new Map<string, string>(); // name -> filePath
    const uniqueAgents: Array<{ filePath: string; agent: ParsedAgent; diskHash: string }> = [];

    for (const entry of validatedAgents) {
      const existing = seenNames.get(entry.agent.name);
      if (existing) {
        errors.push({
          file: entry.filePath,
          reason: `uniqueness: agent name '${entry.agent.name}' already registered from ${existing}`,
        });
        continue;
      }
      seenNames.set(entry.agent.name, entry.filePath);
      uniqueAgents.push(entry);
    }

    // Step 6: Register — insert into the in-memory map
    for (const entry of uniqueAgents) {
      const initialState: AgentState = entry.agent.frozen === true ? 'FROZEN' : 'ACTIVE';

      const record: AgentRecord = {
        agent: entry.agent,
        state: initialState,
        loadedAt: new Date(),
        diskHash: entry.diskHash,
        filePath: entry.filePath,
      };

      this.agents.set(entry.agent.name, record);
    }

    const result: RegistryLoadResult = {
      loaded: uniqueAgents.length,
      rejected: errors.length,
      errors,
      duration_ms: Date.now() - startTime,
    };

    logRegistryEvent('registry_loaded', {
      loaded: result.loaded,
      rejected: result.rejected,
      duration_ms: result.duration_ms,
    });

    return result;
  }

  /**
   * Clear the existing registry and re-run the full loading sequence.
   *
   * @param agentsDir  Path to the directory containing agent `.md` files.
   * @returns          RegistryLoadResult reflecting the new state.
   */
  async reload(agentsDir: string): Promise<RegistryLoadResult> {
    logRegistryEvent('registry_reload_started', { agentsDir });
    this.agents.clear();
    return this.load(agentsDir);
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  /**
   * Return all registered agent records.
   */
  list(): AgentRecord[] {
    return Array.from(this.agents.values());
  }

  /**
   * Return a single agent record by exact name match.
   *
   * @param name  The agent name (must match `ParsedAgent.name` exactly).
   * @returns     The AgentRecord, or undefined if not found.
   */
  get(name: string): AgentRecord | undefined {
    return this.agents.get(name);
  }

  /**
   * Find agents suitable for a task via two-pass matching.
   *
   * Pass 1 (exact): Match agents whose `expertise` tags contain the
   * `taskDomain` string (case-insensitive).
   *
   * Pass 2 (semantic): Compute a simple token-overlap similarity between
   * the `taskDescription` and each agent's `description` + `expertise`.
   * Agents scoring above the threshold (0.6) are included.
   *
   * Results are sorted by score descending. Only ACTIVE agents are
   * considered (FROZEN agents are excluded).
   *
   * @param taskDescription  Free-text description of the task.
   * @param taskDomain       Optional domain tag for exact matching.
   * @returns                Ranked agents sorted by relevance.
   */
  getForTask(taskDescription: string, taskDomain?: string): RankedAgent[] {
    const SIMILARITY_THRESHOLD = 0.6;
    const results: RankedAgent[] = [];
    const seen = new Set<string>();

    const activeAgents = this.list().filter((r) => r.state === 'ACTIVE');

    // Pass 1: exact tag matching
    if (taskDomain) {
      const domainLower = taskDomain.toLowerCase();
      for (const record of activeAgents) {
        const hasMatch = record.agent.expertise.some(
          (tag) => tag.toLowerCase() === domainLower,
        );
        if (hasMatch) {
          results.push({ agent: record, score: 1.0, matchType: 'exact' });
          seen.add(record.agent.name);
        }
      }
    }

    // Pass 2: semantic similarity (token overlap)
    const taskTokens = tokenize(taskDescription);

    for (const record of activeAgents) {
      if (seen.has(record.agent.name)) continue;

      const agentText = [
        record.agent.description,
        ...record.agent.expertise,
      ].join(' ');
      const agentTokens = tokenize(agentText);

      const score = computeTokenOverlap(taskTokens, agentTokens);
      if (score >= SIMILARITY_THRESHOLD) {
        results.push({ agent: record, score, matchType: 'semantic' });
        seen.add(record.agent.name);
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  // -------------------------------------------------------------------------
  // State management
  // -------------------------------------------------------------------------

  /**
   * Freeze an agent, setting its state to FROZEN.
   *
   * Guards:
   *   - Agent must exist.
   *   - Agent must not already be FROZEN.
   *
   * @throws Error if the agent does not exist or is already frozen.
   */
  freeze(name: string): void {
    const record = this.agents.get(name);
    if (!record) {
      throw new Error(`Cannot freeze: agent '${name}' not found in registry`);
    }
    if (record.state === 'FROZEN') {
      throw new Error(`Cannot freeze: agent '${name}' is already FROZEN`);
    }

    const previousState = record.state;
    record.state = 'FROZEN';
    logRegistryEvent('agent_frozen', { name, previousState });
  }

  /**
   * Unfreeze an agent, setting its state to ACTIVE.
   *
   * Guards:
   *   - Agent must exist.
   *   - Agent must be in FROZEN state.
   *
   * @throws Error if the agent does not exist or is not frozen.
   */
  unfreeze(name: string): void {
    const record = this.agents.get(name);
    if (!record) {
      throw new Error(`Cannot unfreeze: agent '${name}' not found in registry`);
    }
    if (record.state !== 'FROZEN') {
      throw new Error(`Cannot unfreeze: agent '${name}' is not FROZEN (current state: ${record.state})`);
    }

    record.state = 'ACTIVE';
    logRegistryEvent('agent_unfrozen', { name });
  }

  /**
   * Transition an agent from ACTIVE to UNDER_REVIEW.
   *
   * Guards:
   *   1. Agent must exist.
   *   2. Agent must be in ACTIVE state.
   *
   * Caller is responsible for verifying observation threshold and rate
   * limits before invoking this method.
   *
   * @param name  The agent name to transition.
   * @throws Error if agent not found or not in ACTIVE state.
   */
  transitionToUnderReview(name: string): void {
    const record = this.agents.get(name);
    if (!record) {
      throw new Error(`Agent '${name}' not found`);
    }

    if (record.state !== 'ACTIVE') {
      throw new Error(
        `Cannot transition '${name}' to UNDER_REVIEW: current state is ${record.state} (must be ACTIVE)`,
      );
    }

    const previousState = record.state;
    record.state = 'UNDER_REVIEW';
    logRegistryEvent('agent_state_changed', {
      name,
      from: previousState,
      to: 'UNDER_REVIEW',
    });
  }

  /**
   * Get the current state of an agent.
   *
   * @param name  The agent name.
   * @returns     The AgentState, or undefined if not found.
   */
  getState(name: string): AgentState | undefined {
    return this.agents.get(name)?.state;
  }

  /**
   * Set the state of an agent directly.
   *
   * This is the low-level state setter. For freeze/unfreeze use the
   * dedicated methods which include guards and audit logging.
   *
   * @param name   The agent name.
   * @param state  The new state.
   * @throws Error if the agent does not exist.
   */
  setState(name: string, state: AgentState): void {
    const record = this.agents.get(name);
    if (!record) {
      throw new Error(`Cannot set state: agent '${name}' not found in registry`);
    }

    const previousState = record.state;
    record.state = state;
    logRegistryEvent('agent_state_changed', { name, previousState, newState: state });
  }

  /**
   * Transition an agent's state following the VALID_TRANSITIONS state machine.
   *
   * Unlike `setState`, this method enforces state machine rules: only
   * transitions listed in `VALID_TRANSITIONS` are permitted. Invalid
   * transitions throw a descriptive error.
   *
   * All transitions are logged to the audit log via `logRegistryEvent`.
   *
   * @param name         The agent name.
   * @param targetState  The target state to transition to.
   * @throws Error if the agent does not exist or the transition is invalid.
   */
  transition(name: string, targetState: AgentState): void {
    const record = this.agents.get(name);
    if (!record) {
      throw new Error(`Agent '${name}' not found`);
    }

    const allowed = VALID_TRANSITIONS[record.state];
    if (!allowed || !allowed.includes(targetState)) {
      throw new Error(
        `Invalid state transition for '${name}': ${record.state} -> ${targetState}. ` +
        `Allowed transitions: ${allowed?.join(', ') || 'none'}`,
      );
    }

    const from = record.state;
    record.state = targetState;

    logRegistryEvent('agent_state_changed', {
      name,
      from,
      to: targetState,
    });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Scan a directory for `.md` agent files.
   * Returns absolute paths, sorted alphabetically.
   */
  private scanAgentFiles(dir: string): string[] {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return [];
    }

    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => path.join(dir, f));
  }
}

// ---------------------------------------------------------------------------
// Text similarity utilities (lightweight, no external deps)
// ---------------------------------------------------------------------------

/**
 * Tokenize a string into lowercase word tokens, removing punctuation.
 */
function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1); // drop single chars
  return new Set(words);
}

/**
 * Compute the Jaccard-like token overlap between two token sets.
 *
 * Returns a score in [0, 1]. This is a lightweight approximation of
 * semantic similarity using shared vocabulary.
 */
function computeTokenOverlap(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection++;
    }
  }

  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}
