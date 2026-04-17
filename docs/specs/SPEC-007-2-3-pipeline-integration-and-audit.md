# SPEC-007-2-3: Pipeline Integration, Weekly Audit & Security Controls

## Metadata
- **Parent Plan**: PLAN-007-2
- **Tasks Covered**: Task 7 (pipeline integration), Task 8 (weekly audit scan), Task 9 (security documentation)
- **Estimated effort**: 10 hours

## Description

Wire the scrubbing pipeline into the observation runner so that no raw production text reaches the LLM context or any persisted file without passing through `scrub()`. Build the weekly automated audit scan that searches all observation reports for unscrubbed PII/secrets. Document the security controls (read-only MCP, credential management, access control) and update `.gitignore` for public repositories.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/runner/observation-runner.ts` | Modify | Insert scrub step between query and analyze phases |
| `src/safety/weekly-audit.ts` | Create | Automated weekly scan of observation files |
| `src/safety/scrub-pipeline.ts` | Modify | Add `scrubCollectedData()` wrapper for batch scrubbing |
| `.gitignore` | Modify | Add `.autonomous-dev/observations/` for public repos |
| `docs/SECURITY.md` | Create | Security controls documentation |
| `tests/safety/weekly-audit.test.ts` | Create | Weekly audit unit tests |
| `tests/integration/scrub-integration.test.ts` | Create | Integration test confirming no bypass path |

## Implementation Details

### Task 7: Pipeline Integration

The scrub step sits between data collection (step 3a) and analysis (step 3c) in the runner lifecycle. The integration point wraps all text from all MCP sources.

```typescript
interface CollectedData {
  prometheus: PrometheusResult[];
  opensearch: OpenSearchResult[];
  grafana: {
    alerts: GrafanaAlertResult;
    annotations: GrafanaAnnotationResult;
  };
}

interface ScrubbedData {
  prometheus: PrometheusResult[];    // String fields scrubbed
  opensearch: ScrubbedOpenSearchResult[];  // Messages, stack traces scrubbed
  grafana: {
    alerts: GrafanaAlertResult;      // Annotation text scrubbed
    annotations: ScrubbedAnnotationResult[];
  };
  scrubAuditEntries: ScrubAuditEntry[];
}

async function scrubCollectedData(
  rawData: CollectedData,
  config: DataSafetyConfig,
  context: { runId: string; service: string }
): Promise<ScrubbedData> {
  const auditEntries: ScrubAuditEntry[] = [];

  // OpenSearch: scrub message, stack_trace, and any user_id fields
  const scrubbedOpenSearch = await Promise.all(
    rawData.opensearch.map(async (result) => {
      const scrubbedHits = await Promise.all(
        result.hits.map(async (hit) => {
          const msgResult = await scrub(hit.message, config, {
            fieldName: 'message', runId: context.runId,
            service: context.service, source: 'opensearch',
          });
          const stackResult = hit.stack_trace
            ? await scrub(hit.stack_trace, config, {
                fieldName: 'stack_trace', runId: context.runId,
                service: context.service, source: 'opensearch',
              })
            : null;
          return {
            ...hit,
            message: msgResult.text,
            stack_trace: stackResult?.text ?? hit.stack_trace,
          };
        })
      );
      return { ...result, hits: scrubbedHits };
    })
  );

  // Prometheus: scrub any string labels that could contain PII
  // (typically labels are metric names, but string values could leak)
  const scrubbedPrometheus = await Promise.all(
    rawData.prometheus.map(async (result) => {
      if (result.labels) {
        const scrubbedLabels: Record<string, string> = {};
        for (const [key, value] of Object.entries(result.labels)) {
          const scrubbed = await scrub(value, config, {
            fieldName: `label:${key}`, runId: context.runId,
            service: context.service, source: 'prometheus',
          });
          scrubbedLabels[key] = scrubbed.text;
        }
        return { ...result, labels: scrubbedLabels };
      }
      return result;
    })
  );

  // Grafana: scrub annotation text fields
  const scrubbedAnnotations = await Promise.all(
    rawData.grafana.annotations.annotations.map(async (ann) => {
      const scrubbed = await scrub(ann.text, config, {
        fieldName: 'annotation_text', runId: context.runId,
        service: context.service, source: 'grafana',
      });
      return { ...ann, text: scrubbed.text };
    })
  );

  return {
    prometheus: scrubbedPrometheus,
    opensearch: scrubbedOpenSearch,
    grafana: {
      alerts: rawData.grafana.alerts,
      annotations: { annotations: scrubbedAnnotations },
    },
    scrubAuditEntries: auditEntries,
  };
}
```

**Critical invariant**: The scrub step is NOT bypassable via configuration. There is no `skip_scrubbing` flag. The `scrubCollectedData()` function is called unconditionally in the runner pipeline. If scrubbing fails (timeout or persistent residual), the affected data is replaced with `[SCRUB_FAILED:...]` -- it is never passed through raw.

### Task 8: Weekly Audit Scan

An automated scan that runs weekly over all observation report files, searching for patterns that should have been caught by the real-time scrubber. This is the last line of defense.

```typescript
interface AuditScanResult {
  files_scanned: number;
  total_lines_scanned: number;
  findings: AuditFinding[];
  scan_duration_ms: number;
  scan_timestamp: string;
}

interface AuditFinding {
  file_path: string;
  line_number: number;
  pattern_type: string;
  pattern_name: string;
  context: string;          // Surrounding text (with the finding highlighted, NOT the raw PII)
}

async function weeklyAuditScan(
  observationsDir: string,
  config: DataSafetyConfig
): Promise<AuditScanResult> {
  const findings: AuditFinding[] = [];
  const start = performance.now();

  // Scan all .md files in observations directory (recursive, including archive)
  const files = await glob('**/*.md', { cwd: observationsDir });
  let totalLines = 0;

  for (const file of files) {
    const content = await fs.readFile(path.join(observationsDir, file), 'utf-8');
    const lines = content.split('\n');
    totalLines += lines.length;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Run all PII patterns
      for (const pattern of config.pii_patterns) {
        const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
        if (regex.test(line)) {
          // Skip matches that are replacement tokens
          if (line.includes('[REDACTED:') || line.includes('[SECRET_REDACTED]')) {
            // Verify the match is actually the token, not raw data next to a token
            const cleanedLine = line.replace(/\[REDACTED:[^\]]+\]/g, '').replace(/\[SECRET_REDACTED\]/g, '');
            if (!new RegExp(pattern.regex.source, pattern.regex.flags).test(cleanedLine)) {
              continue; // False alarm -- the match was inside a replacement token
            }
          }
          findings.push({
            file_path: file,
            line_number: i + 1,
            pattern_type: 'pii',
            pattern_name: pattern.name,
            context: `Line ${i + 1}: [pattern: ${pattern.name} detected]`,
          });
        }
      }

      // Run all secret patterns
      for (const pattern of config.secret_patterns) {
        const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
        if (regex.test(line)) {
          const cleanedLine = line.replace(/\[SECRET_REDACTED\]/g, '');
          if (!new RegExp(pattern.regex.source, pattern.regex.flags).test(cleanedLine)) {
            continue;
          }
          findings.push({
            file_path: file,
            line_number: i + 1,
            pattern_type: 'secret',
            pattern_name: pattern.name,
            context: `Line ${i + 1}: [pattern: ${pattern.name} detected]`,
          });
        }
      }

      // Expanded entropy analysis (broader than real-time, slower is acceptable)
      // Check all strings > 20 chars, not just those in key=value context
      const longStrings = line.match(/\S{20,}/g) || [];
      for (const s of longStrings) {
        if (s.startsWith('[REDACTED') || s.startsWith('[SECRET_REDACTED') || s.startsWith('[SCRUB_FAILED')) {
          continue;
        }
        if (shannonEntropy(s) > 4.5) {
          findings.push({
            file_path: file,
            line_number: i + 1,
            pattern_type: 'high_entropy',
            pattern_name: 'expanded_entropy_scan',
            context: `Line ${i + 1}: high-entropy string detected (${s.length} chars)`,
          });
        }
      }
    }
  }

  return {
    files_scanned: files.length,
    total_lines_scanned: totalLines,
    findings,
    scan_duration_ms: performance.now() - start,
    scan_timestamp: new Date().toISOString(),
  };
}
```

**Schedule**: The weekly audit runs at the end of day Sunday (or configurable). It is triggered by the same `schedule` skill as the observation runner but with a separate cron expression.

**Success metric**: Zero findings. Any finding represents a scrubbing failure that must be investigated and the pattern added to the real-time scrubber.

### Task 9: Security Documentation

Create `docs/SECURITY.md` covering:

1. **Read-only MCP access**: Document that all four MCP server connections use read-only tokens. List the minimum required permissions per server (from TDD section 7.2).
2. **Credential management**: Document that all credentials are stored as environment variables. List the 8 required env vars. State that `intelligence.yaml` and observation reports must never contain credentials.
3. **Observation report access control**: Document that `.autonomous-dev/observations/` should be in `.gitignore` for public repositories. For private repos, access is controlled at the repository level.

Update `.gitignore`:

```gitignore
# Production Intelligence observation data (contains production-derived content)
.autonomous-dev/observations/
.autonomous-dev/logs/
.autonomous-dev/baselines/
.autonomous-dev/fingerprints/
```

## Acceptance Criteria

1. No raw production text reaches the LLM context or is written to any file without passing through the `scrub()` function.
2. OpenSearch log messages and stack traces are scrubbed. Prometheus string label values are scrubbed. Grafana annotation text is scrubbed.
3. The scrub step is not bypassable via configuration -- there is no `skip_scrubbing` option.
4. Weekly audit scan reads all `.md` files in `.autonomous-dev/observations/` (including subdirectories and archive).
5. Audit scan runs the full PII + secret pattern library against file contents.
6. Audit scan reports any matches with file path, line number, and pattern type.
7. Audit scan expanded entropy analysis checks all strings >20 chars (broader than real-time).
8. Target: zero findings on every weekly audit run.
9. `.gitignore` includes `.autonomous-dev/observations/`, `.autonomous-dev/logs/`, `.autonomous-dev/baselines/`, `.autonomous-dev/fingerprints/`.
10. Security documentation covers least-privilege MCP permissions, credential storage requirements, and observation report access control.

## Test Cases

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-2-3-01 | OpenSearch messages scrubbed | Mock OpenSearch returns `john@test.com` in message field | Scrubbed data contains `[REDACTED:email]`, not raw email |
| TC-2-3-02 | Stack traces scrubbed | Mock stack trace with IP addresses | IPs replaced with `[REDACTED:ip]` |
| TC-2-3-03 | Grafana annotations scrubbed | Annotation text contains a bearer token | Token replaced with `[SECRET_REDACTED]` |
| TC-2-3-04 | Prometheus labels scrubbed | Label value contains an email | Email replaced with `[REDACTED:email]` |
| TC-2-3-05 | No bypass path | Attempt to skip scrubbing step | Not possible -- `scrubCollectedData()` is unconditional in runner |
| TC-2-3-06 | Weekly audit clean files | Observation files with only `[REDACTED:...]` tokens | Zero findings |
| TC-2-3-07 | Weekly audit finds leak | Observation file with raw email on line 42 | Finding: `{ file: ..., line: 42, pattern: 'email' }` |
| TC-2-3-08 | Weekly audit expanded entropy | Observation file with high-entropy string outside key= context | Finding reported (broader than real-time detection) |
| TC-2-3-09 | Weekly audit skips tokens | Line contains `[REDACTED:email]` | Not reported as a finding |
| TC-2-3-10 | .gitignore updated | Check `.gitignore` content | Contains all four `.autonomous-dev/` exclusion lines |
| TC-2-3-11 | Scrub failure blocks data | Timeout during scrub | `[SCRUB_FAILED:timeout]` reaches downstream, NOT raw text |
| TC-2-3-12 | Integration: end-to-end | Mock run with PII in OpenSearch data | Final observation report contains zero raw PII |
