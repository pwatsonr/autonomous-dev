# SPEC-007-4-3: Observation-to-PRD Promotion Pipeline & Triage Audit Log

## Metadata
- **Parent Plan**: PLAN-007-4
- **Tasks Covered**: Task 7 (observation-to-PRD promotion pipeline), Task 8 (triage audit log)
- **Estimated effort**: 11 hours

## Description

Build the PRD generator that creates a pipeline-compatible PRD from a promoted observation following the template from TDD section 3.12.2, and implement the JSONL triage audit log that records every triage action per TDD section 4.4.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/triage/prd-generator.ts` | Create | Read promoted observation, generate PRD via LLM, write file |
| `src/triage/prd-template.ts` | Create | PRD template matching TDD section 3.12.2 |
| `src/triage/audit-log.ts` | Create | JSONL append-only triage audit log |
| `tests/triage/prd-generator.test.ts` | Create | PRD generation and format tests |
| `tests/triage/audit-log.test.ts` | Create | Audit entry format and append tests |

## Implementation Details

### Task 7: Observation-to-PRD Promotion Pipeline

The PRD generation process from TDD section 3.12.1:

```typescript
interface PrdGenerationResult {
  prd_id: string;
  file_path: string;
  observation_id: string;
}

async function generatePrdFromObservation(
  observationFilePath: string,
  decision: TriageDecision
): Promise<string> {
  // Step 1: Read the promoted observation report
  const obsContent = await fs.readFile(observationFilePath, 'utf-8');
  const obsFm = parseFrontmatter(obsContent);
  const obsBody = extractMarkdownBody(obsContent);

  // Step 2: Extract structured data
  const structuredData = {
    service: obsFm.service,
    repo: obsFm.repo,
    severity: obsFm.severity,
    confidence: obsFm.confidence,
    observation_id: obsFm.id,
    fingerprint: obsFm.fingerprint,
    evidence: extractEvidenceFromBody(obsBody),
    root_cause_hypothesis: extractSection(obsBody, 'Root Cause Hypothesis'),
    recommended_action: extractSection(obsBody, 'Recommended Action'),
    metrics: extractMetricsFromBody(obsBody),
  };

  // Step 3: Generate PRD using Claude with observation context
  const prdContent = await generatePrdViaLlm(structuredData, obsFm, obsBody);

  // Step 4: Write PRD file
  const prdId = `PRD-OBS-${obsFm.id.replace('OBS-', '')}`;
  const prdPath = path.join(ROOT_DIR, '.autonomous-dev/prd', `${prdId}.md`);
  await fs.mkdir(path.dirname(prdPath), { recursive: true });
  await fs.writeFile(prdPath, prdContent, 'utf-8');

  // Step 5: Update observation report with linked_prd
  await updateFrontmatter(observationFilePath, {
    linked_prd: prdId,
  });

  return prdId;
}
```

**PRD template** (matches TDD section 3.12.2):

```typescript
function buildPrdContent(
  prdId: string,
  observation: ObservationData,
  llmContent: LlmPrdContent
): string {
  const frontmatter = {
    title: `Fix: ${llmContent.title}`,
    version: '1.0',
    date: new Date().toISOString().split('T')[0],
    author: 'Production Intelligence Loop',
    status: 'Draft',
    source: 'production-intelligence',
    observation_id: observation.id,
    severity: observation.severity,
    service: observation.service,
  };

  const body = `
# ${llmContent.title}

## Problem Statement

${llmContent.problemStatement}

## Evidence

${observation.evidence}

## Constraints

- Fix must address the root cause identified in observation ${observation.id}
- Target metric: ${observation.targetMetric} must improve by at least 10% post-deployment
- Service: ${observation.service}, Repo: ${observation.repo}

## Success Criteria

| Metric | Current (broken) | Target (fixed) | Measurement |
|--------|-----------------|----------------|-------------|
| ${observation.targetMetric} | ${observation.currentValue} | ${observation.baselineValue} | Prometheus query post-deploy |

## Scope

${llmContent.scope}
`;

  return `---\n${yaml.dump(frontmatter)}---\n${body}`;
}
```

**LLM prompt for PRD generation**:

```typescript
const PRD_GENERATION_PROMPT = `
You are generating a Product Requirements Document for a production fix.

## Observation Report
{observation_report_full_text}

## Service Configuration
- Service: {service}
- Repo: {repo}
- Criticality: {criticality}

## Previous Observations (same service, last 30 days)
{previous_observations_summary}

## Instructions
Generate the following sections:
1. **title**: A concise fix title (e.g., "Fix Connection Pool Exhaustion in Orders DB")
2. **problemStatement**: 2-3 sentences describing the problem with quantitative metrics
3. **scope**: What the fix should address, based on the recommended action

Respond in this exact JSON format:
{
  "title": "...",
  "problemStatement": "...",
  "scope": "..."
}
`;
```

**Pipeline compatibility**: The generated PRD must be compatible with the existing autonomous development pipeline format from TDD-001. The YAML frontmatter fields (`title`, `version`, `date`, `author`, `status`, `source`) match the pipeline's expected PRD schema.

### Task 8: Triage Audit Log

Append-only JSONL log at `.autonomous-dev/logs/intelligence/triage-audit.log`.

```typescript
interface TriageAuditEntry {
  observation_id: string;
  action: string;          // "promote" | "dismiss" | "defer" | "investigate" | "deferred_return"
  actor: string;           // Username or "system"
  timestamp: string;       // ISO 8601
  reason: string;
  generated_prd: string | null;
  auto_promoted: boolean;
}

class TriageAuditLogger {
  private logPath: string;

  constructor(rootDir: string) {
    this.logPath = path.join(rootDir, '.autonomous-dev/logs/intelligence/triage-audit.log');
  }

  async log(entry: TriageAuditEntry): Promise<void> {
    const json = JSON.stringify(entry);
    await fs.appendFile(this.logPath, json + '\n', 'utf-8');
  }

  async logError(observationId: string, error: string): Promise<void> {
    await this.log({
      observation_id: observationId,
      action: 'error',
      actor: 'system',
      timestamp: new Date().toISOString(),
      reason: error,
      generated_prd: null,
      auto_promoted: false,
    });
  }

  async readAll(): Promise<TriageAuditEntry[]> {
    try {
      const content = await fs.readFile(this.logPath, 'utf-8');
      return content
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }
}
```

**Example audit entries** (matching TDD section 4.4):

```jsonl
{"observation_id":"OBS-20260408-143022-a7f3","action":"promote","actor":"pwatson","timestamp":"2026-04-08T15:12:00Z","reason":"Connection pool issue confirmed. Needs fix PRD.","generated_prd":"PRD-OBS-20260408-143022-a7f3","auto_promoted":false}
{"observation_id":"OBS-20260408-150015-b2c1","action":"dismiss","actor":"pwatson","timestamp":"2026-04-08T15:30:00Z","reason":"Known flaky test, not a real issue.","generated_prd":null,"auto_promoted":false}
{"observation_id":"OBS-20260408-153022-c4d5","action":"defer","actor":"pwatson","timestamp":"2026-04-08T16:00:00Z","reason":"Wait for next deploy cycle.","generated_prd":null,"auto_promoted":false}
```

## Acceptance Criteria

1. PRD is generated from the promoted observation using Claude with context from the observation, service config, and previous observations.
2. PRD follows the template from TDD section 3.12.2 with YAML frontmatter: title, version, date, author ("Production Intelligence Loop"), status ("Draft"), source ("production-intelligence"), observation_id, severity, service.
3. PRD body includes: problem statement with quantitative metrics, evidence copied from observation, constraints, success criteria table, and scope.
4. PRD is written to `.autonomous-dev/prd/PRD-OBS-<observation-id>.md`.
5. Observation report is updated with `linked_prd` field after successful PRD generation.
6. Generated PRDs are compatible with the TDD-001 pipeline format.
7. Triage audit log is written to `.autonomous-dev/logs/intelligence/triage-audit.log` in JSONL format.
8. Each audit entry includes: observation_id, action, actor, timestamp, reason, generated_prd, auto_promoted.
9. Audit log is append-only.
10. Audit entries are parseable for reporting and governance analysis.

## Test Cases

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-4-3-01 | PRD from promoted observation | Observation with P1 severity and evidence | PRD file created with correct YAML frontmatter |
| TC-4-3-02 | PRD frontmatter fields | Any promoted observation | `author: "Production Intelligence Loop"`, `status: "Draft"`, `source: "production-intelligence"` |
| TC-4-3-03 | PRD observation_id link | Observation `OBS-20260408-143022-a7f3` | `observation_id: "OBS-20260408-143022-a7f3"` in PRD frontmatter |
| TC-4-3-04 | PRD file path | Observation `OBS-20260408-143022-a7f3` | Written to `.autonomous-dev/prd/PRD-OBS-20260408-143022-a7f3.md` |
| TC-4-3-05 | Observation updated | After PRD generation | `linked_prd: "PRD-OBS-20260408-143022-a7f3"` in observation |
| TC-4-3-06 | PRD success criteria table | Error rate 12.3%, baseline 0.4% | Table row with current=12.3%, target=0.4% |
| TC-4-3-07 | PRD problem statement | Observation with metrics and logs | Quantitative metrics included in statement |
| TC-4-3-08 | Audit: promote entry | Promote action by `pwatson` | JSONL with `action: "promote"`, `generated_prd: "PRD-OBS-..."` |
| TC-4-3-09 | Audit: dismiss entry | Dismiss action | JSONL with `action: "dismiss"`, `generated_prd: null` |
| TC-4-3-10 | Audit: append-only | Two sequential actions | Log file has 2 lines, first not overwritten |
| TC-4-3-11 | Audit: parseable | Read back all entries | Each line parses to valid `TriageAuditEntry` |
| TC-4-3-12 | Audit: auto_promoted flag | Auto-promoted observation (Phase 3) | `auto_promoted: true` |
| TC-4-3-13 | PRD pipeline compatible | Generated PRD | Frontmatter has `title`, `version`, `date`, `author`, `status` matching TDD-001 format |
