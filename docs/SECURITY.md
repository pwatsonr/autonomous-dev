# Security Controls

This document describes the security controls implemented by the autonomous-dev plugin's Production Intelligence system.

## 1. Read-Only MCP Access

All four MCP server connections use read-only tokens with least-privilege permissions. No MCP connection has write, delete, or administrative access.

### Minimum Required Permissions Per Server

| MCP Server  | Required Permissions | Notes |
|-------------|---------------------|-------|
| **Prometheus** | `query` (read metrics) | No `admin`, `write`, or `delete` access. Only PromQL query execution. |
| **Grafana** | `dashboards:read`, `annotations:read`, `alerts:read` | No `dashboards:write`, `admin`, or `users` access. Read-only viewer role. |
| **OpenSearch** | `indices:data/read/search`, `indices:data/read/get` | No `indices:data/write`, `cluster:admin`, or `indices:admin` access. Read-only index access. |
| **Sentry** | `event:read`, `project:read` | No `event:write`, `project:admin`, or `org:admin` access. Read-only project member role. |

### Enforcement

- MCP server tokens are configured as environment variables (see Section 2).
- The plugin never requests elevated permissions at runtime.
- If a server returns a 403 (Forbidden), the plugin logs the error and proceeds with degraded data -- it does not attempt to escalate privileges.

## 2. Credential Management

All credentials are stored as environment variables. The plugin reads credentials exclusively from the process environment at startup. Credentials are never:

- Written to `intelligence.yaml` or any configuration file
- Included in observation reports or audit logs
- Passed through the LLM context window
- Committed to version control

### Required Environment Variables

| Variable | Purpose |
|----------|---------|
| `PROMETHEUS_URL` | Base URL for the Prometheus MCP server |
| `PROMETHEUS_TOKEN` | Read-only API token for Prometheus |
| `GRAFANA_URL` | Base URL for the Grafana MCP server |
| `GRAFANA_TOKEN` | Read-only API token for Grafana |
| `OPENSEARCH_URL` | Base URL for the OpenSearch MCP server |
| `OPENSEARCH_TOKEN` | Read-only API token for OpenSearch |
| `SENTRY_URL` | Base URL for the Sentry MCP server |
| `SENTRY_TOKEN` | Read-only API token for Sentry |

### Credential Rotation

When rotating credentials:

1. Update the environment variable with the new credential.
2. Restart the plugin (or the Claude Code session).
3. The plugin will use the new credential on the next observation run.
4. No configuration files need to be modified.

## 3. Observation Report Access Control

Observation reports contain production-derived content that has been scrubbed for PII and secrets. However, they may still contain sensitive operational data (error rates, latency percentages, service names).

### Public Repositories

For public repositories, the `.autonomous-dev/` directory must be excluded from version control. The plugin's `.gitignore` includes:

```
.autonomous-dev/observations/
.autonomous-dev/logs/
.autonomous-dev/baselines/
.autonomous-dev/fingerprints/
```

These exclusions prevent accidental publication of:

- Observation reports (production-derived analysis)
- Audit logs (run metadata and error details)
- Baseline data (historical metric snapshots)
- Fingerprint data (deduplication hashes)

### Private Repositories

For private repositories, access is controlled at the repository level. The observation data directory structure is:

```
.autonomous-dev/
  observations/          # Observation reports (Markdown)
    archive/             # Archived observations (older than retention period)
  logs/                  # Audit logs per run
    intelligence/        # Run-level logs with metadata
  baselines/             # Historical metric baselines
  fingerprints/          # Deduplication fingerprint cache
```

Repository administrators should ensure that only authorized team members have access to the repository.

## 4. Data Safety Pipeline

The data safety pipeline is a mandatory, non-bypassable scrubbing step that runs between data collection and analysis in every observation run.

### Pipeline Stages

1. **PII Scrubber (Stage 1)**: 11 deterministic regex patterns detect and replace personally identifiable information (emails, phone numbers, SSNs, credit cards, IP addresses, JWTs, user-context UUIDs).
2. **Secret Detector (Stage 2)**: 15 deterministic regex patterns detect and replace secrets (AWS keys, Stripe keys, GitHub tokens, GitLab tokens, GCP keys, Slack tokens, bearer tokens, basic auth, private keys) plus an environment variable pattern and Shannon entropy-based generic detector.

### Non-Bypassable Guarantee

- There is no `skip_scrubbing` configuration flag.
- The `scrubCollectedData()` function is called unconditionally in the runner pipeline.
- If scrubbing fails (timeout or persistent error), the affected data is replaced with `[SCRUB_FAILED:...]` -- raw text is **never** passed through to the LLM context or any persisted file.

### Weekly Audit Scan

A weekly automated audit scans all observation report files for patterns that should have been caught by the real-time scrubber. This is the last line of defense:

- Scans all `.md` files in `.autonomous-dev/observations/` (including subdirectories and archive).
- Runs the full PII + secret pattern library against file contents.
- Performs expanded entropy analysis on all strings > 20 chars (broader than real-time).
- Target: zero findings on every weekly audit run.
- Any finding represents a scrubbing failure that must be investigated.
