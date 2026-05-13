# Autonomous Dev Integration Guide

This document describes the end-to-end pipeline integration delivered by PLAN-039, covering the submit-to-artifact flow, state management, and troubleshooting.

## Overview

The autonomous development pipeline processes requests from submission through multiple phases (PRD, TDD, Plan, Spec, Code) to produce artifacts and pull requests. The system consists of:

- **CLI submission** → SQLite intake + state.json generation
- **Daemon processing** → phase-to-agent dispatch + state transitions
- **Portal synchronization** → request action files for UI updates

## Submit Flow

Requests are submitted via the CLI and processed as follows:

1. **CLI Submission**: `autonomous-dev request submit <description> --repo <repo> --type <type>`
2. **Intake Storage**: Creates SQLite row in `~/.autonomous-dev/intake.db` and `state.json` file
3. **Daemon Pickup**: Polls for `status: queued` requests and transitions to first phase
4. **Auto-transition**: `intake` phase automatically advances to `prd` without agent dispatch

See TDD-038 §6 for detailed technical specifications.

## State.json Schema

The `state.json` file is the canonical runtime state for each request:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Request ID (REQ-NNNNNN format) |
| `status` | string | Current status: `queued`, `running`, `gate`, `done`, `cancelled`, `failed` |
| `current_phase` | string | Current phase: `intake`, `prd`, `prd_review`, `tdd`, `tdd_review`, etc. |
| `priority` | number | Priority level: 0=high, 1=normal, 2=low |
| `created_at` | string | ISO-8601 creation timestamp |
| `updated_at` | string | ISO-8601 last modified timestamp |
| `title` | string | Request title from submission |
| `description` | string | Request description from submission |
| `target_repo` | string | Absolute path to target repository |
| `source` | string | Source channel (`cli`, `slack`, etc.) |
| `type` | string | Request type: `feature`, `bug`, `infra`, `refactor`, `hotfix` |
| `blocked_by` | array | Array of blocking request IDs |
| `phase_history` | array | Historical phase transitions |
| `phase_overrides` | array | Custom phase sequence (empty = use default) |
| `current_phase_metadata` | object | Phase-specific metadata |
| `cost_accrued_usd` | number | Total cost accrued across phases |
| `turn_count` | number | Total agent turns used |
| `escalation_count` | number | Number of escalations |
| `schema_version` | number | Schema version (currently 1) |
| `error` | string | Error message if status is `failed` |

## Phase-to-Agent Mapping

This is the `resolve_agent()` table in `bin/supervisor-loop.sh`. There are no
`prd-reviewer`/`tdd-reviewer`/etc. agent files, so the document-review phases
all route to `doc-reviewer` (which reviews PRDs/TDDs/plans/specs); code review
uses `quality-reviewer`.

| Phase | Agent | Purpose |
|-------|-------|---------|
| `intake` | _(none — bookkeeping; auto-transitions to `prd`)_ | — |
| `prd` | `prd-author` | Write Product Requirements Document |
| `prd_review` | `doc-reviewer` | Review and approve/reject PRD |
| `tdd` | `tdd-author` | Write Technical Design Document |
| `tdd_review` | `doc-reviewer` | Review and approve/reject TDD |
| `plan` | `plan-author` | Write Implementation Plan |
| `plan_review` | `doc-reviewer` | Review and approve/reject Plan |
| `spec` | `spec-author` | Write Implementation Specifications |
| `spec_review` | `doc-reviewer` | Review and approve/reject Specs |
| `code` | `code-executor` | Implement code changes; create branch + PR |
| `code_review` | `quality-reviewer` | Review code for bugs/security/performance |
| `security_review` | `security-reviewer` | Focused security review |
| `deploy` | `deploy-executor` | Run the deployment workflow |

## State Machine

Phase transitions follow these rules:

- **Pass → Next**: Successful phase moves to next in sequence
- **Fail → Retry**: Failed phase retries up to `max_retries_per_phase` (default: 3)
- **Review → Gate**: Review phases move to `gate` status for human approval
- **Retry Exhausted**: After max retries, status becomes `failed`

Default phase sequence: `intake` → `prd` → `prd_review` → `tdd` → `tdd_review` → `plan` → `plan_review` → `spec` → `spec_review` → `code` → `code_review` → `done`

## Claude Invocation

Agents are invoked via the corrected `claude` CLI contract:

```bash
claude --print --output-format json \
       --agent "${agent}" \
       --add-dir "${req_dir}" --add-dir "${project}" \
       --permission-mode acceptEdits \
       --max-budget-usd "${phase_budget}" \
       "${phase_prompt}"
```

Where:
- `req_dir` = `dirname(state_file)` (makes state.json readable)
- `project` = project root (makes codebase readable)
- `phase_prompt` = prompt with instructions for the specific phase

## Portal Sync

The daemon writes request action files to `${AUTONOMOUS_DEV_STATE_DIR}/request-actions/` (default: `~/.autonomous-dev/request-actions/`) for portal consumption:

```json
{
  "id": "REQ-000001",
  "repo": "/path/to/repo",
  "title": "Request title",
  "phase": "prd_review",
  "status": "gate",
  "cost": 1.25,
  "variant": "feature",
  "createdAt": "2026-05-11T22:00:00Z",
  "completedAt": null,
  "waitedMin": 15
}
```

The `waitedMin` field tracks how long requests have been waiting in gate status.

## Failure Modes

### Orphan Reconciliation
- **Symptom**: SQLite row exists but no state.json file
- **Action**: Request status set to `cancelled/state-file-lost`
- **Check**: Daemon log for "orphan reconciliation" messages

### Retry Exhaustion
- **Symptom**: Phase fails `max_retries_per_phase` times
- **Action**: Request status set to `failed`
- **Check**: `state.json` `error` field for "max retries exceeded"

### Missing Phase Result
- **Symptom**: Agent completes but doesn't write phase-result.json
- **Action**: Synthesized phase-result with `"synthesized": true`
- **Check**: Daemon log for "synthesizing fail result"

### Wall-Clock Timeout
- **Symptom**: Phase runs longer than 30 minutes
- **Action**: Agent killed, synthesized result with `error: "WALL_CLOCK_TIMEOUT"`
- **Check**: Daemon log for timeout messages

## Operator Commands

- **Submit**: `autonomous-dev request submit <description> --repo <repo> --type <type>`
- **Status**: `autonomous-dev request status <REQ-ID>`
- **List**: `autonomous-dev request list [--repo <repo>]`
- **Cancel**: `autonomous-dev request cancel <REQ-ID>`
- **Gate Approve**: Via portal UI or `autonomous-dev request approve <REQ-ID>`
- **Gate Reject**: Via portal UI or `autonomous-dev request reject <REQ-ID>`

## Troubleshooting

### Request Not Picked Up
- **Check**: Repository in allowlist (`~/.claude/autonomous-dev.json` → `repositories.allowlist[]`)
- **Check**: Daemon running (`autonomous-dev daemon status`)
- **Check**: No kill switch engaged (`~/.autonomous-dev/kill-switch.flag` should not exist)

### Portal Not Updating
- **Check**: Portal request actions directory exists: `~/.autonomous-dev/request-actions/`
- **Check**: Request action file exists for your request ID
- **Check**: `waitedMin` field increasing (shows daemon is updating)

### Agent Dispatch Failing
- **Check**: `claude` CLI available on PATH
- **Check**: Daemon log for spawn-session errors
- **Check**: Phase-result files in request directory

### High Cost Usage
- **Check**: Cost limits in config: `daemon.daily_cost_cap_usd`, `daemon.monthly_cost_cap_usd`
- **Check**: Cost ledger: `~/.autonomous-dev/cost-ledger.json`
- **Check**: Per-request costs in `state.json` `cost_accrued_usd`

## Where to Look

- **Daemon logs**: `~/.autonomous-dev/logs/daemon.log`
- **State files**: `<repo>/.autonomous-dev/requests/REQ-*/state.json`
- **Events log**: `~/.autonomous-dev/logs/events.jsonl`
- **Portal actions**: `~/.autonomous-dev/request-actions/REQ-*.json`
- **Phase results**: `<repo>/.autonomous-dev/requests/REQ-*/phase-result-<phase>.json`
- **Cost tracking**: `~/.autonomous-dev/cost-ledger.json`
- **Configuration**: `~/.claude/autonomous-dev.json`

## See Also

- [Smoke E2E Test](../test/e2e/smoke-e2e.sh) - Automated end-to-end verification
- [Manual Verification Runbook](manual_verification/PLAN-039-e2e-pipeline-verification.md) - Step-by-step validation guide
- [TDD-038](tdd/TDD-038-intake-to-deploy-e2e-pipeline.md) - Technical design specifications
- [PRD-019](prd/PRD-019-intake-to-deploy-e2e-pipeline.md) - Product requirements
- [RESEARCH-039](research/RESEARCH-039-claude-state-semantics.md) - Claude CLI flag analysis