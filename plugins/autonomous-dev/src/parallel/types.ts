/**
 * Shared interfaces for the parallel execution engine.
 *
 * Covers data models from TDD Sections 3.1, 3.9.1, and 4.4:
 *   - WorktreeInfo: represents a single git worktree managed by the engine
 *   - PersistedExecutionState: top-level persisted state for a parallel-execution request
 *   - WorktreeStatus, DiskPressureLevel, ExecutionPhase: union/enum types
 */

/** Status of a managed worktree. */
export type WorktreeStatus = 'active' | 'merging' | 'removing' | 'orphaned';

/** Disk pressure classification for resource monitoring. */
export type DiskPressureLevel = 'normal' | 'warning' | 'critical';

/** Lifecycle phase of a parallel-execution request. */
export type ExecutionPhase =
  | 'initializing'
  | 'fan-out'
  | 'merging'
  | 'testing'
  | 'revising'
  | 'complete'
  | 'failed'
  | 'escalated';

/** Represents a single git worktree managed by the engine. */
export interface WorktreeInfo {
  requestId: string;
  trackName: string;
  /** Absolute path under worktreeRoot. */
  worktreePath: string;
  /** e.g. "auto/{requestId}/{trackName}" */
  branchName: string;
  /** e.g. "auto/{requestId}/integration" */
  integrationBranch: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  status: WorktreeStatus;
}

/** Top-level persisted state for a single parallel-execution request. */
export interface PersistedExecutionState {
  version: 1;
  requestId: string;
  baseBranch: string;
  integrationBranch: string;
  phase: ExecutionPhase;
  worktrees: Record<string, WorktreeInfo>;
  // Fields from other plans will extend this via module augmentation
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// DAG Data Model Types
// SPEC-006-2-1: DAG Data Model and Dependency Extraction
// ============================================================================

/**
 * Represents a single node in the dependency DAG,
 * corresponding to one implementation spec.
 */
export interface DAGNode {
  specName: string;
  specPath: string;
  complexity: 'small' | 'medium' | 'large';
  estimatedMinutes: number;       // small=5, medium=15, large=30
  priority: number;               // base + critical path bonus + dependency bonus
  basePriority: number;           // priority before bonuses
  inDegree: number;               // count of incoming edges (dependencies)
  outDegree: number;              // count of outgoing edges (dependents)
  cluster: number;                // assigned cluster index, -1 if unassigned
  filesModified: string[];        // declared file modification list from spec
  interfacesProduced: string[];   // interface names this spec produces
  interfacesConsumed: string[];   // interface names this spec consumes
  dependsOn: string[];            // explicit dependency declarations
}

/**
 * Classification of how a dependency was discovered.
 *
 * - `explicit`: declared via `dependsOn` in the spec metadata
 * - `file-overlap`: two specs modify the same file
 * - `interface-contract`: one spec produces an interface another consumes
 */
export type DependencyType = 'explicit' | 'file-overlap' | 'interface-contract';

/**
 * A directed edge in the DAG representing a dependency relationship.
 * `from` must complete before `to` can start.
 */
export interface DAGEdge {
  from: string;   // specName of the dependency (must complete first)
  to: string;     // specName of the dependent
  type: DependencyType;
  reason: string; // human-readable explanation
}

/**
 * A group of specs that can potentially execute together
 * once their cluster-level dependencies are satisfied.
 */
export interface DAGCluster {
  index: number;
  nodes: string[];       // specNames in this cluster
  dependsOnClusters: number[];  // cluster indices that must complete before this one
}

/**
 * The complete dependency DAG for a set of specs.
 */
export interface DependencyDAG {
  requestId: string;
  nodes: Map<string, DAGNode>;
  edges: DAGEdge[];
  reducedEdges: DAGEdge[];   // after transitive reduction
  originalEdges: DAGEdge[];  // before reduction (audit log)
  clusters: DAGCluster[];
  criticalPath: string[];    // ordered specNames on the longest path
  validated: boolean;
}

/**
 * Input metadata for a single spec, consumed by the DAG constructor.
 */
export interface SpecMetadata {
  name: string;                     // unique spec name
  path?: string;                    // file path to spec
  complexity?: 'small' | 'medium' | 'large';
  dependsOn?: string[];             // explicit dependency declarations
  filesModified?: string[];         // files this spec will modify
  interfacesProduced?: string[];    // interfaces this spec exports
  interfacesConsumed?: string[];    // interfaces this spec imports
  estimatedMinutes?: number;        // override for default complexity-based estimate
}

// ============================================================================
// Agent Lifecycle and Track Assignment Types
// SPEC-006-3-1: Track Assignment Types and Context Bundle Preparation
// ============================================================================

/**
 * Lifecycle phase of a single agent executing a spec within a worktree.
 */
export enum AgentLifecyclePhase {
  Spawning = 'spawning',
  Executing = 'executing',
  Testing = 'testing',
  Reviewing = 'reviewing',
  Committing = 'committing',
  Complete = 'complete',
  Failed = 'failed',
}

/**
 * Describes a contract between two tracks: one produces an interface,
 * the other consumes it.
 */
export interface InterfaceContract {
  producer: string;           // specName of the producing track
  consumer: string;           // specName of the consuming track
  contractType: 'type-definition' | 'function-signature' | 'api-endpoint';
  definition: string;         // the interface definition text (e.g., TypeScript type)
  filePath: string;           // where the definition lives
}

/**
 * Full assignment record for a single track, including spec context,
 * parent document references, turn budget, lifecycle state, and contracts.
 */
export interface TrackAssignment {
  trackName: string;
  worktreePath: string;
  branchName: string;         // e.g. "auto/req-001/track-a"
  agentSessionId: string | null;
  spec: SpecMetadata;
  parentPlan: string;         // path to parent plan document
  parentTDD: string;          // path to parent TDD document
  parentPRD: string;          // path to parent PRD document
  turnBudget: number;
  turnsUsed: number;
  retryCount: number;
  lifecyclePhase: AgentLifecyclePhase;
  interfaceContracts: InterfaceContract[];
  lastActivityAt: string;     // ISO-8601
  startedAt: string | null;
  completedAt: string | null;
}

/**
 * The structured prompt bundle injected into each agent session.
 * Contains everything the agent needs to execute its spec without
 * cross-track communication.
 */
export interface ContextBundle {
  systemPrompt: string;       // instructions about scope, isolation, commit format
  specContent: string;        // full spec document content
  parentExcerpts: {
    plan: string;             // relevant sections of parent plan
    tdd: string;              // relevant sections of parent TDD
    prd: string;              // relevant sections of parent PRD
  };
  turnBudget: number;
  complexity: 'small' | 'medium' | 'large';
  interfaceContracts: InterfaceContract[];
  sharedTypeDefinitions: string[];  // contents of shared type files from integration branch
  commitFormat: string;       // template for commit messages
  workingDirectory: string;   // absolute path to worktree
}

/**
 * Represents a live agent session managed by the AgentSpawner.
 */
export interface AgentSession {
  sessionId: string;
  trackName: string;
  process: SubagentProcess;
  assignment: TrackAssignment;
}

/**
 * Minimal interface for a subagent process handle.
 * The actual implementation depends on the Claude Code SDK.
 */
export interface SubagentProcess {
  id: string;
  terminate(): Promise<void>;
}

// ============================================================================
// Merge Types
// SPEC-006-4-1: Merge Types, Ordering Logic, and Core Merge Sequence
// ============================================================================

/**
 * Result of merging a single track branch into the integration branch.
 */
export interface MergeResult {
  trackName: string;
  integrationBranch: string;
  trackBranch: string;
  mergeCommitSha: string | null;   // null if merge failed
  conflictCount: number;
  conflicts: ConflictDetail[];
  resolutionStrategy: 'clean' | 'auto-resolved' | 'ai-resolved' | 'escalated' | 'failed';
  resolutionDurationMs: number;
  timestamp: string;
}

/**
 * Details about a single conflicted file during a merge.
 */
export interface ConflictDetail {
  file: string;
  conflictType: ConflictType;
  resolution: 'auto' | 'ai' | 'human' | 'unresolved';
  confidence: number;          // 0.0 - 1.0
  resolvedContent?: string;    // the final merged content (for audit)
}

/**
 * Classification of merge conflict types, from simplest to most complex.
 */
export enum ConflictType {
  Disjoint = 'disjoint',
  NonOverlapping = 'non-overlapping',
  OverlappingCompatible = 'overlapping-compatible',
  OverlappingConflicting = 'overlapping-conflicting',
  Structural = 'structural',
}

/**
 * Persistent record of a conflict and its resolution, used for audit logging.
 */
export interface ConflictRecord {
  id: string;                    // unique identifier
  requestId: string;
  file: string;
  trackA: string;                // the integration branch side
  trackB: string;                // the track being merged
  conflictType: ConflictType;
  resolutionStrategy: 'auto' | 'ai' | 'human';
  aiConfidence: number | null;
  resolution: string;            // the resolved content or description
  integrationTestsPassed: boolean | null;  // populated after integration tests
  timestamp: string;
}

/**
 * Input to the conflict resolution pipeline for a single conflicted file.
 */
export interface ConflictResolutionRequest {
  file: string;
  requestId: string;
  trackA: string;
  trackB: string;
  baseContent: string;     // git stage 1 (common ancestor)
  oursContent: string;     // git stage 2 (integration branch)
  theirsContent: string;   // git stage 3 (track branch)
  specA: string;           // spec for trackA
  specB: string;           // spec for trackB
  interfaceContracts: InterfaceContract[];
}

/**
 * Output from the conflict resolution pipeline for a single file.
 */
export interface ConflictResolutionResult {
  resolvedContent: string;
  confidence: number;
  reasoning: string;
  strategy: 'auto' | 'ai' | 'human';
}
