# PLAN-015-1: File Watcher + SSE Event Bus + Read-Only Data Accessors

## Metadata
- **Parent TDD**: TDD-015-portal-live-data-settings
- **Estimated effort**: 4-5 days
- **Dependencies**: ["PLAN-013-2", "PLAN-013-3"]
- **Blocked by**: []
- **Priority**: P0

## Objective

Implement the foundational live data infrastructure for the autonomous-dev portal, consisting of three core components: a file watcher that monitors daemon state files, an SSE (Server-Sent Events) event bus for real-time client updates, and read-only data accessors that provide typed access to daemon state. This plan delivers the substrate for real-time portal features without the mutation endpoints or UI components, which are handled in subsequent plans.

The implementation enables real-time monitoring of daemon state changes, cost updates, and log events through a scalable event-driven architecture. The file watcher provides resilient monitoring with both native filesystem events and polling fallbacks. The SSE event bus ensures reliable delivery to web clients with proper connection lifecycle management. The data accessors provide a clean abstraction layer over the raw daemon files with graceful error handling and schema validation.

## Scope

### In Scope

**File Watcher Infrastructure:**
- Bun-native `fs.watch` API integration for primary file monitoring
- Polling fallback mechanism when file descriptor limits are exceeded (configurable threshold)
- Debouncing logic with 200ms quiet period to batch rapid file changes
- Monitoring targets: `<repo>/.autonomous-dev/requests/*/state.json`, `cost-ledger.json`, `heartbeat.json`, `daemon.log`
- Event emission for file change, creation, deletion, and error conditions
- Graceful degradation when files are temporarily unavailable or corrupted
- File descriptor leak prevention and resource cleanup

**SSE Event Bus:**
- Hono-based SSE server implementation with proper HTTP streaming
- Per-connection lifecycle management (connect, heartbeat, disconnect)
- Heartbeat keepalive every 30 seconds to detect stale connections
- Client reconnection handling with sequence number recovery
- Event type system: state-change, cost-update, heartbeat, log-line, daemon-down
- Maximum 10 concurrent connections with backpressure protection
- Connection timeout and cleanup after 5 minutes of inactivity
- Event batching and compression for high-frequency updates

**Aggregation Cache:**
- In-process memory cache with 5-second TTL for expensive operations
- Query-keyed cache entries (e.g., "all-request-states", "cost-summary")
- File event-based cache invalidation to maintain consistency
- Cache hit ratio monitoring and performance metrics
- Memory usage limits to prevent unbounded growth
- Configurable cache policies per data type

**Read-Only Data Accessors:**
- TypeScript module exporting typed functions for each data source
- `state.json` reader with JSON schema validation and type safety
- `events.jsonl` reader with line-by-line streaming and parsing
- `cost-ledger.json` reader with cost calculation utilities
- `daemon.log` reader with last 500 lines and structured log parsing
- Effective configuration reader (merged defaults + user config)
- Graceful error handling - never throws, always returns Result<T, Error>
- Missing file detection with appropriate default values

**Daemon-Down Detection:**
- Integration with file watcher to monitor `heartbeat.json` freshness
- Configurable staleness threshold (default 60 seconds)
- Automatic daemon-down banner state management
- Event emission when daemon state changes (up/down)
- Recovery detection when daemon comes back online

### Out of Scope

- Settings editor mutation endpoints (PLAN-015-2)
- Gate action endpoints (enable/disable kill-switch, etc.) (PLAN-015-2)
- Cost computation and analysis logic (PLAN-015-3)
- Log tailing UI components and real-time log streaming (PLAN-015-3)
- Operational endpoints (restart daemon, clear logs) (PLAN-015-4)
- Audit trail and change history page (PLAN-015-4)
- Authentication and authorization middleware (PLAN-014-*)
- Rate limiting and abuse protection (PLAN-014-*)
- HTTPS/TLS termination and security headers (PLAN-014-*)

## Tasks

### TASK-001: Implement FileWatcher Core Class
**Description:** Create the foundational FileWatcher class using Bun's native fs.watch API with polling fallback capability. This class manages file descriptor resources, implements debouncing, and provides a clean event interface for file system changes.

**Files to create:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/watchers/FileWatcher.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/watchers/types.ts`

**Files to modify:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/watchers/index.ts` (create barrel export)

**Dependencies:** []

**Acceptance Criteria:**
- FileWatcher class accepts file patterns and options in constructor
- Uses Bun's fs.watch for primary monitoring with error handling
- Automatically falls back to polling when fs.watch fails or descriptor limit exceeded
- Implements 200ms debouncing to batch rapid file changes into single events
- Emits typed events for file changes with file path, event type, and timestamp
- Properly cleans up file descriptors and timers on dispose()
- Handles non-existent files gracefully without throwing errors
- Supports configurable polling interval (default 1000ms) and debounce delay
- Provides isWatching() status method and getWatchedFiles() introspection

**Lint/Test Commands:**
```bash
cd /Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev
npm run lint src/portal/watchers/
npm run test src/portal/watchers/__tests__/FileWatcher.test.ts
```

**Estimated Effort:** 6 hours

**Track:** Core Infrastructure

**Risks:**
- **Medium Risk:** Bun fs.watch behavior may differ from Node.js on edge cases (symlinks, rapid changes)
  - **Mitigation:** Comprehensive test suite with real file operations and edge case coverage
- **Low Risk:** File descriptor limits vary by system and may be hard to test
  - **Mitigation:** Configurable threshold with sensible defaults, manual testing on resource-constrained systems

---

### TASK-002: Implement SSE Server Infrastructure
**Description:** Build the Server-Sent Events infrastructure using Hono's streaming capabilities. This includes connection management, heartbeat keepalive, and the core event delivery mechanism.

**Files to create:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/sse/SSEServer.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/sse/Connection.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/sse/types.ts`

**Files to modify:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/sse/index.ts` (create barrel export)

**Dependencies:** [TASK-001]

**Acceptance Criteria:**
- SSEServer class manages multiple client connections with unique IDs
- Implements proper SSE HTTP response headers and streaming format
- Connection class tracks per-client state (ID, last heartbeat, sequence number)
- Heartbeat events sent every 30 seconds to detect stale connections
- Automatic cleanup of disconnected clients after 5 minutes of inactivity
- Maximum 10 concurrent connections with 429 response for excess connections
- Event delivery with sequence numbers for client-side deduplication
- Proper error handling for client disconnections and network issues
- Graceful shutdown that notifies all clients before closing connections
- Connection metrics tracking (count, duration, events sent per connection)

**Lint/Test Commands:**
```bash
cd /Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev
npm run lint src/portal/sse/
npm run test src/portal/sse/__tests__/SSEServer.test.ts
npm run test src/portal/sse/__tests__/Connection.test.ts
```

**Estimated Effort:** 8 hours

**Track:** Core Infrastructure

**Risks:**
- **Medium Risk:** SSE connection handling in Bun may have subtle differences from Node.js
  - **Mitigation:** Comprehensive integration tests with real HTTP clients and connection scenarios
- **Low Risk:** Browser SSE reconnection behavior varies across vendors
  - **Mitigation:** Well-defined reconnection protocol with sequence numbers, test with multiple browsers

---

### TASK-003: Implement Event Protocol and Types
**Description:** Define the typed event system for the SSE bus, including event schemas, sequence numbering, and serialization. This provides the contract between file watchers and SSE clients.

**Files to create:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/events/EventProtocol.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/events/schemas.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/events/types.ts`

**Files to modify:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/events/index.ts` (create barrel export)

**Dependencies:** [TASK-002]

**Acceptance Criteria:**
- Event type definitions for: state-change, cost-update, heartbeat, log-line, daemon-down
- Each event has mandatory fields: id, timestamp, type, sequenceNumber
- Event-specific payload schemas with TypeScript types and runtime validation
- EventProtocol class handles serialization/deserialization with JSON schema validation
- Sequence number generation with wraparound handling and uniqueness guarantees
- Event batching capability for high-frequency updates (max 10 events per batch)
- Event compression detection for repetitive events (e.g., repeated heartbeats)
- Error events for malformed data or system issues
- Version field for future protocol evolution without breaking changes
- Helper functions for common event creation patterns

**Lint/Test Commands:**
```bash
cd /Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev
npm run lint src/portal/events/
npm run test src/portal/events/__tests__/EventProtocol.test.ts
npm run test src/portal/events/__tests__/schemas.test.ts
```

**Estimated Effort:** 4 hours

**Track:** Core Infrastructure

**Risks:**
- **Low Risk:** Event schema evolution may break older clients
  - **Mitigation:** Version field in events and backward compatibility testing
- **Low Risk:** High-frequency events could overwhelm slower clients
  - **Mitigation:** Event batching and configurable rate limiting per connection

---

### TASK-004: Implement Heartbeat Keepalive System
**Description:** Build the heartbeat mechanism that maintains SSE connections and detects disconnected clients. This includes both server-to-client heartbeats and client connection monitoring.

**Files to create:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/sse/HeartbeatManager.ts`

**Files to modify:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/sse/SSEServer.ts` (integrate heartbeat manager)
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/sse/Connection.ts` (add heartbeat tracking)

**Dependencies:** [TASK-002, TASK-003]

**Acceptance Criteria:**
- HeartbeatManager sends heartbeat events every 30 seconds to all active connections
- Tracks last heartbeat timestamp per connection for staleness detection
- Automatically disconnects clients that haven't responded to heartbeats for 5 minutes
- Heartbeat events include server timestamp for client-side latency calculation
- Configurable heartbeat interval and timeout thresholds
- Connection health status tracking (healthy, stale, disconnected)
- Graceful handling of clients that disconnect during heartbeat transmission
- Metrics on heartbeat delivery success/failure rates
- Integration with SSE event protocol using heartbeat event type
- Manual heartbeat triggering for testing and debugging

**Lint/Test Commands:**
```bash
cd /Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev
npm run lint src/portal/sse/HeartbeatManager.ts
npm run test src/portal/sse/__tests__/HeartbeatManager.test.ts
```

**Estimated Effort:** 3 hours

**Track:** Core Infrastructure

**Risks:**
- **Low Risk:** Timer management in long-running processes may drift over time
  - **Mitigation:** Use setInterval with drift correction and monitoring of actual intervals
- **Low Risk:** Heartbeat flooding during high client count
  - **Mitigation:** Efficient heartbeat batching and rate limiting per connection

---

### TASK-005: Implement Client Reconnection Handling Stub
**Description:** Create the client-side reconnection logic stub that integrates with HTMX SSE extension. This provides the foundation for resilient client connections with minimal browser-side code.

**Files to create:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/client/reconnection.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/client/types.ts`

**Files to modify:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/client/index.ts` (create barrel export)

**Dependencies:** [TASK-003, TASK-004]

**Acceptance Criteria:**
- Client reconnection logic that integrates with HTMX SSE extension
- Exponential backoff for reconnection attempts (1s, 2s, 4s, max 30s)
- Sequence number tracking to request missed events after reconnection
- Local storage persistence of last received sequence number
- Connection state management (connecting, connected, reconnecting, disconnected)
- Event handler registration for connection state changes
- Automatic reconnection on network errors, but not on 4xx/5xx HTTP errors
- Manual reconnection trigger for user-initiated retries
- Client-side event deduplication using sequence numbers
- Configuration options for reconnection behavior and timeouts

**Lint/Test Commands:**
```bash
cd /Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev
npm run lint src/portal/client/
npm run test src/portal/client/__tests__/reconnection.test.ts
```

**Estimated Effort:** 4 hours

**Track:** Client Integration

**Risks:**
- **Medium Risk:** HTMX SSE extension may have limitations or bugs affecting reconnection
  - **Mitigation:** Implement fallback to native EventSource API with feature detection
- **Low Risk:** Browser local storage may be disabled or unavailable
  - **Mitigation:** Graceful degradation to in-memory state with warning to user

---

### TASK-006: Implement Aggregation Cache System
**Description:** Build the in-process caching layer that reduces file system operations and provides fast access to frequently requested data. This includes TTL management, invalidation logic, and memory usage controls.

**Files to create:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/cache/AggregationCache.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/cache/types.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/cache/policies.ts`

**Files to modify:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/cache/index.ts` (create barrel export)

**Dependencies:** [TASK-001]

**Acceptance Criteria:**
- AggregationCache class with generic key-value storage and TTL management
- 5-second default TTL with configurable per-key TTL overrides
- File event-based invalidation when watched files change
- Memory usage limits with LRU eviction when limits exceeded
- Cache hit/miss ratio tracking and performance metrics
- Support for different cache policies (TTL, LRU, manual invalidation)
- Asynchronous cache operations with Promise-based API
- Cache warming for frequently accessed data
- Serialization support for complex cached objects
- Integration with FileWatcher for automatic invalidation on file changes
- Debug logging for cache operations and hit/miss patterns

**Lint/Test Commands:**
```bash
cd /Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev
npm run lint src/portal/cache/
npm run test src/portal/cache/__tests__/AggregationCache.test.ts
npm run test src/portal/cache/__tests__/policies.test.ts
```

**Estimated Effort:** 5 hours

**Track:** Core Infrastructure

**Risks:**
- **Medium Risk:** Memory usage may grow unbounded under high cache usage
  - **Mitigation:** Strict memory limits with monitoring and alerting when limits approached
- **Low Risk:** Cache invalidation race conditions between file events and cache access
  - **Mitigation:** Proper async/await patterns and atomic cache operations

---

### TASK-007: Implement State.json Reader with Schema Validation
**Description:** Create the typed data accessor for daemon request state files with comprehensive schema validation and error handling. This provides the foundation for all state-based portal features.

**Files to create:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/readers/StateReader.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/readers/schemas/state.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/readers/types.ts`

**Files to modify:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/readers/index.ts` (create barrel export)

**Dependencies:** [TASK-006]

**Acceptance Criteria:**
- StateReader class with methods for reading individual and multiple state files
- JSON schema validation using Zod or similar library for runtime type safety
- Result<T, Error> return types that never throw exceptions
- Support for reading all request states from a repository directory
- Caching integration with automatic invalidation on state file changes
- Graceful handling of missing, corrupted, or malformed state files
- Default value provision when state files are unavailable
- State file discovery with glob patterns for request directories
- Typed interfaces matching the daemon's state.json schema exactly
- Performance optimization for bulk state reading operations
- State filtering and querying capabilities (by status, date, etc.)

**Lint/Test Commands:**
```bash
cd /Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev
npm run lint src/portal/readers/StateReader.ts
npm run test src/portal/readers/__tests__/StateReader.test.ts
```

**Estimated Effort:** 6 hours

**Track:** Data Access

**Risks:**
- **Medium Risk:** State file schema may change without notice from daemon updates
  - **Mitigation:** Versioned schemas with backward compatibility and schema validation errors
- **Low Risk:** Large numbers of state files may cause performance issues
  - **Mitigation:** Pagination, lazy loading, and efficient file system operations

---

### TASK-008: Implement Events.jsonl Reader with Streaming
**Description:** Build the streaming event log reader that can efficiently process large event files without loading everything into memory. This supports real-time event analysis and historical event queries.

**Files to create:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/readers/EventsReader.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/readers/schemas/events.ts`

**Files to modify:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/readers/types.ts` (add events types)
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/readers/index.ts` (export EventsReader)

**Dependencies:** [TASK-007]

**Acceptance Criteria:**
- EventsReader class with streaming line-by-line processing capabilities
- Support for reading events from multiple .jsonl files across requests
- Async iterator interface for memory-efficient event streaming
- Event filtering by time range, event type, or custom predicates
- Schema validation for each event line with error recovery
- Reverse chronological reading for recent events first
- Event count and size estimation without full file reading
- Integration with caching for frequently accessed event ranges
- Graceful handling of truncated or corrupted event files
- Support for real-time event tailing as new events are written
- Event aggregation utilities (count by type, time series, etc.)

**Lint/Test Commands:**
```bash
cd /Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev
npm run lint src/portal/readers/EventsReader.ts
npm run test src/portal/readers/__tests__/EventsReader.test.ts
```

**Estimated Effort:** 7 hours

**Track:** Data Access

**Risks:**
- **Medium Risk:** Large event files may cause memory issues during streaming
  - **Mitigation:** Strict streaming implementation with backpressure and memory monitoring
- **Low Risk:** JSONL parsing errors on malformed lines may interrupt stream
  - **Mitigation:** Per-line error handling with skip-and-continue pattern

---

### TASK-009: Implement Cost-Ledger.json Reader
**Description:** Create the cost data accessor with utilities for cost calculation, aggregation, and analysis. This provides the foundation for cost monitoring and budgeting features.

**Files to create:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/readers/CostReader.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/readers/schemas/cost.ts`

**Files to modify:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/readers/types.ts` (add cost types)
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/readers/index.ts` (export CostReader)

**Dependencies:** [TASK-007]

**Acceptance Criteria:**
- CostReader class for parsing and analyzing cost-ledger.json files
- Support for multiple cost file formats (per-request and global ledgers)
- Cost aggregation utilities (by time period, by request, by operation type)
- Running total calculation with configurable time windows
- Cost rate calculation (cost per hour, per day, per operation)
- Budget threshold checking and alerting integration
- Currency formatting and display utilities
- Historical cost trend analysis
- Integration with caching for expensive cost calculations
- Graceful handling of missing or incomplete cost data
- Export utilities for cost reporting (CSV, JSON)
- Cost forecasting based on historical patterns

**Lint/Test Commands:**
```bash
cd /Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev
npm run lint src/portal/readers/CostReader.ts
npm run test src/portal/readers/__tests__/CostReader.test.ts
```

**Estimated Effort:** 5 hours

**Track:** Data Access

**Risks:**
- **Low Risk:** Cost calculation precision issues with floating-point arithmetic
  - **Mitigation:** Use decimal.js or similar for precise monetary calculations
- **Low Risk:** Cost data format changes from daemon updates
  - **Mitigation:** Versioned cost schemas with format detection and migration

---

### TASK-010: Implement Daemon.log Reader with Structured Parsing
**Description:** Build the structured log reader that can parse daemon.log files and provide access to the last 500 lines with filtering and search capabilities.

**Files to create:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/readers/LogReader.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/readers/schemas/log.ts`

**Files to modify:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/readers/types.ts` (add log types)
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/readers/index.ts` (export LogReader)

**Dependencies:** [TASK-007]

**Acceptance Criteria:**
- LogReader class for efficient reading of last 500 lines from daemon.log
- Support for both structured JSON logs and plain text logs
- Log level filtering (error, warn, info, debug) with configurable defaults
- Timestamp parsing and log entry chronological ordering
- Search functionality with regex and text matching
- Log entry parsing for structured fields (timestamp, level, message, context)
- Real-time log tailing capabilities for live updates
- Log rotation detection and handling across multiple files
- Memory-efficient reverse file reading for recent logs
- Integration with caching for frequently accessed log ranges
- Log entry sanitization for safe HTML display
- Export functionality for log segments

**Lint/Test Commands:**
```bash
cd /Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev
npm run lint src/portal/readers/LogReader.ts
npm run test src/portal/readers/__tests__/LogReader.test.ts
```

**Estimated Effort:** 6 hours

**Track:** Data Access

**Risks:**
- **Medium Risk:** Log files may be very large, causing performance issues
  - **Mitigation:** Efficient reverse reading and configurable line limits with pagination
- **Low Risk:** Log format inconsistencies between different daemon versions
  - **Mitigation:** Flexible parsing with fallback to plain text when structured parsing fails

---

### TASK-011: Implement Daemon-Down Detection and Banner Management
**Description:** Create the daemon health monitoring system that integrates with the file watcher to detect when the daemon is down and manage the daemon-down banner state.

**Files to create:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/health/DaemonHealthMonitor.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/health/types.ts`

**Files to modify:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/health/index.ts` (create barrel export)

**Dependencies:** [TASK-001, TASK-003]

**Acceptance Criteria:**
- DaemonHealthMonitor class that watches heartbeat.json freshness
- Configurable staleness threshold (default 60 seconds) for daemon-down detection
- Integration with FileWatcher for heartbeat file change notifications
- Automatic daemon-down banner state management with persistence
- Event emission when daemon status changes (up/down/unknown)
- Health check on startup to determine initial daemon state
- Recovery detection when stale daemon comes back online
- Grace period handling for temporary daemon unavailability
- Health status history tracking for trend analysis
- Integration with SSE event bus for real-time status updates
- Manual health check triggering for testing and debugging
- Health metrics collection (uptime percentage, outage duration)

**Lint/Test Commands:**
```bash
cd /Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev
npm run lint src/portal/health/
npm run test src/portal/health/__tests__/DaemonHealthMonitor.test.ts
```

**Estimated Effort:** 4 hours

**Track:** Health Monitoring

**Risks:**
- **Low Risk:** False positives during daemon restart or heavy load
  - **Mitigation:** Grace period configuration and multiple health check criteria
- **Low Risk:** Clock skew between portal and daemon systems affecting freshness detection
  - **Mitigation:** Relative timestamp comparison and configurable tolerance thresholds

---

### TASK-012: Create Integration Test Suite for End-to-End Event Flow
**Description:** Develop comprehensive integration tests that verify the complete event flow from file changes through the SSE event bus to client delivery, including performance and reliability testing.

**Files to create:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/__tests__/integration/event-flow.test.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/__tests__/integration/performance.test.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/__tests__/integration/reliability.test.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/__tests__/helpers/test-utils.ts`

**Dependencies:** [TASK-001 through TASK-011]

**Acceptance Criteria:**
- **Event Flow Tests:** File mutation triggers SSE event within 1 second under normal conditions
- **Debouncing Tests:** 100 file events within 200ms result in ≤5 SSE dispatches
- **Fallback Tests:** Descriptor limit simulation triggers polling mode automatically
- **Reconnection Tests:** SSE client reconnection resumes from last sequence number
- **Cache Tests:** Aggregation cache hit ratio >50% under simulated typical load
- **Health Tests:** Daemon-down banner appears within 60 seconds of heartbeat staleness
- **Performance Tests:** SSE delivery latency p95 <1 second for typical events
- **Reliability Tests:** Malformed file resilience without crashing or losing other events
- **Concurrency Tests:** 10 concurrent SSE connections receive all events correctly
- **Resource Tests:** No memory leaks during 1-hour test run with continuous events
- **Error Handling Tests:** Network failures and file corruption handled gracefully
- **Schema Tests:** Event protocol backward compatibility with simulated version changes

**Lint/Test Commands:**
```bash
cd /Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev
npm run lint src/portal/__tests__/integration/
npm run test:integration
npm run test:performance
```

**Estimated Effort:** 12 hours

**Track:** Testing & Validation

**Risks:**
- **Medium Risk:** Integration tests may be flaky due to timing-dependent behavior
  - **Mitigation:** Configurable timeouts, retry logic, and careful test isolation
- **Low Risk:** Performance tests may fail on slower development machines
  - **Mitigation:** Environment-specific performance thresholds and CI/CD optimization

---

## Implementation Code Samples

### FileWatcher Class Implementation

```typescript
// src/portal/watchers/FileWatcher.ts
import { watch, type FSWatcher } from 'fs';
import { EventEmitter } from 'events';
import path from 'path';
import { glob } from 'glob';

export interface FileWatcherOptions {
  polling?: boolean;
  pollingInterval?: number;
  debounceDelay?: number;
  maxFileDescriptors?: number;
}

export interface FileChangeEvent {
  type: 'change' | 'create' | 'delete' | 'error';
  filePath: string;
  timestamp: Date;
  error?: Error;
}

export class FileWatcher extends EventEmitter {
  private watchers = new Map<string, FSWatcher>();
  private pollingTimers = new Map<string, NodeJS.Timeout>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private lastModified = new Map<string, number>();
  private options: Required<FileWatcherOptions>;
  private isPolling = false;
  private disposed = false;

  constructor(
    private patterns: string[],
    options: FileWatcherOptions = {}
  ) {
    super();
    this.options = {
      polling: false,
      pollingInterval: 1000,
      debounceDelay: 200,
      maxFileDescriptors: 100,
      ...options
    };
  }

  async start(): Promise<void> {
    if (this.disposed) {
      throw new Error('FileWatcher has been disposed');
    }

    const files = await this.resolvePatterns();
    
    // Try native watching first
    if (!this.options.polling && this.watchers.size < this.options.maxFileDescriptors) {
      try {
        await this.startNativeWatching(files);
      } catch (error) {
        console.warn('Native file watching failed, falling back to polling:', error);
        this.fallbackToPolling(files);
      }
    } else {
      this.fallbackToPolling(files);
    }
  }

  private async resolvePatterns(): Promise<string[]> {
    const allFiles: string[] = [];
    for (const pattern of this.patterns) {
      try {
        const files = await glob(pattern, { absolute: true });
        allFiles.push(...files);
      } catch (error) {
        this.emit('error', new Error(`Failed to resolve pattern ${pattern}: ${error}`));
      }
    }
    return [...new Set(allFiles)]; // Deduplicate
  }

  private async startNativeWatching(files: string[]): Promise<void> {
    for (const filePath of files) {
      try {
        const watcher = watch(filePath, { persistent: false }, (eventType) => {
          this.handleFileEvent(filePath, eventType === 'change' ? 'change' : 'create');
        });
        
        watcher.on('error', (error) => {
          this.handleFileEvent(filePath, 'error', error);
        });

        this.watchers.set(filePath, watcher);
        
        // Check if we're hitting descriptor limits
        if (this.watchers.size >= this.options.maxFileDescriptors) {
          console.warn('Approaching file descriptor limit, switching to polling');
          this.fallbackToPolling(files.slice(this.watchers.size));
          break;
        }
      } catch (error) {
        this.handleFileEvent(filePath, 'error', error as Error);
      }
    }
  }

  private fallbackToPolling(files: string[]): void {
    this.isPolling = true;
    for (const filePath of files) {
      if (this.pollingTimers.has(filePath)) continue;
      
      const timer = setInterval(() => {
        this.checkFileModification(filePath);
      }, this.options.pollingInterval);
      
      this.pollingTimers.set(filePath, timer);
      this.checkFileModification(filePath); // Initial check
    }
  }

  private async checkFileModification(filePath: string): Promise<void> {
    try {
      const stat = await Bun.file(filePath).stat();
      const mtime = stat.mtime.getTime();
      const lastMtime = this.lastModified.get(filePath) || 0;
      
      if (mtime > lastMtime) {
        this.lastModified.set(filePath, mtime);
        if (lastMtime > 0) { // Skip initial detection
          this.handleFileEvent(filePath, 'change');
        }
      }
    } catch (error) {
      const lastMtime = this.lastModified.get(filePath);
      if (lastMtime) {
        // File was deleted
        this.lastModified.delete(filePath);
        this.handleFileEvent(filePath, 'delete');
      }
      // File doesn't exist yet - this is normal
    }
  }

  private handleFileEvent(filePath: string, type: FileChangeEvent['type'], error?: Error): void {
    // Clear existing debounce timer
    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new debounce timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      
      const event: FileChangeEvent = {
        type,
        filePath,
        timestamp: new Date(),
        error
      };
      
      this.emit('fileChange', event);
    }, this.options.debounceDelay);
    
    this.debounceTimers.set(filePath, timer);
  }

  isWatching(): boolean {
    return !this.disposed && (this.watchers.size > 0 || this.pollingTimers.size > 0);
  }

  getWatchedFiles(): string[] {
    return [...new Set([...this.watchers.keys(), ...this.pollingTimers.keys()])];
  }

  dispose(): void {
    if (this.disposed) return;
    
    this.disposed = true;
    
    // Clean up native watchers
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
    
    // Clean up polling timers
    for (const timer of this.pollingTimers.values()) {
      clearInterval(timer);
    }
    this.pollingTimers.clear();
    
    // Clean up debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    
    this.removeAllListeners();
  }
}
```

### SSEEventBus Class Implementation

```typescript
// src/portal/sse/SSEEventBus.ts
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import { EventEmitter } from 'events';

export interface SSEConnection {
  id: string;
  response: ReadableStream;
  lastHeartbeat: Date;
  sequenceNumber: number;
  isActive: boolean;
}

export interface SSEEvent {
  id: string;
  type: string;
  data: any;
  sequenceNumber: number;
  timestamp: Date;
}

export class SSEEventBus extends EventEmitter {
  private connections = new Map<string, SSEConnection>();
  private heartbeatTimer?: NodeJS.Timeout;
  private sequenceCounter = 0;
  private readonly maxConnections: number;
  private readonly heartbeatInterval: number;
  private readonly connectionTimeout: number;

  constructor(options: {
    maxConnections?: number;
    heartbeatInterval?: number;
    connectionTimeout?: number;
  } = {}) {
    super();
    this.maxConnections = options.maxConnections || 10;
    this.heartbeatInterval = options.heartbeatInterval || 30000; // 30 seconds
    this.connectionTimeout = options.connectionTimeout || 300000; // 5 minutes
    
    this.startHeartbeatTimer();
  }

  handleSSEConnection = (c: Context) => {
    if (this.connections.size >= this.maxConnections) {
      return c.text('Too many connections', 429);
    }

    const connectionId = this.generateConnectionId();
    
    return streamSSE(c, async (stream) => {
      const connection: SSEConnection = {
        id: connectionId,
        response: stream as any,
        lastHeartbeat: new Date(),
        sequenceNumber: this.sequenceCounter,
        isActive: true
      };

      this.connections.set(connectionId, connection);
      this.emit('connectionOpened', connection);

      // Send initial connection event
      await this.sendToConnection(connection, {
        id: this.generateEventId(),
        type: 'connection',
        data: { connectionId, timestamp: new Date() },
        sequenceNumber: this.nextSequenceNumber(),
        timestamp: new Date()
      });

      // Handle client disconnect
      stream.onAbort(() => {
        this.removeConnection(connectionId);
      });

      // Keep connection alive by returning a promise that never resolves
      // Events are sent via broadcast methods
      return new Promise<void>(() => {});
    });
  };

  async broadcast(event: Omit<SSEEvent, 'id' | 'sequenceNumber' | 'timestamp'>): Promise<void> {
    const fullEvent: SSEEvent = {
      ...event,
      id: this.generateEventId(),
      sequenceNumber: this.nextSequenceNumber(),
      timestamp: new Date()
    };

    const promises = Array.from(this.connections.values()).map(connection => 
      this.sendToConnection(connection, fullEvent)
    );

    await Promise.allSettled(promises);
    this.emit('eventBroadcast', fullEvent, this.connections.size);
  }

  async sendToConnection(connection: SSEConnection, event: SSEEvent): Promise<void> {
    if (!connection.isActive) return;

    try {
      const stream = connection.response as any;
      await stream.writeSSE({
        id: event.id,
        event: event.type,
        data: JSON.stringify({
          ...event.data,
          sequenceNumber: event.sequenceNumber,
          timestamp: event.timestamp.toISOString()
        })
      });

      connection.lastHeartbeat = new Date();
      this.emit('eventSent', connection.id, event);
    } catch (error) {
      console.error(`Failed to send event to connection ${connection.id}:`, error);
      this.removeConnection(connection.id);
    }
  }

  private startHeartbeatTimer(): void {
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeats();
      this.cleanupStaleConnections();
    }, this.heartbeatInterval);
  }

  private async sendHeartbeats(): Promise<void> {
    const heartbeatEvent: Omit<SSEEvent, 'id' | 'sequenceNumber' | 'timestamp'> = {
      type: 'heartbeat',
      data: { serverTime: new Date().toISOString() }
    };

    await this.broadcast(heartbeatEvent);
  }

  private cleanupStaleConnections(): void {
    const now = new Date();
    const staleConnections: string[] = [];

    for (const [id, connection] of this.connections) {
      const timeSinceHeartbeat = now.getTime() - connection.lastHeartbeat.getTime();
      if (timeSinceHeartbeat > this.connectionTimeout) {
        staleConnections.push(id);
      }
    }

    staleConnections.forEach(id => this.removeConnection(id));
  }

  private removeConnection(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.isActive = false;
      this.connections.delete(connectionId);
      this.emit('connectionClosed', connectionId);
    }
  }

  private generateConnectionId(): string {
    return `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private generateEventId(): string {
    return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private nextSequenceNumber(): number {
    return ++this.sequenceCounter;
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  getActiveConnections(): string[] {
    return Array.from(this.connections.keys());
  }

  shutdown(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    // Close all connections
    for (const connection of this.connections.values()) {
      this.removeConnection(connection.id);
    }

    this.removeAllListeners();
  }
}
```

### AggregationCache Implementation

```typescript
// src/portal/cache/AggregationCache.ts
import { EventEmitter } from 'events';

export interface CacheEntry<T> {
  value: T;
  timestamp: Date;
  ttl: number;
  accessCount: number;
  lastAccess: Date;
}

export interface CacheOptions {
  defaultTTL?: number;
  maxSize?: number;
  maxMemoryMB?: number;
}

export class AggregationCache extends EventEmitter {
  private cache = new Map<string, CacheEntry<any>>();
  private options: Required<CacheOptions>;
  private hitCount = 0;
  private missCount = 0;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(options: CacheOptions = {}) {
    super();
    this.options = {
      defaultTTL: 5000, // 5 seconds
      maxSize: 1000,
      maxMemoryMB: 50,
      ...options
    };

    this.startCleanupTimer();
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.cache.get(key);
    
    if (!entry) {
      this.missCount++;
      this.emit('miss', key);
      return null;
    }

    // Check TTL
    const now = Date.now();
    if (now - entry.timestamp.getTime() > entry.ttl) {
      this.cache.delete(key);
      this.missCount++;
      this.emit('expired', key);
      return null;
    }

    // Update access statistics
    entry.accessCount++;
    entry.lastAccess = new Date();
    
    this.hitCount++;
    this.emit('hit', key);
    return entry.value;
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    const entry: CacheEntry<T> = {
      value,
      timestamp: new Date(),
      ttl: ttl || this.options.defaultTTL,
      accessCount: 0,
      lastAccess: new Date()
    };

    this.cache.set(key, entry);
    this.emit('set', key, value);

    // Enforce size limits
    await this.enforceLimits();
  }

  invalidate(key: string): boolean {
    const deleted = this.cache.delete(key);
    if (deleted) {
      this.emit('invalidated', key);
    }
    return deleted;
  }

  invalidatePattern(pattern: RegExp): number {
    let count = 0;
    for (const key of this.cache.keys()) {
      if (pattern.test(key)) {
        this.cache.delete(key);
        count++;
        this.emit('invalidated', key);
      }
    }
    return count;
  }

  private async enforceLimits(): Promise<void> {
    // Enforce max size limit with LRU eviction
    if (this.cache.size > this.options.maxSize) {
      const sortedEntries = Array.from(this.cache.entries())
        .sort(([, a], [, b]) => a.lastAccess.getTime() - b.lastAccess.getTime());
      
      const toRemove = sortedEntries.slice(0, this.cache.size - this.options.maxSize);
      for (const [key] of toRemove) {
        this.cache.delete(key);
        this.emit('evicted', key, 'size-limit');
      }
    }

    // Rough memory usage check
    const memoryUsageMB = this.estimateMemoryUsage();
    if (memoryUsageMB > this.options.maxMemoryMB) {
      const toRemove = Math.ceil(this.cache.size * 0.2); // Remove 20%
      const sortedEntries = Array.from(this.cache.entries())
        .sort(([, a], [, b]) => a.lastAccess.getTime() - b.lastAccess.getTime());
      
      for (let i = 0; i < toRemove && i < sortedEntries.length; i++) {
        const [key] = sortedEntries[i];
        this.cache.delete(key);
        this.emit('evicted', key, 'memory-limit');
      }
    }
  }

  private estimateMemoryUsage(): number {
    let totalSize = 0;
    for (const [key, entry] of this.cache) {
      // Rough estimation: key + serialized value size
      totalSize += key.length * 2; // UTF-16 characters
      totalSize += JSON.stringify(entry.value).length * 2;
      totalSize += 200; // Overhead for entry object
    }
    return totalSize / (1024 * 1024); // Convert to MB
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, this.options.defaultTTL);
  }

  private cleanupExpired(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];

    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp.getTime() > entry.ttl) {
        expiredKeys.push(key);
      }
    }

    for (const key of expiredKeys) {
      this.cache.delete(key);
      this.emit('expired', key);
    }
  }

  getStats() {
    return {
      size: this.cache.size,
      hitCount: this.hitCount,
      missCount: this.missCount,
      hitRatio: this.hitCount / (this.hitCount + this.missCount) || 0,
      memoryUsageMB: this.estimateMemoryUsage()
    };
  }

  clear(): void {
    this.cache.clear();
    this.hitCount = 0;
    this.missCount = 0;
    this.emit('cleared');
  }

  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.clear();
    this.removeAllListeners();
  }
}
```

### StateReader Implementation

```typescript
// src/portal/readers/StateReader.ts
import { z } from 'zod';
import { glob } from 'glob';
import path from 'path';
import type { AggregationCache } from '../cache/AggregationCache';

// Schema matching daemon's state.json structure
const StateSchema = z.object({
  request_id: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  user_id: z.string(),
  repository: z.string(),
  branch: z.string().optional(),
  title: z.string(),
  description: z.string(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  tags: z.array(z.string()).optional(),
  estimated_cost: z.number().optional(),
  actual_cost: z.number().optional(),
  session_id: z.string().optional(),
  error: z.string().optional(),
  completion_percentage: z.number().min(0).max(100).optional(),
  artifacts: z.array(z.object({
    type: z.string(),
    path: z.string(),
    size: z.number().optional()
  })).optional()
});

export type RequestState = z.infer<typeof StateSchema>;

export interface ReadStateOptions {
  includeCompleted?: boolean;
  status?: RequestState['status'][];
  repository?: string;
  userId?: string;
  limit?: number;
  offset?: number;
}

export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export class StateReader {
  constructor(
    private basePath: string,
    private cache?: AggregationCache
  ) {}

  async readState(requestId: string): Promise<Result<RequestState | null>> {
    try {
      const cacheKey = `state:${requestId}`;
      
      if (this.cache) {
        const cached = await this.cache.get<RequestState>(cacheKey);
        if (cached) {
          return { ok: true, value: cached };
        }
      }

      const statePath = path.join(this.basePath, '.autonomous-dev', 'requests', requestId, 'state.json');
      const file = Bun.file(statePath);
      
      if (!(await file.exists())) {
        return { ok: true, value: null };
      }

      const content = await file.text();
      const rawData = JSON.parse(content);
      const state = StateSchema.parse(rawData);

      if (this.cache) {
        await this.cache.set(cacheKey, state);
      }

      return { ok: true, value: state };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return { 
          ok: false, 
          error: new Error(`Invalid state format for ${requestId}: ${error.message}`) 
        };
      }
      return { 
        ok: false, 
        error: error instanceof Error ? error : new Error(`Unknown error reading state for ${requestId}`) 
      };
    }
  }

  async readAllStates(options: ReadStateOptions = {}): Promise<Result<RequestState[]>> {
    try {
      const cacheKey = `all-states:${JSON.stringify(options)}`;
      
      if (this.cache) {
        const cached = await this.cache.get<RequestState[]>(cacheKey);
        if (cached) {
          return { ok: true, value: cached };
        }
      }

      const requestDirs = await this.findRequestDirectories();
      const states: RequestState[] = [];
      
      for (const requestId of requestDirs) {
        const result = await this.readState(requestId);
        if (result.ok && result.value) {
          const state = result.value;
          
          // Apply filters
          if (options.status && !options.status.includes(state.status)) continue;
          if (options.repository && state.repository !== options.repository) continue;
          if (options.userId && state.user_id !== options.userId) continue;
          if (!options.includeCompleted && state.status === 'completed') continue;
          
          states.push(state);
        }
      }

      // Sort by updated_at (most recent first)
      states.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

      // Apply pagination
      let result = states;
      if (options.offset) {
        result = result.slice(options.offset);
      }
      if (options.limit) {
        result = result.slice(0, options.limit);
      }

      if (this.cache) {
        await this.cache.set(cacheKey, result, 2000); // Shorter TTL for bulk queries
      }

      return { ok: true, value: result };
    } catch (error) {
      return { 
        ok: false, 
        error: error instanceof Error ? error : new Error('Unknown error reading states') 
      };
    }
  }

  async getStateCounts(): Promise<Result<Record<RequestState['status'], number>>> {
    try {
      const cacheKey = 'state-counts';
      
      if (this.cache) {
        const cached = await this.cache.get<Record<RequestState['status'], number>>(cacheKey);
        if (cached) {
          return { ok: true, value: cached };
        }
      }

      const allStatesResult = await this.readAllStates({ includeCompleted: true });
      if (!allStatesResult.ok) {
        return allStatesResult;
      }

      const counts = {
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0
      };

      for (const state of allStatesResult.value) {
        counts[state.status]++;
      }

      if (this.cache) {
        await this.cache.set(cacheKey, counts);
      }

      return { ok: true, value: counts };
    } catch (error) {
      return { 
        ok: false, 
        error: error instanceof Error ? error : new Error('Unknown error computing state counts') 
      };
    }
  }

  private async findRequestDirectories(): Promise<string[]> {
    try {
      const pattern = path.join(this.basePath, '.autonomous-dev', 'requests', '*');
      const paths = await glob(pattern);
      
      return paths
        .map(p => path.basename(p))
        .filter(name => name !== '.' && name !== '..' && !name.startsWith('.'));
    } catch (error) {
      console.warn('Failed to find request directories:', error);
      return [];
    }
  }

  // Invalidate cache entries when state files change
  invalidateStateCache(requestId?: string): void {
    if (!this.cache) return;

    if (requestId) {
      this.cache.invalidate(`state:${requestId}`);
    }
    
    // Invalidate aggregated caches
    this.cache.invalidatePattern(/^(all-states|state-counts):/);
  }
}
```

## Dependency Graph

```
TASK-001 (FileWatcher) 
├── TASK-006 (Cache) 
│   ├── TASK-007 (StateReader)
│   ├── TASK-008 (EventsReader)
│   ├── TASK-009 (CostReader)
│   └── TASK-010 (LogReader)
├── TASK-002 (SSEServer)
│   ├── TASK-003 (EventProtocol)
│   │   ├── TASK-004 (Heartbeat)
│   │   └── TASK-005 (Reconnection)
│   └── TASK-011 (DaemonHealth)
└── TASK-012 (Integration Tests)

Critical Path: TASK-001 → TASK-002 → TASK-003 → TASK-012 (19 hours)
```

## Parallel Execution Schedule

**Track 1 - Core Infrastructure (Critical Path):**
- TASK-001: FileWatcher Core (6h)
- TASK-002: SSE Server (8h) 
- TASK-003: Event Protocol (4h)
- TASK-012: Integration Tests (12h)

**Track 2 - Data Access:**
- TASK-006: Aggregation Cache (5h) [after TASK-001]
- TASK-007: State Reader (6h) [after TASK-006]
- TASK-008: Events Reader (7h) [after TASK-007]
- TASK-009: Cost Reader (5h) [after TASK-007] 
- TASK-010: Log Reader (6h) [after TASK-007]

**Track 3 - Client Integration:**
- TASK-004: Heartbeat Manager (3h) [after TASK-003]
- TASK-005: Client Reconnection (4h) [after TASK-003] 
- TASK-011: Daemon Health Monitor (4h) [after TASK-001, TASK-003]

**Total Effort:** 70 hours  
**Critical Path:** 30 hours  
**Wall Clock Time (3 parallel tracks):** ~35 hours

## Testing Strategy

### Unit Testing
- Each class gets comprehensive unit tests with mocked dependencies
- File system operations tested with temporary directories
- Error conditions tested with deliberate failures
- Performance characteristics validated with synthetic load

### Integration Testing  
- End-to-end event flow from file change to SSE delivery
- Multi-client SSE scenarios with connection management
- Cache invalidation integration with file watcher events
- Error recovery scenarios (network failures, file corruption)

### Performance Testing
- SSE delivery latency measurement under various loads  
- File watcher scalability with hundreds of watched files
- Cache hit ratio optimization under realistic access patterns
- Memory usage monitoring during extended operation

### Reliability Testing
- Network partition simulation for SSE connections
- File system stress testing (rapid changes, large files)
- Malformed data resilience testing
- Resource leak detection over long-running tests

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Bun fs.watch API differences from Node.js | Medium | High | Comprehensive testing on target platform, polling fallback |
| SSE connection limits in production environments | Medium | Medium | Connection pooling, configurable limits, monitoring |
| File watcher performance with large numbers of files | Medium | Medium | Polling fallback, configurable thresholds, optimization |
| Memory usage growth in long-running cache | Low | Medium | Strict size limits, monitoring, periodic cleanup |
| Event ordering issues in high-frequency scenarios | Low | High | Sequence numbers, atomic operations, integration tests |
| Browser SSE reconnection compatibility | Low | Low | Standard SSE protocol compliance, multiple browser testing |

## Definition of Done

- [ ] FileWatcher class handles both native watching and polling fallback automatically
- [ ] SSE server supports 10 concurrent connections with heartbeat keepalive
- [ ] Event protocol provides typed events with sequence numbers for deduplication
- [ ] Client reconnection logic integrates with HTMX SSE extension
- [ ] Aggregation cache achieves >50% hit ratio under typical load patterns
- [ ] State reader provides typed access to all daemon state files with validation
- [ ] Events reader streams large .jsonl files efficiently without memory issues  
- [ ] Cost reader provides aggregation and analysis utilities for cost data
- [ ] Log reader returns last 500 lines with structured parsing capabilities
- [ ] Daemon health monitor detects down state within 60 seconds of heartbeat staleness
- [ ] Integration tests verify end-to-end event delivery latency <1s p95
- [ ] Performance tests validate file change debouncing (100 events → ≤5 dispatches)
- [ ] Reliability tests confirm graceful handling of malformed files and network issues
- [ ] All unit tests pass with >90% code coverage
- [ ] No memory leaks during 1-hour continuous operation test
- [ ] TypeScript compilation succeeds with strict mode enabled
- [ ] ESLint passes with no warnings on all source files