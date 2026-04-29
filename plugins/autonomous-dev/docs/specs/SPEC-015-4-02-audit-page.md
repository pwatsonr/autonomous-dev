# SPEC-015-4-02: Audit Page (Paginated HMAC-Chained Log Viewer + Filtering)

## Metadata
- **Parent Plan**: PLAN-015-4
- **Tasks Covered**: TASK-007 (audit log reader), TASK-008 (audit integrity verifier), TASK-009 (audit page handler + templates), TASK-010 (audit display formatter), TASK-015 (CLI audit-verify tool)
- **Estimated effort**: 14.5 hours (≈1.8 days)

## Description
Render the `/audit` page with paginated, filterable access to the HMAC-chained audit log produced by SPEC-014-3-03. The page shows 50 entries per request, supports filters (`operatorId`, `action`, `startDate`, `endDate`), reports per-page integrity status (`verified | warning | error | unknown`) using the SPEC-014-3-03 verification primitives, and ships an offline `audit-verify` CLI for cron-friendly chain validation.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/portal/types/audit-types.ts` | Create | `AuditEntry`, `AuditPageResult`, `AuditFilters`, `IntegrityStatus` |
| `src/portal/services/audit-log-reader.ts` | Create | `AuditLogReader` with `getPage()`, streaming line read with bounded buffer |
| `src/portal/services/audit-log-reader.test.ts` | Create | Unit tests (covered fully in SPEC-015-4-04) |
| `src/portal/services/audit-integrity-verifier.ts` | Create | Wraps SPEC-014-3-03 verification; returns `{ status, sequenceGaps, hmacFailures }` for a contiguous range |
| `src/portal/services/audit-display-formatter.ts` | Create | Maps `AuditEntry` → `AuditDisplay { title, description, severity, icon, relativeTime }` |
| `src/portal/routes/audit.ts` | Create | `GET /audit` handler with HTMX-aware response branching (full page vs fragment) |
| `src/portal/templates/audit.hbs` | Create | Full page extending `layouts/base.hbs`; embeds filter form + entries fragment + pagination fragment |
| `src/portal/templates/fragments/audit-entry.hbs` | Create | Single-row partial |
| `src/portal/templates/fragments/audit-pagination.hbs` | Create | Prev/Next + page-N-of-M; preserves filters in URL |
| `src/portal/templates/fragments/integrity-indicator.hbs` | Create | Green/yellow/red pill with tooltip text |
| `bin/audit-verify.ts` | Create | Offline CLI: `audit-verify <log-path> [--key-file <path>] [--verbose] [--from <seq>] [--to <seq>]` |
| `package.json` | Modify | Add `bin.audit-verify` entry pointing at the new file |

## Implementation Details

### Types (`src/portal/types/audit-types.ts`)

```typescript
export interface AuditEntry {
  sequence: number;
  timestamp: string;            // ISO-8601 UTC
  operatorId: string;
  action: string;               // e.g. "kill-switch.engage"
  details: Record<string, unknown>;
  previous_hmac: string | null; // null only for sequence === 1
  entry_hmac: string;
}

export type IntegrityStatus = 'verified' | 'warning' | 'error' | 'unknown';

export interface AuditFilters {
  operatorId?: string;
  action?: string;       // substring match (case-insensitive)
  startDate?: Date;
  endDate?: Date;
}

export interface AuditPageResult {
  entries: AuditEntry[];
  totalCount: number;
  hasNext: boolean;
  hasPrevious: boolean;
  currentPage: number;
  pageSize: number;
  integrityStatus: IntegrityStatus;
  integrityDetail?: { sequenceGaps: number; hmacFailures: number; firstFailingSequence?: number };
}
```

### `AuditLogReader.getPage(page, pageSize, filters)`

```typescript
export class AuditLogReader {
  constructor(private auditLogPath: string, private verifier: AuditIntegrityVerifier) {}
  async getPage(page: number = 1, pageSize: number = 50, filters?: AuditFilters): Promise<AuditPageResult>;
}
```

Behavior:
- Reads `audit.jsonl` line-by-line via `readline.createInterface(fs.createReadStream(...))` — never `readFile` (memory-bound for ≥100K-entry logs).
- Each malformed JSON line is skipped with a `console.warn(seq?, lineNo)`. Malformed lines do NOT count toward `totalCount`.
- Entries are sorted by `sequence` DESCENDING for display (newest first).
- Filtering: applied AFTER parsing, BEFORE pagination. `action` is a case-insensitive substring match. `operatorId` is exact match. Date range is `entry.timestamp >= startDate AND <= endDate`.
- Pagination: `startIndex = (page-1) * pageSize`, `endIndex = startIndex + pageSize`, `entries = filtered.slice(startIndex, endIndex)`.
- Page bounds: `page < 1` is treated as `1`. `page > ceil(totalCount/pageSize)` returns an empty `entries` array with `hasNext=false, hasPrevious=true` (or both false when total is 0).
- `pageSize` clamped to `[1, 200]`.
- Integrity check is run only on the page's contiguous slice (in original ascending order) by handing the range to `verifier.checkRange(firstSeq, lastSeq)`. If the slice is non-contiguous after filtering, `integrityStatus` is `'unknown'` (we cannot verify a gap-free chain across filtered output).
- On read failure (file missing, permission denied), returns `{ entries: [], totalCount: 0, integrityStatus: 'error' }` and logs the error.

### `AuditIntegrityVerifier.checkRange(fromSeq, toSeq)`

Wraps the verification primitives delivered by SPEC-014-3-03:
- Re-walks the chain from `fromSeq` to `toSeq` (inclusive), recomputes each entry HMAC using the current key, asserts `entry.previous_hmac === priorEntry.entry_hmac`, asserts `entry.sequence === priorEntry.sequence + 1`.
- Returns `{ status: 'verified' }` when all entries match.
- Returns `{ status: 'warning', sequenceGaps, hmacFailures: 0 }` when sequence numbers skip but HMACs are valid for present entries (gaps could be benign rotation artifacts).
- Returns `{ status: 'error', hmacFailures, firstFailingSequence }` when ANY HMAC mismatch is detected.
- Returns `{ status: 'unknown' }` when the verification key is missing or unreadable. The page renders normally with the `unknown` indicator.

### `AuditDisplayFormatter.formatEntry(entry, now)`

```typescript
export interface AuditDisplay {
  sequence: number;
  title: string;            // e.g. "Kill-switch engaged by alice"
  description: string;      // operator-facing one-liner from details
  severity: 'info' | 'warning' | 'critical';
  icon: string;             // lucide icon name
  relativeTime: string;     // "5m ago"
  absoluteTime: string;     // ISO-8601
  operatorDisplay: string;  // strips realm: "alice@host" → "alice"
  rawDetails: Record<string, unknown>;
}
```

Severity rules:
- `critical`: `kill-switch.engage`, `circuit-breaker.engage`, any action whose `details.outcome === 'failed'` for a destructive operation.
- `warning`: `*.reject`, `circuit-breaker.reset`, settings changes that touch security-sensitive keys (e.g. `auth.*`, `intake.allowlist`).
- `info`: everything else, including approvals and read-only audit reads.

Icon mapping is a static table; unknown actions fall back to `info` + `circle` icon.

`relativeTime` uses `now - timestamp`:
- < 60s → `"just now"`
- < 1h → `"Nm ago"`
- < 24h → `"Nh ago"`
- < 30d → `"Nd ago"`
- otherwise → `"on YYYY-MM-DD"`

### `GET /audit` Route

Query parameters: `page` (int, default 1), `operatorId`, `action`, `startDate` (ISO-8601 date), `endDate`.

Response:
- If `HX-Request: true` AND `HX-Target: audit-content`: render `audit-content` partial (entries + pagination only).
- Otherwise: render full `audit.hbs` extending `base.hbs`.

Both branches receive the same context: `{ result: AuditPageResult, displays: AuditDisplay[], filters, csrfToken, staleBanner }`. Filter state is preserved in `pagination.hbs` links via querystring concatenation, and the filter form uses `hx-push-url="true"` so deep links work.

Pagination: rendered links are `?page={N}&operatorId={...}&action={...}&startDate=...&endDate=...`. URL-encoded values are mandatory. Date-range parsing rejects non-ISO inputs with a 400.

### `audit-verify` CLI (`bin/audit-verify.ts`)

```
Usage: audit-verify <log-path> [options]
  --key-file <path>   HMAC key file (default: $AUTONOMOUS_DEV_AUDIT_KEY_FILE)
  --from <seq>        Start sequence (inclusive, default 1)
  --to <seq>          End sequence (inclusive, default last)
  --verbose           Print per-entry status
  --json              Emit machine-readable summary
  -h, --help          Show this help and exit 0
```

Behavior:
- Walks the log via the same streaming reader. For each entry: validate HMAC, check sequence continuity, check `previous_hmac` linkage.
- Emits per-entry detail lines under `--verbose` only.
- Always prints a summary block: total entries, gap count, HMAC failure count, first failing sequence (if any), wall-clock duration.
- Exit codes: `0` verified, `1` warnings (gaps but no HMAC failures), `2` errors (HMAC failures, missing key, unreadable file).
- `--json` mode prints the summary as a single-line JSON object to stdout instead of human text; intended for `cron` and CI consumption.

## Acceptance Criteria

- [ ] `getPage(1, 50)` over a fixture with 73 entries returns 50 newest entries (sorted by `sequence` DESC) with `totalCount: 73, hasNext: true, hasPrevious: false, currentPage: 1`.
- [ ] `getPage(2, 50)` returns the remaining 23 entries with `hasNext: false, hasPrevious: true`.
- [ ] `getPage(99, 50)` (out-of-range) returns `entries: [], hasNext: false, hasPrevious: true, currentPage: 99`.
- [ ] `pageSize: 500` is clamped to 200; `pageSize: 0` is clamped to 1.
- [ ] Filter `{ operatorId: 'alice' }` returns only entries where `operatorId === 'alice'`. Filter `{ action: 'kill' }` matches `kill-switch.engage` AND `kill-switch.reset` (case-insensitive substring).
- [ ] Filter `{ startDate: '2026-04-01', endDate: '2026-04-15' }` excludes entries before April 1 and after April 15.
- [ ] A malformed JSONL line (e.g. `{not valid`) is skipped with a single `console.warn`; `totalCount` excludes it.
- [ ] When the file is missing, `getPage()` returns `{ entries: [], totalCount: 0, integrityStatus: 'error' }`.
- [ ] `integrityStatus === 'verified'` when the page slice has no gaps and all HMACs validate.
- [ ] `integrityStatus === 'warning'` when the page slice has sequence gaps but HMACs validate for the present entries.
- [ ] `integrityStatus === 'error'` when ANY HMAC in the page slice fails validation; `integrityDetail.firstFailingSequence` matches the corrupted entry.
- [ ] `integrityStatus === 'unknown'` when filtering produces a non-contiguous slice OR the verification key is unreadable.
- [ ] `formatEntry` returns `severity: 'critical'` for `kill-switch.engage`, `'warning'` for `kill-switch.reset`, and `'info'` for an approval entry.
- [ ] `formatEntry.relativeTime` for `now - timestamp = 5 minutes` returns `"5m ago"`; for 25 hours returns `"1d ago"`.
- [ ] `GET /audit?page=2&operatorId=alice` renders the audit page with filtered + paginated entries; the pagination links preserve `operatorId=alice` in the querystring.
- [ ] When the request has header `HX-Request: true` AND `HX-Target: audit-content`, only the entries-and-pagination fragment is returned (no full HTML document).
- [ ] `GET /audit?startDate=not-a-date` returns 400 with `{ error: 'INVALID_DATE' }`.
- [ ] `audit-verify <good-log>` exits 0 and prints a summary with `entries: N, gaps: 0, hmac_failures: 0`.
- [ ] `audit-verify <log-with-tampered-entry>` exits 2 and reports the first failing sequence.
- [ ] `audit-verify <log-with-missing-key>` exits 2 with stderr message `"audit-verify: HMAC key not readable"`.
- [ ] `audit-verify --json <log>` prints exactly one JSON object to stdout; the object parses cleanly with `JSON.parse`.
- [ ] `audit-verify --help` exits 0 with the documented usage text.

## Dependencies

- SPEC-014-3-03: `AuditEntry` schema, `verifyEntry(entry, prev)`, HMAC key file location, sequence-gap detection primitives.
- PLAN-014-2: CSRF middleware (read-only `GET /audit` does not require CSRF, but the filter form does include the token to align with portal patterns).
- SPEC-015-4-03 (sibling): `staleBanner` injection middleware.
- PLAN-013-3: Hono routing, `c.html()`, HTMX header conventions (`HX-Request`, `HX-Target`, `hx-push-url`).
- Existing `layouts/base.hbs` template engine.

## Notes

- Streaming line-read is non-negotiable for files >50 MB. `readFile` would have made this spec faster to implement but would balloon memory under realistic audit retention windows.
- Sorting DESC for display is independent from the on-disk ASC ordering — the verifier always walks ASC to validate the chain.
- `integrityStatus = 'unknown'` for non-contiguous filtered output is intentional: it tells the operator "we cannot prove this filtered subset is unbroken; for chain proof, run `audit-verify` against the raw log."
- The CLI's `--json` mode is the integration point for nightly cron jobs that page operators on integrity drift; SPEC-015-4-04 covers the exit-code contract under test.
- Pagination uses standard offset/limit math, not cursor pagination. With 50/page and ~10K entries, deep pages cost ≤ one full file scan; acceptable for an internal admin page. Cursor pagination becomes worth implementing only past 100K entries.
