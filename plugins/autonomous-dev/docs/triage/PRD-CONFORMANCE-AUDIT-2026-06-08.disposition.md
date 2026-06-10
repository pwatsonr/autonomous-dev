# PRD-025 Conformance Audit — Disposition Record

**Source audit:** `PRD-CONFORMANCE-AUDIT-2026-06-08.audits.json` (24 per-PRD audits)
**Disposition date:** 2026-06-10
**Tracking:** PRD-025 FR-025-30 (disposition every finding) / FR-025-31 (request-ID contradiction)

The audit's `missing` / `partial` / `contradicts` findings were triaged into nine
P1/P2 issues (#354–#362). Every finding cluster below has a disposition. "Deferred"
items are blocked on infrastructure that is a separate, larger effort — noted per row.

## P1/P2 issue dispositions

| Issue | Area | Disposition | Evidence |
|-------|------|-------------|----------|
| #354 | Supervisor safety controls (FR-025-10/11/12) + FR-504 | **Resolved.** Kill-switch SIGTERM, cost caps, per-request cap, rate-limit backoff shipped. FR-504 concurrent-gate moot — the supervisor runs sequentially. | PRs #366, #371; closed |
| #357 | Cooldown / oscillation governance | **Resolved.** Stub scanners wired to real `observation-store` functions; deployment-metadata type reconciled. | PR #378; closed |
| #358 | Intake source integrity (FR-025-17) | **Resolved.** `source` now derived server-side from the authenticated channel via `channelTypeToRequestSource()`; was hard-coded `'cli'`. | PR #380; closed |
| #362 | Standing conformance audit | **Resolved.** Deterministic pre-release gate (`scripts/ci/conformance-audit.js`) added to `release.yml`; seeded with the six fixes below. | PR #383; closed |
| #355 | Parallel-exec defaults + filesystem isolation | **Partial.** Inverted disk-threshold defaults **and** the inverted validator fixed (PRD-004 App. D). Isolation-hook wiring **deferred** — blocked on the subagent session factory being a stub. | PR #379; open for pt2 |
| #356 | Portal security/freshness | **Partial.** Referrer-Policy `same-origin` (FR-S33) + dashboard refresh ≤5s (FR-903) fixed. daemon-status API fields + OpsHealth circuit-breaker **deferred** — need the daemon to expose start-time/iteration. | PR #381; open for pt2 |
| #359 | Pipeline variants | **Partial.** plan/spec hook points (FR-1108) + HOTFIX tdd-skip (FR-1102) fixed; phase-overrides already honored by `next_phase_for_state`. Reviewer-manifest registration (FR-1242/1261/1262) **deferred** — ux-ui reviewer undefined + chain wiring. | PR #382; open for pt3 |
| #361 | Visual-regression reader isolation | **Assessed / largely done.** Live surface readers already honor `AUTONOMOUS_DEV_STATE_DIR` (portal v3). Remaining: un-skip `portal-surfaces.visual.ts` + capture goldens — **deferred**, gated on the broken Playwright harness. | open |
| #360 | This disposition + request-ID contradiction | **Resolved.** This record + PRD-001 amendment below. | this PR |

## FR-025-31 — request-ID format contradiction

**Finding:** PRD-001 FR-200 specified `REQ-{YYYYMMDD}-{4-char-hex}` (e.g. `REQ-20260408-a3f1`),
but the shipped system uses `^REQ-\d{6}$` (e.g. `REQ-000123`) — a zero-padded monotonic
counter. The implementation was already self-consistent: validator
(`intake/core/path_security.ts` `REQUEST_ID_RE = /^REQ-\d{6}$/`), generator
(`intake/db/repository.ts` `REQ-${…padStart(6,'0')}`), and the `types.ts` contract all agree.

**Disposition:** **Resolved.** PRD-001 FR-200 and its example state file amended to the shipped
`^REQ-\d{6}$` format. Code and docs are now consistent.

## FR-025-30 — PRD status tables

The audit recommended amending source-PRD status tables from "done" → "deferred" for the
partially-implemented PRDs (005, 007, 014, 015, 016, 017, 019, 024). On inspection, **none of
these PRDs claim completion** — their status fields read `Draft`, `Proposed`, or
`Ready for Review`. The status tables therefore already reflect "not shipped"; no
done→deferred amendment is warranted. The specific unimplemented FRs the audit flagged
(PRD-005 FR-009, PRD-007 FR-06/07, PRD-014 FR-1440/1454, PRD-015 docs, PRD-016/017 artifacts,
PRD-019 FR-019-12/14, PRD-024 error codes) are **dispositioned as deferred** here; they remain
in-scope for their respective Draft PRDs and are not contradicted by any shipped status claim.
