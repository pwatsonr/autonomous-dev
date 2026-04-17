# SPEC-007-4-1: Observation Report Generation & Schema Validation

## Metadata
- **Parent Plan**: PLAN-007-4
- **Tasks Covered**: Task 1 (report generator), Task 2 (file naming/placement), Task 3 (YAML frontmatter schema validation)
- **Estimated effort**: 14 hours

## Description

Build the report generator that transforms candidate observations from the analytics engine into YAML-frontmatter + Markdown files matching the full format from TDD section 3.9.2, implement the file naming scheme (`OBS-YYYYMMDD-HHMMSS-<hex4>.md`) with year/month directory placement, and create the schema validator that enforces the TDD section 4.1 schema on both read and write.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/reports/report-generator.ts` | Create | Candidate observation -> YAML+Markdown file writer |
| `src/reports/file-naming.ts` | Create | OBS-YYYYMMDD-HHMMSS-hex4 naming and directory creation |
| `src/reports/schema-validator.ts` | Create | Zod-based YAML frontmatter validation |
| `src/reports/templates.ts` | Create | Markdown body section templates |
| `tests/reports/report-generator.test.ts` | Create | Output format matching TDD example |
| `tests/reports/file-naming.test.ts` | Create | Naming format and collision handling |
| `tests/reports/schema-validator.test.ts` | Create | Valid, invalid, and edge-case frontmatter |

## Implementation Details

### Task 1: Report Generator

The generator produces a file matching the full example from TDD section 3.9.2.

```typescript
interface ReportInput {
  candidate: CandidateObservation;
  severity: SeverityResult;
  confidence: ConfidenceScore;
  dedupResult: DeduplicationResult;
  metrics: PrometheusResult[];
  logs: ScrubbedOpenSearchResult[];
  alerts: GrafanaAlertResult;
  baseline: BaselineMetrics;
  runId: string;
  tokensConsumed: number;
  dataSourceStatus: Record<string, DataSourceStatus>;
  governanceFlags: GovernanceFlags;
  llmAnalysis?: LlmAnalysisResult;
}

function generateReport(input: ReportInput): string {
  const id = generateObservationId(input.candidate);
  const frontmatter = buildFrontmatter(id, input);
  const body = buildMarkdownBody(id, input);
  return `---\n${yaml.dump(frontmatter)}---\n\n${body}`;
}

function buildFrontmatter(id: string, input: ReportInput): object {
  return {
    id,
    timestamp: new Date().toISOString(),
    service: input.candidate.service,
    repo: input.candidate.repo ?? findServiceRepo(input.candidate.service),
    type: input.candidate.type,
    severity: input.severity.override?.accepted
      ? input.severity.override.new_severity
      : input.severity.severity,
    confidence: parseFloat(input.confidence.composite.toFixed(2)),
    triage_status: input.governanceFlags.cooldown_active ? 'cooldown' : 'pending',
    triage_decision: null,
    triage_by: null,
    triage_at: null,
    triage_reason: null,
    defer_until: null,
    cooldown_active: input.governanceFlags.cooldown_active,
    linked_prd: null,
    linked_deployment: null,
    effectiveness: null,
    effectiveness_detail: null,
    observation_run_id: input.runId,
    tokens_consumed: input.tokensConsumed,
    fingerprint: input.candidate.fingerprint,
    occurrence_count: input.candidate.occurrence_count ?? 1,
    data_sources: {
      prometheus: input.dataSourceStatus.prometheus ?? 'not_configured',
      grafana: input.dataSourceStatus.grafana ?? 'not_configured',
      opensearch: input.dataSourceStatus.opensearch ?? 'not_configured',
      sentry: input.dataSourceStatus.sentry ?? 'not_configured',
    },
    related_observations: input.dedupResult.existing_observation_id
      ? [input.dedupResult.existing_observation_id]
      : [],
    oscillation_warning: input.governanceFlags.oscillation_warning,
  };
}
```

**Markdown body template** (matches TDD section 3.9.2):

```typescript
function buildMarkdownBody(id: string, input: ReportInput): string {
  const sections: string[] = [];

  // Title
  sections.push(`# Observation: ${input.llmAnalysis?.title ?? generateTitle(input)}\n`);

  // Summary
  sections.push(`## Summary\n\n${input.llmAnalysis?.summary ?? generateSummary(input)}\n`);

  // Severity Rationale Table
  sections.push(`## Severity Rationale\n`);
  sections.push(buildSeverityRationaleTable(input.severity));
  if (input.severity.override?.accepted) {
    sections.push(`\n**LLM Override**: ${input.severity.override.original_severity} -> ${input.severity.override.new_severity}. Justification: ${input.severity.override.justification}\n`);
  }

  // Evidence: Metrics
  sections.push(`## Evidence\n`);
  sections.push(`### Metrics (Prometheus)\n`);
  sections.push(buildMetricsTable(input.metrics, input.baseline));

  // Evidence: Logs
  if (input.logs.length > 0) {
    sections.push(`### Logs (OpenSearch)\n`);
    sections.push(buildLogSection(input.logs));
  }

  // Evidence: Alerts
  if (input.alerts.alerts.length > 0) {
    sections.push(`### Alerts (Grafana)\n`);
    sections.push(buildAlertSection(input.alerts));
  }

  // Root Cause Hypothesis
  sections.push(`## Root Cause Hypothesis\n`);
  sections.push(`> **Note: This is a hypothesis generated by the intelligence engine, not a\n> confirmed root cause. Verify before acting.**\n`);
  sections.push(`\n${input.llmAnalysis?.rootCauseHypothesis ?? 'LLM analysis unavailable.'}\n`);

  // Recommended Action
  sections.push(`## Recommended Action\n`);
  sections.push(`${input.llmAnalysis?.recommendedAction ?? 'Manual investigation required.'}\n`);

  // Related Observations
  sections.push(`## Related Observations\n`);
  if (input.dedupResult.existing_observation_id) {
    sections.push(`- ${input.dedupResult.existing_observation_id} (${input.dedupResult.reason})\n`);
  } else {
    sections.push(`None (first occurrence of this pattern).\n`);
  }

  // Oscillation Warning (if applicable)
  if (input.governanceFlags.oscillation_warning) {
    sections.push(buildOscillationWarning(input.governanceFlags.oscillation_data));
  }

  return sections.join('\n');
}

function buildSeverityRationaleTable(severity: SeverityResult): string {
  const b = severity.breakdown;
  return `
| Factor | Value | Score |
|--------|-------|-------|
| Error rate | ${b.error_rate.value}% | ${severityRange(b.error_rate.sub_score)} |
| Estimated affected users | ~${b.affected_users.value.toLocaleString()} | ${severityRange(b.affected_users.sub_score)} |
| Service criticality | ${b.service_criticality.value} | ${severityRange(b.service_criticality.sub_score)} |
| Duration | ${b.duration.value} min | ${severityRange(b.duration.sub_score)} |
| Data integrity | ${b.data_integrity.value} | ${b.data_integrity.sub_score > 0 ? severityRange(b.data_integrity.sub_score) : 'N/A'} |
| **Weighted score** | **${severity.score.toFixed(2)}** | **${severity.severity}** |
`;
}

function buildMetricsTable(metrics: PrometheusResult[], baseline: BaselineMetrics): string {
  let table = '| Metric | Current | Baseline (7d) | Threshold |\n';
  table += '|--------|---------|---------------|----------|\n';
  for (const m of metrics) {
    if (m.value === null) continue;
    const bl = baseline.metrics[m.query_name];
    const baselineStr = bl ? `${bl.mean_7d.toFixed(2)} +/- ${bl.stddev_7d.toFixed(2)}` : 'N/A';
    table += `| ${formatMetricName(m.query_name)} | ${formatMetricValue(m)} | ${baselineStr} | N/A |\n`;
  }
  return table;
}
```

### Task 2: File Naming and Directory Placement

```typescript
import { randomBytes } from 'crypto';

function generateObservationId(candidate: CandidateObservation): string {
  const now = new Date();
  const dateStr = now.toISOString().replace(/[-:T]/g, '').slice(0, 15);
  // Format: YYYYMMDD-HHMMSS
  const datePart = dateStr.slice(0, 8);
  const timePart = dateStr.slice(8, 14);
  const shortId = randomBytes(2).toString('hex'); // 4 hex chars
  return `OBS-${datePart}-${timePart}-${shortId}`;
}

function getObservationFilePath(id: string, rootDir: string): string {
  // Extract year and month from the ID
  const match = id.match(/^OBS-(\d{4})(\d{2})\d{2}-\d{6}-[a-f0-9]{4}$/);
  if (!match) throw new Error(`Invalid observation ID format: ${id}`);
  const [, year, month] = match;
  const dir = path.join(rootDir, '.autonomous-dev/observations', year, month);
  return path.join(dir, `${id}.md`);
}

async function writeObservationReport(
  id: string,
  content: string,
  rootDir: string
): Promise<string> {
  const filePath = getObservationFilePath(id, rootDir);

  // Ensure directory exists
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  // Collision check (extremely unlikely with random hex)
  if (await fileExists(filePath)) {
    // Regenerate short ID
    const newId = regenerateShortId(id);
    return writeObservationReport(newId, content.replace(id, newId), rootDir);
  }

  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}
```

### Task 3: Schema Validation

Uses Zod (same schema as SPEC-007-3-6 but used here on read/write of actual files).

```typescript
function validateOnWrite(frontmatter: object): void {
  const result = ObservationFrontmatterSchema.safeParse(frontmatter);
  if (!result.success) {
    throw new SchemaValidationError(
      `Observation report validation failed:\n${result.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`
    );
  }
}

function validateOnRead(filePath: string): { valid: boolean; errors: string[]; frontmatter?: object } {
  const content = fs.readFileSync(filePath, 'utf-8');
  const parsed = parseFrontmatter(content);
  if (!parsed) {
    return { valid: false, errors: ['Failed to parse YAML frontmatter'] };
  }
  const result = ObservationFrontmatterSchema.safeParse(parsed);
  if (result.success) {
    return { valid: true, errors: [], frontmatter: result.data };
  }
  return {
    valid: false,
    errors: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
  };
}

function parseFrontmatter(content: string): object | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  try {
    return yaml.load(match[1]);
  } catch {
    return null;
  }
}
```

## Acceptance Criteria

1. Output matches the full report example from TDD section 3.9.2 with all YAML frontmatter fields from schema 4.1.
2. YAML frontmatter includes: id, timestamp, service, repo, type, severity, confidence, triage_status (initially `pending` or `cooldown`), triage_decision (null), cooldown_active, fingerprint, occurrence_count, data_sources, related_observations, oscillation_warning, tokens_consumed, observation_run_id.
3. Markdown body includes: summary, severity rationale table with all 5 factors, evidence sections (metrics, logs, alerts), root cause hypothesis with disclaimer, recommended action, related observations.
4. File name format: `OBS-YYYYMMDD-HHMMSS-<hex4>.md`. Hex4 is 4 random hex characters.
5. Files placed in `.autonomous-dev/observations/YYYY/MM/`. Directories created if missing.
6. File name collision (extremely unlikely) triggers short ID regeneration.
7. Schema validator checks all required fields, correct types, and valid enum values on both read and write.
8. Invalid frontmatter on write throws `SchemaValidationError` with clear violation list.
9. Invalid frontmatter on read returns `{ valid: false, errors: [...] }` without throwing.

## Test Cases

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-4-1-01 | Report matches TDD example | Input matching TDD section 3.9.2 values | Output contains all YAML fields and Markdown sections |
| TC-4-1-02 | Severity rationale table | Score breakdown from severity scorer | Table with 5 rows + weighted total |
| TC-4-1-03 | Metrics table | 4 Prometheus results + baseline | Table with Current, Baseline, Threshold columns |
| TC-4-1-04 | Log section | OpenSearch results with error messages | Formatted code block with log excerpts |
| TC-4-1-05 | Root cause disclaimer | LLM analysis available | Hypothesis preceded by disclaimer note |
| TC-4-1-06 | No LLM analysis | LLM unavailable | "LLM analysis unavailable." in hypothesis section |
| TC-4-1-07 | File name format | Timestamp 2026-04-08T14:30:22Z | `OBS-20260408-143022-XXXX.md` where XXXX is hex |
| TC-4-1-08 | Directory placement | April 2026 | Written to `.autonomous-dev/observations/2026/04/` |
| TC-4-1-09 | Directory auto-creation | 2026/04 directory does not exist | Created automatically |
| TC-4-1-10 | Schema valid write | All fields correct | No error thrown |
| TC-4-1-11 | Schema invalid type enum | `type: "disaster"` | `SchemaValidationError` with `type` path |
| TC-4-1-12 | Schema missing confidence | No `confidence` field | Validation error listing `confidence` |
| TC-4-1-13 | Schema valid read | Well-formed observation file | `valid: true`, frontmatter parsed |
| TC-4-1-14 | Schema invalid read | Corrupted YAML | `valid: false`, parse error |
| TC-4-1-15 | Cooldown triage status | `cooldown_active: true` | `triage_status: 'cooldown'` in frontmatter |
| TC-4-1-16 | Oscillation warning section | Oscillation flag true | Markdown includes "## Oscillation Warning" section |
