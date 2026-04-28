# PLAN-012-2: SQLite Schema Migration + Source Metadata

## Metadata
- **Parent TDD**: TDD-012-intake-daemon-handoff
- **Estimated effort**: 1-2 days
- **Dependencies**: []
- **Blocked by**: []
- **Priority**: P0

## Objective
Implement SQLite v1→v2 schema migration to add source tracking fields (`source`, `adapter_metadata`) to the requests table. Updates repository layer for new fields; defines canonical TypeScript types for `RequestSource` and `AdapterMetadata`; ensures backward compatibility with existing v1 state.json files.

## Scope
### In Scope
- Migration `intake/db/migrations/002_add_source_metadata.sql`:
  ```sql
  ALTER TABLE requests ADD COLUMN source TEXT NOT NULL DEFAULT 'cli';
  ALTER TABLE requests ADD COLUMN adapter_metadata TEXT DEFAULT '{}';
  CREATE INDEX idx_requests_source ON requests(source);
  ```
- Update `intake/db/migrator.ts` to apply migration on startup if `schema_version < 2`
- Update `intake/db/repository.ts` `RequestEntity` to include `source`, `adapter_metadata`; update insert/update queries
- Create `intake/types/request_source.ts` with `RequestSource` enum + discriminated `AdapterMetadata` per TDD-012 §7.1
- State.json schema additions per §7.3: optional `source`, `adapter_metadata` fields with defaults for v1.0 backward compat
- Backward-compat handling per §16.1: existing v1.0 state.json without `source` defaults to `'cli'` when read

### Out of Scope
- Two-phase commit handoff (PLAN-012-1)
- Reconciliation CLI (PLAN-012-3)

## Tasks

1. **Author SQLite migration file** -- `002_add_source_metadata.sql` per §8.1.
   - Files: `intake/db/migrations/002_add_source_metadata.sql` (new)
   - Acceptance: adds source column with NOT NULL DEFAULT 'cli'; adds adapter_metadata as TEXT DEFAULT '{}'; creates source index; idempotent (safe to apply multiple times).
   - Effort: 1h

2. **Update migrator to apply v1→v2 migration** -- automatic detection on startup.
   - Files: `intake/db/migrator.ts`
   - Acceptance: detects v1 schema; applies 002; tracks in `_migrations` table; fresh DB gets 001+002; already-migrated skips 002.
   - Effort: 1h

3. **Extend RequestEntity + repository ops** -- `RequestEntity.source` (RequestSource), `RequestEntity.adapter_metadata` (string); insert/update queries include new columns.
   - Files: `intake/db/repository.ts`
   - Acceptance: insert with source='discord' roundtrips; insert without source defaults to 'cli'; backward-compat reads v1 schema.
   - Effort: 2h

4. **Define RequestSource + AdapterMetadata types** -- canonical enum from PRD-008 §10.1; discriminated unions for adapter-specific shapes.
   - Files: `intake/types/request_source.ts` (new)
   - Acceptance: enum has cli, claude-app, discord, slack, production-intelligence, portal; AdapterMetadata covers all adapter shapes (CLI pid/cwd/branch, Discord guild/channel/user/message, Slack team/channel/user/message_ts, Claude session/user/workspace, portal session/user_agent); all fields optional except discriminator.
   - Effort: 1h

5. **Update state.json schema for source tracking** -- include `source` + `adapter_metadata`; backward-compat for v1.0 files.
   - Files: state.json validators in codebase
   - Acceptance: new files include both fields; reading v1.0 (no source) defaults to 'cli' + empty metadata; writing always includes both for v1.1.
   - Effort: 2h

6. **Create v1.1 state.json fixtures** -- representative examples per adapter type.
   - Files: test fixtures
   - Acceptance: fixtures for CLI, Discord, Slack, Claude App; each has appropriate adapter_metadata; all validate against extended schema.
   - Effort: 1h

7. **Implement backward-compat validator** -- accepts v1.0 (no source) and v1.1 (with); graceful defaults; rejects invalid source enum values.
   - Files: state validation logic
   - Acceptance: v1.0 fixture validates with defaults; v1.1 fixture roundtrips; invalid enum rejected.
   - Effort: 2h

8. **Comprehensive test suite** -- migration, repository, types, backward-compat.
   - Files: `intake/__tests__/db/migration_002.test.ts` (new) + extend repository tests
   - Acceptance: tests cover fresh + existing v1 migration, repository ops, RequestSource usage, AdapterMetadata type safety, v1.0 backward read, v1.1 roundtrip.
   - Effort: 3h

## Dependencies & Integration Points

**Exposes:**
- RequestSource + AdapterMetadata types consumed by all channel adapters (PLAN-011-*)
- Extended RequestEntity used by handoff (PLAN-012-1)
- Source metadata enables audit trails + reconciliation (PLAN-012-3)
- Migration framework for future schema evolution

**Consumes:** None — foundational.

## Test Plan

- **Migration:** empty DB, existing v1 DB, already-migrated; verify idempotency + constraints
- **Repository:** insert/update/select with new fields; source defaults; adapter_metadata JSON handling
- **Type safety:** compile-time enum + discriminated-union verification
- **Backward compat:** load v1.0 fixtures; verify graceful handling
- **Schema validation:** v1.1 examples for all adapter types

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Migration fails on production data | Low | High | Realistic fixture testing; transaction-wrapped migration; backup strategy documented |
| adapter_metadata grows large, impacting perf | Medium | Medium | Monitor sizes; consider compression or separate table; index for common queries |
| Backward compat breaks daemon | Low | High | Thorough state.json read testing; defaults preserve v1.0 processability |

## Acceptance Criteria

- [ ] Migration adds source + adapter_metadata columns with constraints
- [ ] Migrator auto-applies on startup for v1 DBs
- [ ] RequestEntity includes source + adapter_metadata
- [ ] Repository ops handle new fields
- [ ] RequestSource enum + AdapterMetadata in `intake/types/request_source.ts`
- [ ] state.json supports v1.0 (backward) + v1.1 (with source)
- [ ] Validator handles missing source with 'cli' default
- [ ] Test fixtures cover all adapter types
- [ ] All tests pass
- [ ] No TypeScript errors
- [ ] Documentation updated
