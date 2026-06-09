# PRD-025: PRD↔Code Conformance Remediation

| Field | Value |
|-------|-------|
| **PRD ID** | PRD-025 |
| **Title** | PRD↔Code Conformance Remediation — close verified drift between shipped PRDs and the code |
| **Version** | 1.0 |
| **Date** | 2026-06-08 |
| **Status** | Proposed |
| **Plugin** | autonomous-dev (+ autonomous-dev-portal) |

> This PRD is the output of a full conformance audit run on 2026-06-08:
> one independent auditor per shipped PRD (PRD-001 … PRD-024, 24 agents,
> ~3.2M tokens) verified each PRD's functional requirements against the
> actual code with `Grep`/`Read`, citing `file:line` evidence and
> refusing to trust the PRDs' own status claims. **All 24 PRDs scored
> `partial` conformance.** The raw findings are persisted at
> `plugins/autonomous-dev/docs/triage/PRD-CONFORMANCE-AUDIT-2026-06-08.audits.json`
> (full) and `…critical-high.json` (the 92 actionable critical/high
> findings). This PRD selects, hand-verifies, and prioritizes the
> highest-impact subset for remediation. It does **not** re-open the
> design intent of any prior PRD — it closes the gap between what those
> PRDs say and what the daemon actually does.

---

## 1. Problem Statement

The autonomous-dev pipeline has shipped 24 PRDs. Many requirements
marked "done" in PRD status tables, handoff memos, and release notes are
in fact **partially implemented, contradicted by config defaults, or
silently inert** (library present, never wired into the running loop).
Because the daemon self-improves and the PRDs are treated as the
authoritative contract, this drift compounds: each new PRD builds on the
assumption that the prior one is fully live.

### Audit at a glance

| Metric | Count |
|--------|-------|
| PRDs audited | 24 |
| PRDs at full conformance | **0** |
| PRDs at `partial` | 24 |
| Requirements verified | ~900 |
| Actionable critical findings | 12 |
| High findings | 80 |
| Requirements that **contradict** the PRD (config/behaviour inverted) | 20 |
| Requirements **missing** entirely | 92 |
| Requirements **regressed** (was implemented, later broken) | 2 |

### Five hand-verified P0 findings (re-checked by the author against HEAD `e7045e6`)

These were independently re-verified after the fleet reported them, by
reading the cited files directly:

1. **Portal CSS-lint enforcement is a no-op (PRD-018 R-02/M-01, PRD-023).**
   `plugins/autonomous-dev-portal/scripts/lint-css-tokens.sh:18` and
   `lint-box-shadow.sh:61-71` scan `$PORTAL/server/static` (does not
   exist) and `$PORTAL/src/styles` (exists, holds only
   `layout/components/utilities.css`). The authoritative stylesheets —
   `static/app.css`, `design-tokens.css`, `shell.css`, `portal.css`,
   `primitives.css` — are **never scanned**. `portal-lint.yml` runs both
   scripts and they exit 0 without inspecting a single real file. The
   token-discipline gate that PRD-018 and PRD-023 both depend on does not
   guard the files it was written to guard.

2. **Stale dark-mode phase palette overrides the canonical tokens
   (PRD-018 M-02).** `static/app.css:9` opens a
   `:root[data-theme="dark"]` block that re-declares all 8 `--phase-*`
   colors with **superseded values** (`--phase-prd:#a48bd9` at line 46,
   vs the canonical `#d6c4ee` in `design-tokens.css`). Because `app.css`
   loads after `design-tokens.css`, every phase chip, lane, and card
   border renders the wrong color in dark mode — defeating exactly the
   ≥3:1 peer-chip contrast PRD-018 M-02 / OI-3403 was created to
   guarantee. Finding #1 is *why this was never caught.*

3. **CI doc-review jobs reference non-existent reviewer agents
   (PRD-010 FR-4003/4/5).** `.github/workflows/prd-review.yml:81` and
   `tdd-review.yml:83` set `prompt-template-path:
   plugins/autonomous-dev/agents/prd-reviewer.md` and
   `…/tdd-reviewer.md`. **Neither file exists** (the reviewer is
   `doc-reviewer.md`). The "Load reviewer prompt" step errors, so the
   required `docs/prd-review` / `docs/tdd-review` checks fail on every PR
   that touches a PRD or TDD.

4. **Reviewer/meta agents are unloadable by their own validator
   (PRD-003 FR-01/03/35, regressed).** Commit `5725b5c`
   ("fix(agents): add Write tool to author + reviewer frontmatter")
   added `Write` to reviewer- and meta-role agents. The agent-factory
   validator's `TOOL_ALLOWLIST`
   (`src/agent-factory/validator.ts:30-35`) forbids `Write` for those
   roles (`RULE_005`), and every agent declares `model:
   "claude-opus-4-7"` / `"claude-sonnet-4-6"`, neither of which is in
   `DEFAULT_MODEL_REGISTRY` (only the `…-20250514` IDs — `RULE_009`).
   `registry.load()` (`registry.ts:166-171`) validates with the default
   context and passes no custom model registry, so a production
   `registry.load()` would **reject every agent**.
   `tests/agent-factory/agents.test.ts` already fails 7/9 on exactly
   these two rules.

5. **The portal writes daemon state directly, bypassing the intake
   router (PRD-009 FR-915/FR-925, PRD-008 FR-820).** `config-set` and
   gate-action commands exist on `IntakeRouterClient` but are not used:
   `server/wiring/settings-store.tsx:250` calls `atomicWriteJson` on the
   config file directly (FR-925 says the portal SHALL NOT), and
   `server/wiring/gate-store.tsx` writes per-id marker files into the
   daemon state dir instead of issuing router approve/reject commands
   carrying `source: 'portal'` (FR-915). Two write paths to the same
   state with no single point of validation or audit.

### Why now

PRD-024 ("No Faked Evidence") just hardened the daemon against agents
*claiming* unverified work. This PRD is the operator-side analogue:
hardening the project against *PRDs* claiming unverified completion. The
two highest-impact items (#1, #2) are a tight causal pair — a dead lint
gate hiding a real token regression — and are nearly free to fix.

---

## 2. Goals & Non-Goals

### Goals

- **G1.** Close every hand-verified P0 finding (§1) so CI gates,
  token discipline, agent loading, and the portal→daemon write path are
  actually live.
- **G2.** Triage all 92 critical/high findings into P0/P1/P2 with an
  owner-decidable disposition: **fix**, **accept + amend the PRD**, or
  **defer (ticketed)**. No finding silently dropped.
- **G3.** Resolve every `contradicts` finding (20) by making code and
  PRD agree — either change the code to match the PRD or amend the PRD to
  match a deliberate decision. A contradiction is never left implicit.
- **G4.** Establish a **standing conformance check** so this drift class
  is caught continuously, not in a once-a-year audit.

### Non-Goals

- **NG1.** Re-designing any subsystem. This PRD only reconciles code to
  already-approved intent.
- **NG2.** Implementing deferred Phase-3 scope (e.g. PRD-007 trust
  promotion, PRD-005 PagerDuty cross-ref). Those are legitimately
  future work; the goal is only to *correct their status claims*.
- **NG3.** The portal v3 visual redesign — tracked separately in
  **PRD-026**. (Finding #1/#2 are included here because they are
  *correctness/CI* bugs, not visual scope.)

---

## 3. User Personas

- **Operator (single-user owner).** Trusts `daemon status`, the
  approvals queue, and PRD status tables to reflect reality. Harmed when
  a kill-switch doesn't SIGTERM, a cost cap isn't enforced, or a "done"
  PRD isn't.
- **The autonomous pipeline itself.** Consumes PRDs as ground truth when
  planning follow-on work. Harmed by drift: it builds on inert features.
- **Contributor.** Blocked by red required checks caused by finding #3,
  and by a token-lint gate (finding #1) that gives false assurance.

---

## 4. Functional Requirements

> Each FR cites the source audit finding. Severity-ordered. Evidence
> paths are relative to repo root unless noted. P0 = correctness/CI/safety
> live-fire; P1 = contradiction or missing safety control; P2 =
> completeness / status-claim correction.

### 4.1 P0 — verified, land first

- **FR-025-01 (PRD-018/023).** The portal CSS linters SHALL scan the
  directory where the stylesheets actually live. Update
  `lint-css-tokens.sh` and `lint-box-shadow.sh` to scan
  `$PORTAL_DIR/static/**.css` (in addition to `src/styles`), and SHALL
  exit non-zero if **zero** files were scanned (fail-closed against
  future path drift). `portal-lint.yml` path-filters SHALL include
  `static/**.css`.
- **FR-025-02 (PRD-018 M-02).** The superseded `:root[data-theme="dark"]`
  `--phase-*` re-declarations in `static/app.css` SHALL be deleted so the
  canonical dark palette in `design-tokens.css` is authoritative. After
  the fix, `lint-css-tokens.sh` (now live per FR-025-01) SHALL pass, and a
  test SHALL assert no `--phase-*` token is declared outside
  `design-tokens.css`.
- **FR-025-03 (PRD-010).** `prd-review.yml` and `tdd-review.yml` SHALL
  reference an existing reviewer prompt. Either create
  `agents/prd-reviewer.md` + `agents/tdd-reviewer.md`, or repoint
  `prompt-template-path` to `agents/doc-reviewer.md`. A CI lint SHALL
  assert every `prompt-template-path` in `.github/workflows/**` resolves
  to an existing file.
- **FR-025-04 (PRD-003).** Reviewer/meta agents SHALL load. Resolve the
  `RULE_005`/`RULE_009` regression by one of: (a) remove `Write` from
  reviewer/meta frontmatter and add the model IDs in use
  (`claude-opus-4-7`, `claude-sonnet-4-6`) to `DEFAULT_MODEL_REGISTRY`;
  or (b) if reviewers legitimately need `Write` (scratch notes), add a
  narrowly-scoped allowance to `TOOL_ALLOWLIST` and document why.
  `tests/agent-factory/agents.test.ts` SHALL pass 9/9.
- **FR-025-05 (PRD-009/008).** The portal SHALL route configuration
  mutations and gate decisions through `IntakeRouterClient` (`config-set`,
  approve/request-changes/reject) carrying `source: 'portal'`, instead of
  writing config files / marker files directly. If no daemon-RPC channel
  exists yet, this FR includes standing up that channel (or an
  amendment recording the marker-file path as the sanctioned interim
  protocol with its audit guarantees).

### 4.2 P1 — contradictions & missing safety controls

- **FR-025-10 (PRD-001 FR-405).** Kill-switch SHALL send `SIGTERM` to the
  running daemon PID (from `daemon.lock`) after writing the flag file, so
  an in-flight session stops within the cooldown, not at the next
  iteration boundary.
- **FR-025-11 (PRD-001 FR-503/504).** The supervisor loop SHALL enforce
  the per-request cost cap (`per_request_cost_cap_usd`, default $50) and
  the max-concurrent-requests cap in `check_gates()`. Both are configured
  but unenforced today.
- **FR-025-12 (PRD-001 FR-505).** `lib/rate_limit_handler.sh` SHALL be
  sourced and `detect_rate_limit()` called on session output in
  `supervisor-loop.sh` so the specced backoff ladder actually runs.
- **FR-025-13 (PRD-004 FR-006/007/014, NFR-006/008).** Correct the
  inverted parallel-execution defaults to match the PRD: swap
  `disk_warning_threshold_gb`/`disk_hard_limit_gb`, set `max_tracks=3`,
  and instantiate `FilesystemIsolationHook` in `AgentSpawner.spawnAgent()`.
- **FR-025-14 (PRD-009 FR-S33).** Set `referrerPolicy` in
  `DEFAULT_SECURITY_HEADERS_CONFIG` to `same-origin` per FR-S33.
- **FR-025-15 (PRD-009 FR-903).** The dashboard SHALL reflect SSE events
  (fragment swap on message) or poll at the specced ≤5s interval — not
  whichever is wired today.
- **FR-025-16 (PRD-005 FR-032/033).** Replace the cooldown/oscillation
  governance store **stubs** in the observation runner with the real
  file-scanning lookups (`observation-store.ts` already exposes the
  finders).
- **FR-025-17 (PRD-008 FR-823a/829).** The router SHALL populate `source`
  from the adapter's real channel identity (not hard-coded `'cli'`) and
  SHALL reject any command whose declared source ≠ the adapter's
  registered channel.
- **FR-025-18 (PRD-011 FR-1102/1108).** Wire phase-override routing
  (`state.phase_overrides` honored; `HOTFIX` skips `tdd`/`tdd_review`)
  and add the missing `plan-pre-author` / `spec-pre-author` hook points.
- **FR-025-19 (PRD-012 FR-1242/1261/1262).** Register the four specialist
  reviewers via PRD-011 hook manifests and add `ux-ui-reviewer` to the
  default Spec-review chain.

### 4.3 P2 — completeness & status-claim correction

- **FR-025-30.** Every remaining `missing`/`partial` finding in the audit
  artifact SHALL receive a disposition row (fix / amend / defer-ticket).
  For **deferred** items, the source PRD's status table SHALL be amended
  to read "Phase N — deferred" instead of "done" (covers PRD-005 FR-009,
  PRD-007 FR-06/07, PRD-014 FR-1440/1454, PRD-015 doc gaps, PRD-016/017
  doc artifacts, PRD-019 FR-019-12/14, PRD-024 error-code mapping, …).
- **FR-025-31 (PRD-001 FR-200).** Resolve the request-ID format
  contradiction (`REQ-NNNNNN` shipped vs `REQ-{YYYYMMDD}-{hex}` specced)
  by amending PRD-001 to the shipped format (recommended) and making all
  validators/docs consistent.
- **FR-025-32 (PRD-001 FR-404).** `daemon status` SHALL additionally
  report uptime, iteration count, active-request count, and
  current-period cost burn.
- **FR-025-33 (PRD-018 R-03 / PRD-023 FR-023-08, FR-020-04, FR-022-08,
  etc.).** Close the remaining individually-small portal/security/marketplace
  items enumerated in the audit artifact.

---

## 5. Acceptance Criteria

- **AC-01.** `bash plugins/autonomous-dev-portal/scripts/lint-css-tokens.sh`
  and `lint-box-shadow.sh` scan the real `static/*.css` files, report a
  non-zero scanned-file count, and the suite passes after FR-025-02.
  (FR-025-01/02)
- **AC-02.** Deleting the stale block changes no light-mode rendering and
  produces the canonical dark `--phase-*` values; a unit/regression test
  asserts single-source-of-truth for `--phase-*`. (FR-025-02)
- **AC-03.** A CI check fails if any `.github/workflows/**`
  `prompt-template-path` points at a missing file; `prd-review` /
  `tdd-review` required checks go green on a doc-only PR. (FR-025-03)
- **AC-04.** `tests/agent-factory/agents.test.ts` passes 9/9 and a fresh
  `registry.load()` admits all shipped agents. (FR-025-04)
- **AC-05.** Editing a setting or approving a gate from the portal
  produces an intake-router command with `source: 'portal'` in the audit
  log; no direct config/marker write occurs (or the interim protocol is
  documented with its audit guarantee). (FR-025-05)
- **AC-06.** Engaging the kill-switch terminates an in-flight session
  within the configured cooldown (observable via heartbeat/log).
  (FR-025-10)
- **AC-07.** A request exceeding `per_request_cost_cap_usd` pauses and
  escalates; a 4th concurrent request is held. (FR-025-11)
- **AC-08.** Every `contradicts` finding (20) is closed by a code change
  or a dated PRD amendment; the audit artifact's disposition column has
  no blanks. (G3, FR-025-30)
- **AC-09.** A re-run of the conformance audit harness on the touched
  PRDs reports the targeted findings resolved. (G4)

## 6. Success Metrics

| Metric | Baseline (2026-06-08) | Target |
|--------|----------------------|--------|
| PRDs at full conformance on audited FRs | 0 / 24 | P0+P1 FRs: 24 / 24 clean |
| Live CI token-lint files scanned | 0 authoritative | all `static/*.css` |
| `prompt-template-path` broken refs | 2 | 0 (CI-enforced) |
| `agents.test.ts` pass rate | 2 / 9 | 9 / 9 |
| Unenforced configured safety caps (per-req cost, concurrency, rate-limit) | 3 | 0 |
| `contradicts` findings with no disposition | 20 | 0 |

## 7. Open Questions

- **OQ-01.** Request-ID format: amend PRD-001 to the shipped
  `REQ-NNNNNN` (recommended), or migrate code to the dated-hex format?
- **OQ-02.** Reviewer `Write` tool: was `5725b5c` solving a real need
  (keep `Write`, widen allowlist) or a mistake (revert)?
- **OQ-03.** Portal→daemon channel: build a real RPC/IPC channel now, or
  sanction the marker-file protocol via amendment for this release?
- **OQ-04.** Should the standing conformance audit (G4) run as a
  scheduled GitHub Action (monthly) or as a pre-release gate?

## 8. References

- Audit artifacts (this repo):
  `plugins/autonomous-dev/docs/triage/PRD-CONFORMANCE-AUDIT-2026-06-08.audits.json`,
  `…critical-high.json`
- Companion design PRD: **PRD-026 — Portal v3 Design Implementation**
- Related prior work: PRD-018 (visual redesign), PRD-023 (portal
  security), PRD-009 (web control plane), PRD-024 (no faked evidence)
- Audit method: 24 parallel conformance auditors, evidence-cited,
  status-claim-skeptical; 5 P0 findings re-verified by hand against HEAD
  `e7045e6`.
