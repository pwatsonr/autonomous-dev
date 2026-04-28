# AMENDMENT: Unified Setup-Wizard Phase Registry

**Status**: Active. Supersedes PRD-008 §13.4 and any per-PRD phase numbering.
**Date**: 2026-04-28
**Applies to**: PRD-008, PRD-009, PRD-010, PRD-011, PRD-012, PRD-013, PRD-014, autonomous-dev-homelab PRD-001

The setup-wizard phase numbering across PRDs has accumulated collisions. This amendment establishes the single source of truth.

## Phase Registry

| Phase | Topic                                                | Owning PRD            | Notes |
|-------|------------------------------------------------------|-----------------------|-------|
| 1     | Prerequisites                                         | existing              |       |
| 2     | Plugin installation                                   | existing              |       |
| 3     | Configuration                                         | existing              |       |
| 4     | Trust level                                           | existing              |       |
| 5     | Cost budget                                           | existing              |       |
| 6     | Daemon install + start                                | existing              |       |
| 7     | Submit first request (CLI)                            | PRD-008               |       |
| 8     | Enable chat channels (Discord/Slack)                  | PRD-008               |       |
| 9     | Notifications                                         | existing              |       |
| 10    | Production intelligence                               | existing              |       |
| 11    | Web portal install (optional)                         | PRD-009               |       |
| 12    | CI setup (workflows + secrets + branch protection)    | PRD-010               |       |
| 13    | Request types & extension hooks                       | PRD-011               |       |
| 14    | Engineering standards bootstrap                       | PRD-013               |       |
| 15    | Specialist reviewer chains                            | PRD-012               |       |
| 16    | Deployment backends                                   | PRD-014               |       |
| 17    | Homelab platform discovery                            | autonomous-dev-homelab|       |
| 18    | Homelab platform connection (MCP/SSH)                 | autonomous-dev-homelab|       |
| 19    | Homelab backup configuration                          | autonomous-dev-homelab|       |
| 20    | Verification & summary                                | existing (was P12)    |       |

## Per-PRD Updates

Each PRD's setup-wizard section SHALL reference this registry instead of asserting standalone phase numbers. New PRDs SHALL request a phase number via update to this amendment, not by inserting at an arbitrary location.

## Phase Skipping

Operators can skip optional phases (11 portal, 12 CI, 13-19 platform extensions) per their needs. Phases 1-10 and 20 are required.

---
