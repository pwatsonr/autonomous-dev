# SPEC-007-1-1: MCP Server Configuration & Directory Bootstrap

## Metadata
- **Parent Plan**: PLAN-007-1
- **Tasks Covered**: Task 1 (MCP server configuration), Task 2 (intelligence.yaml schema), Task 3 (directory bootstrap)
- **Estimated effort**: 8 hours

## Description

Establish the foundational configuration and filesystem scaffolding for the Production Intelligence Loop. This spec covers the `.mcp.json` plugin-level MCP server definitions, the `intelligence.yaml` primary configuration schema with validation, and the automatic directory structure creation that must succeed before any observation run begins.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `.mcp.json` | Create | MCP server definitions for Grafana, Prometheus, OpenSearch, Sentry |
| `.autonomous-dev/config/intelligence.yaml` | Create | Primary configuration file with schedule, services, thresholds, query budgets |
| `src/config/intelligence-config.ts` | Create | Configuration loader with schema validation and deep-merge logic |
| `src/config/intelligence-config.schema.ts` | Create | TypeScript types and Zod schema for `intelligence.yaml` |
| `src/runner/directory-bootstrap.ts` | Create | Directory tree initialization logic |
| `tests/config/intelligence-config.test.ts` | Create | Config loader unit tests |
| `tests/runner/directory-bootstrap.test.ts` | Create | Directory bootstrap unit tests |

## Implementation Details

### Task 1: `.mcp.json` MCP Server Definitions

Create the plugin-level `.mcp.json` with all four MCP server entries. Every credential and URL MUST reference an environment variable -- no hardcoded values.

```jsonc
{
  "mcpServers": {
    "grafana": {
      "type": "sse",
      "url": "${GRAFANA_MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${GRAFANA_MCP_TOKEN}"
      }
    },
    "prometheus": {
      "type": "sse",
      "url": "${PROMETHEUS_MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${PROMETHEUS_MCP_TOKEN}"
      }
    },
    "opensearch": {
      "type": "sse",
      "url": "${OPENSEARCH_MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${OPENSEARCH_MCP_TOKEN}"
      }
    },
    "sentry": {
      "type": "sse",
      "url": "${SENTRY_MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${SENTRY_MCP_TOKEN}"
      }
    }
  }
}
```

### Task 2: `intelligence.yaml` Configuration Schema

The configuration file supports the following top-level sections. The Zod schema enforces types and required fields at load time.

```yaml
# .autonomous-dev/config/intelligence.yaml
schedule:
  type: "cron"            # "cron" | "interval"
  expression: "0 */4 * * *"  # Cron expression or interval string (e.g., "4h")

services:
  - name: "api-gateway"
    repo: "org/api-gateway"
    prometheus_job: "api-gateway"
    grafana_dashboard_uid: "abc123"
    opensearch_index: "logs-api-gateway-*"
    sentry_project: "api-gateway"      # Phase 3
    criticality: "critical"            # critical | high | medium | low

default_thresholds:
  error_rate_percent: 5.0
  sustained_duration_minutes: 10
  p99_latency_ms: 5000
  availability_percent: 99.0

per_service_overrides:
  api-gateway:
    error_rate_percent: 3.0
    sustained_duration_minutes: 5

query_budgets:
  prometheus:
    max_queries_per_service: 20
    timeout_seconds: 30
  grafana:
    max_queries_per_service: 10
    timeout_seconds: 30
  opensearch:
    max_queries_per_service: 15
    timeout_seconds: 60
  sentry:
    max_queries_per_service: 10
    timeout_seconds: 30

anomaly_detection:
  method: "zscore"                   # "zscore" | "iqr"
  sensitivity: 2.5
  consecutive_runs_required: 2

trend_analysis:
  windows: ["7d", "14d", "30d"]
  min_slope_threshold: 5.0           # Percentage

false_positive_filters:
  maintenance_windows: []
  excluded_error_patterns: []
  load_test_markers: []

governance:
  cooldown_days: 7
  oscillation_window_days: 30
  oscillation_threshold: 3
  effectiveness_comparison_days: 7
  effectiveness_improvement_threshold: 10.0

retention:
  observation_days: 90
  archive_days: 365

custom_pii_patterns: []
custom_secret_patterns: []

auto_promote:
  enabled: false
  override_hours: 2

notifications:
  enabled: false
  webhook_url: null
  severity_filter: ["P0", "P1"]
```

**Configuration loader** (`src/config/intelligence-config.ts`):

```typescript
interface IntelligenceConfig {
  schedule: ScheduleConfig;
  services: ServiceConfig[];
  default_thresholds: ThresholdConfig;
  per_service_overrides: Record<string, Partial<ThresholdConfig>>;
  query_budgets: QueryBudgetConfig;
  // ... all sections above
}

function loadConfig(configPath: string): IntelligenceConfig {
  // 1. Read YAML file
  // 2. Parse with yaml library
  // 3. Validate against Zod schema -- throw on invalid
  // 4. Apply per_service_overrides deep-merge with defaults
  // 5. Convert interval schedule to cron if needed ("4h" -> "0 */4 * * *", "30m" -> "*/30 * * * *")
  // 6. Return typed config
}

function getServiceThresholds(config: IntelligenceConfig, serviceName: string): ThresholdConfig {
  // Deep-merge: defaults <- per_service_overrides[serviceName]
  // Only specified override fields replace defaults; unspecified inherit
  return { ...config.default_thresholds, ...(config.per_service_overrides[serviceName] ?? {}) };
}
```

**Interval-to-cron conversion rules**:
- `4h` -> `0 */4 * * *`
- `30m` -> `*/30 * * * *`
- `1h` -> `0 */1 * * *`
- `6h` -> `0 */6 * * *`

### Task 3: Directory Bootstrap

The bootstrap function creates the full `.autonomous-dev/` directory tree if any part is missing. It is idempotent -- calling it on an existing tree is a no-op.

```typescript
const REQUIRED_DIRS = [
  '.autonomous-dev/config',
  '.autonomous-dev/observations',
  '.autonomous-dev/observations/archive',
  '.autonomous-dev/observations/digests',
  '.autonomous-dev/baselines',
  '.autonomous-dev/fingerprints',
  '.autonomous-dev/logs/intelligence',
  '.autonomous-dev/prd',
];

async function bootstrapDirectories(rootDir: string): Promise<void> {
  for (const dir of REQUIRED_DIRS) {
    const fullPath = path.join(rootDir, dir);
    await fs.mkdir(fullPath, { recursive: true });
  }
  // Also ensure YYYY/MM subdirectory exists for current month
  const now = new Date();
  const yearMonth = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
  await fs.mkdir(
    path.join(rootDir, '.autonomous-dev/observations', yearMonth),
    { recursive: true }
  );
}
```

## Acceptance Criteria

1. `.mcp.json` declares all four MCP servers (Grafana, Prometheus, OpenSearch, Sentry) with `"type": "sse"` and `${ENV_VAR}` references for all URLs and tokens. Zero hardcoded credentials.
2. `intelligence.yaml` supports both `cron` and `interval` schedule formats. Interval strings are correctly converted to cron expressions.
3. Config loader validates the full schema via Zod. Invalid configs produce clear error messages listing each violation.
4. `per_service_overrides` are deep-merged with `default_thresholds` -- only specified fields override; unspecified fields inherit from defaults.
5. Query budget limits match TDD section 3.1.4 defaults: Prometheus 20/30s, Grafana 10/30s, OpenSearch 15/60s, Sentry 10/30s.
6. Directory bootstrap creates all required directories including `YYYY/MM` for the current month.
7. Bootstrap is idempotent: existing directories are not overwritten or errored.
8. Bootstrap works correctly on a completely clean filesystem (first-ever run).

## Test Cases

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-1-1-01 | Valid config loads successfully | Well-formed `intelligence.yaml` | Typed `IntelligenceConfig` returned, no errors |
| TC-1-1-02 | Missing required field rejected | Config without `schedule` block | Zod validation error: `schedule is required` |
| TC-1-1-03 | Invalid enum value rejected | `criticality: "extreme"` | Zod error: `Invalid enum value. Expected 'critical' \| 'high' \| 'medium' \| 'low'` |
| TC-1-1-04 | Interval conversion: hours | `schedule.expression: "4h"` | Cron: `0 */4 * * *` |
| TC-1-1-05 | Interval conversion: minutes | `schedule.expression: "30m"` | Cron: `*/30 * * * *` |
| TC-1-1-06 | Deep-merge overrides | Default `error_rate_percent: 5.0`, override `api-gateway.error_rate_percent: 3.0` | `getServiceThresholds("api-gateway").error_rate_percent === 3.0`, `.sustained_duration_minutes === 10` (inherited) |
| TC-1-1-07 | Deep-merge no override | No override for `user-service` | All fields equal defaults |
| TC-1-1-08 | Bootstrap on clean directory | Empty filesystem | All 9+ directories created successfully |
| TC-1-1-09 | Bootstrap on existing directory | All directories already exist | No errors, no overwrites |
| TC-1-1-10 | Bootstrap creates current month dir | Run on 2026-04-08 | `.autonomous-dev/observations/2026/04/` exists |
| TC-1-1-11 | No hardcoded credentials in .mcp.json | Parse `.mcp.json` | All URL and token values match `^\$\{[A-Z_]+\}$` pattern |
| TC-1-1-12 | Custom patterns appended | Config with 2 custom PII patterns | Default 11 PII patterns + 2 custom = 13 total |
