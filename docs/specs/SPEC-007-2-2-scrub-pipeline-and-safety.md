# SPEC-007-2-2: Scrubbing Pipeline Orchestrator, Validation & Failure Handling

## Metadata
- **Parent Plan**: PLAN-007-2
- **Tasks Covered**: Task 3 (pipeline orchestrator), Task 4 (post-scrub validation), Task 5 (scrubbing audit log), Task 6 (scrub failure handling)
- **Estimated effort**: 14 hours

## Description

Wire the PII scrubber and secret detector into the ordered two-stage pipeline, implement the defense-in-depth post-scrub validation pass, build the scrubbing audit log, and handle all three scrubbing failure modes (malformed regex, timeout, residual detection). The `scrub()` function is the single entry point for all downstream consumers -- no raw production text may bypass it.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/safety/scrub-pipeline.ts` | Create | Pipeline orchestrator: PII -> secrets -> validation |
| `src/safety/scrub-audit.ts` | Create | Per-invocation audit log writer (JSON format) |
| `src/safety/types.ts` | Modify | Add `ScrubResult`, `DataSafetyConfig`, `ScrubAuditEntry` types |
| `tests/safety/scrub-pipeline.test.ts` | Create | Pipeline ordering, validation, failure mode tests |
| `tests/safety/scrub-audit.test.ts` | Create | Audit log format tests |

## Implementation Details

### Task 3: Pipeline Orchestrator

The `scrub()` function is the sole entry point. PII scrubbing runs first, then secret detection, to prevent email-like patterns inside API keys from being double-tagged.

```typescript
interface ScrubResult {
  text: string;
  redaction_count: number;
  redactions: Redaction[];
  validation_passed: boolean;
  scrub_failed_fields: string[];  // Fields replaced with [SCRUB_FAILED:...]
  processing_time_ms: number;
}

interface Redaction {
  type: string;        // "email", "phone", "ssn", "credit_card", "ip", "jwt", "user_id", "secret"
  position: number;
  original_length: number;
  // NOTE: original value is NEVER stored
}

interface DataSafetyConfig {
  pii_patterns: PatternDefinition[];     // Built-in 11 + custom from config
  secret_patterns: PatternDefinition[];  // Built-in 15 + env var + high-entropy + custom
  timeout_ms: number;                    // Default 30_000
}

function buildSafetyConfig(config: IntelligenceConfig): DataSafetyConfig {
  return {
    pii_patterns: [...PII_PATTERNS, ...config.custom_pii_patterns.map(toPatternDef)],
    secret_patterns: [...SECRET_PATTERNS, ENV_VAR_PATTERN, ...config.custom_secret_patterns.map(toPatternDef)],
    timeout_ms: 30_000,
  };
}

async function scrub(
  text: string,
  config: DataSafetyConfig,
  context: { fieldName?: string; runId: string; service: string; source: string }
): Promise<ScrubResult> {
  const start = performance.now();

  // Timeout wrapper
  const result = await Promise.race([
    performScrub(text, config, context),
    rejectAfter(config.timeout_ms).then(() => {
      throw new ScrubTimeoutError(`Scrubbing exceeded ${config.timeout_ms}ms`);
    }),
  ]);

  result.processing_time_ms = performance.now() - start;
  return result;
}

function performScrub(
  text: string,
  config: DataSafetyConfig,
  context: { fieldName?: string }
): ScrubResult {
  let result = text;
  const redactions: Redaction[] = [];

  // Stage 1: PII patterns (ordered)
  for (const pattern of config.pii_patterns) {
    try {
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match;
      while ((match = regex.exec(result)) !== null) {
        // False positive check
        if (pattern.falsePositiveCheck && pattern.falsePositiveCheck(match[0], result)) {
          continue;
        }
        redactions.push({
          type: pattern.type,
          position: match.index,
          original_length: match[0].length,
        });
        result = result.slice(0, match.index) + pattern.replacement + result.slice(match.index + match[0].length);
        regex.lastIndex = match.index + pattern.replacement.length;
      }
    } catch (e) {
      // Malformed pattern handling (Task 6)
      logMalformedPattern(pattern.name, e);
      continue; // Skip, do not crash
    }
  }

  // Stage 2: Secret patterns (ordered)
  for (const pattern of config.secret_patterns) {
    try {
      // Similar execution with replaceFunc support for env var pattern
      // ...
    } catch (e) {
      logMalformedPattern(pattern.name, e);
      continue;
    }
  }

  // Stage 2b: High-entropy detection (runs after explicit patterns)
  const entropyRedactions = detectHighEntropySecrets(result);
  for (const r of entropyRedactions) {
    // Apply redaction
  }
  redactions.push(...entropyRedactions);

  return {
    text: result,
    redaction_count: redactions.length,
    redactions,
    validation_passed: true, // Updated by post-scrub validation
    scrub_failed_fields: [],
    processing_time_ms: 0,  // Set by caller
  };
}
```

### Task 4: Post-Scrub Validation Pass

Defense-in-depth: after the initial scrub, run the full pattern list again. If residuals are found, re-scrub. If they still persist, replace the entire field with `[SCRUB_FAILED:field_name]`.

```typescript
function postScrubValidation(
  scrubResult: ScrubResult,
  config: DataSafetyConfig,
  fieldName: string
): ScrubResult {
  // Pass 1: Check for residuals
  const residuals = detectResiduals(scrubResult.text, config);

  if (residuals.length === 0) {
    scrubResult.validation_passed = true;
    return scrubResult;
  }

  // Pass 2: Re-scrub residuals
  const reScrubbed = performScrub(scrubResult.text, config, { fieldName });
  const residualsAfterReScrub = detectResiduals(reScrubbed.text, config);

  if (residualsAfterReScrub.length === 0) {
    reScrubbed.validation_passed = true;
    reScrubbed.redaction_count += scrubResult.redaction_count;
    return reScrubbed;
  }

  // Pass 3: Nuclear option -- replace entire field
  return {
    text: `[SCRUB_FAILED:${fieldName}]`,
    redaction_count: scrubResult.redaction_count + reScrubbed.redaction_count,
    redactions: [...scrubResult.redactions, ...reScrubbed.redactions],
    validation_passed: false,
    scrub_failed_fields: [fieldName],
    processing_time_ms: scrubResult.processing_time_ms,
  };
}

function detectResiduals(text: string, config: DataSafetyConfig): PatternMatch[] {
  // Run all PII + secret patterns against the text
  // Return any matches found (these are residuals that should have been caught)
  const matches: PatternMatch[] = [];
  for (const pattern of [...config.pii_patterns, ...config.secret_patterns]) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match;
    while ((match = regex.exec(text)) !== null) {
      // Skip matches that are already replacement tokens
      if (match[0].startsWith('[REDACTED:') || match[0].startsWith('[SECRET_REDACTED]')) {
        continue;
      }
      matches.push({ pattern: pattern.name, position: match.index, value_length: match[0].length });
    }
  }
  return matches;
}
```

### Task 5: Scrubbing Audit Log

Every `scrub()` invocation writes a JSON audit entry matching the format from TDD section 3.4.5.

```typescript
interface ScrubAuditEntry {
  run_id: string;
  service: string;
  source: string;          // "opensearch" | "prometheus" | "grafana"
  lines_processed: number;
  redactions: Record<string, number>;  // { email: 12, ip: 34, phone: 0, secret: 2, jwt: 1 }
  processing_time_ms: number;
  validation_passed: boolean;
  scrub_failed_fields: string[];
  timestamp: string;       // ISO 8601
}

class ScrubAuditLogger {
  constructor(private auditLog: AuditLogger) {}

  logScrub(result: ScrubResult, context: ScrubContext): void {
    const counts: Record<string, number> = {};
    for (const r of result.redactions) {
      counts[r.type] = (counts[r.type] || 0) + 1;
    }

    const entry: ScrubAuditEntry = {
      run_id: context.runId,
      service: context.service,
      source: context.source,
      lines_processed: context.lineCount,
      redactions: counts,
      processing_time_ms: result.processing_time_ms,
      validation_passed: result.validation_passed,
      scrub_failed_fields: result.scrub_failed_fields,
      timestamp: new Date().toISOString(),
    };

    this.auditLog.appendJson(entry);
  }
}
```

**Example audit entry** (matches TDD section 3.4.5):

```json
{
  "run_id": "RUN-20260408-1430",
  "service": "api-gateway",
  "source": "opensearch",
  "lines_processed": 50,
  "redactions": {
    "email": 12,
    "ip": 34,
    "phone": 0,
    "secret": 2,
    "jwt": 1
  },
  "processing_time_ms": 45,
  "validation_passed": true,
  "scrub_failed_fields": [],
  "timestamp": "2026-04-08T14:30:15Z"
}
```

### Task 6: Scrub Failure Handling

Three failure modes from TDD section 6.2:

| Mode | Trigger | Response | Severity |
|------|---------|----------|----------|
| Malformed custom regex | `new RegExp(pattern)` throws | Skip pattern, log warning, continue with remaining | Warning |
| Timeout >30s | `Promise.race` rejects | Truncate batch. **Do NOT pass unscrubbed data forward.** Return empty `ScrubResult` with error flag | Error |
| Residual detection | Post-scrub validation finds match | Re-scrub. If still present, replace entire field with `[SCRUB_FAILED:field_name]` | Error |

```typescript
class ScrubTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScrubTimeoutError';
  }
}

// In the scrub() caller:
try {
  const result = await scrub(text, config, context);
  return result;
} catch (error) {
  if (error instanceof ScrubTimeoutError) {
    auditLog.error(`Scrubbing timeout for ${context.service}/${context.source}. Data discarded.`);
    // Return a safe empty result -- NEVER forward unscrubbed text
    return {
      text: `[SCRUB_FAILED:timeout]`,
      redaction_count: 0,
      redactions: [],
      validation_passed: false,
      scrub_failed_fields: ['*'],
      processing_time_ms: config.timeout_ms,
    };
  }
  throw error;
}
```

## Acceptance Criteria

1. `scrub()` function accepts raw text and `DataSafetyConfig`, returns `ScrubResult` with cleaned text, redaction count, and redaction metadata (type, position, original length -- never the original value).
2. PII patterns execute before secret patterns to prevent email-like patterns in API keys from being double-tagged.
3. Custom patterns from `intelligence.yaml` are appended to the default list, never replacing it.
4. Post-scrub validation runs the full pattern list a second time. Residuals trigger re-scrub.
5. Persistent residuals (after second pass) cause the entire field to be replaced with `[SCRUB_FAILED:field_name]` and a security warning logged.
6. Malformed custom regex patterns are caught, logged as warnings, and skipped without crashing.
7. Scrubbing exceeding 30s triggers timeout. The timed-out batch is discarded -- unscrubbed data is NEVER passed forward.
8. Audit log entry is written for every `scrub()` invocation with the exact JSON format from TDD section 3.4.5.
9. Audit log includes per-type redaction counts, processing time in milliseconds, and validation status.

## Test Cases

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-2-2-01 | PII before secrets ordering | `key=john@example.com` | Email redacted first: `key=[REDACTED:email]` (not double-tagged as secret) |
| TC-2-2-02 | Mixed PII and secrets | `user john@example.com token=ghp_abc...xyz` | Both redacted with correct types |
| TC-2-2-03 | Custom pattern appended | Custom pattern `CUSTOM_\d{6}`, text has both email and custom | Email and custom both redacted |
| TC-2-2-04 | Post-scrub clean | Text with 3 emails, scrubbed once | Validation pass finds 0 residuals, `validation_passed: true` |
| TC-2-2-05 | Post-scrub residual caught | Contrived pattern that partially matches after first scrub | Re-scrub catches it, final text clean |
| TC-2-2-06 | Post-scrub persistent residual | Pattern that can't be fully scrubbed in 2 passes | `[SCRUB_FAILED:field_name]` returned |
| TC-2-2-07 | Malformed regex skipped | Custom pattern `[invalid regex` | Warning logged, remaining patterns execute normally |
| TC-2-2-08 | Timeout discards data | Scrub takes >30s (mocked) | `[SCRUB_FAILED:timeout]` returned, no unscrubbed text |
| TC-2-2-09 | Audit log format | Scrub 50 lines with 12 emails, 34 IPs | JSON entry matches TDD format exactly |
| TC-2-2-10 | Audit processing time | Scrub completes in ~45ms | `processing_time_ms` within 10ms of actual |
| TC-2-2-11 | Empty text input | `""` | Returns empty text, 0 redactions |
| TC-2-2-12 | Text with no PII | `"normal log message at 2026-04-08"` | Returns unchanged text, 0 redactions |
| TC-2-2-13 | Redaction metadata no values | Scrub email `john@test.com` | `redactions[0].original_length === 13`, no `original_value` field |
