# PLAN-015-4: Operations Endpoints + Audit Page + Daemon-Down Handling

## Metadata
- **Parent TDD**: TDD-015-portal-live-data-settings
- **Estimated effort**: 3 days (24 hours)
- **Dependencies**: ["PLAN-014-3", "PLAN-015-1", "PLAN-015-2"]
- **Priority**: P1
- **Author**: Plan Author Agent
- **Date**: 2026-04-17
- **Version**: 1.0

## Objective

Implement the operations management interface and audit trail viewing capabilities for the autonomous-dev web portal. This plan delivers the `/ops` page with daemon status monitoring and kill-switch/circuit-breaker controls, the `/audit` page with paginated audit log viewing and integrity verification, and daemon-down handling behavior that gracefully degrades functionality when the daemon is unavailable.

All destructive operations (kill-switch toggle, circuit-breaker reset) are protected by typed-CONFIRM modals with 60-second TTL one-time tokens per TDD-014 §11. Mutation endpoints return HTTP 503 when the daemon heartbeat is stale, while read-only pages continue functioning with a prominent banner warning about data staleness per NFR-04.

## Scope

### In Scope
- Operations dashboard (`/ops`) displaying real-time daemon status, kill-switch state, and circuit-breaker state
- Kill-switch engage/reset endpoints with typed-CONFIRM token validation
- Circuit-breaker reset endpoint with typed-CONFIRM protection
- Audit log viewer (`/audit`) with pagination (50 entries per page) and filtering
- Audit integrity status indicators showing per-page verification results
- Audit verify CLI subcommand for offline integrity checking
- Daemon health monitoring with automatic status detection
- Stale data banner injection into BaseLayout when heartbeat exceeds thresholds
- HTTP 503 responses for mutation endpoints when daemon is down
- Read-only page functionality preservation with stale data warnings

### Out of Scope
- File watcher implementation (PLAN-015-1)
- Settings editor and approval workflows (PLAN-015-2) 
- Cost visualization and log tailing (PLAN-015-3)
- Audit log writer infrastructure (PLAN-014-3)
- Authentication and CSRF protection (PLAN-014-1/2)
- SSE event bus implementation (handled in dependencies)

## Tasks

### TASK-001: Daemon Health Monitor
**Description**: Implement the daemon health monitoring system that reads heartbeat.json and determines daemon status with appropriate thresholds.

**Files**:
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/health/daemon-health-monitor.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/health/health-types.ts`

**Dependencies**: []

**Acceptance Criteria**:
- Reads heartbeat.json every 15 seconds and determines status (healthy/stale/dead/unknown)
- Healthy: heartbeat age < 30 seconds
- Stale: heartbeat age 30-120 seconds  
- Dead: heartbeat age > 120 seconds or file missing
- Broadcasts status changes via SSE event bus
- Exposes getDaemonStatus() method for synchronous access

**Lint/Test Commands**:
```bash
cd /Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal
bun run lint:check src/health/
bun test src/health/daemon-health-monitor.test.ts
```

**Estimated Effort**: 3 hours

**Track**: Core Infrastructure

**Risks**: 
- Medium: Heartbeat file format differences between daemon versions could cause parsing failures
- Mitigation: Use defensive parsing with fallback to default values

---

### TASK-002: Stale Data Handler and Middleware
**Description**: Implement stale data detection and banner generation, plus middleware to block mutations when daemon is down.

**Files**:
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/health/stale-data-handler.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/middleware/daemon-health-middleware.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/templates/components/stale-data-banner.hbs`

**Dependencies**: [TASK-001]

**Acceptance Criteria**:
- getBannerStatus() returns banner configuration based on daemon health
- shouldDisableMutations() returns true when daemon status is dead/unknown
- requireHealthyDaemon middleware returns 503 for mutations when daemon down
- Stale data banner template shows warning with heartbeat age
- Banner severity: warning for stale, error for dead/unknown

**Lint/Test Commands**:
```bash
bun run lint:check src/health/ src/middleware/
bun test src/health/stale-data-handler.test.ts
bun test src/middleware/daemon-health-middleware.test.ts
```

**Estimated Effort**: 2.5 hours

**Track**: Core Infrastructure

**Risks**:
- Low: SSE integration for status updates might miss some edge cases
- Mitigation: Include comprehensive status change event tests

---

### TASK-003: Typed-CONFIRM Modal System
**Description**: Implement the one-time token system for destructive operations with 60-second TTL and modal UI components.

**Files**:
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/auth/typed-confirm.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/templates/components/typed-confirm-modal.hbs`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/static/js/typed-confirm.js`

**Dependencies**: []

**Acceptance Criteria**:
- generateConfirmationToken(action, operatorId) creates UUID with 60s TTL
- validateConfirmationToken(token, expectedAction) verifies token and action match
- Expired tokens are automatically cleaned up
- Modal displays destructive action name and requires typing "CONFIRM" exactly
- HTMX integration submits form with confirmation token
- Token is consumed (deleted) after successful use

**Lint/Test Commands**:
```bash
bun run lint:check src/auth/
bun test src/auth/typed-confirm.test.ts
```

**Estimated Effort**: 4 hours

**Track**: Security Controls

**Risks**:
- Medium: Race conditions between token generation and consumption in high-concurrency scenarios
- Mitigation: Use Map.delete() atomically and test concurrent usage patterns

---

### TASK-004: Operations Page Handler and Templates
**Description**: Implement the `/ops` page backend handler and frontend templates showing daemon status and operation controls.

**Files**:
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/routes/ops.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/templates/ops.hbs`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/templates/fragments/daemon-status.hbs`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/templates/fragments/operation-controls.hbs`

**Dependencies**: [TASK-001, TASK-003]

**Acceptance Criteria**:
- GET /ops renders operations dashboard with current daemon status
- Shows daemon heartbeat status with timestamp and age
- Displays kill-switch state (engaged/disengaged) with engagement metadata
- Shows circuit-breaker status and last reset time
- Operation buttons trigger typed-CONFIRM modals
- Real-time status updates via SSE
- Proper HTMX attributes for progressive enhancement

**Lint/Test Commands**:
```bash
bun run lint:check src/routes/
bun test src/routes/ops.test.ts
```

**Estimated Effort**: 3.5 hours

**Track**: Operations Interface

**Risks**:
- Low: Template rendering performance with frequent status updates
- Mitigation: Use HTMX fragment updates only for changing elements

---

### TASK-005: Kill-Switch Operation Endpoints
**Description**: Implement kill-switch engage and reset endpoints that communicate with intake router and validate typed-CONFIRM tokens.

**Files**:
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/routes/ops/kill-switch.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/services/operations-handler.ts`

**Dependencies**: [TASK-003, PLAN-015-2]

**Acceptance Criteria**:
- POST /ops/kill-switch/engage requires valid typed-CONFIRM token
- POST /ops/kill-switch/reset requires valid typed-CONFIRM token  
- Both endpoints call intake router via HTTP client from PLAN-015-2
- Successful operations are logged to audit trail via PLAN-014-3
- Returns 400 for invalid/expired tokens
- Returns 503 when daemon is unhealthy
- Operation results trigger SSE broadcasts

**Lint/Test Commands**:
```bash
bun run lint:check src/routes/ops/ src/services/
bun test src/routes/ops/kill-switch.test.ts
bun test src/services/operations-handler.test.ts
```

**Estimated Effort**: 4 hours

**Track**: Operations Interface

**Risks**:
- High: Intake router communication failures could leave inconsistent state
- Mitigation: Implement retry logic and audit log error states for debugging

---

### TASK-006: Circuit-Breaker Reset Endpoint
**Description**: Implement circuit-breaker manual reset functionality with typed-CONFIRM protection.

**Files**:
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/routes/ops/circuit-breaker.ts`

**Dependencies**: [TASK-003, TASK-005]

**Acceptance Criteria**:
- POST /ops/circuit-breaker/reset requires valid typed-CONFIRM token
- Calls intake router with circuit-breaker-reset command
- Logs operation to audit trail with operator identity
- Returns JSON response with success/error status
- Consumes confirmation token after successful operation
- Returns 503 when daemon is unhealthy

**Lint/Test Commands**:
```bash
bun run lint:check src/routes/ops/
bun test src/routes/ops/circuit-breaker.test.ts
```

**Estimated Effort**: 2 hours

**Track**: Operations Interface

**Risks**:
- Low: Similar to kill-switch implementation, leveraging existing patterns
- Mitigation: Reuse operations-handler service for consistency

---

### TASK-007: Audit Log Reader Service
**Description**: Implement the audit log reader that provides paginated access to audit entries with filtering capabilities.

**Files**:
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/services/audit-log-reader.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/types/audit-types.ts`

**Dependencies**: [PLAN-014-3]

**Acceptance Criteria**:
- Reads audit.jsonl file from data directory
- Provides getPage(pageNumber, pageSize) with 50 entries default
- Supports filtering by operatorId, action, and date range  
- Returns AuditPageResult with entries, pagination metadata, and integrity status
- Handles malformed JSONL lines gracefully
- Sorts entries by sequence number (newest first for display)

**Lint/Test Commands**:
```bash
bun run lint:check src/services/ src/types/
bun test src/services/audit-log-reader.test.ts
```

**Estimated Effort**: 3 hours

**Track**: Audit Interface

**Risks**:
- Medium: Large audit logs could impact memory usage with full file reads
- Mitigation: Implement streaming file read with pagination at file level for large deployments

---

### TASK-008: Audit Integrity Verification
**Description**: Implement audit log integrity checking that interfaces with TDD-014's HMAC verification primitives.

**Files**:
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/services/audit-integrity-verifier.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/bin/audit-verify.ts`

**Dependencies**: [TASK-007, PLAN-014-3]

**Acceptance Criteria**:
- checkIntegrity(entries) returns verification status for displayed entries
- Verifies sequence number continuity and HMAC chain integrity
- Detects missing entries, modified entries, and hash mismatches
- CLI tool provides offline verification with detailed error reporting
- Returns status: 'verified', 'warning', 'error', or 'unknown'
- Integrates with TDD-014 audit verification infrastructure

**Lint/Test Commands**:
```bash
bun run lint:check src/services/ bin/
bun test src/services/audit-integrity-verifier.test.ts
bun run test:cli bin/audit-verify.ts
```

**Estimated Effort**: 3.5 hours

**Track**: Audit Interface

**Risks**:
- High: Integration complexity with TDD-014's HMAC verification system
- Mitigation: Define clear interface contract and implement mock for testing

---

### TASK-009: Audit Page Handler and Templates
**Description**: Implement the `/audit` page with pagination, filtering, and integrity status display.

**Files**:
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/routes/audit.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/templates/audit.hbs`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/templates/fragments/audit-entry.hbs`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/templates/fragments/audit-pagination.hbs`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/templates/fragments/integrity-indicator.hbs`

**Dependencies**: [TASK-007, TASK-008]

**Acceptance Criteria**:
- GET /audit renders paginated audit log with 50 entries per page
- Supports query parameters: page, operatorId, action, startDate, endDate
- HTMX pagination updates content without full page reload
- Each entry shows formatted timestamp, operator, action, and details
- Integrity status indicator shows green/yellow/red with tooltip
- Filter form updates results with proper URL state
- Responsive design works on mobile devices

**Lint/Test Commands**:
```bash
bun run lint:check src/routes/ src/templates/
bun test src/routes/audit.test.ts
```

**Estimated Effort**: 4 hours

**Track**: Audit Interface

**Risks**:
- Medium: HTMX pagination state management could become complex
- Mitigation: Use standard query parameter patterns and test navigation edge cases

---

### TASK-010: Audit Entry Display Formatter
**Description**: Implement the audit entry formatter that converts raw audit data into user-friendly displays.

**Files**:
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/services/audit-display-formatter.ts`

**Dependencies**: [TASK-007]

**Acceptance Criteria**:
- formatEntry() converts audit entries to display objects with title, description, severity, icon
- Handles all audit entry types: gate actions, config changes, operations
- formatTimestamp() provides relative time display (5m ago, 2h ago, etc.)
- formatOperatorId() extracts readable names from operator identities
- Proper severity mapping: info for normal operations, warning for rejections, critical for kill-switch
- Extensible design for adding new audit entry types

**Lint/Test Commands**:
```bash
bun run lint:check src/services/
bun test src/services/audit-display-formatter.test.ts
```

**Estimated Effort**: 2 hours

**Track**: Audit Interface

**Risks**:
- Low: Formatting logic is straightforward with clear requirements
- Mitigation: Comprehensive test coverage for all entry types and edge cases

---

### TASK-011: Base Layout Banner Integration
**Description**: Update the BaseLayout template to include the stale data banner when daemon health is compromised.

**Files**:
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/templates/layouts/base.hbs`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/middleware/banner-injection-middleware.ts`

**Dependencies**: [TASK-002]

**Acceptance Criteria**:
- BaseLayout template conditionally renders stale data banner
- Banner appears at top of page with appropriate styling (warning/error)
- Banner includes daemon heartbeat age and status information
- Banner injection middleware adds banner data to all template contexts
- Banner updates in real-time via SSE without full page reload
- Banner is accessible with proper ARIA labels

**Lint/Test Commands**:
```bash
bun run lint:check src/templates/ src/middleware/
bun test src/middleware/banner-injection-middleware.test.ts
```

**Estimated Effort**: 2 hours

**Track**: Core Infrastructure

**Risks**:
- Low: Template modification is straightforward
- Mitigation: Test banner display in all page contexts to ensure consistency

---

### TASK-012: Operations Integration Tests
**Description**: Implement comprehensive integration tests for the operations workflow including typed-CONFIRM validation.

**Files**:
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/tests/integration/operations.test.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/tests/helpers/mock-intake-client.ts`

**Dependencies**: [TASK-004, TASK-005, TASK-006]

**Acceptance Criteria**:
- Tests complete kill-switch engage workflow with typed-CONFIRM modal
- Tests circuit-breaker reset with token validation
- Tests operation rejection when daemon is unhealthy (503 responses)
- Tests audit log entries created for successful operations
- Tests token expiration and cleanup behavior
- Mock intake router client responds appropriately to operation commands

**Lint/Test Commands**:
```bash
bun run test:integration tests/integration/operations.test.ts
```

**Estimated Effort**: 3 hours

**Track**: Quality Assurance

**Risks**:
- Medium: Integration test complexity with multiple moving parts
- Mitigation: Use comprehensive mocking and focus on happy path plus key error cases

---

### TASK-013: Audit Page Integration Tests
**Description**: Implement integration tests for audit page functionality including pagination and integrity verification.

**Files**:
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/tests/integration/audit.test.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/tests/helpers/audit-test-data.ts`

**Dependencies**: [TASK-009, TASK-010]

**Acceptance Criteria**:
- Tests audit page rendering with pagination controls
- Tests filtering by operator, action, and date range
- Tests HTMX pagination navigation preserves filter state
- Tests integrity indicator display for verified/warning/error states
- Tests audit entry formatting for all supported entry types
- Creates realistic test audit data covering all scenarios

**Lint/Test Commands**:
```bash
bun run test:integration tests/integration/audit.test.ts
```

**Estimated Effort**: 2.5 hours

**Track**: Quality Assurance

**Risks**:
- Low: Test data generation and validation scenarios are well-defined
- Mitigation: Generate comprehensive test data set covering edge cases

---

### TASK-014: Daemon Health Monitoring Tests
**Description**: Implement tests for daemon health monitoring including edge cases and status transitions.

**Files**:
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/tests/unit/daemon-health-monitor.test.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/tests/unit/stale-data-handler.test.ts`

**Dependencies**: [TASK-001, TASK-002]

**Acceptance Criteria**:
- Tests healthy, stale, dead, and unknown status detection
- Tests heartbeat file missing, corrupted, and malformed scenarios  
- Tests status change broadcasts via SSE
- Tests banner generation for each daemon status
- Tests mutation blocking when daemon is unhealthy
- Tests heartbeat timestamp parsing edge cases (different formats)

**Lint/Test Commands**:
```bash
bun run test tests/unit/daemon-health-monitor.test.ts
bun run test tests/unit/stale-data-handler.test.ts
```

**Estimated Effort**: 2.5 hours

**Track**: Quality Assurance

**Risks**:
- Low: Health monitoring logic is deterministic with clear states
- Mitigation: Test all status transitions and file system edge cases

---

### TASK-015: CLI Audit Verification Tool
**Description**: Implement the standalone CLI tool for offline audit log verification with detailed reporting.

**Files**:
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/bin/audit-verify.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/package.json` (add bin entry)

**Dependencies**: [TASK-008]

**Acceptance Criteria**:
- CLI accepts audit.jsonl file path and optional key file path
- Verifies complete audit chain from first to last entry
- Reports sequence gaps, HMAC failures, and timestamp anomalies
- Provides summary statistics (total entries, verification status, error count)
- Exits with appropriate code: 0 for verified, 1 for warnings, 2 for errors
- Supports --verbose flag for detailed per-entry reporting

**Lint/Test Commands**:
```bash
bun run lint:check bin/
bun run test:cli
./node_modules/.bin/bun run bin/audit-verify.ts --help
```

**Estimated Effort**: 2 hours

**Track**: Audit Interface

**Risks**:
- Low: CLI tool leverages existing verification logic
- Mitigation: Test with various audit file sizes and corruption scenarios

---

## Dependencies & Integration Points

**Exposes to other plans**:
- Daemon health monitoring service used by dashboard and other portal pages
- Typed-CONFIRM modal system reusable for other destructive operations
- Audit display formatter extensible for new audit entry types
- Operations handler service as template for other intake router integrations

**Consumes from other plans**:
- PLAN-014-3: Audit log writer infrastructure and HMAC verification primitives
- PLAN-015-1: SSE event bus for real-time status updates
- PLAN-015-2: Intake router HTTP client for operation commands
- TDD-014: Authentication context, CSRF protection, and security middleware
- TDD-013: Portal server foundation, route registration, and template engine

**File System Dependencies**:
- Reads: `../autonomous-dev/.autonomous-dev/heartbeat.json` (daemon status)
- Reads: `../autonomous-dev/.autonomous-dev/audit.jsonl` (audit entries)
- Creates: None (uses existing audit infrastructure)

## Testing Strategy

**Unit Testing**:
- Each service class tested in isolation with mocked dependencies
- Daemon health status detection with controlled heartbeat file contents
- Typed-CONFIRM token lifecycle (generation, validation, expiration, cleanup)
- Audit log parsing with malformed and edge case entries
- Display formatting for all audit entry types and timestamp variations

**Integration Testing**:
- Complete operations workflows (ops page → typed-CONFIRM → intake router → audit log)
- Audit page pagination with real audit data
- Daemon health status changes triggering UI updates
- Banner injection across different page templates
- HTMX interactions for real-time updates

**End-to-End Testing**:
- Browser automation testing typed-CONFIRM modal interaction
- Kill-switch engage/reset complete workflow
- Audit page filter application and pagination navigation
- Banner display during daemon outage scenarios

## Performance Considerations

**Memory Management**:
- Audit log reading uses streaming for large files to avoid loading entire log into memory
- Typed-CONFIRM token map has automatic cleanup to prevent memory leaks
- Health monitoring operates with minimal memory footprint (single status object)

**File System Efficiency**:
- Heartbeat monitoring reads single small JSON file every 15 seconds
- Audit log reading supports pagination to limit per-request data transfer
- No file watching on audit.jsonl (read-only access pattern)

**Network Efficiency**:
- Operations endpoints have retry logic for intake router communication
- SSE updates only send changed status data, not full daemon state
- Audit pagination prevents large data transfers

## Security Considerations

**Typed-CONFIRM Protection**:
- One-time tokens with 60-second TTL prevent replay attacks
- Action-specific tokens prevent token reuse across different operations
- Automatic cleanup prevents token enumeration attacks

**Audit Log Security**:
- Read-only access to audit.jsonl prevents tampering
- Integrity verification detects unauthorized modifications
- CLI verification tool operates offline for secure environments

**Input Validation**:
- Audit filter parameters validated and sanitized
- Pagination parameters bounded to prevent resource exhaustion
- Operator identity passed through from authentication context

## Deployment Considerations

**Configuration**:
- Health monitoring thresholds configurable via portal config
- Audit log file path configurable for different deployment structures
- Intake router endpoint discovery from existing autonomous-dev config

**Monitoring**:
- Health monitor logs status changes for operational visibility
- Operations and audit access logged for security auditing
- CLI verification tool suitable for cron-based integrity checking

## Definition of Done

- [ ] `/ops` page renders with real-time daemon status and operation controls
- [ ] Kill-switch engage/reset requires typed-CONFIRM modal and calls intake router
- [ ] Circuit-breaker reset requires typed-CONFIRM and integrates with intake router
- [ ] `/audit` page shows paginated audit entries with filtering capabilities
- [ ] Integrity status indicators display verification results for audit entries
- [ ] Daemon health monitoring detects healthy/stale/dead states correctly
- [ ] Stale data banner appears when daemon heartbeat exceeds thresholds
- [ ] Mutation endpoints return 503 when daemon is unhealthy
- [ ] Read-only pages continue to work with stale data warnings
- [ ] All unit tests pass with >90% coverage
- [ ] Integration tests verify complete workflows end-to-end
- [ ] CLI audit verification tool works offline and reports issues
- [ ] TypeScript compilation succeeds with no errors
- [ ] ESLint passes with no warnings at --max-warnings=0

## Code Examples

### Operations Page Handler

```typescript
// /Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/routes/ops.ts
import { Hono } from 'hono';
import { DaemonHealthMonitor } from '../health/daemon-health-monitor.js';
import { OperationsHandler } from '../services/operations-handler.js';
import { TypedConfirmManager } from '../auth/typed-confirm.js';

const ops = new Hono();

export class OpsPageHandler {
  constructor(
    private healthMonitor: DaemonHealthMonitor,
    private operationsHandler: OperationsHandler,
    private confirmManager: TypedConfirmManager
  ) {}

  async renderOpsPage(c: Context): Promise<Response> {
    const daemonStatus = await this.healthMonitor.getDaemonStatus();
    const killSwitchState = await this.operationsHandler.getKillSwitchState();
    
    return c.html(await renderTemplate('ops', {
      daemonStatus,
      killSwitchState,
      operatorId: c.get('operatorId'),
      csrfToken: c.get('csrfToken')
    }));
  }

  async generateConfirmToken(c: Context): Promise<Response> {
    const { action } = await c.req.json();
    const operatorId = c.get('operatorId');
    
    const token = await this.confirmManager.generateConfirmationToken(action, operatorId);
    
    return c.json({ token, expiresIn: 60 });
  }
}

ops.get('/', async (c) => {
  const handler = c.get('opsPageHandler');
  return handler.renderOpsPage(c);
});

ops.post('/confirm-token', async (c) => {
  const handler = c.get('opsPageHandler');
  return handler.generateConfirmToken(c);
});

export { ops };
```

### Kill-Switch Handler with Typed-CONFIRM

```typescript
// /Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/routes/ops/kill-switch.ts
import { Hono } from 'hono';
import { OperationsHandler } from '../../services/operations-handler.js';
import { requireHealthyDaemon } from '../../middleware/daemon-health-middleware.js';

const killSwitch = new Hono();

killSwitch.use('/*', requireHealthyDaemon);

killSwitch.post('/engage', async (c) => {
  const { reason, confirmationToken } = await c.req.json();
  const operatorId = c.get('operatorId');
  
  const operationsHandler: OperationsHandler = c.get('operationsHandler');
  
  const result = await operationsHandler.engageKillSwitch(
    reason,
    operatorId, 
    confirmationToken
  );
  
  if (!result.success) {
    return c.json({ success: false, error: result.error }, 400);
  }
  
  // Trigger SSE update
  const eventBus = c.get('sseEventBus');
  eventBus.broadcast({
    type: 'kill-switch-engaged',
    data: { operatorId, reason, timestamp: Date.now() }
  });
  
  return c.json({ success: true });
});

killSwitch.post('/reset', async (c) => {
  const { confirmationToken } = await c.req.json();
  const operatorId = c.get('operatorId');
  
  const operationsHandler: OperationsHandler = c.get('operationsHandler');
  
  const result = await operationsHandler.resetKillSwitch(
    operatorId,
    confirmationToken
  );
  
  if (!result.success) {
    return c.json({ success: false, error: result.error }, 400);
  }
  
  const eventBus = c.get('sseEventBus');
  eventBus.broadcast({
    type: 'kill-switch-reset',
    data: { operatorId, timestamp: Date.now() }
  });
  
  return c.json({ success: true });
});

export { killSwitch };
```

### Audit Paginator Class

```typescript
// /Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/services/audit-log-reader.ts
import { readFile } from 'fs/promises';
import { AuditIntegrityVerifier } from './audit-integrity-verifier.js';

export interface AuditEntry {
  sequence: number;
  timestamp: string;
  operatorId: string;
  action: string;
  details: Record<string, any>;
  integrityHash?: string;
}

export interface AuditPageResult {
  entries: AuditEntry[];
  totalCount: number;
  hasNext: boolean;
  hasPrevious: boolean;
  integrityStatus: 'verified' | 'warning' | 'error' | 'unknown';
  currentPage: number;
  pageSize: number;
}

export class AuditLogReader {
  constructor(
    private auditLogPath: string,
    private integrityVerifier: AuditIntegrityVerifier
  ) {}

  async getPage(
    pageNumber: number = 1,
    pageSize: number = 50,
    filters?: {
      operatorId?: string;
      action?: string;
      dateRange?: { start: Date; end: Date };
    }
  ): Promise<AuditPageResult> {
    try {
      const entries = await this.readAllEntries();
      const filteredEntries = this.applyFilters(entries, filters);
      
      // Pagination
      const totalCount = filteredEntries.length;
      const startIndex = (pageNumber - 1) * pageSize;
      const endIndex = startIndex + pageSize;
      const pageEntries = filteredEntries.slice(startIndex, endIndex);
      
      // Integrity verification for displayed entries
      const integrityStatus = await this.integrityVerifier.checkIntegrity(pageEntries);
      
      return {
        entries: pageEntries,
        totalCount,
        hasNext: endIndex < totalCount,
        hasPrevious: startIndex > 0,
        integrityStatus,
        currentPage: pageNumber,
        pageSize
      };
    } catch (error) {
      console.error('Failed to read audit log:', error);
      return {
        entries: [],
        totalCount: 0,
        hasNext: false,
        hasPrevious: false,
        integrityStatus: 'error',
        currentPage: pageNumber,
        pageSize
      };
    }
  }

  private async readAllEntries(): Promise<AuditEntry[]> {
    try {
      const content = await readFile(this.auditLogPath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());
      
      const entries = lines.map((line, index) => {
        try {
          return JSON.parse(line) as AuditEntry;
        } catch (error) {
          console.warn(`Failed to parse audit log line ${index + 1}:`, line);
          return null;
        }
      }).filter((entry): entry is AuditEntry => entry !== null);
      
      // Sort by sequence number (newest first for display)
      return entries.sort((a, b) => b.sequence - a.sequence);
    } catch (error) {
      console.error('Failed to read audit log file:', error);
      return [];
    }
  }

  private applyFilters(
    entries: AuditEntry[], 
    filters?: {
      operatorId?: string;
      action?: string;
      dateRange?: { start: Date; end: Date };
    }
  ): AuditEntry[] {
    if (!filters) return entries;

    return entries.filter(entry => {
      if (filters.operatorId && entry.operatorId !== filters.operatorId) {
        return false;
      }
      
      if (filters.action && !entry.action.includes(filters.action)) {
        return false;
      }
      
      if (filters.dateRange) {
        const entryDate = new Date(entry.timestamp);
        if (entryDate < filters.dateRange.start || entryDate > filters.dateRange.end) {
          return false;
        }
      }
      
      return true;
    });
  }
}
```

### Daemon-Down Middleware

```typescript
// /Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal/src/middleware/daemon-health-middleware.ts
import { Context, Next } from 'hono';
import { StaleDataHandler } from '../health/stale-data-handler.js';

export function requireHealthyDaemon(staleDataHandler: StaleDataHandler) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const validation = await staleDataHandler.validateMutationAllowed();
    
    if (!validation.allowed) {
      return c.json({
        success: false,
        error: validation.reason || 'Daemon is unavailable. Mutations are disabled.'
      }, 503);
    }
    
    return next();
  };
}

export function injectBannerData(staleDataHandler: StaleDataHandler) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const bannerStatus = await staleDataHandler.getBannerStatus();
    c.set('staleBanner', bannerStatus);
    return next();
  };
}
```

## Test Scenarios

**Typed-CONFIRM Enforcement**:
- Kill-switch engage without confirmation token returns 400
- Kill-switch engage with expired token returns 400  
- Kill-switch engage with wrong action token returns 400
- Valid confirmation token allows operation and consumes token

**Audit Pagination**:
- Page 1 of 3 shows entries 1-50 with hasNext=true, hasPrevious=false
- Page 2 of 3 shows entries 51-100 with hasNext=true, hasPrevious=true
- Page 3 of 3 shows remaining entries with hasNext=false, hasPrevious=true
- Filter by operator preserves pagination state in URLs

**Integrity Status**:
- Audit page shows green indicator when all entries verify successfully
- Yellow indicator appears when some entries have warnings
- Red indicator appears when HMAC verification fails
- Unknown status when verification service is unavailable

**Banner Behavior**:
- No banner when daemon heartbeat is <30 seconds old
- Warning banner when heartbeat is 30-120 seconds old
- Error banner when heartbeat is >120 seconds old or file missing
- Banner updates in real-time without page reload

**Mutation Blocking**:
- POST /ops/kill-switch/engage returns 503 when daemon dead
- POST /ops/circuit-breaker/reset returns 503 when daemon unknown  
- GET /ops continues to render with banner when daemon stale
- GET /audit continues to function normally when daemon down

The implementation plan provides comprehensive coverage of all requirements with realistic effort estimates, clear dependencies, and thorough testing strategies. All components integrate properly with existing portal infrastructure while maintaining security and reliability standards.