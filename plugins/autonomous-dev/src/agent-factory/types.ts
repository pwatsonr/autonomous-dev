/**
 * Shared types for the Agent Factory module (SPEC-005-1-1).
 *
 * Defines the schema for agent definition files: frontmatter fields,
 * validation structures, and role/tier enumerations.
 */

// ---------------------------------------------------------------------------
// Enums and literal types
// ---------------------------------------------------------------------------

/** The four agent roles in the pipeline. */
export type AgentRole = 'author' | 'executor' | 'reviewer' | 'meta';

/** Valid AgentRole values as a readonly tuple for runtime checks. */
export const AGENT_ROLES: readonly AgentRole[] = [
  'author',
  'executor',
  'reviewer',
  'meta',
] as const;

/** Risk tier classification for an agent definition. */
export type RiskTier = 'low' | 'medium' | 'high' | 'critical';

/** Valid RiskTier values as a readonly tuple for runtime checks. */
export const RISK_TIERS: readonly RiskTier[] = [
  'low',
  'medium',
  'high',
  'critical',
] as const;

// ---------------------------------------------------------------------------
// Agent definition sub-structures
// ---------------------------------------------------------------------------

/** A single dimension in the evaluation rubric. */
export interface QualityDimension {
  name: string;
  weight: number;
  description: string;
}

/** A single entry in the version history log. */
export interface VersionHistoryEntry {
  version: string;
  date: string;
  change: string;
}

// ---------------------------------------------------------------------------
// ParsedAgent — the fully-typed agent definition
// ---------------------------------------------------------------------------

/**
 * The typed representation of an agent `.md` file after parsing.
 * Frontmatter fields are mapped directly; the Markdown body becomes
 * `system_prompt`.
 */
export interface ParsedAgent {
  name: string;
  version: string;
  role: AgentRole;
  model: string;
  temperature: number;
  turn_limit: number;
  tools: string[];
  expertise: string[];
  evaluation_rubric: QualityDimension[];
  version_history: VersionHistoryEntry[];
  risk_tier?: RiskTier;
  frozen?: boolean;
  description: string;
  /** The Markdown body (everything after the second --- delimiter). */
  system_prompt: string;
}

// ---------------------------------------------------------------------------
// Parser result types
// ---------------------------------------------------------------------------

/** An error produced during frontmatter parsing. */
export interface ParserError {
  message: string;
  line?: number;
  field?: string;
}

/** Result of parsing an agent definition file. */
export interface ParsedAgentResult {
  success: boolean;
  agent?: ParsedAgent;
  errors: ParserError[];
}

// ---------------------------------------------------------------------------
// Validator types
// ---------------------------------------------------------------------------

/** Context passed to each validation rule. */
export interface ValidationContext {
  existingNames: Set<string>;
  filename?: string;
  modelRegistry?: Set<string>;
}

/** A single validation error/warning produced by a rule. */
export interface ValidationError {
  rule: string;
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

/** Alias: validation warnings share the same shape. */
export type ValidationWarning = ValidationError;

/** The aggregate result of running all validation rules. */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

/** A single validation rule: takes the agent and context, returns an error or null. */
export interface ValidationRule {
  id: string;
  field: string;
  validate: (agent: ParsedAgent, context: ValidationContext) => ValidationError | null;
}

// ---------------------------------------------------------------------------
// Integrity types (SPEC-005-1-2)
// ---------------------------------------------------------------------------

/** Result of integrity checking a single agent file. */
export interface FileIntegrityResult {
  filePath: string;
  passed: boolean;
  reason?: string;
  diskHash?: string;
  gitHash?: string;
  gitStatus?: string;
}

/** Aggregate result of integrity checking an agents directory. */
export interface IntegrityResult {
  passed: FileIntegrityResult[];
  rejected: FileIntegrityResult[];
  allPassed: boolean;
}

// ---------------------------------------------------------------------------
// Registry types (SPEC-005-1-2)
// ---------------------------------------------------------------------------

/** Lifecycle state of a registered agent. */
export type AgentState =
  | 'REGISTERED'
  | 'ACTIVE'
  | 'FROZEN'
  | 'UNDER_REVIEW'
  | 'VALIDATING'
  | 'CANARY'
  | 'PROMOTED'
  | 'REJECTED';

/** An agent stored in the registry with metadata. */
export interface AgentRecord {
  agent: ParsedAgent;
  state: AgentState;
  loadedAt: Date;
  diskHash: string;
  filePath: string;
}

/** Result of a registry load or reload operation. */
export interface RegistryLoadResult {
  loaded: number;
  rejected: number;
  errors: Array<{ file: string; reason: string }>;
  duration_ms: number;
}

/** An agent matched against a task query, with relevance score. */
export interface RankedAgent {
  agent: AgentRecord;
  score: number;
  matchType: 'exact' | 'semantic';
  matchedTags?: string[];
}

/** Options for the agent discovery function (SPEC-005-1-3). */
export interface DiscoveryOptions {
  similarityThreshold?: number;  // default 0.6
  maxResults?: number;           // default 5
}

// ---------------------------------------------------------------------------
// Audit types (SPEC-005-1-3)
// ---------------------------------------------------------------------------

/** Concrete audit event type identifiers. */
export type AuditEventType =
  | 'tool_call_blocked'
  | 'path_access_blocked'
  | 'integrity_check_failed'
  | 'agent_frozen'
  | 'agent_unfrozen'
  | 'agent_loaded'
  | 'agent_rejected'
  | 'registry_reloaded'
  | 'domain_gap_detected'
  // Improvement lifecycle events (SPEC-005-3-5)
  | 'analysis_triggered'
  | 'weakness_report_generated'
  | 'proposal_generated'
  | 'proposal_rejected_constraint_violation'
  | 'meta_review_completed'
  | 'meta_review_bypassed_self_referential'
  | 'modification_rate_limited'
  | 'agent_state_changed'
  // Autonomous promotion events (SPEC-005-5-3)
  | 'auto_promotion_ineligible'
  | 'agent_auto_promoted'
  | 'override_window_opened'
  | 'override_window_expired'
  | 'override_window_used'
  | 'auto_rollback_quality_decline'
  | 'auto_rollback_monitoring_started'
  | 'auto_rollback_monitoring_ended';

/** A single audit event written to the JSONL log. */
export interface AuditEvent {
  timestamp: string;           // ISO 8601
  event_type: AuditEventType;
  agent_name?: string;
  details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Runtime types (SPEC-005-1-3)
// ---------------------------------------------------------------------------

/** Result of a runtime hook execution. */
export interface HookResult {
  allowed: boolean;
  reason?: string;
}

/** Context passed to a runtime hook. */
export interface HookContext {
  agent: ParsedAgent;
  toolName: string;
  toolArgs: Record<string, unknown>;
  workingDirectory: string;
}

/** A runtime hook that intercepts tool calls or invocation events. */
export interface RuntimeHook {
  name: string;
  phase: 'pre_tool_call' | 'post_tool_call' | 'pre_invoke' | 'post_invoke';
  execute(context: HookContext): HookResult;
}

/** Context provided when invoking an agent through the runtime. */
export interface RuntimeContext {
  workingDirectory: string;
  sessionId?: string;
  parentAgent?: string;
}

/** Result of an agent runtime invocation. */
export interface RuntimeResult {
  success: boolean;
  output?: string;
  toolCallsBlocked: number;
  toolCallsAllowed: number;
  duration_ms: number;
}

/** Record of a tool call interception by the runtime. */
export interface ToolCallInterception {
  toolName: string;
  allowed: boolean;
  reason?: string;
  hookName: string;
  timestamp: string;
}

/** The public contract for the Agent Registry. */
export interface IAgentRegistry {
  load(agentsDir: string): Promise<RegistryLoadResult>;
  reload(agentsDir: string): Promise<RegistryLoadResult>;
  list(): AgentRecord[];
  get(name: string): AgentRecord | undefined;
  getForTask(taskDescription: string, taskDomain?: string): RankedAgent[];
  freeze(name: string): void;
  unfreeze(name: string): void;
  getState(name: string): AgentState | undefined;
  setState(name: string, state: AgentState): void;
  /** Transition agent state following the VALID_TRANSITIONS state machine (SPEC-005-4-5). */
  transition(name: string, targetState: AgentState): void;
}
