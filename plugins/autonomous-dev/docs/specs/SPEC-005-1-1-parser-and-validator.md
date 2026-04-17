# SPEC-005-1-1: Agent Definition Parser and Schema Validator

## Metadata
- **Parent Plan**: PLAN-005-1
- **Tasks Covered**: Task 1 (Agent definition frontmatter parser), Task 2 (Schema validator)
- **Estimated effort**: 14 hours

## Description

Implement the two-stage parsing and validation pipeline for agent `.md` files. The parser extracts YAML frontmatter into a typed `ParsedAgent` structure, separating it from the Markdown body. The validator enforces all 10 schema rules from TDD 3.1.2 against the parsed output, producing specific, actionable error messages for each violation.

These two components are the single entry point for all agent definition processing. Every agent file must pass through parser then validator before it can be registered.

## Files to Create/Modify

### New Files

**`src/agent-factory/parser.ts`**
- Exports: `parseAgentFile(filePath: string): ParsedAgentResult`
- Exports: `parseAgentString(content: string): ParsedAgentResult`
- Imports: `yaml` (YAML parser library), types from `./types.ts`

**`src/agent-factory/validator.ts`**
- Exports: `validateAgent(parsed: ParsedAgent, existingNames?: Set<string>): ValidationResult`
- Exports: `VALIDATION_RULES: ValidationRule[]` (for introspection/testing)
- Imports: types from `./types.ts`

**`src/agent-factory/types.ts`** (shared types, extended by later specs)
- Exports: `ParsedAgent`, `ParsedAgentResult`, `ValidationResult`, `ValidationError`, `ValidationRule`, `AgentRole`, `RiskTier`, `QualityDimension`, `VersionHistoryEntry`

## Implementation Details

### Parser (`parser.ts`)

1. **Frontmatter extraction**: Detect YAML frontmatter delimited by `---` at the start of the file. Extract the block between the first and second `---` lines. Everything after the second `---` is the Markdown body.

2. **YAML parsing**: Parse the extracted YAML string into a raw object. On YAML syntax error, return a `ParsedAgentResult` with `success: false` and a `ParserError` containing the YAML error message and line number.

3. **Type coercion**: Map raw YAML fields to the `ParsedAgent` structure:

```typescript
interface ParsedAgent {
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
  description: string;           // from frontmatter
  system_prompt: string;         // the Markdown body
}

type AgentRole = 'author' | 'executor' | 'reviewer' | 'meta';

type RiskTier = 'low' | 'medium' | 'high' | 'critical';

interface QualityDimension {
  name: string;
  weight: number;
  description: string;
}

interface VersionHistoryEntry {
  version: string;
  date: string;
  change: string;
}

interface ParsedAgentResult {
  success: boolean;
  agent?: ParsedAgent;
  errors: ParserError[];
}

interface ParserError {
  message: string;
  line?: number;
  field?: string;
}
```

4. **Missing field handling**: If a required field is missing from YAML, the parser still returns the partial object (validator handles required-field enforcement). Parser only fails on YAML syntax errors or missing frontmatter delimiters.

### Validator (`validator.ts`)

Implements all 10 validation rules. Each rule is a function `(agent: ParsedAgent, context: ValidationContext) => ValidationError | null`.

```typescript
interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

interface ValidationError {
  rule: string;          // e.g. "RULE_001_NAME_UNIQUENESS"
  field: string;         // e.g. "name"
  message: string;       // human-readable, actionable
  severity: 'error' | 'warning';
}

interface ValidationContext {
  existingNames: Set<string>;
  filename?: string;
  modelRegistry?: Set<string>;
}
```

**The 10 validation rules:**

| Rule ID | Field | Rule | Error Message Template |
|---------|-------|------|----------------------|
| RULE_001 | `name` | Must be unique across all loaded agents | `"Agent name '{name}' conflicts with an already-registered agent"` |
| RULE_002 | `name` + filename | `name` must match the filename (without `.md` extension) | `"Agent name '{name}' does not match filename '{filename}'"` |
| RULE_003 | `version` | Must be valid semver (major.minor.patch) | `"Version '{version}' is not valid semver (expected X.Y.Z)"` |
| RULE_004 | `role` | Must be one of: `author`, `executor`, `reviewer`, `meta` | `"Role '{role}' is not valid (expected: author, executor, reviewer, meta)"` |
| RULE_005 | `tools` | Must only contain tools allowed for the agent's role (per TDD 3.1.3 allowlist) | `"Tool '{tool}' is not allowed for role '{role}'"` |
| RULE_006 | `evaluation_rubric` | Must contain at least 2 dimensions | `"Evaluation rubric must have at least 2 dimensions, found {count}"` |
| RULE_007 | `version_history` | Latest entry version must match `version` field | `"version_history latest entry '{historyVersion}' does not match version '{version}'"` |
| RULE_008 | `turn_limit` | Must be integer in range 1-100 | `"turn_limit {value} is out of range (must be 1-100)"` |
| RULE_009 | `model` | Must be in the model registry (configurable set) | `"Model '{model}' is not in the approved model registry"` |
| RULE_010 | `temperature` | Must be a number in range 0.0-1.0 | `"Temperature {value} is out of range (must be 0.0-1.0)"` |

**Tool allowlist per role (TDD 3.1.3):**

```typescript
const TOOL_ALLOWLIST: Record<AgentRole, string[]> = {
  author:   ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  executor: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'WebSearch', 'WebFetch'],
  reviewer: ['Read', 'Glob', 'Grep'],
  meta:     ['Read', 'Glob', 'Grep'],
};
```

## Acceptance Criteria

1. Parser correctly extracts all frontmatter fields from a well-formed agent `.md` file into a typed `ParsedAgent`.
2. Parser returns typed errors for malformed YAML with line numbers.
3. Parser cleanly separates frontmatter from Markdown body; body is stored as `system_prompt`.
4. Parser handles edge cases: empty body, no frontmatter, single `---` delimiter, extra `---` in body.
5. Validator enforces all 10 rules and produces specific, actionable error messages.
6. RULE_005 enforces the role-based tool allowlist exactly as specified.
7. RULE_001 detects duplicate names when `existingNames` context is provided.
8. RULE_002 compares name to filename (case-sensitive).
9. Each validation error includes the rule ID, field name, and human-readable message.
10. Validator returns all errors (does not short-circuit on first failure).

## Test Cases

### Parser Unit Tests

```
test_parse_valid_agent_file
  Input: well-formed .md with all fields
  Expected: success=true, all fields correctly typed, system_prompt = body text

test_parse_missing_frontmatter_delimiters
  Input: .md file with no --- delimiters
  Expected: success=false, error "No YAML frontmatter found"

test_parse_malformed_yaml
  Input: .md file with invalid YAML between --- delimiters (e.g., unclosed quote)
  Expected: success=false, error contains YAML parse error with line number

test_parse_empty_body
  Input: .md file with valid frontmatter, nothing after second ---
  Expected: success=true, system_prompt=""

test_parse_extra_delimiters_in_body
  Input: .md body contains --- (e.g., horizontal rule)
  Expected: success=true, body includes the --- as content

test_parse_missing_optional_fields
  Input: .md file without risk_tier and frozen fields
  Expected: success=true, risk_tier=undefined, frozen=undefined

test_parse_type_coercion
  Input: turn_limit as string "50" in YAML
  Expected: turn_limit parsed as number 50
```

### Validator Unit Tests

```
test_rule_001_name_uniqueness_pass
  Input: ParsedAgent with name "code-executor", existingNames={"prd-author"}
  Expected: no error

test_rule_001_name_uniqueness_fail
  Input: ParsedAgent with name "code-executor", existingNames={"code-executor"}
  Expected: error RULE_001

test_rule_002_name_filename_match_pass
  Input: name="prd-author", filename="prd-author.md"
  Expected: no error

test_rule_002_name_filename_match_fail
  Input: name="prd-author", filename="prd_author.md"
  Expected: error RULE_002

test_rule_003_valid_semver
  Input: version="1.2.3"
  Expected: no error

test_rule_003_invalid_semver
  Input: version="1.2" / version="v1.2.3" / version="abc"
  Expected: error RULE_003 for each

test_rule_004_valid_role
  Input: role="author" / "executor" / "reviewer" / "meta"
  Expected: no error for each

test_rule_004_invalid_role
  Input: role="admin"
  Expected: error RULE_004

test_rule_005_tool_allowlist_author_pass
  Input: role="author", tools=["Read", "Glob"]
  Expected: no error

test_rule_005_tool_allowlist_author_fail
  Input: role="author", tools=["Read", "Bash"]
  Expected: error RULE_005 for "Bash"

test_rule_005_tool_allowlist_executor_pass
  Input: role="executor", tools=["Read", "Bash", "Edit", "Write"]
  Expected: no error

test_rule_005_tool_allowlist_reviewer_fail
  Input: role="reviewer", tools=["Read", "Edit"]
  Expected: error RULE_005 for "Edit"

test_rule_006_rubric_minimum_pass
  Input: evaluation_rubric with 2 dimensions
  Expected: no error

test_rule_006_rubric_minimum_fail
  Input: evaluation_rubric with 1 dimension
  Expected: error RULE_006

test_rule_007_version_history_consistency_pass
  Input: version="1.2.0", version_history latest entry version="1.2.0"
  Expected: no error

test_rule_007_version_history_consistency_fail
  Input: version="1.2.0", version_history latest entry version="1.1.0"
  Expected: error RULE_007

test_rule_008_turn_limit_boundaries
  Input: turn_limit=1 -> pass; turn_limit=100 -> pass; turn_limit=0 -> fail; turn_limit=101 -> fail
  Expected: errors for 0 and 101

test_rule_009_model_registry
  Input: model="claude-sonnet-4-20250514" with registry containing it -> pass
  Input: model="gpt-unknown" with registry not containing it -> fail

test_rule_010_temperature_boundaries
  Input: temperature=0.0 -> pass; temperature=1.0 -> pass; temperature=-0.1 -> fail; temperature=1.1 -> fail

test_validator_returns_all_errors
  Input: ParsedAgent violating rules 003, 005, 008
  Expected: ValidationResult with 3 errors (not short-circuited)
```
