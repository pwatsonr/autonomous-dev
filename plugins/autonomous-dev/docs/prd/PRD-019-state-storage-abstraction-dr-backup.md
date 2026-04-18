# PRD-019: State Storage Abstraction, Disaster Recovery & Backup

| Field | Value |
|-------|-------|
| PRD ID | PRD-019 |
| Version | 0.1.0 |
| Date | 2026-04-18 |
| Author | Patrick Watson |
| Status | Draft |
| Plugin | autonomous-dev |

---

## 1. Problem

PRD-001 stores all request state as JSON files on local disk. This approach is fragile: disk corruption means state is lost permanently with no recovery path. There are no backups, no point-in-time recovery, and no integrity verification. The architecture is fundamentally single-host (PRD-001 NG-3), making horizontal scaling and high availability impossible without a more robust foundation.

To enable PRD-020 multi-tenancy and horizontal scale, state persistence must be pluggable and adapter-driven: filesystem (today) → SQLite (robust single-host) → Postgres (multi-host/tenant). Disaster recovery must be a first-class concern, not an afterthought. Every operator deploying this plugin in a production environment needs confidence that their state can be recovered, verified for integrity, and migrated to stronger backends without downtime.

This PRD defines the `StateStore` interface, adapter implementations across three tiers, a pluggable backup engine, point-in-time restore, automated DR drills, migration tooling, and the observability needed to verify these guarantees continuously.

---

## 2. Goals

| ID | Goal |
|----|------|
| G-1 | Define a `StateStore` interface covering request, event, cost, and audit persistence with a uniform CRUD + transaction contract |
| G-2 | Ship adapters for filesystem (MVP default), SQLite (Phase 2), and Postgres (Phase 3) |
| G-3 | Guarantee atomic writes on every adapter — no partial state under crash or out-of-disk conditions |
| G-4 | Implement daily automated backup with configurable retention per PRD-001 defaults |
| G-5 | Support point-in-time restore to any hour within the last 7 days |
| G-6 | Make backup engines pluggable (Restic/Kopia/Borg) with S3-compatible targets including MinIO on-prem |
| G-7 | Ship `autonomous-dev db migrate` as an engine-agnostic migration tool for FS → SQLite → Postgres transitions |
| G-8 | Implement state-format version negotiation so plugin upgrades never silently corrupt existing records |
| G-9 | Detect corrupted state via per-record checksums and auto-recover from last-good checkpoint |
| G-10 | Auto-generate a DR runbook and provide quarterly drill automation with pass/fail reporting |

---

## 3. Non-Goals

| ID | Non-Goal |
|----|----------|
| NG-1 | This is not general-purpose database hosting infrastructure |
| NG-2 | Replication and HA failover are deferred to PRD-020 |
| NG-3 | User project files, source code, and git history are out of scope for backup |
| NG-4 | Time-travel debugging of plugin logic is not in scope |
| NG-5 | This system does not replace or augment git as a version control mechanism |

---

## 4. Personas

**Platform Operator** — Deploys and configures the plugin in production. Needs reliable backup scheduling and straightforward restore procedures.

**SRE** — Owns availability and incident response. Needs RTO/RPO visibility, alerting on backup failures, and runnable DR drills.

**Security Reviewer** — Audits encryption posture, key management practices, and retention enforcement.

**Compliance Auditor** — Verifies that retention schedules meet regulatory requirements (including 7-year modes for PRD-022) and that audit logs are tamper-evident.

**Multi-Tenant Admin** — Manages isolated state namespaces per tenant. Requires per-tenant snapshot capability in Phase 3 (PRD-020 integration).

---

## 5. User Stories

| ID | Story | Priority |
|----|-------|----------|
| US-01 | As an operator, I run `backup create` and receive an encrypted snapshot of all plugin state | P0 |
| US-02 | As an SRE, I restore state from 7 days ago to recover from accidental deletion | P0 |
| US-03 | As a compliance auditor, I verify that retention policy meets the required 7-year window | P1 |
| US-04 | As an operator, disk corruption auto-triggers recovery from the last valid checkpoint without manual intervention | P0 |
| US-05 | As an operator, I migrate from filesystem to SQLite with zero downtime and full verification | P1 |
| US-06 | As a multi-tenant admin, I migrate from SQLite to Postgres to support additional tenants | P1 |
| US-07 | As an SRE, I run a quarterly DR drill that confirms RTO and RPO targets are met | P1 |
| US-08 | As a security reviewer, I verify the hash-chained audit log has not been tampered with | P1 |
| US-09 | As an operator on a restricted network, I configure MinIO as the on-prem backup target | P1 |
| US-10 | As a security reviewer, I confirm all snapshots are encrypted at rest using age | P0 |
| US-11 | As an operator, Restic deduplication keeps snapshot storage growth within budget | P1 |
| US-12 | As an SRE, I restore state to a specific hour within the last 7 days to recover from a logic bug | P1 |
| US-13 | As an SRE, I receive a PRD-007 escalation alert when a scheduled backup fails | P0 |
| US-14 | As an operator, I run `db verify` and receive a clear integrity report with any anomalies flagged | P0 |
| US-15 | As a security reviewer, I rotate the backup encryption key and confirm all existing snapshots are re-encrypted | P1 |
| US-16 | As an SRE, the plugin pauses gracefully during restore so no in-flight requests are lost or corrupted | P0 |
| US-17 | As a multi-tenant admin, I create and restore per-tenant snapshots independently (PRD-020) | P1 |
| US-18 | As an operator, I swap the backup provider from Restic to Kopia with zero downtime | P1 |

---

## 6. Functional Requirements

### 6.1 StateStore Interface (FR-100s)

**FR-100 Contract.** The `StateStore` interface exposes the following operations: `Create`, `Read`, `Update`, `Delete`, `List`, and `Transaction`. `Transaction` supports rollback on error and must be honored by all adapters. The interface is defined in `pkg/statestore/interface.go` and is the only surface the plugin core may use for persistence.

**FR-101 Schema Versioning.** Every persisted record carries a `schema_version` field. Reads against records with a lower schema version than the current binary trigger an in-place migration handler. Reads against records with a higher schema version than the binary return an error with a clear upgrade message.

**FR-102 Atomic Writes.** The filesystem adapter uses write-to-temp-then-rename. SQLite uses explicit `BEGIN`/`COMMIT` blocks. Postgres uses transactions with serializable isolation for writes. No adapter may leave partial state on crash.

**FR-103 Corruption Detection.** Every record stores a `sha256` checksum of its payload. On read, the checksum is verified. On mismatch, the record is flagged as corrupted, the event is emitted to the observability pipeline (FR-1000), and the auto-recovery path (FR-603) is triggered.

### 6.2 Adapters (FR-200s)

**FR-200 Filesystem Adapter.** Wraps the existing PRD-001 JSON-on-disk behavior. Adds atomic rename, per-record checksums, and schema-version fields to existing records on first read after upgrade. Default adapter in Phase 1.

**FR-201 SQLite Adapter.** Uses WAL mode for concurrent reads, enforces foreign keys via `PRAGMA foreign_keys = ON`, and enables `auto_vacuum = INCREMENTAL`. Connection pooling is single-writer, multiple readers. WAL checkpointing is automated with a configurable interval.

**FR-202 Postgres Adapter.** Uses `uuid-ossp` for primary keys, `JSONB` for payload fields, and `pgvector` for embedding columns if PRD-011 is installed in the same environment. Connection pooling via `pgxpool`. Schema is namespaced per tenant when PRD-020 multi-tenancy is active.

### 6.3 Migration Engine (FR-300s)

**FR-300 CLI Command.** `autonomous-dev db migrate` applies pending versioned migrations for the configured adapter. Migrations are tracked in a `schema_migrations` table (SQL adapters) or a `_migrations.json` sidecar file (filesystem adapter).

**FR-301 SQL Compatibility.** Migration files are Atlas-compatible SQL. Each adapter ships its own migration directory (`migrations/sqlite/`, `migrations/postgres/`). The migration runner selects the correct directory based on the active adapter.

**FR-302 Reversibility.** All migrations follow expand/contract pattern by default. Down migrations are required unless explicitly marked irreversible with a comment. The runner validates down migrations exist before applying up migrations unless `--irreversible` is passed.

**FR-303 Dry-Run and Force.** `--dry-run` prints the SQL that would be applied without executing it. `--force` skips the confirmation prompt for production environments where automation requires non-interactive execution. Both flags are mutually exclusive.

### 6.4 Backup Engine (FR-400s)

**FR-400 BackupProvider Interface.** The `BackupProvider` interface exposes `Create`, `List`, `Restore`, `Delete`, and `Verify` operations. Provider implementations live in `pkg/backup/providers/`. The active provider is configured in `config.yaml` under `backup.provider`.

**FR-401 Provider Adapters.** Restic is the default provider. Kopia and Borg are supported as alternatives. Provider selection does not affect the `BackupProvider` interface contract. Switching providers requires a one-time migration of existing snapshots or acceptance of a snapshot history gap.

**FR-402 Backup Targets.** Supported targets: S3-compatible (MinIO, AWS S3, Cloudflare R2, GCS via gcsfuse), local directory, and SSH remote. Target configuration is validated at startup. An unreachable target at startup blocks the daemon from starting unless `backup.target.required = false`.

**FR-403 Encryption at Rest.** All snapshots are encrypted using `age` by default. GPG is supported as an alternative. The encryption key is stored via the PRD-015 secrets abstraction. Unencrypted snapshots are rejected unless `backup.encryption.disabled = true` is explicitly set with a warning logged.

**FR-404 Schedule.** Backups run daily at 02:00 local time by default. The schedule is configurable as a cron expression under `backup.schedule`. The daemon emits a structured log event and OTel metric on each backup start, success, and failure.

### 6.5 Restore (FR-500s)

**FR-500 Snapshot Listing.** `autonomous-dev backup list` outputs a table of snapshots with ID, timestamp, size, target, and encryption status. The `--json` flag emits machine-readable output.

**FR-501 Restore Command.** `autonomous-dev backup restore <snapshot-id>` requires interactive confirmation unless `--yes` is passed. Before restore begins, the plugin daemon is paused via the PRD-007 coordination mechanism. In-flight requests are drained before the state swap. The daemon is resumed after post-restore verification passes.

**FR-502 Point-in-Time Restore.** When the active adapter is SQLite or Postgres, `backup restore --pitr <timestamp>` selects the nearest snapshot before the target timestamp and replays the WAL forward to the exact timestamp. The filesystem adapter supports PITR only to snapshot granularity.

**FR-503 Post-Restore Verification.** After every restore, `db verify` runs automatically. If verification fails, the restore is rolled back to the pre-restore state and an alert is fired via PRD-007.

### 6.6 Integrity (FR-600s)

**FR-600 Per-Record Checksum.** See FR-103. Checksums use SHA-256 over the canonical JSON serialization of the record payload, excluding the checksum field itself.

**FR-601 Periodic Verification.** `autonomous-dev db verify` can be run on demand or on a schedule. It scans all records, verifies checksums, checks referential integrity across related records, and reports anomalies. Exit code 0 means clean; non-zero means anomalies found.

**FR-602 Hash-Chained Audit Log.** In Phase 2 and above, the audit log (PRD-009 spec) is hash-chained: each entry includes the SHA-256 hash of the previous entry. This makes log tampering detectable without requiring a separate integrity service. Hash-chain verification is included in `db verify`.

**FR-603 Auto-Recovery.** On corruption detection, the adapter identifies the last contiguous sequence of valid records, marks corrupted records with a `corrupted_at` timestamp, and emits a recovery event. The daemon continues operating on the clean portion of state. A PRD-007 alert is raised for operator review.

### 6.7 Retention (FR-700s)

**FR-700 Default Retention.** Retention defaults match PRD-001 configuration: daily snapshots retained for 7 days, weekly snapshots retained for 4 weeks, monthly snapshots retained for 12 months.

**FR-701 Compliance Mode.** When `backup.retention.compliance = true` is set (PRD-022 integration), retention extends to 7 years. Compliance-mode snapshots are write-locked and cannot be deleted by the normal retention sweep. Deletion requires an explicit `backup delete --compliance-override` command with audit logging.

**FR-702 Secure Delete.** On expiry, snapshot data is securely deleted from the target. For local filesystem targets, this means overwrite-then-unlink. For S3-compatible targets, this means issuing a delete with versioning awareness. Deletion events are recorded in the audit log.

### 6.8 Encryption and Keys (FR-800s)

**FR-800 Default Encryption.** Age is the default encryption backend. The age public key is stored in `config.yaml`; the private key is stored via PRD-015. GPG is available as an alternative with `backup.encryption.backend = gpg`.

**FR-801 Key Rotation.** `autonomous-dev backup rotate-key --new-key <path>` re-encrypts all existing snapshots under the new key in a streaming fashion. The old key remains valid until rotation completes. A rotation log is written to the audit log.

**FR-802 Key Storage.** Encryption keys are retrieved exclusively through the PRD-015 secrets abstraction. Plaintext keys must never appear in config files, environment variables exported to child processes, or logs.

### 6.9 DR Drills (FR-900s)

**FR-900 DR Drill Command.** `autonomous-dev dr drill` performs a full end-to-end DR test: creates a fresh snapshot, restores it to an isolated sandbox environment, runs `db verify` against the sandbox, and reports pass/fail with timing for RTO comparison.

**FR-901 Quarterly Reminder.** The daemon tracks the last successful DR drill timestamp. If more than 90 days have passed without a passing drill, a PRD-007 alert is raised at INFO level, escalating to WARNING at 100 days and CRITICAL at 120 days.

**FR-902 Drill Reporting.** Drill results are archived as structured JSON in `$STATE_DIR/dr-drills/`. Each report includes snapshot ID, restore duration, verify result, RTO measured, RPO calculated from last backup timestamp to drill invocation time, and overall pass/fail status.

### 6.10 Observability (FR-1000s)

**FR-1000 OTel Spans.** Every `StateStore` operation emits an OpenTelemetry span with adapter name, operation type, record count, and duration. Errors include structured attributes for error class and whether auto-recovery was attempted.

**FR-1001 Backup Metrics.** The following metrics are emitted: `backup.duration_seconds` (histogram), `backup.size_bytes` (gauge), `backup.success_total` (counter), `backup.failure_total` (counter), `backup.last_success_timestamp` (gauge).

**FR-1002 RTO/RPO Dashboards.** A Grafana dashboard definition is shipped in `dashboards/dr-overview.json`. It visualizes backup age, last successful drill RTO, RPO trend, and corruption event frequency.

---

## 7. Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NFR-01 | Read p95 latency: filesystem adapter <10ms; SQLite adapter <5ms; Postgres adapter <20ms under local network conditions |
| NFR-02 | Write atomicity verified by chaos test that kills the daemon at random points during writes — zero partial records allowed |
| NFR-03 | Restic deduplication must keep incremental snapshot size below 10% of total state size for typical workloads |
| NFR-04 | Restore RTO must be under 1 hour at p95 for state sets up to 10GB |
| NFR-05 | Corruption must be auto-detected within 1 second of the corrupted record being read |
| NFR-06 | Zero data loss under clean daemon shutdown or unclean crash, verified by test suite |
| NFR-07 | Backup encryption is mandatory; no plaintext snapshots may be written to any target |
| NFR-08 | Retention policy must be enforced on every backup cycle with verified deletion of expired snapshots |
| NFR-09 | DR drill must pass 100% of quarterly runs, confirmed by automated reporting |
| NFR-10 | Backup storage growth is tracked per snapshot and exposed via FR-1001 metrics |

---

## 8. Architecture

```
Daemon / Plugin Core
        │
        ▼
┌─────────────────────────────────────────┐
│           StateStore Interface          │
│  ┌──────────────┐  ┌──────────────────┐ │
│  │ FS Adapter   │  │  SQLite Adapter  │ │
│  │ (Phase 1)    │  │  (Phase 2, WAL)  │ │
│  └──────────────┘  └──────────────────┘ │
│  ┌─────────────────────────────────────┐ │
│  │      Postgres Adapter (Phase 3)     │ │
│  └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────┐
│         BackupProvider Interface        │
│  Restic (default) │ Kopia │ Borg        │
└─────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────┐
│              Backup Targets             │
│  MinIO │ S3 │ R2 │ GCS │ local │ SSH   │
└─────────────────────────────────────────┘

Audit log: hash-chained, append-only (Phase 2+)
Migration: autonomous-dev db migrate (Atlas-compatible SQL)
DR Drill:  snapshot → sandbox restore → verify → report
Keys:      PRD-015 secrets abstraction → age (default) / GPG
Alerts:    PRD-007 escalation on backup failure, drill overdue, corruption
```

---

## 9. Testing Strategy

**Chaos Tests.** A process-kill harness kills the daemon at random points during `StateStore` write operations using SIGKILL. Post-kill, the state directory is scanned for partial records. Zero partial records is the pass criterion across all adapters.

**Disk-Full Tests.** The filesystem adapter is tested under simulated `ENOSPC` conditions. The test verifies that the rename-temp strategy rolls back cleanly and that no data from the in-progress write is persisted.

**Migration Tests.** End-to-end migration tests cover FS → SQLite → Postgres. Each test verifies record count, checksum validity, and schema version correctness after migration. Migration tests run in CI against a local Postgres container.

**Restore-to-Sandbox Tests.** `dr drill` is exercised in CI using a local MinIO container as the backup target. The test asserts that the restored state is byte-for-byte equivalent to the pre-backup state for deterministic records.

**Hash-Chain Integrity Tests.** The audit log is written, then a single byte in the middle is flipped. `db verify` must detect the tampering and report the exact entry ID where the chain breaks.

**Encryption Tests.** Snapshots are inspected at the target to confirm no plaintext JSON is present. Key rotation is tested by rotating a key and verifying that old snapshots become unreadable with the old key and readable with the new key.

**RTO/RPO Load Tests.** A 10GB synthetic state set is backed up and restored under simulated production load. The test asserts that restore completes within the NFR-04 RTO target of 1 hour at p95.

---

## 10. Migration and Rollout

**Phase 1 (Weeks 1–3): Foundation**
Extract the `StateStore` interface from the PRD-001 filesystem implementation. Ship the filesystem adapter that wraps existing behavior with added atomic writes, per-record checksums, and schema versioning. Deploy daily Restic backup to a local directory target. Ship `autonomous-dev backup create`, `backup list`, `backup restore`, and `db verify` commands. Wire backup failure alerts into PRD-007.

**Phase 2 (Weeks 4–6): SQLite and Remote Backup**
Ship the SQLite adapter with WAL mode, the `db migrate` tool for FS → SQLite migration, MinIO/S3 target support, age encryption, and PITR for SQLite via WAL replay. Enable hash-chained audit log. Ship key rotation command. Enable per-record checksum verification in `db verify`.

**Phase 3 (Weeks 7–10): Postgres and Multi-Tenancy**
Ship the Postgres adapter with per-tenant schema namespacing as required by PRD-020. Ship SQLite → Postgres migration path. Enable DR drill automation with quarterly reminder and archived reporting. Ship Grafana RTO/RPO dashboard. Enable per-tenant snapshot capability for PRD-020 integration.

---

## 11. Risks

| ID | Risk | Mitigation |
|----|------|------------|
| R-1 | Migration of large state sets causes extended downtime | Chunked online migration with progress reporting and resumability |
| R-2 | Backup target misconfigured silently | Validate target connectivity and write permissions at daemon startup |
| R-3 | Restore encryption key lost, snapshots unrecoverable | Integrate with KMS via PRD-015; document key escrow procedure in runbook |
| R-4 | PITR edge cases at WAL boundary produce inconsistent state | Extensive boundary testing; PITR requires explicit confirmation prompt |
| R-5 | FS tombstones lost during rename on certain filesystems | Durable operation log written before rename; validated on fsync |
| R-6 | SQLite WAL checkpoint failure causes WAL file growth | Auto-rotation on checkpoint failure with alert |
| R-7 | Postgres adapter complexity introduced prematurely | Postgres adapter is Phase 3 only; no cross-phase dependency |
| R-8 | Network backup target transient failures cause false-positive outage alerts | Exponential retry with backoff; alert only after 3 consecutive failures |
| R-9 | Compliance retention costs exceed budget for long-lived deployments | Policy tier configuration with per-retention-mode storage cost estimate shown at config time |
| R-10 | Audit hash-chain verification not run frequently enough for tampering to be caught | `db verify` runs daily by default with hash-chain check included |
| R-11 | Backup creation races with deploy causing split state | Backup acquires advisory lock; deploy waits or signals backup to defer |
| R-12 | Schema version skew between plugin versions on rolling upgrade | Compat matrix tested in CI; read path tolerates N-1 schema versions |

---

## 12. Success Metrics

- Zero data-loss incidents attributable to storage layer failures in the 12 months following Phase 1 GA.
- Scheduled backup success rate of 99.5% or higher, measured over any 30-day rolling window.
- Restore RTO at p95 under 1 hour for state sets up to 10GB.
- RPO at p95 under 24 hours, meaning the most recent backup is always within one day of the restore point.
- DR drill passes 100% of quarterly runs with no manual intervention required.
- State corruption auto-recovery succeeds in 95% or more of detected corruption events without operator intervention.

---

## 13. Open Questions

| ID | Question |
|----|----------|
| OQ-1 | Should Restic, Kopia, or Borg be the default backup provider? Restic has wider adoption; Kopia has better performance at scale. |
| OQ-2 | Should the default backup target be MinIO (requires additional service) or local directory (zero dependencies)? |
| OQ-3 | Should the hash-chained audit log be default-on in Phase 2 or opt-in to avoid performance overhead at small scale? |
| OQ-4 | Should the SQLite → Postgres migration tool be a custom implementation or delegate to Atlas? Atlas adds a dependency but reduces maintenance burden. |
| OQ-5 | What is the PITR granularity target — hourly (simpler, aligns with NFR-04) or per-minute (higher fidelity, higher WAL storage cost)? |
| OQ-6 | Should the default encryption backend be age (modern, simple) or GPG (wider toolchain compatibility)? |

---

## 14. References

**Related PRDs:** PRD-001 (Core State and Request Lifecycle), PRD-007 (Alerting and Escalation), PRD-009 (Audit Log), PRD-015 (Secrets Abstraction), PRD-020 (Multi-Tenancy), PRD-022 (Compliance and Retention), PRD-023 (Observability).

**External References:**
- Restic backup tool: https://restic.net
- Kopia backup tool: https://kopia.io
- BorgBackup: https://www.borgbackup.org
- MinIO object storage: https://min.io
- Atlas schema migrations: https://atlasgo.io
- age encryption: https://age-encryption.org
- PostgreSQL documentation: https://www.postgresql.org

---

**END PRD-019**
