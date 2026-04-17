# SPEC-009-2-2: Escalation Message Formatter

## Metadata
- **Parent Plan**: PLAN-009-2
- **Tasks Covered**: Task 3 (Implement Escalation Message Formatter)
- **Estimated effort**: 8 hours

## Description

Implement the message formatter that constructs v1 JSON schema-compliant escalation messages with three verbosity modes. The formatter generates unique escalation IDs, populates all required fields, enforces security constraints (no raw secrets in human-facing fields), and sanitizes file paths for external delivery. This is the serialization boundary between the internal failure context and the structured message delivered to humans.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/escalation/formatter.ts` | Create | Escalation message construction and formatting |

## Implementation Details

### Escalation ID Generation

Format: `esc-YYYYMMDD-NNN` where:
- `YYYYMMDD` is the current date in UTC.
- `NNN` is a zero-padded monotonic counter that resets daily.
- Counter is persisted to `.autonomous-dev/state/escalation-counter.json` (`{ date: "YYYYMMDD", counter: N }`).
- On restart, counter resumes from the persisted value for today's date. If the date has changed, counter resets to 1.
- Counter supports more than 3 digits (e.g., `esc-20260408-1001`) but is zero-padded to at least 3 (`esc-20260408-001`).

```typescript
export class EscalationIdGenerator {
  constructor(private statePath: string) {}
  next(): string;  // Returns next escalation ID, persists counter
}
```

### EscalationFormatter

```typescript
export class EscalationFormatter {
  constructor(
    private idGenerator: EscalationIdGenerator,
    private verbosity: "terse" | "standard" | "verbose",
  ) {}

  format(input: FormatterInput): EscalationMessage;
}

export interface FormatterInput {
  requestId: string;
  repository: string;
  pipelinePhase: string;
  escalationType: EscalationType;
  urgency: EscalationUrgency;
  failureReason: string;
  options: EscalationOption[];
  artifacts?: EscalationArtifact[];
  technicalDetails?: string;
  previousEscalationId?: string;
  retryCount: number;
  costImpact?: CostImpact;
}
```

### Verbosity Modes

| Field | terse | standard | verbose |
|-------|-------|----------|---------|
| schema_version | yes | yes | yes |
| escalation_id | yes | yes | yes |
| timestamp | yes | yes | yes |
| request_id | yes | yes | yes |
| repository | yes | yes | yes |
| pipeline_phase | no | yes | yes |
| escalation_type | yes | yes | yes |
| urgency | yes | yes | yes |
| summary | yes | yes | yes |
| failure_reason | no | yes | yes |
| options | yes (label only) | yes | yes (with description) |
| artifacts | no | path only | path + summary |
| technical_details | no | no | yes |
| previous_escalation_id | if present | if present | if present |
| retry_count | no | yes | yes |
| cost_impact | no | if present | if present |

### Summary Generation

The `summary` field is auto-generated from the failure context, max 200 characters:
- Pattern: `"[{escalation_type}] {pipeline_phase}: {truncated_failure_reason}"`
- Truncated to 200 chars with `"..."` suffix if needed.

### Security Constraints

1. The `summary`, `failure_reason`, and `options[].label` fields MUST NOT contain raw secret values. The formatter scans for common secret patterns (API keys, tokens, passwords, connection strings) and replaces them with `"[REDACTED]"`.
2. Secret detection patterns: strings matching `/(?:api[_-]?key|token|password|secret|credential|connection[_-]?string)\s*[:=]\s*\S+/gi` are redacted.
3. The `technical_details` field may reference file paths and line numbers but NOT secret values.
4. File paths in `artifacts[].path` are sanitized to workspace-relative paths (strip everything before the workspace root). Absolute paths like `/Users/foo/workspace/repo/src/file.ts` become `src/file.ts`.

### Path Sanitization

```typescript
function sanitizePath(absolutePath: string, workspaceRoot: string): string {
  if (absolutePath.startsWith(workspaceRoot)) {
    return absolutePath.slice(workspaceRoot.length).replace(/^\//, '');
  }
  return absolutePath; // Cannot sanitize; return as-is
}
```

## Acceptance Criteria

1. Generated escalation IDs follow the `esc-YYYYMMDD-NNN` format.
2. IDs are unique and monotonically increasing within a day.
3. Counter persists across restarts; no ID collisions after restart.
4. Counter resets on date change.
5. `terse` mode output includes only summary, options (labels), and required identifiers.
6. `standard` mode output includes all required fields per the table above.
7. `verbose` mode output includes `technical_details` and full artifact data.
8. All three modes produce valid `EscalationMessage` objects.
9. Summary is truncated to 200 characters with `"..."` suffix.
10. Secret values are redacted from `summary`, `failure_reason`, and option labels.
11. Absolute file paths are sanitized to workspace-relative in artifacts.
12. Escalation messages round-trip through JSON serialization without data loss.

## Test Cases

1. **ID format** -- `next()` returns string matching `/^esc-\d{8}-\d{3,}$/`.
2. **ID monotonic** -- Calling `next()` three times returns `esc-YYYYMMDD-001`, `esc-YYYYMMDD-002`, `esc-YYYYMMDD-003`.
3. **ID counter persists** -- Create generator, call `next()` twice, create new generator with same state path, call `next()` returns `003`.
4. **ID date reset** -- Simulate date change; counter resets to `001`.
5. **Terse mode omits pipeline_phase** -- Format with `terse`; output has no `pipeline_phase` field.
6. **Terse mode includes summary and options** -- Verify summary and options present.
7. **Standard mode includes failure_reason** -- Format with `standard`; `failure_reason` populated.
8. **Verbose mode includes technical_details** -- Format with `verbose`; `technical_details` populated.
9. **Summary truncation** -- Input with 300-char failure reason produces summary <= 200 chars ending with `"..."`.
10. **Secret redaction in summary** -- Input `"Failed: api_key=sk-12345abc"` becomes `"Failed: [REDACTED]"`.
11. **Secret redaction in failure_reason** -- Input `"Connection string: postgres://user:pass@host"` redacted.
12. **Secret redaction in option labels** -- Option label containing `"token=abc123"` redacted.
13. **Technical details may reference file path** -- `technical_details` with `"Error at src/foo.ts:42"` is NOT redacted.
14. **Path sanitization** -- Artifact path `/Users/dev/workspace/repo/src/main.ts` with workspace root `/Users/dev/workspace/repo` becomes `src/main.ts`.
15. **JSON round-trip** -- `JSON.parse(JSON.stringify(formatted))` deep-equals the original.
16. **Re-escalation links** -- When `previousEscalationId` is provided, it appears in the output.
17. **Options require at least 2** -- Formatter throws if fewer than 2 options provided.
