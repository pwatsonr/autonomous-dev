# SPEC-005-1-3: Agent Discovery, Runtime Enforcement, and Audit Log

## Metadata
- **Parent Plan**: PLAN-005-1
- **Tasks Covered**: Task 5 (Agent discovery: domain matching), Task 6 (Runtime wrapper: tool access enforcement), Task 7 (Runtime wrapper: path filtering), Task 8 (Audit log writer)
- **Estimated effort**: 24 hours

## Description

Implement agent discovery with two-pass domain matching (exact + semantic), the Agent Runtime wrapper that intercepts and enforces tool access and path restrictions at invocation time, and the append-only JSONL audit log that records all security-relevant events. These components work together: discovery finds the right agent, runtime enforces its boundaries, and audit records violations.

## Files to Create/Modify

### New Files

**`src/agent-factory/discovery.ts`**
- Exports: `discoverAgents(query: string, registry: AgentRecord[], options?: DiscoveryOptions): RankedAgent[]`
- Exports: `computeSimilarity(textA: string, textB: string): number`

**`src/agent-factory/runtime.ts`**
- Exports: `AgentRuntime` class wrapping agent execution with pre/post hooks
- Exports: `ToolAccessEnforcer` (pre-tool-call hook)
- Exports: `PathFilter` (pre-tool-call hook for file operations)

**`src/agent-factory/audit.ts`**
- Exports: `AuditLogger` class with `log(event: AuditEvent): void`
- Exports: `AuditEvent` type and subtypes

### Modified Files

**`src/agent-factory/types.ts`** (extend)
- Add: `RankedAgent`, `DiscoveryOptions`, `AuditEvent`, `ToolCallInterception`

## Implementation Details

### Agent Discovery (`discovery.ts`)

**Two-pass matching algorithm:**

**Pass 1 -- Exact tag match (fast path):**
- Extract domain keywords from the query string (split on whitespace, lowercase, remove stop words).
- For each agent, check if any keyword appears in the agent's `expertise` array (case-insensitive exact match).
- Score: number of matching expertise tags / total query keywords. Agents with score > 0 proceed.
- Return agents sorted by score descending.

**Pass 2 -- Semantic similarity (fallback):**
- Only executed if Pass 1 returns no results above a configurable threshold (default 0.6).
- For each agent, compute cosine similarity between:
  - Query text (task description)
  - Agent text (concatenation of `description` + expertise tags joined by space)
- Use a lightweight TF-IDF approach:
  1. Build a vocabulary from all agent descriptions + the query.
  2. Compute TF-IDF vectors for query and each agent text.
  3. Compute cosine similarity between query vector and each agent vector.
- Return agents sorted by similarity score descending.

**Domain gap detection:**
- If no agent exceeds the similarity threshold (default 0.6) in either pass, return an empty array and emit a `domain_gap_detected` event to the audit log.

```typescript
interface RankedAgent {
  agent: AgentRecord;
  score: number;
  matchType: 'exact' | 'semantic';
  matchedTags?: string[];
}

interface DiscoveryOptions {
  similarityThreshold?: number;  // default 0.6
  maxResults?: number;           // default 5
}
```

### Agent Runtime (`runtime.ts`)

The `AgentRuntime` wraps agent invocation, intercepting tool calls before they execute.

```typescript
class AgentRuntime {
  constructor(
    private agent: AgentRecord,
    private auditLogger: AuditLogger,
    private hooks: RuntimeHook[]
  ) {}

  async invoke(input: string, context: RuntimeContext): Promise<RuntimeResult> {
    // Pre-invocation setup
    // Execute agent with tool call interception
    // Post-invocation cleanup and metrics emission
  }
}

interface RuntimeHook {
  name: string;
  phase: 'pre_tool_call' | 'post_tool_call' | 'pre_invoke' | 'post_invoke';
  execute(context: HookContext): HookResult;
}

interface HookResult {
  allowed: boolean;
  reason?: string;
}
```

**Tool Access Enforcer (pre-tool-call hook):**

Before every tool call, check if the tool name is in the agent's `tools` array.

```
ToolAccessEnforcer.execute(context):
  if context.toolName NOT IN context.agent.tools:
    auditLogger.log({
      type: 'tool_call_blocked',
      agentName: context.agent.name,
      toolName: context.toolName,
      reason: `Tool '${context.toolName}' is not authorized for agent '${context.agent.name}' (role: ${context.agent.role})`
    })
    return { allowed: false, reason: "Tool not authorized" }
  return { allowed: true }
```

**Path Filter (pre-tool-call hook for Bash, Edit, Write):**

For file-operation tools, extract the target path and reject operations on protected directories.

Protected path patterns:
- `agents/**` (agent definitions)
- `data/agent-*` (agent data files)
- `data/metrics/**` (metrics data)

```
PathFilter.execute(context):
  if context.toolName NOT IN ['Bash', 'Edit', 'Write']:
    return { allowed: true }

  targetPath = extractTargetPath(context.toolName, context.toolArgs)
  normalizedPath = path.resolve(targetPath)  // resolve ../

  for each pattern in PROTECTED_PATTERNS:
    if minimatch(normalizedPath, pattern):
      auditLogger.log({
        type: 'path_access_blocked',
        agentName: context.agent.name,
        toolName: context.toolName,
        targetPath: targetPath,
        normalizedPath: normalizedPath,
        pattern: pattern
      })
      return { allowed: false, reason: `Access to '${targetPath}' is blocked (protected path)` }

  return { allowed: true }
```

**Path extraction per tool:**
- `Edit`: extract from `file_path` parameter
- `Write`: extract from `file_path` parameter
- `Bash`: extract file paths from command string using regex patterns for common operations (`cd`, `cat`, `echo >`, `rm`, `mv`, `cp`, `touch`). For ambiguous Bash commands, apply the path filter to the working directory if it matches a protected pattern.

**Path traversal handling:**
- Always `path.resolve()` relative paths against the working directory before matching.
- `../agents/foo.md` from any subdirectory resolves to the actual agents path and is blocked.

### Audit Logger (`audit.ts`)

Append-only JSONL writer for security and operational events.

```typescript
interface AuditEvent {
  timestamp: string;           // ISO 8601
  event_type: string;
  agent_name?: string;
  details: Record<string, unknown>;
}

// Concrete event types:
type AuditEventType =
  | 'tool_call_blocked'
  | 'path_access_blocked'
  | 'integrity_check_failed'
  | 'agent_frozen'
  | 'agent_unfrozen'
  | 'agent_loaded'
  | 'agent_rejected'
  | 'registry_reloaded'
  | 'domain_gap_detected';
```

**File handling:**
- Open `data/agent-audit.log` in append mode (`fs.openSync(path, 'a')`).
- Write one JSON object per line followed by `\n`.
- No truncate, delete, or overwrite operations.
- On write failure (e.g., disk full), log to stderr and continue (do not crash the system).
- File created on first write if it does not exist.

**JSONL format (one line per event):**
```json
{"timestamp":"2026-04-08T12:00:00.000Z","event_type":"tool_call_blocked","agent_name":"prd-author","details":{"tool":"Bash","reason":"Tool not authorized"}}
```

## Acceptance Criteria

1. Pass 1 discovery returns agents with exact expertise tag matches, sorted by match count.
2. Pass 2 discovery computes TF-IDF cosine similarity and returns agents above threshold.
3. Domain gap emitted when no agent exceeds 0.6 threshold.
4. Tool access enforcer blocks calls to tools not in the agent's `tools` list.
5. `tool_call_blocked` event logged with agent name, tool name, and reason.
6. Path filter blocks operations targeting `agents/**`, `data/agent-*`, `data/metrics/**`.
7. Path filter handles traversal attempts (e.g., `../agents/`).
8. `path_access_blocked` event logged with full details including normalized path.
9. Audit logger writes one JSON object per line in append mode.
10. Audit log file is never truncated or overwritten.
11. Each audit event includes ISO 8601 timestamp, event type, and event-specific details.

## Test Cases

### Discovery Unit Tests

```
test_exact_match_single_tag
  Input: query="typescript", agents with expertise=["typescript", "nodejs"] and ["python"]
  Expected: first agent ranked higher, matchType="exact"

test_exact_match_multiple_tags
  Input: query="typescript testing", agent with expertise=["typescript", "testing"]
  Expected: score reflects 2/2 matches

test_exact_match_case_insensitive
  Input: query="TypeScript", agent with expertise=["typescript"]
  Expected: match found

test_semantic_fallback_no_exact_match
  Input: query="web application security", no agents with exact tag match
  Expected: Pass 2 executes, returns agents ranked by cosine similarity

test_domain_gap_no_match_above_threshold
  Input: query="quantum computing", no agents with relevant expertise
  Expected: empty array returned, domain_gap_detected event logged

test_max_results_limit
  Input: 10 matching agents, maxResults=3
  Expected: only top 3 returned

test_similarity_threshold_respected
  Input: agents scoring 0.5 and 0.7, threshold=0.6
  Expected: only 0.7 agent returned
```

### Tool Access Enforcer Unit Tests

```
test_authorized_tool_allowed
  Input: agent with tools=["Read", "Glob"], tool call for "Read"
  Expected: allowed=true

test_unauthorized_tool_blocked
  Input: agent with tools=["Read", "Glob"], tool call for "Bash"
  Expected: allowed=false, audit event logged

test_reviewer_cannot_edit
  Input: reviewer agent (tools=["Read","Glob","Grep"]), tool call for "Edit"
  Expected: allowed=false

test_executor_can_edit
  Input: executor agent (tools include "Edit"), tool call for "Edit"
  Expected: allowed=true
```

### Path Filter Unit Tests

```
test_block_agents_directory
  Input: Edit tool targeting "agents/prd-author.md"
  Expected: allowed=false, reason contains "protected path"

test_block_agent_data_files
  Input: Write tool targeting "data/agent-metrics.db"
  Expected: allowed=false

test_block_metrics_directory
  Input: Bash tool targeting "data/metrics/agent-invocations.jsonl"
  Expected: allowed=false

test_allow_src_directory
  Input: Edit tool targeting "src/foo.ts"
  Expected: allowed=true

test_block_path_traversal
  Input: Edit tool targeting "../agents/prd-author.md" from src/
  Expected: allowed=false (resolved path is agents/prd-author.md)

test_block_bash_cd_to_agents
  Input: Bash command "cd agents && cat prd-author.md"
  Expected: allowed=false

test_allow_non_file_bash_commands
  Input: Bash command "echo hello"
  Expected: allowed=true
```

### Audit Logger Unit Tests

```
test_append_single_event
  Action: log one event
  Expected: file contains one JSON line with timestamp, event_type, details

test_append_multiple_events
  Action: log 3 events
  Expected: file contains 3 JSON lines, each parseable

test_creates_file_on_first_write
  Setup: audit log file does not exist
  Action: log one event
  Expected: file created, contains the event

test_never_truncates
  Setup: file with existing content
  Action: log one event
  Expected: existing content preserved, new event appended

test_valid_json_per_line
  Action: log event, read file, parse each line
  Expected: every line is valid JSON with required fields

test_timestamp_is_iso8601
  Action: log event
  Expected: timestamp field matches ISO 8601 pattern
```

### Security Integration Tests

```
test_tool_enforcement_end_to_end
  Setup: Load reviewer agent via registry
  Action: Invoke agent, attempt Edit tool call
  Expected: Edit blocked, audit log contains tool_call_blocked entry

test_path_enforcement_end_to_end
  Setup: Load executor agent via registry
  Action: Invoke agent, attempt Write to agents/foo.md
  Expected: Write blocked, audit log contains path_access_blocked entry

test_path_traversal_end_to_end
  Setup: Load executor agent
  Action: Attempt Bash command with "../agents/meta-reviewer.md"
  Expected: Blocked, audit log records the attempt with normalized path
```
