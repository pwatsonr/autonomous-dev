# PRD-021: Comprehensive Cypress End-to-End Test Suite for Portal UI

| Field | Value |
|-------|-------|
| **PRD ID** | PRD-021 |
| **Title** | Comprehensive Cypress End-to-End Test Suite for Portal UI |
| **Version** | 1.0 |
| **Date** | 2026-05-16 |
| **Status** | Draft |
| **Parent** | `plugins/autonomous-dev/docs/triage/PORTAL-AUDIT-2026-05-15.md` |
| **Plugin** | autonomous-dev-portal |

---

## 1. Problem Statement

The operator has been manually discovering UI regression after UI regression in the autonomous-dev portal. Today's session alone uncovered:

- Settings forms (trust level, cost caps, allowlist, webhooks) that look functional but silently fail to persist
- Webhook "Add" / "Test" buttons that render as enabled but do nothing when clicked
- Requests getting stuck between phases with no UI indication of the failure
- MTD spend numbers disagreeing across three different pages (Dashboard: $2.42, Requests: $2.67, Costs: $28.64)
- Kill-switch armed banner with no cancel button, requiring 30-second timeout or destructive confirmation
- Dashboard repo tiles rendering as buttons that do nothing when clicked
- Filter buttons on `/requests` that change visual state but never filter the table
- A portal that can't see running daemons (shows "STOPPED" when `heartbeat.json` indicates the daemon is actively running)

Each of these **could have been caught by a Cypress test**. The PRD's purpose is to turn "we keep finding regressions by hand" into "CI runs Cypress on every PR and catches them automatically."

The operator's direct words: *"I keep finding things broken by hand. I want the test suite to find them first."*

---

## 2. Goals & Non-Goals

### Goals

| ID | Goal |
|----|------|
| G-01 | Implement comprehensive Cypress end-to-end test coverage for all UI workflows described in `PORTAL-AUDIT-2026-05-15.md` |
| G-02 | Integrate the test suite with CI to run automatically on every pull request touching portal code |
| G-03 | Achieve >95% detection rate for operator-visible UI bugs before they reach main |
| G-04 | Ensure test suite runs reliably (<1% false failure rate) and completes in under 5 minutes |
| G-05 | Enable local development workflow: `bun run cypress` for developers adding features |

### Non-Goals

- **Visual regression testing** — Playwright already handles pixel-perfect static visual comparisons (see `plugins/autonomous-dev-portal/playwright.config.ts` and `tests/visual-regression/`). Cypress focuses on user interaction and data flow.
- **Accessibility testing** — Warrants its own dedicated audit and tooling.
- **Performance benchmarking** — Functional correctness only; performance is a separate initiative.
- **API testing** — Cypress covers the UI layer; integration tests already exist for API contracts.

---

## 3. User Personas

- **Primary: Operator** — Runs the daemon daily, submits requests via CLI, approves gates from portal, monitors cost and system health. Wants confidence that clicking buttons actually works.
- **Secondary: Plugin Developer** — Adds features to the portal, needs test coverage for new UI components and workflows. Wants fast feedback loop on regressions.
- **Tertiary: Future Contributor** — Reviews PRs, relies on CI to catch issues before code review. Wants clear test failure messages pointing to specific broken workflows.

---

## 4. User Stories & Functional Requirements

### Must Have (P0) — Core Navigation & Data Integrity

**Epic: Navigation Smoke**
- **US-021-01** — As an operator, when I visit any portal route, I want it to return 200, render within 2 seconds, and show no console errors, so I know the basic page infrastructure works.
- **FR-021-01** — Every route registered in `server/routes/index.ts` (`/`, `/approvals`, `/requests`, `/costs`, `/ops`, `/logs`, `/agents`, `/settings`, `/repos`, `/audit`, `/repo/:repo/request/:id`, `/design-system`) MUST be reachable and render successfully. Test MUST verify response status 200, page title renders, navigation sidebar appears, no JavaScript errors in console.

**Epic: Settings Persistence**
- **US-021-02** — As an operator, when I change any setting and reload the page, I want my changes to persist.
- **FR-021-02** — Every form control on `/settings` (trust level select, cost cap inputs, allowlist add/remove, Discord/Slack webhook URL, default notification method, DND toggle + start/end times) MUST trigger the appropriate POST. Test MUST verify change → submit → reload → new value present.

**Epic: Request Lifecycle**
- **US-021-03** — As an operator, when I submit a request via CLI, I want to see it appear in the portal within 10 seconds and watch its progress through phases.
- **FR-021-03** — Test MUST seed a request-action JSON file + state file, verify it appears on dashboard "Active requests" table within one polling interval, simulate phase transitions by mutating files, verify status updates propagate across dashboard/requests/approvals pages.

**Epic: Gate Approval Flow**
- **US-021-04** — As an operator, when a request reaches a gate, I want to see it in `/approvals`, click "Approve", and watch the request advance to the next phase.
- **FR-021-04** — Test MUST verify gate creation → appears in `/approvals` list → approval button click triggers POST → gate disappears from list → request advances to next phase in dashboard view.

### Should Have (P1) — Interactive Elements & Error States

**Epic: Webhook Lifecycle**
- **US-021-05** — As an operator, when I add a Discord webhook, click "Test", and see success confirmation, I want confidence that notifications will actually be sent.
- **FR-021-05** — Test MUST verify webhook URL entry → "Test" button enables → click triggers POST to `/api/settings/notifications/test/{discord,slack,send}` → success/failure message displays. Cover both Discord and Slack.

**Epic: Kill Switch Flow**
- **US-021-06** — As an operator, when I need to emergency-stop the daemon, I want the kill switch flow to work reliably and provide escape options.
- **FR-021-06** — Test MUST verify: idle → click "Kill switch" → confirmation banner appears → **Cancel** swaps back to idle; idle → arm → type **CONFIRM** → submit → engaged state; engaged → **Reset** → idle.

**Epic: Dashboard Data Consistency**
- **US-021-07** — As an operator, when I see MTD spend numbers, I want them to be consistent across all pages.
- **FR-021-07** — Test MUST verify MTD spend values match between Dashboard, Requests page, and Costs page within the same session. Gate counts on Dashboard's "Awaiting approval" tile MUST match the gate-list length on `/approvals`.

**Epic: Auto-refresh Behavior**
- **US-021-08** — As an operator, when I leave the portal open in a background tab, I want it to stop polling automatically and resume when I return.
- **FR-021-08** — Test MUST verify polling per the contract pinned in `tests/integration/auto-refresh-polling.test.ts`: foreground tabs poll at documented intervals; background tabs (where `document.visibilityState !== 'visible'`) do NOT poll; returning to foreground resumes polling within one interval.

### Could Have (P2) — Edge Cases & Polish

**Epic: Error Handling**
- **US-021-09** — As an operator, when something goes wrong (404, 500, missing data), I want clear error messages and recovery options.
- **FR-021-09** — Test MUST verify 404 page renders correctly with navigation back to dashboard; 500 error page provides useful information; request-detail page with missing state file shows appropriate error instead of crashing.

**Epic: Agent Management**
- **US-021-10** — As an operator, when I inspect an agent and click "Shadow" mode, I want the action to execute and the UI to reflect the new state.
- **FR-021-10** — Test MUST verify agent inspect modal opens → Promote/Shadow/Freeze button click triggers POST → modal reflects new state OR closes → agent list updates to show new mode.

---

## 5. Non-Functional Requirements

| ID | Requirement | Target | Measurement |
|----|-------------|---------|-------------|
| NFR-021-01 | **Test Suite Speed** | Full suite completes in <5 minutes | CI job duration |
| NFR-021-02 | **Reliability** | False failure rate <1% over 30 days | CI failure rate vs actual bug rate |
| NFR-021-03 | **CI Integration** | Tests run on every PR touching `plugins/autonomous-dev-portal/` | GitHub Actions workflow |
| NFR-021-04 | **Local Development** | `bun run cypress` (or equivalent) works without external deps | Developer setup time |
| NFR-021-05 | **Test Environment** | Tests run against fresh daemon + clean portal state | Test isolation verification |
| NFR-021-06 | **No Real API Spend** | Suite runs without burning Claude API credits | Mock daemon or stubbed claude CLI |

---

## 6. Technical Constraints

### Runtime Decision: Bun vs Node for Cypress

The portal uses `bun` as its primary test runner (`bun test`). Cypress typically expects Node.js.

- **Option A**: Run Cypress on Node.js (most compatible, established tooling)
- **Option B**: Use Cypress with Bun (cutting edge, aligns with portal's Bun-first approach)

**Recommendation**: Start with Node.js for Cypress to minimize tooling friction; revisit Bun later if needed.

### Portal Orchestration

The portal binds to `localhost:19280` by default. Test orchestration must:

- Start portal before tests run (own port, e.g., `19281` to avoid conflicts with running portal)
- Ensure clean state between test runs (separate `AUTONOMOUS_DEV_STATE_DIR`)
- Stop portal after tests complete
- Manage conflicts with already-running portal instances

### Daemon Interaction Strategy

Two approaches:

- **Mock daemon**: Test doubles respond to portal API calls with fixture data. Faster, isolated, no API spend.
- **Real daemon + test data**: Run actual daemon against fixture request-action files and config. Higher fidelity, slower setup.

**Recommendation**: Mock daemon for the fast suite; separate "integration" suite later for high-confidence verification.

---

## 7. Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Operator Bug Detection** | >95% of audit-type issues caught by CI before reaching main | Manual audit findings vs CI catches |
| **Test Stability** | <1% false failure rate over 30 days | CI job failure rate analysis |
| **CI Performance** | Suite adds <5 minutes to PR feedback loop | GitHub Actions timing |
| **Developer Adoption** | >80% of portal feature PRs include Cypress test updates | PR review analysis |
| **Coverage Completeness** | All 11 audit findings from 2026-05-15 would be caught by the suite | Retroactive test run against audit conditions |

---

## 8. Open Questions

1. **Q-021-01**: Real daemon or mock for the fast suite?
   - **Impact**: Real = higher confidence, slower, expensive. Mock = faster, requires maintaining test doubles.
   - **Decision needed by**: TDD phase.
2. **Q-021-02**: Seed test data via direct file creation or CLI simulation?
   - **Impact**: File creation = faster. CLI simulation = more realistic but requires CLI mocking.
   - **Decision needed by**: Implementation start.
3. **Q-021-03**: Cypress component testing for individual JSX views, or only e2e?
   - **Impact**: Component tests = faster feedback. E2e = full workflow coverage.
   - **Decision needed by**: Test strategy.
4. **Q-021-04**: Test isolation strategy — full state reset between tests, or incremental cleanup?
   - **Impact**: Full reset = reliable but slow. Incremental = faster but risk of interdependence.
   - **Decision needed by**: TDD phase.

---

## 9. Acceptance Criteria

- **AC-021-01**: Running `bun run cypress` (or `npm run cypress`) from portal root executes the full test suite locally.
- **AC-021-02**: CI runs Cypress tests on every PR that touches `plugins/autonomous-dev-portal/`.
- **AC-021-03**: All 11 deep-interaction findings from `PORTAL-AUDIT-2026-05-15.md` have specific test cases.
- **AC-021-04**: Test suite verifies all routes in `server/routes/index.ts` return 200 with no console errors.
- **AC-021-05**: Settings persistence test fails when backend persistence is broken; passes when working.
- **AC-021-06**: Auto-refresh polling test verifies background/foreground behavior per the existing contract.
- **AC-021-07**: Data consistency test catches MTD disagreements and gate count mismatches.
- **AC-021-08**: Full suite completes in under 5 minutes with <1% flake rate over 10 consecutive runs.

---

## 10. Rollout Plan

### Phase 1: MVP Foundation
- Set up Cypress infrastructure and CI integration
- Implement navigation smoke tests for all routes (FR-021-01)
- Cover top 3 audit findings: settings persistence, request detail 404, MTD discrepancies

### Phase 2: Core Workflows
- Request lifecycle and gate approval flows (FR-021-03, FR-021-04)
- Kill switch and webhook testing (FR-021-05, FR-021-06)
- Auto-refresh and data consistency verification (FR-021-07, FR-021-08)

### Phase 3: Edge Cases & Polish
- Error state coverage and agent management (FR-021-09, FR-021-10)
- Performance optimization and reliability hardening
- Suite documentation and developer onboarding

---

## 11. Dependencies

- Cypress installation and bun/Node.js compatibility resolution
- Test data fixtures representing various request states and daemon configurations
- Mock services for daemon APIs if not using real daemon
- CI environment setup in GitHub Actions with portal build + test orchestration
- Portal test harness for starting/stopping service and managing state isolation

---

## 12. Future Considerations

- **Visual regression integration**: Cypress + Playwright complementary, not duplicative.
- **Accessibility testing**: Future axe-core integration.
- **Performance monitoring**: Page-load and interaction-time tracking.
- **Cross-browser testing**: Current scope targets Chrome; expand to Firefox/Safari later.

---

**Summary**: Comprehensive Cypress coverage transforms "find bugs by hand" into "CI catches them first." 10 functional requirements + 6 non-functional requirements + 8 acceptance criteria. Recommended TDD focus: start with navigation smoke + settings persistence (highest-impact bugs from the audit), establish the daemon-mocking strategy, then expand.
