# Verification Artifact Fallback (REQ-000052 / #617)

## Background

Issue #617 reported a false-negative in the verification gate: a passing build
(208/208 tests) was marked `VERIFICATION_FAILED / command_not_in_audit_log`
because the agent's test command (`bun test`) was not captured in the audit log,
even though the command ran and produced a test-results artifact.

The root cause is that the PreToolUse audit-log hook may fail silently (e.g.
race condition, SDK version without `tool_use_id`, or hook not invoked before
response). The fix (REQ-000052) adds an artifact-as-proof fallback: when a
substantive presence-miss occurs and `VERIFICATION_ARTIFACT_FALLBACK=1`, the
verifier searches for a fresh, ecosystem-matched, content-validated test/build
artifact and, if found, rescues the verdict as `verified_by_artifact`.

## New Verdict: `verified_by_artifact`

When the fallback fires, the verification report row will have:

```json
{
  "verdict": "verified_by_artifact",
  "reason": "artifact_proof=junit:/abs/project/junit.xml|tests=208|failures=0",
  "artifact_proof": {
    "kind": "junit",
    "path": "/abs/project/junit.xml",
    "tests": 208,
    "failures": 0,
    "mtime": "2026-06-29T15:30:12Z"
  }
}
```

To grep for rescued rows:

```bash
jq 'select(.verdict == "verified_by_artifact")' \
  .autonomous-dev/requests/REQ-XXXXXX/verification-report.jsonl
```

## Environment Flags

| Flag | Default | Description |
|---|---|---|
| `VERIFICATION_ARTIFACT_FALLBACK` | `1` | `0` disables the rescue entirely |
| `VERIFICATION_ARTIFACT_MAX_DEPTH` | `6` | Max `find` depth under project root |
| `VERIFICATION_ARTIFACT_MAX_FILES` | `200` | Max candidate paths to scan |
| `VERIFICATION_ARTIFACT_MAX_SIZE_MB` | `5` | Max artifact file size in MB |
| `VERIFICATION_ARTIFACT_FRESHNESS_REQUIRED` | `1` | `0` skips the mtime >= dispatched_at check |

## Disabling the Fallback

```bash
export VERIFICATION_ARTIFACT_FALLBACK=0
```

**Security trade-off:** with the fallback enabled, an agent could in theory
pre-stage a test artifact before running the agent session and have it counted
as proof. The freshness gate (artifact mtime >= dispatched_at) mitigates this
by requiring the artifact to have been written after the phase was dispatched.
Disabling the fallback (`=0`) restores strict audit-log-only verification.
