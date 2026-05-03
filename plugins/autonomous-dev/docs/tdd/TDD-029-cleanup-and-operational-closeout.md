# TDD-029: Cleanup and Operational Closeout for TDDs 010-024

| Field          | Value                                                       |
|----------------|-------------------------------------------------------------|
| **Title**      | Cleanup and Operational Closeout for TDDs 010-024           |
| **TDD ID**     | TDD-029                                                     |
| **Version**    | 1.0                                                         |
| **Date**       | 2026-05-02                                                  |
| **Status**     | Draft                                                       |
| **Author**     | Patrick Watson                                              |
| **Parent PRD** | PRD-017: Cleanup, Hygiene, and Operational Closeout         |
| **Plugin**     | autonomous-dev                                              |

---

## 1. Summary

TDD-029 is the architectural design for the closeout effort defined by PRD-017. PRD-017 closes five hygiene loops left open at the end of the spec→code session that built TDDs 010-024: a cost-cap dual-path (production code), pinned-SHA placeholders in deploy plugins and the release workflow, a missing opt-in `observe.yml.example`, ~30+ specs whose "Files to Create/Modify" tables drifted from the as-built layout, and a recurring "stale stub assertion" pattern that has no documented prevention.

The five workstreams are mechanical or doc-only; none invent product behavior. The single architectural decision in this TDD that has runtime impact is the cost-cap dual-path resolution — TDD-029 selects **Path-A** (migrate orchestrator to `cost-cap-enforcer.ts`, delete `cost-cap.ts`) and specifies how the migration ships behind a feature flag with a deprecation window. Every other workstream is a deletion, a doc edit, a workflow template, or a convention proposal.

The TDD is intentionally kept compact: PRD-017's NG-02 forbids widening cleanup into refactor, so the design space is small. What design exists is in the trade-offs (Path-A vs Path-B for cost-cap; SHA-pin automation vs manual pinning + cadence; lint enforcement vs convention-only for stub-assertion staleness) and in the cross-cutting concerns each workstream introduces (supply-chain integrity, audit independence, no-regress test posture).

---

## 2. Goals and Non-Goals

### 2.1 Technical Goals

| ID    | Goal                                                                                                                                                |
|-------|-----------------------------------------------------------------------------------------------------------------------------------------------------|
| TG-01 | Eliminate dead code on the cost-cap surface: orchestrator, tests, and ledger callers all converge on `cost-cap-enforcer.ts`; `cost-cap.ts` deleted. |
| TG-02 | Make `git grep 'TBD-replace-with-pinned-SHA'` return zero matches on `main` across the four cloud-deploy plugins and `release.yml`.                 |
| TG-03 | Ship `observe.yml.example` that passes `actionlint` and is referenced from `commands/observe.md`.                                                   |
| TG-04 | Amend every drifted spec's "Files to Create/Modify" table to reflect as-built paths, with original paths preserved in `<!-- moved-from -->` comments.|
| TG-05 | Publish a lessons-learned appendix and a proposed test-tagging convention for stub-assertion staleness; do not enforce in this PRD.                 |
| TG-06 | Hold the line on test counts: jest baseline before the PR ≤ jest baseline after the PR for total tests; pass count strictly non-decreasing.         |
| TG-07 | Keep each workstream in its own commit so reviewers can revert any one independently (PRD-017 FR-1726).                                             |

### 2.2 Non-Goals

| ID     | Non-Goal                                                                                                                       |
|--------|--------------------------------------------------------------------------------------------------------------------------------|
| NTG-01 | No refactor of cost-governance beyond the import-site migration (no schema change, no API change for the enforcer).            |
| NTG-02 | No new linter, CI gate, or precommit hook beyond the targeted `lint:no-tbd-shas` script PRD-017 already mandates.              |
| NTG-03 | No structural changes to spec content. Drift sweep edits paths only; acceptance criteria, requirements, and test plans are untouched. |
| NTG-04 | No enforcement of the proposed test-tagging convention; that is a follow-up PRD.                                               |
| NTG-05 | No bumps of upstream third-party action versions. SHA pinning fixes the version that is *already in use*; bumps are out of scope. |

---

## 3. Tenets

These tenets resolve the recurring trade-offs across the five workstreams.

1. **Independent revertability over single-PR convenience.** Each workstream lands in its own commit (and may split into its own PR if review requests it). When a closeout commit breaks production, the revert must not undo the other four.
2. **Doc-only edits are reviewed line-by-line.** The path-drift sweep touches ~30+ files; reviewer fatigue is the primary risk. The architecture pushes the sweep into a single commit with a machine-generated summary table so the reviewer can spot-check rather than re-read.
3. **Path-A wins when one file dominates.** When two files implement overlapping behavior, the one with the stronger security and observability story (HMAC-chained ledger, sticky escalations, override consumption) is the survivor. Documenting both as "intentionally distinct" is the lazy answer and is rejected here.
4. **Pin to what is already running, not to what is newest.** SHA pinning is a supply-chain hygiene exercise; bumping versions is a separate exercise that PRD-017 NG-02 forbids.

---

## 4. Architecture Overview

The five workstreams partition naturally by area of the repository. They touch nothing in common except the closeout PR's branch and the test posture (TG-06).

```
                  PRD-017 closeout PR
                         │
   ┌──────────┬──────────┼──────────┬───────────┬───────────┐
   │          │          │          │           │           │
   ▼          ▼          ▼          ▼           ▼           ▼
[WS-1]     [WS-2]     [WS-3]     [WS-4]      [WS-5]      [WS-6]
cost-cap   SHA-pin   observe    spec drift  stub-asn    lint
migration  resolve   template    sweep       lessons     guard
   │          │          │          │           │           │
   ▼          ▼          ▼          ▼           ▼           ▼
intake/   plugins/   plugins/    docs/       docs/       package
deploy/*  *-deploy-* autonomous- specs/**    lessons-    .json +
          /**/*.yml  dev/.gh/wf/             learned/    CI step
          + .gh/wf/  observe.    +_path-     stub-asn-
          release    yml.example drift-      stalenes
          .yml                   amend.md    .md

                   (independent commits;
                    no shared source files)
```

Each workstream is one commit. `WS-6` (the `lint:no-tbd-shas` script) is paired with `WS-2` so the guard ships with the fix and reverts together if the SHA pin needs to roll back.

The only runtime change is `WS-1` (cost-cap migration). The other five workstreams are doc, workflow, or build-tooling changes with no runtime effect.

---

## 5. Detailed Design

### 5.1 WS-1: Cost-Cap Dual-Path Migration (Path-A)

**Decision: Path-A.** Migrate `intake/deploy/orchestrator.ts` from `cost-cap.ts` to `cost-cap-enforcer.ts`; delete `cost-cap.ts`; port its tests.

#### 5.1.1 Why Path-A

Reading both files reveals a clean superset relationship rather than two distinct responsibilities:

| Capability                            | `cost-cap.ts` (PLAN-023-2) | `cost-cap-enforcer.ts` (PLAN-023-3) |
|---------------------------------------|----------------------------|--------------------------------------|
| Per-env daily aggregate                | Yes (`CostLedger` JSON)    | Yes (via `CostLedger.aggregate`)     |
| HMAC-chained tamper-evident ledger     | No                         | Yes (records via `CostLedger`)       |
| 80% sticky soft warning per actor/day  | No                         | Yes (`maybeStickyWarn`)              |
| 100% projected reject                  | Yes (`reason` string)      | Yes (`DailyCostCapExceededError`)    |
| 110% admin override token consumption  | No                         | Yes (`consumeOverride`)              |
| Operator config hot-reload             | No                         | Yes (`config: () => ...`)            |
| UTC rollover                           | Yes                        | Implicit via `aggregate({window})`   |
| Idempotent record-on-success           | Yes (`recordCost`)         | Lives on `CostLedger`, not enforcer  |

Every capability `cost-cap.ts` provides exists in the `cost-cap-enforcer.ts` plus ledger combination. There is no Path-B argument that survives this table — keeping both forces every future contributor to read both before changing either, in violation of Tenet 3.

The orchestrator currently calls `checkCostCap` (returns `{allowed, reason}`) and `recordCost` (idempotent append). The enforcer's `check()` throws on rejection and records via the injected `CostLedger`. The migration is a small wrapper at the orchestrator level — no API expansion of the enforcer.

#### 5.1.2 Migration Shape

`intake/deploy/orchestrator.ts` changes (illustrative; final shape lives in the spec):

```typescript
// before
const capCheck = await checkCostCap({ requestDir, envName, capUsd, estimatedUsd });
if (!capCheck.allowed) throw new CostCapExceededError(capCheck.reason);
// ... after backend.deploy() ...
await recordCost({ requestDir, envName, deployId, usd: estimatedCost });

// after
const enforcer = new CostCapEnforcer({
  ledger: getLedger(args.requestDir),                  // shared ledger instance
  config: () => loadCostCapConfig(args.requestDir),
  escalate: orchestratorEscalationSink,                 // existing sink
});
try {
  await enforcer.check({
    actor: args.actor,
    estimated_cost_usd: estimatedCost,
    deployId: args.deployId,
    env: resolved.envName,
    backend: selection.backendName,
  });
} catch (err) {
  if (err instanceof DailyCostCapExceededError || err instanceof AdminOverrideRequiredError) {
    emitDeployCompletion({ ..., outcome: 'cost-cap-exceeded', reason: err.message });
    throw err;
  }
  throw err;
}
// ... after backend.deploy() ...
await getLedger(args.requestDir).recordCompleted(args.deployId, estimatedCost);
```

The orchestrator's `RunDeployArgs` gains an `actor` field (already supplied by caller as part of approval state — no new plumbing).

#### 5.1.3 Feature Flag and Deprecation Window

Risk R1 (PRD-017): the migration could break an undiscovered caller. Mitigation:

1. The closeout PR introduces an env-var feature flag `AUTONOMOUS_DEV_COST_CAP_LEGACY=1`. When set, the orchestrator routes to the legacy `checkCostCap` path. Default is unset (new path).
2. `cost-cap.ts` is deleted in the same PR but its exported functions are re-exported as deprecated thin shims from `cost-cap-enforcer.ts` for one minor version. This preserves any external consumer (none known, but the deploy plugins are operator-extensible).
3. The shim emits `console.warn('cost-cap.ts shim — switch to CostCapEnforcer; will be removed in vNEXT')` exactly once per process via a Set guard.

The feature flag is removed in the next minor release; the shim is removed at the same time. PRD-017 does not own that follow-up — it's logged in §11.

#### 5.1.4 Test Migration

Tests under `intake/deploy/__tests__/cost-cap.test.ts` (or wherever they live in tree) are ported to `cost-cap-enforcer.test.ts`. The contract checks that previously asserted `result.allowed === false && result.reason === '...'` migrate to `expect(...).rejects.toThrow(DailyCostCapExceededError)`. Idempotency of `recordCost` becomes a test against `CostLedger.recordCompleted` (deduplicates on `deployId`).

A new orchestrator-level test (FR-1705) asserts that `runDeploy()` with a non-zero `costCapUsd` writes a ledger entry through the enforcer for every successful deploy, and that the entry is HMAC-chained.

### 5.2 WS-2: Cloud SHA Placeholder Resolution

#### 5.2.1 Approach

For every occurrence of `TBD-replace-with-pinned-SHA` in `plugins/autonomous-dev-deploy-{aws,gcp,azure,k8s}/**` and `.github/workflows/release.yml`, perform the following per-occurrence procedure:

1. Read the action reference (`uses: org/action-name@TBD-replace-with-pinned-SHA`).
2. Identify the version comment that already accompanies the line (the SPEC-024-1 deviation requires every TBD line to be accompanied by `# {action}@v{semver}`).
3. Resolve that semver tag to its SHA via `gh api repos/{org}/{action}/git/ref/tags/v{semver}`. Verify the SHA is reachable on the upstream `main` branch (defense against tag-replay).
4. Replace the literal with the 40-char SHA. Update the comment to `# {action-name}@v{semver} (pinned 2026-05-02)`.

This is a per-PR procedure (FR-1708). To keep the closeout PR auditable, the SHA resolution is performed manually with each commit captured in the diff — automation here is anti-goal because supply-chain pin verification is the kind of work that benefits from human eyes.

#### 5.2.2 Pinning Protocol vs Dependabot

**Decision: Manual pinning + documented refresh cadence.** Dependabot was considered.

| Approach           | Pro                                            | Con                                                                                                |
|--------------------|------------------------------------------------|----------------------------------------------------------------------------------------------------|
| Dependabot         | Automatic; no human cadence                    | Bumps to *new* versions; PRD-017 NG-05 forbids version bumps; opt-in across 5 plugin dirs is fragile |
| Manual + cadence   | Operator controls when bumps happen            | Requires periodic review; staleness possible                                                        |
| Hybrid (Dependabot for *security-only*) | Catches CVEs without minor bumps  | Action ecosystem rarely ships security advisories; over-engineered for current risk                 |

Manual is selected. The "How to refresh pins" runbook (FR-1710) lives at `plugins/autonomous-dev/docs/runbooks/refresh-action-pins.md` and documents the same per-occurrence procedure plus a quarterly review cadence.

#### 5.2.3 Lint Guard (WS-6, paired with WS-2)

A new npm script `lint:no-tbd-shas` runs:

```bash
git grep -n 'TBD-replace-with-pinned-SHA' \
  -- 'plugins/autonomous-dev-deploy-*' '.github/workflows/release.yml' \
  && echo "ERROR: TBD-replace-with-pinned-SHA reintroduced" && exit 1 \
  || exit 0
```

It is wired into the existing `ci.yml` `lint` job (one new `run:` step) and into `package.json` `scripts.lint:no-tbd-shas`. No new workflow file; no new tooling.

### 5.3 WS-3: observe.yml.example Workflow Template

#### 5.3.1 File Layout

`plugins/autonomous-dev/.github/workflows/observe.yml.example` is shipped as a copy-target. Operators copy it to their *own* `.github/workflows/observe.yml`. This matches the convention PRD-010 §5.9 specifies — the file ships with `.example` so it is not invoked from the autonomous-dev repo's own CI.

#### 5.3.2 Workflow Content

```yaml
# observe.yml.example — opt-in observability digest workflow
# Copy this to .github/workflows/observe.yml in your repo and customize.
# Required secrets: AUTONOMOUS_DEV_OBSERVE_TOKEN
# Required inputs: see the `with:` block below
# See plugins/autonomous-dev/commands/observe.md for the operator runbook.

name: Observe (autonomous-dev digest)

on:
  schedule:
    - cron: '0 14 * * 1'   # Mondays 14:00 UTC; customize per team timezone
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  digest:
    runs-on: ubuntu-latest
    if: false   # default OFF; set to true after configuring inputs
    steps:
      - uses: actions/checkout@v4
      - name: Run observe digest
        run: npx @autonomous-dev/observe digest --window 7d
        env:
          AUTONOMOUS_DEV_OBSERVE_TOKEN: ${{ secrets.AUTONOMOUS_DEV_OBSERVE_TOKEN }}
      - name: Sticky comment closer
        uses: marocchino/sticky-pull-request-comment@v2  # pinned in WS-2 cadence
        with:
          header: autonomous-dev-observe
          recreate: true
          path: observe-digest.md
```

Key design choices:

- `if: false` default per Risk R5: prevents unconfigured runs.
- `marocchino/sticky-pull-request-comment` is pinned to a SHA via the same `@v2` → SHA pinning procedure as WS-2.
- The schedule is documented as customizable (PRD-010 §5.9 requires cron, not a specific value).
- Header comments enumerate required secrets and the runbook path (FR-1712).

#### 5.3.3 Doc-Only Test (FR-1714)

A markdown/file-existence assertion lives in the existing `test:docs` suite: `expect(fs.existsSync('plugins/autonomous-dev/.github/workflows/observe.yml.example')).toBe(true)`. A second assertion runs `actionlint plugins/autonomous-dev/.github/workflows/observe.yml.example` and expects exit code 0. If `actionlint` is not present in the repo's devDependencies (OQ-06), it is added in this PR.

### 5.4 WS-4: Spec Path-Drift Sweep (Production Code Side)

#### 5.4.1 Detection Pipeline

A one-shot script (lives at `scripts/audit-spec-drift.ts`, deleted in the same PR after the report is captured — it is a single-use audit aid, not infrastructure):

```typescript
// 1. For every spec under plugins/autonomous-dev/docs/specs/**:
//    a. Parse "Files to Create/Modify" tables (markdown table after a heading
//       matching /^##.*Files to (Create|Modify)/i).
//    b. Extract the path from each row.
//    c. Test fs.existsSync(repoRoot + path).
//    d. If not exists, run a heuristic remap:
//       - 'src/portal/...' → try 'plugins/autonomous-dev-portal/server/...'
//       - 'plugins/autonomous-dev/...' → try 'plugins/autonomous-dev/intake/...'
//       - record both the original and any candidate match.
//    e. Append to a CSV: spec_id, original_path, candidate_path, exists_after_remap.
// 2. The CSV is the input to the human author of the doc-only commit:
//    they review each row, pick the right as-built path, and edit the spec.
```

The script is a *finder*, not an *editor*. PRD-017 FR-1717 forbids non-path edits, and Tenet 2 says doc-only edits are line-by-line reviewed — automated `sed -i` would risk false-positive replacements inside code blocks or unrelated prose. The author edits each spec by hand; the script's job is to make the work-list complete.

#### 5.4.2 Amendment Format

Per FR-1716, every amended row in a spec gains a preceding HTML comment:

```markdown
## Files to Create/Modify

| Path                                          | Action |
|-----------------------------------------------|--------|
<!-- moved-from: src/portal/foo.ts -->
| plugins/autonomous-dev-portal/server/foo.ts   | Create |
```

The HTML comment is invisible in rendered markdown but greppable. `_path-drift-amendments.md` (FR-1718) is generated by:

```bash
git grep -n '<!-- moved-from:' -- 'plugins/autonomous-dev/docs/specs/' \
  | sort \
  | sed -E 's/^([^:]+):.*moved-from: (.*) -->$/\1|\2/' \
  > /tmp/drift.tsv
```

Then a small markdown table is hand-built or scripted from `/tmp/drift.tsv`. The summary table in `_path-drift-amendments.md` has columns: `Spec ID | Original Path | As-Built Path | Commit SHA`.

#### 5.4.3 Test-Side Drift Boundary (FR-1720)

If a spec's "Files to Create/Modify" entry is a test path (matches `/(tests?|__tests__|spec)\//`), the row is added to `_path-drift-amendments.md` in a separate "Deferred to PRD-016" section, **not amended in this PR**. This is enforced by a checklist in the closeout PR description, not by tooling.

### 5.5 WS-5: Stub-Assertion Staleness — Lessons-Learned and Convention

#### 5.5.1 Appendix Structure

`plugins/autonomous-dev/docs/lessons-learned/stub-assertion-staleness.md` follows a standard lessons-learned shape:

1. **Pattern Description.** SPEC-N stubs assert `console.warn('stub')` to certify the stub is wired. SPEC-N+1 replaces the stub with the real impl. The SPEC-N test still passes because (a) some other unrelated `console.warn` matches, or (b) the stub-warning is silently dropped from the assertion when the test was modified for typing reasons.
2. **Three Cited Examples (FR-1722).** Real SPEC IDs from the spec→code session, with the stub assertion text and how it became stale. The examples are populated from the audit log; specific SPEC IDs are deferred to the spec phase.
3. **Proposed Convention (FR-1723).** Per OQ-07 recommendation: a structured helper function `stubOf(specId, replacedBySpecId?)` that gets imported into the test file. When `replacedBySpecId` is set, the helper makes the test fail with a clear "stub for SPEC-N has been superseded by SPEC-M; remove this assertion" message.

   ```typescript
   // proposed (not enforced in this PRD):
   import { stubOf } from '@autonomous-dev/test-utils';
   describe('SPEC-023-2-04 cost-cap', () => {
     stubOf('SPEC-023-2-04').supersededBy('SPEC-023-3-03');
     it('warns when stub fires', () => { /* ... */ });
   });
   ```

   When SPEC-023-3-03's PR lands, the implementer flips one line:

   ```diff
   - stubOf('SPEC-023-2-04').supersededBy('SPEC-023-3-03');
   + stubOf('SPEC-023-2-04').supersededBy('SPEC-023-3-03').delete();
   ```

   The `.delete()` makes the test fail loudly until the assertion is removed, surfacing the stale block in the diff.
4. **Worked Example (FR-1724).** A complete diff showing SPEC-N+1's PR flipping the tag.
5. **Deferred Adoption (FR-1725).** A short list of open questions the follow-up PRD must answer: (a) is the helper a runtime no-op or compile-time check? (b) how does it interact with `describe.skip`? (c) what's the mechanism for "delete me" — throw, fail, or warn?

The appendix is **documentation, not enforcement.** Per NG-04 and Tenet 1, no linter or CI gate is added in this PRD.

### 5.6 WS-6: Lint Guard

Already covered in §5.2.3. Co-located with WS-2 because the guard's purpose is to defend WS-2's invariant.

---

## 6. Cross-Cutting Concerns

### 6.1 Security

- **WS-1 (cost-cap migration).** Path-A *strengthens* security: the HMAC-chained ledger replaces the unsigned JSON ledger. Tamper-evidence improves. The deprecation shim is a supply-chain consideration: the shim re-exports the old API but routes to the new ledger underneath, preserving signing.
- **WS-2 (SHA pinning).** This *is* a security workstream. The closeout converts trust-on-tag-name (mutable) to trust-on-SHA (immutable). The lint guard prevents regression. The verification step (resolve tag → SHA via `gh api`, check reachable on upstream `main`) defends against tag-replay attacks where an attacker pushes a malicious commit and re-tags `v2` to point to it.
- **WS-3 (observe.yml.example).** `if: false` default means a copied-without-config workflow will not run unconfigured. Required secrets are enumerated in header comments. The pinned sticky-comment action is itself part of WS-2's pin set.
- **WS-4 (spec drift).** Doc-only; no security surface.
- **WS-5 (stub assertion).** Doc-only; convention proposal does not change security posture.

### 6.2 Privacy

- **WS-1.** No new PII. The cost ledger contains `actor` strings (typically usernames or service accounts) — same as today.
- **WS-2.** Pinned SHAs are public commit identifiers; no privacy impact.
- **WS-3.** `observe.yml.example` references a secret (`AUTONOMOUS_DEV_OBSERVE_TOKEN`) but does not handle PII. The digest tool's PII handling is owned by the observe runbook, not this PR.
- **WS-4, WS-5.** Doc-only.

### 6.3 Scalability

This PRD does not change scaling characteristics of any subsystem.

- **WS-1.** `CostCapEnforcer.check()` performs the same I/O profile as `checkCostCap` (one read of the ledger file, one write on completion). The HMAC chain is O(N) on append but N is bounded by deploys-per-day-per-env, which is bounded by the cap. No new bottleneck.
- **WS-2.** Pinned SHAs do not change runtime cost; they may slightly slow `actions/setup-node`-style cache lookups by ~100ms because GitHub's action-cache may not pre-warm pinned SHAs as aggressively as tags. Acceptable.
- **WS-3.** Cron schedule is weekly; the workflow runs at most ~52 times per year per repo.
- **WS-4, WS-5.** Doc-only.

### 6.4 Reliability

- **WS-1 (the runtime change).** Risk R1 (PRD-017): undiscovered caller breaks. Mitigation is layered:
  1. Feature flag `AUTONOMOUS_DEV_COST_CAP_LEGACY=1` lets operators flip back without redeploy.
  2. Deprecated shim preserves the import surface for one minor version.
  3. Full integration test matrix runs before merge.
  4. The orchestrator's existing `try/catch` around `enforcer.check()` ensures unexpected throws bubble as `failed` deploy outcomes rather than process crashes.
- **WS-2.** Risk: a pinned SHA points to a release that is later yanked or rewritten upstream. Mitigation: the verification step checks reachability on upstream `main` at pin time; if upstream rewrites history later, our pin still works (the SHA is content-addressed) but our verification is now stale. Acceptable; refresh runbook covers it.
- **WS-3.** Workflow defaults to `if: false`. Even a misconfigured copy will not fire.
- **WS-4, WS-5.** Doc-only; reliability impact is on the *contributor onboarding* path, not runtime.

### 6.5 Observability

- **WS-1.** The orchestrator already emits `deploy.init` and `deploy.completion` telemetry. Path-A migration preserves both events. The `cost-cap-exceeded` outcome remains; the `reason` field now carries the enforcer's error class name plus message (e.g., `"DailyCostCapExceededError: projected USD 73.20 >= cap 50.00"`). This is *more* observable than the old `reason` strings.
- **WS-2.** No runtime observability change. The `lint:no-tbd-shas` check produces a CI failure with a clear error message naming the offending file and line.
- **WS-3.** The example workflow itself includes a sticky-comment closer that posts the digest to PRs. Operators get observability into their digest runs.
- **WS-4.** The `_path-drift-amendments.md` summary table provides observability into the audit. Future contributors searching for `<!-- moved-from: -->` find the trail.
- **WS-5.** The proposed `stubOf().supersededBy().delete()` helper is itself an observability instrument: when a stub is superseded, the test fails with a clear stale-stub message.

### 6.6 Cost

All workstreams are zero or near-zero infrastructure cost:

- **WS-1.** Same I/O profile; same compute. Free.
- **WS-2.** No runtime cost. CI cost: the `lint:no-tbd-shas` step is a single `git grep` invocation, ~50ms.
- **WS-3.** The example workflow is opt-in; cost is borne by adopting operators per their cron schedule. For autonomous-dev itself, zero cost (we ship the example, we do not invoke it).
- **WS-4, WS-5.** Doc edits; zero cost.

The only contributor cost is review time. The five-commit structure (TG-07) is the mitigation: reviewers can approve commit-by-commit and stop when fatigued.

---

## 7. Alternatives Considered

### 7.1 Alt-1: Path-B for Cost-Cap (Document Both Files as Intentional)

**Approach.** Keep both `cost-cap.ts` and `cost-cap-enforcer.ts`. Add JSDoc headers and an arch doc explaining that `cost-cap.ts` is the "simple per-env aggregate" used by the orchestrator and `cost-cap-enforcer.ts` is the "policy-rich enforcer" used by per-request flows.

**Pros.**
- Zero migration risk for the orchestrator. R1 is fully avoided.
- Smaller PR; less reviewer surface.

**Cons.**
- The two-files-with-overlap pattern is a known anti-pattern: every future contributor must read both before changing either.
- The capability table in §5.1.1 shows the enforcer is a strict superset; the "intentional distinction" is fictional.
- Doc-only resolution depends on contributors actually reading the doc — empirically unreliable.
- Tenet 3 explicitly rejects this answer when one file dominates.

**Verdict.** Rejected. The doc-only patch defers the migration cost rather than eliminating it; the dominant cost (every-future-contributor-reads-both) compounds, while the migration cost (one PR, one feature flag, one deprecation window) is paid once.

### 7.2 Alt-2: Automated `sed -i` Sweep for WS-4 Path Drift

**Approach.** Build a script that automatically rewrites every drifted path in every spec, using a heuristic remap table.

**Pros.**
- Faster: one author-day vs. the per-spec hand-edit estimate.
- Reproducible if rerun.

**Cons.**
- False-positive risk: a `sed -i 's|src/portal|plugins/autonomous-dev-portal/server|g'` rewrite catches paths inside fenced code blocks, in narrative prose ("see `src/portal/foo.ts` for context"), and in markdown links — wherever the path string occurs. Reviewer must still inspect every diff line.
- Tenet 2 says doc-only edits are line-by-line reviewed; an auto-sweep does not save reviewer time, only author time.
- The script becomes a dependency: future contributors discover it and assume it is maintained.

**Verdict.** Rejected. The detection script (§5.4.1) is kept (and deleted after use); the editing is hand-done.

### 7.3 Alt-3: Dependabot Instead of Manual SHA Pinning

**Approach.** Configure Dependabot to track the four cloud-deploy plugins and `release.yml`, automatically opening PRs when upstream actions release new versions.

**Pros.**
- Hands-off after initial config.
- Catches CVE-driven upstream releases.

**Cons.**
- Dependabot bumps to *new* versions; PRD-017 NG-05 forbids version bumps in this PR (the PR pins the version *that is already in use*).
- Configuring Dependabot for five separate locations (4 plugins + `release.yml`) is fragile and easy to misconfigure.
- The manual + cadence approach gives operators control over *when* bumps happen, which matters for branch-protected deploy workflows.

**Verdict.** Rejected for this PR. The "How to refresh pins" runbook (FR-1710) covers the manual cadence. A future PRD may revisit Dependabot if the manual cadence proves unsustainable.

### 7.4 Alt-4: Lint Rule for Stub-Assertion Staleness Now

**Approach.** Build a custom ESLint rule (or a jest matcher) that detects `console.warn('stub')` assertions and flags them when the underlying SUT is no longer a stub.

**Pros.**
- Enforcement, not just convention.
- Catches the pattern automatically.

**Cons.**
- "Underlying SUT is no longer a stub" is hard to detect from the test file alone — would need cross-module analysis.
- PRD-017 NG-04 explicitly forbids new linters in this PR.
- The proposed `stubOf().supersededBy()` helper (§5.5.1) is a lighter-weight enforcement that ships in a follow-up PRD.

**Verdict.** Rejected for this PR. The lessons-learned appendix proposes the helper; adoption is deferred (FR-1725).

### 7.5 Alt-5: Single Squashed Commit Instead of Five

**Approach.** Land the closeout as one squash-merged commit.

**Pros.**
- Simpler `git log`.

**Cons.**
- Violates FR-1726 (separate commits per workstream).
- Reviewer cannot revert one workstream without reverting all five.
- A regression caused by WS-1 (the only runtime-impact workstream) cannot be rolled back independently of the doc-only WS-4 sweep.

**Verdict.** Rejected. Five commits, possibly across multiple PRs if review requests it.

---

## 8. Operational Readiness

### 8.1 Deployment

- **WS-1.** Ships behind `AUTONOMOUS_DEV_COST_CAP_LEGACY` flag. Default is off (new path). Operators with concerns can flip the flag on. Deprecated shim preserves import surface. Removal of the flag and shim is a follow-up PRD; no commitment in this PRD.
- **WS-2.** Ships immediately. Pinned SHAs are immutable; no runtime knob.
- **WS-3.** Ships as `.example` file; not invoked from autonomous-dev's own CI.
- **WS-4, WS-5.** Doc-only; ships immediately.

### 8.2 Rollback

- **WS-1.** Two layers: env-var flag flip (immediate, no redeploy) and full revert of WS-1 commit (rolls back the import-site change but keeps the new enforcer file intact for future re-migration).
- **WS-2.** Revert restores `TBD-replace-with-pinned-SHA` placeholders. CI lint guard would also need to revert (paired in WS-6).
- **WS-3.** Delete the file.
- **WS-4.** Revert the doc-only commit.
- **WS-5.** Delete the appendix.

Each workstream's revert is tested locally before merge: revert the commit on a scratch branch, confirm `npm test` and `npm run lint` still pass.

### 8.3 Canary

- **WS-1.** No canary required because the migration is wrapped by the feature flag. Operators canary by leaving the flag off in their staging deploy and flipping it on in production after observing one full deploy cycle.
- Other WSes: no canary applicable (build-time or doc-only).

---

## 9. Implementation Plan

| Phase | Workstream | Scope                                                                                    | Estimate |
|-------|------------|------------------------------------------------------------------------------------------|----------|
| 1     | WS-1       | Migrate orchestrator to enforcer; port tests; ship feature flag and shim                 | M        |
| 2     | WS-2 + WS-6| Resolve every TBD-SHA; add `lint:no-tbd-shas`; ship refresh-pins runbook                  | S        |
| 3     | WS-3       | Author `observe.yml.example`; cross-reference `commands/observe.md`; add doc-only test    | S        |
| 4     | WS-4       | Run detection script; hand-edit ~30+ specs; generate `_path-drift-amendments.md`           | M        |
| 5     | WS-5       | Author `stub-assertion-staleness.md` with three examples and proposed convention          | S        |

Phases are independent and may be authored in parallel, but commits land in workstream order so the closeout PR's history reads cleanly.

---

## 10. Test Strategy

The closeout's defining test posture is **non-decreasing pass count**. Per TG-06, the jest baseline before the PR (number of suites, number of tests, pass count) must be matched or exceeded after the PR.

### 10.1 Per-Workstream Tests

- **WS-1.** Orchestrator integration test asserts:
  1. With cap > 0 and estimate within cap, deploy completes and ledger contains an HMAC-chained entry for the deployId.
  2. With cap > 0 and estimate exceeding cap, `runDeploy()` rejects with `DailyCostCapExceededError` and emits `cost-cap-exceeded` telemetry.
  3. Idempotency: two `runDeploy()` calls with the same deployId produce one ledger entry.
  4. Feature flag: `AUTONOMOUS_DEV_COST_CAP_LEGACY=1` routes to the deprecated shim (asserted via spy on shim's `console.warn`).
- **WS-2.** Unit test of `lint:no-tbd-shas` script: synthesize a temp file containing the literal, run the script, assert exit code 1; remove the literal, re-run, assert exit code 0.
- **WS-3.** File-existence test plus `actionlint` invocation in `test:docs` (or equivalent existing doc-test suite).
- **WS-4.** No runtime tests; the verification is the `_path-drift-amendments.md` row count matching `git grep '<!-- moved-from:' | wc -l`.
- **WS-5.** No tests; appendix is doc-only.

### 10.2 Regression Tests

Before merge, run:

```bash
npm test 2>&1 | tee /tmp/before.log    # on main
git checkout closeout-branch
npm test 2>&1 | tee /tmp/after.log
diff <(grep -E 'Tests:|Suites:' /tmp/before.log) <(grep -E 'Tests:|Suites:' /tmp/after.log)
```

The diff must show pass count strictly non-decreasing. Any regression is a blocker for merge.

### 10.3 Manual Smoke

WS-1 also runs a manual smoke against the deploy phase: a real `runDeploy()` invocation against a no-op backend with a small cap, verifying the ledger writes and the telemetry events fire. This is performed once before merge, not as automated CI.

---

## 11. Open Questions

| ID    | Question                                                                                                            | Recommended Answer                                                                                                                    |
|-------|---------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------|
| OQ-01 | When does the deprecated `cost-cap.ts` shim get removed? Same minor as the migration, or one minor later?            | One minor later. Gives any external consumer one release cycle to migrate. Tracked separately; not owned by PRD-017.                  |
| OQ-02 | Should the `stubOf().supersededBy()` helper be a runtime no-op or a compile-time check?                              | Runtime, with `delete()` causing a `test.fail`. Compile-time would require a TypeScript transformer; over-engineered for the audit window. |
| OQ-03 | Does the path-drift detection script (§5.4.1) ship in the repo or get deleted post-audit?                            | Deleted post-audit. PRD-017 NG-02 forbids new tooling; the script is single-use.                                                      |
| OQ-04 | If WS-2 discovers an action whose pinned semver tag has been *re-tagged* upstream (tag-replay), does the closeout PR refuse to pin it? | Yes — refuse, file an upstream issue, and document the gap in the runbook. The closeout PR can ship without that one pin.            |
| OQ-05 | Does WS-4's exclusion of test-side drift (FR-1720) need a CI check, or is the PR-description checklist sufficient?    | Checklist sufficient. Per NG-04, no new CI gates. PRD-016 owns the test-side sweep and will add its own check if needed.              |
| OQ-06 | Does `actionlint` need to be added as a devDependency for WS-3, or is it already available in CI?                     | Verify in the closeout PR. If absent, add. Single small dependency; well within scope.                                                |
| OQ-07 | Does the closeout PR ship as one PR or split into two (runtime + doc-only)?                                          | One PR with five commits. Split only if review requests it (FR-1719 keeps WS-4 as a separate commit regardless).                      |

---

## 12. Design Review Log

*(Populated by the reviewer agent.)*

---

## 13. References

| Document                                                                                                            | Relationship | Notes                                                      |
|---------------------------------------------------------------------------------------------------------------------|--------------|------------------------------------------------------------|
| **PRD-017: Cleanup, Hygiene, and Operational Closeout** (`plugins/autonomous-dev/docs/prd/PRD-017-cleanup-and-operational-closeout.md`) | Parent       | Source PRD. Every TG/NTG in this TDD maps to a PRD-017 FR. |
| **TDD-023: Deployment Backend Framework Core**                                                                      | Upstream     | Defines the orchestrator that WS-1 modifies.               |
| **TDD-024: Cloud Backends and Credential Proxy**                                                                    | Upstream     | Defines the deploy plugins that WS-2 pins.                 |
| **PRD-010: GitHub Actions CI/CD Pipeline** (§5.9)                                                                   | Upstream     | Specifies the `observe.yml.example` surface that WS-3 ships.|
| **PRD-016: Test Stabilization** (forthcoming)                                                                       | Sibling      | Owns test-side path drift; WS-4 explicitly excludes it.    |
| **AMENDMENT-002: Setup-Wizard Phase Coverage Extension**                                                            | Downstream   | Onboards operators across the surfaces this closeout cleans up. |

---

*End of TDD-029: Cleanup and Operational Closeout for TDDs 010-024*
