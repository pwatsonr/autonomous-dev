# PRD: ONBOARD Phase 3 — Portal Views (projects/repos/teams, ingestion, questions, toggles)

## 1. Title and Metadata

| Field | Value |
|-------|-------|
| Document Title | Operator-facing portal views for ONBOARD: project/repo/team filtered browser, live ingestion, blocking-question answering, per-repo auto-improve toggle |
| Initiative | ONBOARD (epic #583) |
| Tracking Issue | #594 |
| Phase | 3 of 5 — depends on [0,1] (shipped: daemon 0.3.32/0.3.33/0.3.35). Order 0 → 1 → (2 ∥ 3) → 4 → 5 |
| Author | Operator-directed Claude Code session (pwatsonr@gmail.com) |
| Date | 2026-06-24 |
| Version | 0.2 (Draft — revised after PRD review: H1–H3/M1–M6 folded in) |
| Plugin | **`autonomous-dev-portal`** (SEPARATE from the daemon plugin; Hono + JSX SSR + HTMX, 127.0.0.1:19280, own launchd plist `com.autonomous-dev.portal`) |
| Build mechanism | **Operator-directed** on clone (R1); 3-round adversarial self-review; **@1900px headless-Chrome screenshots before shipping any UI** |

---

## 2. Problem Statement

Phases 0/1/1.6/2 built the ONBOARD substrate (ownership/scope, scoped memory, read-only ingestion, project inference, the blocking-question queue, the enrollment gate, scoped skill generation, the Neo4j graph) — but it is **CLI-only**. An operator onboarding a 100s-of-repos org cannot *see* what was ingested, *answer* a blocked repo's question without the CLI, or *toggle* a repo into auto-improvement from a UI. Phase 3 adds operator-facing **portal views** over the existing ONBOARD state files, following the portal's established discipline (CSP-safe, versioned assets, no fabricated data, state-isolated tests, screenshot-verified).

---

## 3. Goals and Non-Goals

### Goals
- **G1** — A **project/repo/team filtered browser**: list the linked org's projects + repos, filter by project / by tag (the flexible "team"/"domain" dimension), search by repo id — usable at 100s of repos. Drill into a repo to see its scoped memory summary (overview/deps/ownership/build/test topics).
- **G2** — A **live ingestion view**: show ingestion progress (repos with memory, repos blocked on questions, last graph sync) updating live as a crawl proceeds.
- **G3** — A **blocking-question answer UI**: list pending questions; answer one in-portal (the choice writes the question store and unblocks the repo).
- **G4** — A **per-repo auto-improve toggle**: flip `participate_in_auto_improvement` from a repo row (writes the ownership manifest; ingest ≠ enroll preserved).
- **G5** — Reuse the portal's patterns end-to-end: `wiring/*-readers.ts` (cached, safe-default, never-throw) for reads; CSRF-protected POST + audit + SSE for writes; `asset()`/nonce/CSP; the shell IA + a new "Onboard" rail group.

### Non-Goals
- **NG1** — Neo4j **graph visualization** (node-link diagram) → fast-follow (the views need the file layer, not the graph render). A small "graph: N nodes / reachable?" stat is allowed, read cheaply.
- **NG2** — Editing memory, generating/promoting artifacts from the portal (artifact accept/reject is a separate surface; Phase 2 is CLI). Phase 3 may *display* proposal counts but not mutate them.
- **NG3** — Triggering ingestion/crawl from the portal (that's `org ingest`, a long network job) → Phase 4/ops. Phase 3 *observes* ingestion; it doesn't start it.
- **NG4** — Org-linking / project CRUD from the portal → CLI remains authoritative for structure; Phase 3 toggles enrollment + answers questions only (the two safe per-repo writes).
- **NG5** — Changing the daemon plugin. Phase 3 is portal-only; it reads the daemon's state files + performs the two writes the CLI already supports (answer, enroll).

---

## 4. Functional Requirements

### FR-A — ONBOARD state readers (new `server/wiring/onboard-readers.ts`)
- **FR-A1** — Reads via the portal's `state-paths.ts` (so test isolation holds): **ownership** from `userConfigPath()` → `.ownership` (org/projects/repos/tags/`participate_in_auto_improvement`); **memory** from `stateDirRoot()/memory/repo/<id>/*.md` (topic list + first-line summaries; never the full bodies on a list page); **questions** from `stateDirRoot()/ingest/questions.json`; **proposals** from `stateDirRoot()/artifacts/proposals.json` (counts only, NG2). Each: 5s cache, safe default (`{org:null,projects:[],repos:[]}` / `[]`), **never throws** (mirrors `daemon-readers.ts`).
- **FR-A2** — Re-implements ONLY the tiny read shapes it needs (it cannot import the daemon plugin's `src`); the shapes are pinned + tolerant (unknown fields ignored; wrong types → safe default). A schema-drift in the daemon degrades a field, never crashes the portal. **`enrolled` is computed as `participate_in_auto_improvement === true`** (any other value — `false`, unset, garbage — renders not-enrolled; mirrors `ownership/loader.ts` and is required for the FR-E2 ingest≠enroll guarantee). Question `options` must be a `string[]`; a question whose shape isn't `string[]` is rendered **read-only with a "shape-mismatch" badge**, never answerable (M2).
- **FR-A3** — A cheap **ingestion-status** aggregate: `{ reposTotal, reposWithMemory, reposBlocked, questionsPending, proposalsPending }` derived from ownership + a memory-dir listing + questions + proposals. The directory listing (O(N repos)) is cached the **same 5s** as the JSON readers and is computed ONLY on the Onboard surfaces — it is NOT on the shell-render path. The rail badge (FR-F1) uses ONLY the cheap `questionsPending` counter (from the already-cached questions read), so every full-page render does not scan `~/.autonomous-dev/memory/` (H1). No Neo4j call on any portal hot path (graph stat deferred — NG1/OQ-4).

### FR-B — Project/repo/team browser (view `onboard`)
- **FR-B1** — `GET /onboard` lists projects (with repo counts + tags) and repos, with **filters**: `?project=<id>`, `?tag=<k>=<v>` (the flexible team/domain dimension), `?q=<substring>` on repo id. Server-side filtered (scales to 100s) + **paginated**: `?page=<N>` (1-based, default 1), `pageSize=25` (fixed); filters compose with page (`?project=X&page=2`); a past-the-end page renders the empty-tail state, not an error.
- **FR-B2** — Each repo row shows: id, project, tags, **enrollment state** (enrolled / not), blocked-by-question indicator, memory-topic chips. Drill-in `GET /onboard/repo/:repo` shows the repo's scoped-memory topic summaries (still read-only).
- **FR-B3** — Empty/edge states are honest (no fabricated rows): "no org linked", "no repos ingested", "0 of N enrolled".

### FR-C — Live ingestion view (view `onboard-ingestion`)
- **FR-C1** — `GET /onboard/ingestion` renders the FR-A3 status aggregate + a per-repo progress list (has-memory / blocked / pending).
- **FR-C2** — **Live**: the page refreshes the status fragment via HTMX polling every ~5s (MVP — the ingest CLI does not emit SSE today; a true SSE feed is a fast-follow when ingestion broadcasts). Each poll goes through the **5s reader cache**, so two polls inside a 5s window reuse one disk hit (the poll is cheap by construction, not by luck). The "live" dot animates only when the status actually changed.

### FR-D — Blocking-question answer UI (view `onboard-questions`)
- **FR-D1** — `GET /onboard/questions` lists pending questions (`id`, `repoId`, `question`, `options`), and answered ones (collapsed). Reads `questions.json`.
- **FR-D2** — `POST /onboard/questions/:id/answer` (CSRF-enforced) with the chosen option → validates the choice ∈ options → writes `questions.json` (atomic; sets `status:answered`, `answer`) via a new `onboard-writers.ts` mirroring the daemon's `answerQuestion` semantics → audits → SSE-broadcasts `onboard_question_answered` → returns the updated row fragment (HTMX swap). Invalid choice → 422 fragment.

### FR-E — Per-repo auto-improve toggle
- **FR-E1** — `POST /onboard/repo/:repo/enroll` and `.../unenroll` (CSRF-enforced) → `onboard-writers.ts` reads the manifest, flips `participate_in_auto_improvement` for that repo, and **atomically writes back preserving all other keys** → audits → returns the updated toggle fragment. **Write strategy (resolved — H2/OQ-1): DIRECT atomic write of `~/.claude/autonomous-dev.json`.** The portal's other operator-state mutations use a config-change MARKER the daemon applies — but that requires a daemon-side applier, which NG5 forbids (Phase 3 is portal-only). Direct write is therefore the only portal-only option, and is safe because: (a) the daemon has **no runtime writer** of the manifest (only the operator CLI + the portal write it), so there is no daemon race; (b) the **refuse-to-clobber guard** (mirrors `ownership/store.ts:writeOwnership`): the existing file is read + JSON-parsed + checked it is an object before the `ownership` key is replaced — a corrupt/non-object manifest causes a 422 fragment, never an overwrite; (c) **schema-validate before write (L4)** — if the existing `ownership` block fails the minimal org→projects→repos shape check, the toggle returns 422 and refuses to write; (d) atomic temp+rename, mode 0600; (e) tests are state-isolated (NFR-2).
- **FR-E2** — The write is a read-modify-write on `~/.claude/autonomous-dev.json`; concurrency with the CLI is rare + last-writer-wins (same stance + the same #586 file-lock follow-up as the daemon store). The toggle never enrolls in bulk; it is one repo per click.

### FR-F — IA + assets + security
- **FR-F1** — A new **"Onboard"** rail group in `ShellLayout` (3 views), with a **pending-questions** badge (the cheap `questionsPending` counter only — H1). Three new `ViewName` literals + their `renderViewBody` dispatch cases (the dispatcher's `_exhaustive: never` guard requires all three) + `activePathFor` branches: **`"onboard"`** → `/onboard` (browser), **`"onboard-ingestion"`** → `/onboard/ingestion`, **`"onboard-questions"`** → `/onboard/questions` (all three map to the `/onboard` rail group). The repo drill-in (`GET /onboard/repo/:repo`, FR-B2) is a **fragment swap rendered within the `onboard` view** (HTMX), NOT a fourth ViewName.
- **FR-F2** — All client interactivity is **CSP-safe**: external JS in `static/`, HTMX `hx-get`/`hx-post` with the CSRF token header, **no inline `onclick`/`hx-on`**, nonce on any `<script>`. Static assets via `asset()`/manifest (`?v=<version>`).

---

## 5. Acceptance Criteria (→ #594)
- **AC1** — Filter by project/repo/team(tag) at 100s-of-repos scale; the browser lists projects + repos with enrollment + memory chips, server-side filtered + paginated.
- **AC2** — The ingestion view shows live progress (repos with memory / blocked / pending), auto-refreshing.
- **AC3** — A pending question is **answered in-portal**; the write lands in `questions.json` (choice validated), the repo unblocks, the row updates without a full reload.
- **AC4** — A repo's auto-improvement is **toggled in-portal**; the write lands in the ownership manifest (other keys preserved); ingest≠enroll holds (default off).
- **AC5** — Every new view is **screenshot-verified @1900px** (headless Chrome) before shipping; assets versioned; CSP-safe (no inline handlers); no fabricated data.

---

## 6. Non-Functional Requirements
- **NFR-1 (No fabricated data):** every number/row derives from a real state file; empty states are explicit (the portal "recurring disease #1" is hardcoded KPIs — forbidden).
- **NFR-2 (Test isolation):** all tests run under the `isolate-state-dir` preload, which sets **BOTH `AUTONOMOUS_DEV_STATE_DIR` AND `AUTONOMOUS_DEV_USER_CONFIG`** to fresh temp dirs (the 2026-06-12 webhook-wipe happened because only one was isolated — both must be). A new CI assertion verifies both env vars point at temp before any onboard test (esp. the enrollment-write test) runs; tests **never** touch real `~/.autonomous-dev` or `~/.claude/autonomous-dev.json`.
- **NFR-3 (CSP/CSRF):** new scripts carry the nonce; POSTs enforce CSRF; no `'unsafe-inline'` script; reuse `csp-config`/`csrf-protection`.
- **NFR-4 (Safe reads):** readers never throw, cache 5s, return safe defaults — a missing/corrupt ONBOARD file degrades a tile, never 500s the page.
- **NFR-5 (Scale):** the browser is server-side filtered + paginated; the memory list page reads topic names + first lines only (not full docs) so a 100s-of-repos org renders fast.
- **NFR-6 (CI):** touched-file unit tests + route tests + a visual-regression golden per new view (the existing Playwright harness); `tsc`/eslint/css-coverage green.

---

## 7. Technical Constraints
- **TC-1** — Portal-only; build operator-directed on the clone; deploy via the **portal** runbook (bump portal plugin.json + marketplace entry → `claude plugin update autonomous-dev-portal@autonomous-dev` → `bun install` in the new cache → edit plist WorkingDirectory → `launchctl bootout`+`bootstrap`).
- **TC-2** — **Reuse**: `wiring/state-paths.ts`, the `daemon-readers.ts` cached-reader pattern, `atomic-json.ts` (read/atomicWriteJson), `csrf-protection`, `SSEEventBus`, `asset()`/`asset-manifest`, `ShellLayout`, `renderPage`. New code = `onboard-readers.ts` + `onboard-writers.ts` + 3 view components + 3 routes + the rail nav entry.
- **TC-3** — The portal CANNOT import the daemon plugin's `src` (separate plugin) — it reads the JSON/markdown files + re-implements the two tiny writes (answer, enroll) against the same shapes. Schemas pinned in `onboard-readers.ts`.
- **TC-4** — `@1900px` is the manual pre-ship audit standard; the committed visual-regression goldens use the existing harness viewport (1440×900) — both are produced.

---

## 8. Open Questions (resolve in TDD)
- **OQ-1** — Direct atomic write of `~/.claude/autonomous-dev.json` for enrollment vs a config-change marker the daemon applies. Lean: **direct atomic write** (the manifest is operator-config the daemon never writes at runtime; matches how the portal already writes approvals/gate-decisions). Confirm no daemon-side ownership writer races.
- **OQ-2** — Live ingestion: HTMX-poll (MVP) vs SSE. Lean: **poll** now; SSE when the ingest CLI emits events (fast-follow).
- **OQ-3** — Memory summary depth on the repo drill-in: topic list + first line vs first paragraph. Lean: first line/heading (scale).
- **OQ-4** — Graph stat on the ingestion view: skip (NG1) vs a cached `graph status` count. Lean: skip for MVP (avoid a Neo4j call on a portal page); revisit.
- **OQ-5** — Pagination size + filter UX (server query params vs HTMX live filter). Lean: query params + HTMX swap.

---

## 9. Risks
| ID | Risk | Severity | Mitigation |
|----|------|----------|------------|
| R1 | A portal write corrupts/clobbers `~/.claude/autonomous-dev.json` (wipes repositories/trust/notifications) | High | Read-modify-write with the refuse-to-clobber guard (reject non-object/corrupt manifest), atomic temp+rename, preserve all keys; route + unit tests; NFR-2 isolation |
| R2 | A test writes real operator state (the 2026-06-12 webhook-wipe class) | High | `isolate-state-dir` preload enforced before any module load; assert in CI that state paths point at temp |
| R3 | Fabricated/placeholder data slips into a view | Medium | NFR-1; every tile traces to a reader; visual goldens from fixtures only |
| R4 | CSP regression (inline handler / unversioned asset) | Medium | CSP-safe external JS + nonce; the source-scan test that fails on raw `/static/` + inline handlers |
| R5 | Schema drift between daemon state files + portal readers | Medium | Tolerant pinned shapes (TC-3); safe defaults; a reader that logs+degrades on shape mismatch |
| R6 | Scale: 100s of repos renders slowly | Medium | Server-side filter + paginate; topic-summary (not full memory) reads (NFR-5) |

---

## 10. Traceability
| Acceptance | Functional Requirements |
|------------|-------------------------|
| AC1 | FR-A1, FR-B1, FR-B2, FR-B3 |
| AC2 | FR-A3, FR-C1, FR-C2 |
| AC3 | FR-D1, FR-D2 |
| AC4 | FR-E1, FR-E2 |
| AC5 | FR-F1, FR-F2, NFR-1/3/5 |

---

## 11. Implementation order (reader-first; screenshot each view)
1. **P3.1** — `server/wiring/onboard-readers.ts` (ownership/memory/questions/proposals + the ingestion-status aggregate) + unit tests (fixtures, isolated).
2. **P3.2** — `onboard` browser view + route (`/onboard`, `/onboard/repo/:repo`) with project/tag/q filters + pagination + the enrollment indicator. Screenshot @1900px.
3. **P3.3** — `onboard-ingestion` view + route (status aggregate + HTMX poll). Screenshot.
4. **P3.4** — `onboard-questions` view + route + `onboard-writers.ts answerQuestion` + `POST .../answer` (CSRF + audit + SSE). Screenshot.
5. **P3.5** — enrollment toggle: `onboard-writers.ts setEnrollment` + `POST .../enroll|unenroll` wired into the repo row. Screenshot.
6. **P3.6** — rail nav "Onboard" group + cheap badge; the 3 ViewName/dispatch/activePath entries; route tests; **visual-regression** (H3): append `/onboard`, `/onboard/ingestion`, `/onboard/questions` to the `SURFACES` array in `tests/visual-regression/portal-surfaces.visual.ts`, **seed `server/fixtures/kit-parity/` with sample ONBOARD content** (a small ownership manifest with projects/repos/tags/enrollment, a `memory/repo/<id>/` tree, a `ingest/questions.json` with a pending + answered question, an `artifacts/proposals.json`) so the views render real fixture data, then regenerate goldens (`npm run gen:visual-goldens`) in a follow-up commit; css-coverage.
7. **P3.7** — 3-round adversarial self-review (security/correctness/UX-and-screenshots) → release+deploy the **portal** plugin → verify (@1900px screenshots of all 3 views live; toggle + answer round-trip against an isolated fixture).
