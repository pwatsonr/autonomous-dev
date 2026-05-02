# Additional-Gate Evaluators (Stubs)

These scripts are **stubs**. They emit a passing JSON artifact unconditionally
so infra-typed requests do not hang on missing gate evaluation during the
PLAN-018-2 rollout. Each stub MUST be replaced with a real evaluator before
relying on the corresponding gate in production.

## Artifact contract

The supervisor checks **presence**, not content, of the artifact at:

```
<state-dir>/gates/<gate-name>.json
```

Any non-empty file at that path unblocks phase advancement past the gated
phase. Operators relying on real gate semantics MUST replace the stubs with
implementations that fail when the underlying check fails (and skip writing
the artifact, or write `status: "failed"` and surface that downstream).

## Artifact JSON shape

```json
{
  "gate": "<gate-name>",
  "status": "passed",
  "stub": true,
  "evaluated_at": "2026-05-01T12:34:56Z"
}
```

Real evaluators may add arbitrary additional keys (findings, links to
reports, severity, etc.). The four documented keys above are reserved.

## Wiring

The supervisor consults `.type_config.additionalGates[<phase>]` in
`state.json` (v1.1). When that key is set, the supervisor calls
`check_required_gates` (in `bin/lib/gate-check.sh`) before allowing
advancement past `<phase>`. If the artifact is absent, `status_reason` is
updated to `awaiting gate: <gate-name>` and the request stays put.

The stubs in this directory are NOT auto-invoked. They are operator-callable
helpers used to manually unblock requests during development. A future plan
wires them into a hook, agent, or scheduled job.

## Replacing a stub

Replace the script body with the real check. Preserve the artifact path and
the four reserved keys. Drop `"stub": true` once the implementation is real.
