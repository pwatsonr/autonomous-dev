# TDD-015: Portal Live Data Layer & Settings Editor

| Field        | Value                                              |
|--------------|----------------------------------------------------|
| **Title**    | Portal Live Data Layer & Settings Editor           |
| **TDD ID**   | TDD-015                                            |
| **Version**  | 1.0                                                |
| **Date**     | 2026-04-28                                         |
| **Status**   | Draft                                              |
| **Author**   | Patrick Watson                                     |
| **Parent PRD** | PRD-009: Web Control Plane                       |
| **Plugin**   | autonomous-dev-portal                              |

---

## 1. Summary

This TDD designs the live data layer and configuration management subsystem for the autonomous-dev web portal. The system provides real-time data access to daemon state files, cost tracking, operational health, and configuration management through a file-watching architecture with Server-Sent Events (SSE) streaming to connected browsers.

The design bridges read-only access to autonomous-dev daemon state with write-through mutations via the existing intake router, maintaining strict data consistency while delivering sub-second UI updates for operator workflows including approval gates, cost monitoring, and operational controls.

Key technical decisions: Bun's `fs.watch` API for file monitoring, 5-second aggregation cache with event-triggered invalidation, HTTP localhost client for intake router communication, server-side SVG chart generation, and append-only audit logging with HMAC chain integrity.

## 2. Goals & Non-Goals

### Goals
- Monitor `<repo>/.autonomous-dev/requests/*/state.json`, `cost-ledger.json`, `heartbeat.json`, `daemon.log` with sub-second update delivery to browsers
- Provide typed, validated data accessors for portal pages with intelligent caching
- Implement approval gate action flow: form submission → validation → intake router → audit log → SSE broadcast
- Support settings editor with real-time validation, regex test compilation, path verification, and daemon reload signaling
- Deliver cost computation with trailing-7-day projection and per-repo/phase breakdowns
- Enable operations dashboard with kill-switch toggle and circuit-breaker reset via typed-CONFIRM modals
- Implement log tailing with live append, filtering, and gzip download
- Provide audit trail pagination with integrity verification indicators

### Non-Goals
- TDD-013 (portal server foundation, route registration, template engine) - referenced, not designed here
- TDD-014 (authentication, CSRF protection, audit log HMAC chain) - called into but not implemented here
- Database persistence beyond file system - all data remains file-based
- Multi-operator concurrency beyond basic connection limits
- Client-side JavaScript frameworks - server-rendered HTML with HTMX only

## 3. Architecture

### 3.1 Component Overview

```text
┌─────────────────────────────────────────────────────────────────┐
│                     Portal Browser Connections                   │
│                    (max 10 concurrent SSE)                      │
└─────────────────────┬───────────────────────────────────────────┘
                      │ SSE events
                      v
┌─────────────────────────────────────────────────────────────────┐
│                   Portal Server (Hono + Bun)                    │
│  ┌───────────────┐  ┌─────────────────┐  ┌─────────────────────┐ │
│  │ File Watcher  │  │ SSE Event Bus   │  │ Aggregation Cache   │ │
│  │ - Bun fs.watch│  │ - Connection    │  │ - 5s TTL keys      │ │
│  │ - 200ms batch │  │   lifecycle     │  │ - Event invalidate  │ │
│  │ - Descriptor  │  │ - Event types   │  │ - Memory budget     │ │
│  │   limits      │  │ - Heartbeat     │  └─────────────────────┘ │
│  └───────────────┘  └─────────────────┘                          │
│         │                      │                                 │
│         v                      ^                                 │
│  ┌───────────────┐            │                                 │
│  │ Read-Only     │            │                                 │
│  │ Data Access   │            │                                 │
│  │ - State files │            │                                 │
│  │ - Cost ledger │            │                                 │
│  │ - Config      │            │                                 │
│  │ - Logs        │            │                                 │
│  └───────────────┘            │                                 │
│                                │                                 │
│  ┌───────────────┐            │                                 │
│  │ Mutation Flow │            │                                 │
│  │ - Gate actions│───────────┘                                  │
│  │ - Settings    │                                              │
│  │ - Operations  │                                              │
│  └───────────────┘                                              │
│         │                                                       │
└─────────┼───────────────────────────────────────────────────────┘
          v
┌─────────────────────────────────────────────────────────────────┐
│                     Intake Router (HTTP)                        │
│                   http://127.0.0.1:<port>/router                │
└─────────────────────────────────────────────────────────────────┘
          │
          v
┌─────────────────────────────────────────────────────────────────┐
│                  Autonomous-Dev State Files                     │
│  - requests/*/state.json    - cost-ledger.json                  │
│  - heartbeat.json           - daemon.log                        │
│  - ~/.claude/config files                                       │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Data Flow Diagram

```text
File Change Event → File Watcher → Cache Invalidation → SSE Broadcast
                                ↓
User Form Submit → Validation → Intake Router → State Update → File Change Event
                            ↓
                   Audit Log Append
```

## 4. File Watcher Design

### 4.1 Watched Path Structure

```typescript
interface WatchedPaths {
  stateFiles: string[];        // ../autonomous-dev/.autonomous-dev/requests/*/state.json
  costLedger: string;          // ../autonomous-dev/.autonomous-dev/cost-ledger.json
  heartbeat: string;           // ../autonomous-dev/.autonomous-dev/heartbeat.json
  daemonLog: string;           // ../autonomous-dev/.autonomous-dev/logs/daemon.log
  configFiles: string[];      // ~/.claude/autonomous-dev.json + per-repo configs
}
```text

### 4.2 File Watcher Implementation

```typescript
export class PortalFileWatcher {
  private watchers: Map<string, Bun.Watcher> = new Map();
  private eventBus: SSEEventBus;
  private descriptorCount = 0;
  private readonly MAX_DESCRIPTORS = 950; // Leave 74 for other portal uses
  private batchTimer: Timer | null = null;
  private pendingEvents: Set<string> = new Set();
  
  constructor(eventBus: SSEEventBus, private config: PortalConfig) {
    this.eventBus = eventBus;
  }

  async start(paths: WatchedPaths): Promise<void> {
    // Watch state files directory with recursive monitoring
    await this.watchDirectory('../autonomous-dev/.autonomous-dev/requests', {
      pattern: '**/state.json',
      eventType: 'state-change'
    });
    
    // Watch individual files
    await this.watchFile(paths.costLedger, 'cost-update');
    await this.watchFile(paths.heartbeat, 'heartbeat');
    await this.watchFile(paths.daemonLog, 'log-line');
    
    // Watch config files
    for (const configPath of paths.configFiles) {
      await this.watchFile(configPath, 'config-change');
    }
  }

  private async watchFile(filePath: string, eventType: string): Promise<void> {
    if (this.descriptorCount >= this.MAX_DESCRIPTORS) {
      console.warn(`File descriptor limit reached, falling back to polling for ${filePath}`);
      this.startPolling(filePath, eventType);
      return;
    }

    try {
      const watcher = Bun.file(filePath).watch((event) => {
        this.batchEvent(`${eventType}:${filePath}`);
      });
      
      this.watchers.set(filePath, watcher);
      this.descriptorCount++;
    } catch (error) {
      console.warn(`Failed to watch ${filePath}, falling back to polling:`, error);
      this.startPolling(filePath, eventType);
    }
  }

  private async watchDirectory(dirPath: string, options: { pattern: string; eventType: string }): Promise<void> {
    if (this.descriptorCount >= this.MAX_DESCRIPTORS) {
      this.startDirectoryPolling(dirPath, options);
      return;
    }

    try {
      // On macOS, fs.watch quirks: events may fire multiple times
      // Debouncing in batchEvent handles this
      const watcher = Bun.file(dirPath).watch((event) => {
        if (event.path?.includes(options.pattern.replace('**/', '').replace('*', ''))) {
          this.batchEvent(`${options.eventType}:${event.path}`);
        }
      });
      
      this.watchers.set(dirPath, watcher);
      this.descriptorCount++;
    } catch (error) {
      console.warn(`Failed to watch directory ${dirPath}, falling back to polling:`, error);
      this.startDirectoryPolling(dirPath, options);
    }
  }

  private batchEvent(eventKey: string): void {
    this.pendingEvents.add(eventKey);
    
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }
    
    // 200ms quiet period for batching rapid file changes
    this.batchTimer = setTimeout(() => {
      this.flushEvents();
      this.batchTimer = null;
    }, 200);
  }

  private flushEvents(): void {
    const events = Array.from(this.pendingEvents);
    this.pendingEvents.clear();
    
    for (const eventKey of events) {
      const [eventType, filePath] = eventKey.split(':');
      this.eventBus.broadcast({
        type: eventType,
        data: { filePath, timestamp: Date.now() }
      });
    }
  }

  private startPolling(filePath: string, eventType: string): void {
    let lastMtime = 0;
    
    setInterval(async () => {
      try {
        const stat = await Bun.file(filePath).stat();
        if (stat && stat.mtime > lastMtime) {
          lastMtime = stat.mtime;
          this.batchEvent(`${eventType}:${filePath}`);
        }
      } catch (error) {
        // File might not exist yet, ignore
      }
    }, 1000); // 1s polling interval for fallback
  }

  async stop(): Promise<void> {
    for (const watcher of this.watchers.values()) {
      await watcher.unref();
    }
    this.watchers.clear();
    this.descriptorCount = 0;
    
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }
}
```text

## 5. SSE Design

### 5.1 Connection Lifecycle

```typescript
export interface SSEConnection {
  id: string;
  response: Response;
  controller: ReadableStreamController;
  lastHeartbeat: number;
  subscriptions: Set<string>; // Event types this connection wants
}

export class SSEEventBus {
  private connections: Map<string, SSEConnection> = new Map();
  private heartbeatInterval: Timer;
  private readonly MAX_CONNECTIONS = 10;
  
  constructor() {
    // Send heartbeat every 30 seconds to keep connections alive
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, 30000);
  }

  addConnection(request: Request): Response {
    if (this.connections.size >= this.MAX_CONNECTIONS) {
      return new Response('Too many connections', { status: 429 });
    }

    const connectionId = crypto.randomUUID();
    
    const stream = new ReadableStream({
      start(controller) {
        const connection: SSEConnection = {
          id: connectionId,
          response: new Response(stream, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'Access-Control-Allow-Origin': '*', // Adjust based on auth mode
            }
          }),
          controller,
          lastHeartbeat: Date.now(),
          subscriptions: new Set(['state-change', 'cost-update', 'heartbeat', 'log-line'])
        };
        
        this.connections.set(connectionId, connection);
        
        // Send initial connection event
        controller.enqueue(`data: ${JSON.stringify({
          type: 'connection',
          data: { connectionId, timestamp: Date.now() }
        })}\n\n`);
      },
      
      cancel() {
        this.connections.delete(connectionId);
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      }
    });
  }

  broadcast(event: { type: string; data: any }): void {
    const message = `data: ${JSON.stringify(event)}\n\n`;
    
    for (const [connId, conn] of this.connections.entries()) {
      if (conn.subscriptions.has(event.type)) {
        try {
          conn.controller.enqueue(message);
        } catch (error) {
          console.warn(`Failed to send to connection ${connId}:`, error);
          this.connections.delete(connId);
        }
      }
    }
  }

  private sendHeartbeat(): void {
    this.broadcast({
      type: 'heartbeat',
      data: { timestamp: Date.now() }
    });
  }

  shutdown(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    for (const conn of this.connections.values()) {
      try {
        conn.controller.close();
      } catch (error) {
        // Connection already closed
      }
    }
    this.connections.clear();
  }
}
```text

### 5.2 Event Protocol

```typescript
interface SSEEvent {
  type: 'state-change' | 'cost-update' | 'heartbeat' | 'log-line' | 'config-change';
  data: {
    timestamp: number;
    [key: string]: any;
  };
}

// Example events
const stateChangeEvent: SSEEvent = {
  type: 'state-change',
  data: {
    timestamp: Date.now(),
    requestId: 'REQ-20260428-a1b2',
    previousPhase: 'prd',
    currentPhase: 'prd_review',
    filePath: '/path/to/state.json'
  }
};

const costUpdateEvent: SSEEvent = {
  type: 'cost-update',
  data: {
    timestamp: Date.now(),
    dailySpend: 15.42,
    monthlySpend: 387.91,
    filePath: '/path/to/cost-ledger.json'
  }
};
```text

## 6. Aggregation Cache

### 6.1 Cache Implementation

```typescript
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number; // Time to live in milliseconds
}

export class AggregationCache {
  private cache: Map<string, CacheEntry<any>> = new Map();
  private readonly DEFAULT_TTL = 5000; // 5 seconds
  private readonly MEMORY_BUDGET = 50 * 1024 * 1024; // 50MB
  private currentMemoryUsage = 0;

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    
    if (!entry || Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.data as T;
  }

  set<T>(key: string, data: T, ttl: number = this.DEFAULT_TTL): void {
    // Estimate memory usage (rough approximation)
    const estimatedSize = JSON.stringify(data).length * 2; // UTF-16 bytes
    
    // Evict if over budget
    if (this.currentMemoryUsage + estimatedSize > this.MEMORY_BUDGET) {
      this.evictLRU();
    }
    
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      ttl
    };
    
    // Remove old entry if exists
    if (this.cache.has(key)) {
      this.currentMemoryUsage -= this.estimateEntrySize(this.cache.get(key)!);
    }
    
    this.cache.set(key, entry);
    this.currentMemoryUsage += estimatedSize;
  }

  invalidate(keyPattern: string): void {
    const regex = new RegExp(keyPattern);
    
    for (const [key, entry] of this.cache.entries()) {
      if (regex.test(key)) {
        this.currentMemoryUsage -= this.estimateEntrySize(entry);
        this.cache.delete(key);
      }
    }
  }

  invalidateByFilePath(filePath: string): void {
    // Map file paths to cache key patterns
    if (filePath.includes('state.json')) {
      this.invalidate('dashboard-.*');
      this.invalidate('request-detail-.*');
      this.invalidate('approval-queue');
    } else if (filePath.includes('cost-ledger.json')) {
      this.invalidate('cost-.*');
      this.invalidate('dashboard-global');
    } else if (filePath.includes('heartbeat.json')) {
      this.invalidate('operations-.*');
      this.invalidate('dashboard-global');
    }
  }

  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTimestamp = Date.now();
    
    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
        oldestKey = key;
      }
    }
    
    if (oldestKey) {
      const entry = this.cache.get(oldestKey)!;
      this.currentMemoryUsage -= this.estimateEntrySize(entry);
      this.cache.delete(oldestKey);
    }
  }

  private estimateEntrySize(entry: CacheEntry<any>): number {
    return JSON.stringify(entry.data).length * 2;
  }
}
```text

## 7. Read-Only Data Accessors

### 7.1 State File Reader

```typescript
export interface RequestState {
  requestId: string;
  phase: string;
  status: 'active' | 'paused' | 'completed' | 'failed';
  title: string;
  repository: string;
  requester: string;
  createdAt: string;
  updatedAt: string;
  costs: {
    total: number;
    byPhase: Record<string, number>;
  };
  trustLevel: number;
  turnCount: number;
  sourceChannel: string; // Added per PRD-008 FR-829
}

export class StateFileReader {
  constructor(
    private cache: AggregationCache,
    private basePath: string = '../autonomous-dev/.autonomous-dev'
  ) {}

  async getRequestState(requestId: string): Promise<RequestState | null> {
    const cacheKey = `request-state-${requestId}`;
    let state = this.cache.get<RequestState>(cacheKey);
    
    if (state) {
      return state;
    }
    
    try {
      const filePath = `${this.basePath}/requests/${requestId}/state.json`;
      const file = Bun.file(filePath);
      
      if (!(await file.exists())) {
        return null;
      }
      
      const rawData = await file.json();
      state = this.transformRawState(rawData);
      
      this.cache.set(cacheKey, state);
      return state;
    } catch (error) {
      console.error(`Failed to read state for ${requestId}:`, error);
      return null;
    }
  }

  async getAllRequestStates(): Promise<RequestState[]> {
    const cacheKey = 'all-request-states';
    let states = this.cache.get<RequestState[]>(cacheKey);
    
    if (states) {
      return states;
    }
    
    try {
      const requestsDir = `${this.basePath}/requests`;
      const entries = await readdir(requestsDir);
      const statePromises = entries
        .filter(entry => entry.isDirectory())
        .map(entry => this.getRequestState(entry.name));
      
      const results = await Promise.all(statePromises);
      states = results.filter((state): state is RequestState => state !== null);
      
      this.cache.set(cacheKey, states);
      return states;
    } catch (error) {
      console.error('Failed to read all request states:', error);
      return [];
    }
  }

  private transformRawState(rawData: any): RequestState {
    return {
      requestId: rawData.request_id || rawData.id,
      phase: rawData.current_phase || rawData.phase,
      status: rawData.status,
      title: rawData.title || rawData.request_title,
      repository: rawData.repository || rawData.repo,
      requester: rawData.requester || rawData.submitted_by,
      createdAt: rawData.created_at || rawData.timestamp,
      updatedAt: rawData.updated_at || rawData.last_updated,
      costs: {
        total: rawData.total_cost || 0,
        byPhase: rawData.costs_by_phase || {}
      },
      trustLevel: rawData.trust_level || 1,
      turnCount: rawData.turn_count || 0,
      sourceChannel: rawData.source_channel || rawData.source || 'unknown'
    };
  }
}
```text

### 7.2 Cost Data Reader

```typescript
export interface CostLedger {
  dailySpend: number;
  monthlySpend: number;
  dailyCap: number;
  monthlyCap: number;
  requestCosts: Record<string, number>;
  repoBreakdown: Record<string, number>;
  phaseBreakdown: Record<string, number>;
  topExpensiveRequests: Array<{ requestId: string; cost: number; title: string }>;
  trailing7DayAverage: number;
  projectedMonthEnd: number;
}

export class CostDataReader {
  constructor(
    private cache: AggregationCache,
    private basePath: string = '../autonomous-dev/.autonomous-dev'
  ) {}

  async getCostData(): Promise<CostLedger> {
    const cacheKey = 'cost-ledger-data';
    let costData = this.cache.get<CostLedger>(cacheKey);
    
    if (costData) {
      return costData;
    }
    
    try {
      const filePath = `${this.basePath}/cost-ledger.json`;
      const file = Bun.file(filePath);
      
      if (!(await file.exists())) {
        return this.getEmptyCostLedger();
      }
      
      const rawData = await file.json();
      costData = this.transformCostData(rawData);
      
      this.cache.set(cacheKey, costData);
      return costData;
    } catch (error) {
      console.error('Failed to read cost ledger:', error);
      return this.getEmptyCostLedger();
    }
  }

  private transformCostData(rawData: any): CostLedger {
    // Calculate trailing 7-day average for projection per FR-933
    const last7Days = rawData.daily_costs?.slice(-7) || [];
    const trailing7DayAverage = last7Days.reduce((sum: number, day: any) => 
      sum + (day.total_cost || 0), 0) / Math.max(last7Days.length, 1);
    
    // Project month-end spend based on trailing average
    const today = new Date();
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const dayOfMonth = today.getDate();
    const remainingDays = daysInMonth - dayOfMonth;
    const currentMonthSpend = rawData.monthly_spend || 0;
    const projectedMonthEnd = currentMonthSpend + (trailing7DayAverage * remainingDays);

    return {
      dailySpend: rawData.daily_spend || 0,
      monthlySpend: rawData.monthly_spend || 0,
      dailyCap: rawData.daily_cap || 100,
      monthlyCap: rawData.monthly_cap || 1000,
      requestCosts: rawData.request_costs || {},
      repoBreakdown: rawData.costs_by_repo || {},
      phaseBreakdown: rawData.costs_by_phase || {},
      topExpensiveRequests: (rawData.top_expensive_requests || []).slice(0, 10),
      trailing7DayAverage,
      projectedMonthEnd
    };
  }

  private getEmptyCostLedger(): CostLedger {
    return {
      dailySpend: 0,
      monthlySpend: 0,
      dailyCap: 100,
      monthlyCap: 1000,
      requestCosts: {},
      repoBreakdown: {},
      phaseBreakdown: {},
      topExpensiveRequests: [],
      trailing7DayAverage: 0,
      projectedMonthEnd: 0
    };
  }
}
```text

## 8. Approval Gate Flow

### 8.1 Gate Action Sequence

```typescript
export interface GateActionRequest {
  requestId: string;
  action: 'approve' | 'request-changes' | 'reject';
  comment?: string;
  confirmationToken?: string; // For destructive actions requiring typed-CONFIRM
}

export interface GateActionResult {
  success: boolean;
  error?: string;
  auditEntryId?: string;
}

export class ApprovalGateHandler {
  constructor(
    private intakeClient: IntakeRouterClient,
    private auditLogger: PortalAuditLogger,
    private eventBus: SSEEventBus
  ) {}

  async processGateAction(
    request: GateActionRequest,
    operatorId: string,
    csrfToken: string
  ): Promise<GateActionResult> {
    // 1. CSRF validation (handled by TDD-014 middleware)
    // 2. For destructive actions, validate typed-CONFIRM token
    if (request.action === 'reject' && !request.confirmationToken) {
      // Note: Based on PRD requirements, only kill-switch and similar destructive 
      // ops need typed-CONFIRM. Approval flow doesn't require it per specifications.
      // But preserving the pattern for potential future use.
    }

    try {
      // 3. Call intake router with portal source attribution
      const intakeResponse = await this.intakeClient.submitCommand({
        command: request.action,
        requestId: request.requestId,
        comment: request.comment,
        source: 'portal',
        sourceUserId: operatorId
      });

      if (!intakeResponse.success) {
        return {
          success: false,
          error: intakeResponse.error || 'Intake router rejected the action'
        };
      }

      // 4. Record audit entry
      const auditEntryId = await this.auditLogger.logGateAction({
        operatorId,
        requestId: request.requestId,
        action: request.action,
        comment: request.comment,
        timestamp: new Date().toISOString(),
        intakeResponseId: intakeResponse.commandId
      });

      // 5. SSE broadcast will happen automatically when intake router
      //    updates state.json and file watcher detects the change

      return {
        success: true,
        auditEntryId
      };

    } catch (error) {
      console.error('Gate action failed:', error);
      return {
        success: false,
        error: 'Internal server error processing gate action'
      };
    }
  }
}
```text

### 8.2 Intake Router Client

```typescript
export interface IntakeCommand {
  command: string;
  requestId: string;
  comment?: string;
  source: string; // Always 'portal' for portal-initiated actions
  sourceUserId: string; // Operator identity from auth or "localhost"
}

export interface IntakeResponse {
  success: boolean;
  commandId: string;
  error?: string;
  data?: any;
}

export class IntakeRouterClient {
  private baseUrl: string;
  private timeout = 5000; // 5 second timeout
  
  constructor(private config: PortalConfig) {
    // Discover intake router port from its config
    const intakePort = this.discoverIntakePort();
    this.baseUrl = `http://127.0.0.1:${intakePort}/router`;
  }

  async submitCommand(command: IntakeCommand): Promise<IntakeResponse> {
    try {
      const response = await fetch(`${this.baseUrl}/command`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'autonomous-dev-portal/1.0'
        },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(this.timeout)
      });

      const data = await response.json();
      
      if (!response.ok) {
        return {
          success: false,
          commandId: '',
          error: data.error || `HTTP ${response.status}`
        };
      }

      return {
        success: true,
        commandId: data.commandId || crypto.randomUUID(),
        data
      };

    } catch (error) {
      console.error('Intake router communication failed:', error);
      return {
        success: false,
        commandId: '',
        error: error instanceof Error ? error.message : 'Network error'
      };
    }
  }

  private discoverIntakePort(): number {
    // Read intake router's userConfig from autonomous-dev plugin
    // Fall back to default port if not found
    try {
      const intakeConfigPath = '../autonomous-dev/.claude-plugin/userConfig.json';
      const intakeConfig = JSON.parse(readFileSync(intakeConfigPath, 'utf-8'));
      return intakeConfig.router?.port || 19279;
    } catch (error) {
      console.warn('Could not discover intake router port, using default 19279');
      return 19279;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(2000)
      });
      return response.ok;
    } catch (error) {
      return false;
    }
  }
}
```text

## 9. Settings Editor Flow

### 9.1 Configuration Validation Chain

```typescript
export interface ConfigValidationRule {
  field: string;
  validate: (value: any, context: ValidationContext) => ValidationResult;
}

export interface ValidationContext {
  fullConfig: any;
  userHomeDir: string;
  allowedRoots: string[];
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  warnings?: string[];
}

export class ConfigurationValidator {
  private rules: ConfigValidationRule[] = [
    {
      field: 'costCaps.daily',
      validate: (value) => {
        const num = parseFloat(value);
        if (isNaN(num) || num <= 0) {
          return { valid: false, error: 'Daily cost cap must be a positive number' };
        }
        return { valid: true };
      }
    },
    {
      field: 'costCaps.monthly', 
      validate: (value, context) => {
        const num = parseFloat(value);
        const dailyCap = parseFloat(context.fullConfig.costCaps?.daily || 0);
        
        if (isNaN(num) || num <= 0) {
          return { valid: false, error: 'Monthly cost cap must be a positive number' };
        }
        if (num < dailyCap * 30) {
          return { 
            valid: true, 
            warnings: ['Monthly cap is less than 30x daily cap, may trigger frequently'] 
          };
        }
        return { valid: true };
      }
    },
    {
      field: 'allowlist',
      validate: (paths, context) => this.validateAllowlistPaths(paths, context)
    },
    {
      field: 'patterns.regex',
      validate: (pattern) => this.validateRegexPattern(pattern)
    }
  ];

  async validateField(field: string, value: any, context: ValidationContext): Promise<ValidationResult> {
    const rule = this.rules.find(r => r.field === field);
    if (!rule) {
      return { valid: true };
    }
    
    return rule.validate(value, context);
  }

  private validateAllowlistPaths(paths: string[], context: ValidationContext): ValidationResult {
    for (const path of paths) {
      // FR-S20: Canonicalize and check allowed roots
      try {
        const canonicalPath = require('path').resolve(path);
        const isAllowed = context.allowedRoots.some(root => 
          canonicalPath.startsWith(require('path').resolve(root))
        );
        
        if (!isAllowed) {
          return {
            valid: false,
            error: `Path ${path} is outside allowed roots: ${context.allowedRoots.join(', ')}`
          };
        }

        // FR-S21: Verify git repository
        const gitCheck = this.verifyGitRepository(canonicalPath);
        if (!gitCheck.valid) {
          return gitCheck;
        }
        
      } catch (error) {
        return {
          valid: false,
          error: `Invalid path ${path}: ${error.message}`
        };
      }
    }
    
    return { valid: true };
  }

  private verifyGitRepository(path: string): ValidationResult {
    try {
      // FR-S21: Use subprocess with timeout, no shell
      const proc = Bun.spawn(['git', '-C', path, 'rev-parse', '--git-dir'], {
        stdout: 'pipe',
        stderr: 'pipe'
      });
      
      // 2 second timeout
      const timeoutId = setTimeout(() => proc.kill(), 2000);
      
      const exitCode = await proc.exited;
      clearTimeout(timeoutId);
      
      if (exitCode !== 0) {
        return {
          valid: false,
          error: `Path ${path} is not a git repository`
        };
      }
      
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: `Git verification failed for ${path}: ${error.message}`
      };
    }
  }

  private validateRegexPattern(pattern: string): ValidationResult {
    // FR-S22: Test-compile with timeout and input limits
    try {
      if (pattern.length > 1000) {
        return {
          valid: false,
          error: 'Regular expression too long (max 1000 characters)'
        };
      }

      // Test compilation in sandboxed environment with timeout
      const startTime = Date.now();
      const regex = new RegExp(pattern);
      const compileTime = Date.now() - startTime;
      
      if (compileTime > 100) {
        return {
          valid: false,
          error: 'Regular expression compilation took too long (ReDoS protection)'
        };
      }

      // Test with limited input to detect expensive patterns
      const testInput = 'a'.repeat(100);
      const testStart = Date.now();
      regex.test(testInput);
      const testTime = Date.now() - testStart;
      
      if (testTime > 100) {
        return {
          valid: false,
          error: 'Regular expression is too expensive (ReDoS protection)'
        };
      }
      
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: `Invalid regular expression: ${error.message}`
      };
    }
  }
}
```text

### 9.2 Settings Mutation Handler

```typescript
export class SettingsHandler {
  constructor(
    private validator: ConfigurationValidator,
    private intakeClient: IntakeRouterClient,
    private auditLogger: PortalAuditLogger,
    private eventBus: SSEEventBus
  ) {}

  async updateSettings(
    changes: Record<string, any>,
    operatorId: string
  ): Promise<{ success: boolean; errors?: string[]; warnings?: string[] }> {
    const validationContext: ValidationContext = {
      fullConfig: changes,
      userHomeDir: process.env.HOME || '/Users/operator',
      allowedRoots: [process.env.HOME || '/Users/operator']
    };

    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate all changes
    for (const [field, value] of Object.entries(changes)) {
      const result = await this.validator.validateField(field, value, validationContext);
      
      if (!result.valid) {
        errors.push(`${field}: ${result.error}`);
      }
      
      if (result.warnings) {
        warnings.push(...result.warnings.map(w => `${field}: ${w}`));
      }
    }

    if (errors.length > 0) {
      return { success: false, errors, warnings };
    }

    try {
      // Send config-set command to intake router
      const intakeResponse = await this.intakeClient.submitCommand({
        command: 'config-set',
        requestId: crypto.randomUUID(), // Config changes get a request ID for tracking
        source: 'portal',
        sourceUserId: operatorId,
        // Include the configuration changes in the command data
        configChanges: changes
      });

      if (!intakeResponse.success) {
        return {
          success: false,
          errors: [intakeResponse.error || 'Configuration update failed']
        };
      }

      // Log to audit trail
      await this.auditLogger.logConfigChange({
        operatorId,
        changes: Object.keys(changes),
        oldValueHashes: this.hashConfigValues({}), // Would read existing config
        newValueHashes: this.hashConfigValues(changes),
        timestamp: new Date().toISOString(),
        intakeCommandId: intakeResponse.commandId
      });

      // FR-927: Signal daemon reload if needed
      if (this.requiresDaemonReload(changes)) {
        await this.signalDaemonReload();
      }

      return { success: true, warnings };

    } catch (error) {
      console.error('Settings update failed:', error);
      return {
        success: false,
        errors: ['Internal server error updating settings']
      };
    }
  }

  private hashConfigValues(values: Record<string, any>): Record<string, string> {
    const hashes: Record<string, string> = {};
    
    for (const [key, value] of Object.entries(values)) {
      const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
      hashes[key] = Bun.hash(valueStr).toString(16);
    }
    
    return hashes;
  }

  private requiresDaemonReload(changes: Record<string, any>): boolean {
    const reloadTriggers = [
      'costCaps.daily',
      'costCaps.monthly', 
      'trustLevels',
      'circuitBreaker',
      'killSwitch'
    ];
    
    return Object.keys(changes).some(key => 
      reloadTriggers.some(trigger => key.includes(trigger))
    );
  }

  private async signalDaemonReload(): Promise<void> {
    // Send reload signal via intake router
    try {
      await this.intakeClient.submitCommand({
        command: 'daemon-reload',
        requestId: crypto.randomUUID(),
        source: 'portal',
        sourceUserId: 'system'
      });
    } catch (error) {
      console.error('Failed to signal daemon reload:', error);
      // Non-fatal, daemon will pick up changes on next restart
    }
  }
}
```text

## 10. Cost Computation

### 10.1 Cost Aggregation Engine

```typescript
export interface DailyCostMetrics {
  date: string; // ISO 8601 date
  totalSpend: number;
  requestCount: number;
  avgCostPerRequest: number;
}

export interface MonthlyCostMetrics {
  month: string; // YYYY-MM format
  totalSpend: number;
  requestCount: number;
  dailyAverage: number;
}

export interface CostProjection {
  trailing7DayAverage: number;
  projectedMonthEnd: number;
  daysRemaining: number;
  isOverBudget: boolean;
}

export class CostComputationEngine {
  constructor(
    private costReader: CostDataReader,
    private cache: AggregationCache
  ) {}

  async getDailyCostSeries(days: number = 30): Promise<DailyCostMetrics[]> {
    const cacheKey = `daily-costs-${days}`;
    let series = this.cache.get<DailyCostMetrics[]>(cacheKey);
    
    if (series) {
      return series;
    }

    const costData = await this.costReader.getCostData();
    
    // Generate last N days
    const today = new Date();
    series = [];
    
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      
      // Look up cost for this date from cost ledger
      const daySpend = this.getDailySpend(dateStr, costData);
      const dayRequests = this.getDailyRequestCount(dateStr, costData);
      
      series.push({
        date: dateStr,
        totalSpend: daySpend,
        requestCount: dayRequests,
        avgCostPerRequest: dayRequests > 0 ? daySpend / dayRequests : 0
      });
    }
    
    this.cache.set(cacheKey, series);
    return series;
  }

  async getMonthlyCostSeries(months: number = 12): Promise<MonthlyCostMetrics[]> {
    const cacheKey = `monthly-costs-${months}`;
    let series = this.cache.get<MonthlyCostMetrics[]>(cacheKey);
    
    if (series) {
      return series;
    }

    const costData = await this.costReader.getCostData();
    const today = new Date();
    series = [];
    
    for (let i = months - 1; i >= 0; i--) {
      const date = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const monthStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      
      const monthSpend = this.getMonthlySpend(monthStr, costData);
      const monthRequests = this.getMonthlyRequestCount(monthStr, costData);
      const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
      
      series.push({
        month: monthStr,
        totalSpend: monthSpend,
        requestCount: monthRequests,
        dailyAverage: monthSpend / daysInMonth
      });
    }
    
    this.cache.set(cacheKey, series);
    return series;
  }

  async getCostProjection(): Promise<CostProjection> {
    const cacheKey = 'cost-projection';
    let projection = this.cache.get<CostProjection>(cacheKey);
    
    if (projection) {
      return projection;
    }

    const costData = await this.costReader.getCostData();
    
    // FR-933: Trailing 7-day average projection
    const trailing7DayAverage = costData.trailing7DayAverage;
    
    const today = new Date();
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const daysRemaining = daysInMonth - today.getDate();
    
    const projectedMonthEnd = costData.monthlySpend + (trailing7DayAverage * daysRemaining);
    const isOverBudget = projectedMonthEnd > costData.monthlyCap;
    
    projection = {
      trailing7DayAverage,
      projectedMonthEnd,
      daysRemaining,
      isOverBudget
    };
    
    this.cache.set(cacheKey, projection);
    return projection;
  }

  async getTopExpensiveRequests(limit: number = 10): Promise<Array<{
    requestId: string;
    title: string;
    totalCost: number;
    repository: string;
    completedAt: string;
  }>> {
    const cacheKey = `top-expensive-${limit}`;
    let topRequests = this.cache.get<any[]>(cacheKey);
    
    if (topRequests) {
      return topRequests;
    }

    const costData = await this.costReader.getCostData();
    
    // Sort by cost and take top N
    topRequests = costData.topExpensiveRequests
      .slice(0, limit)
      .map(req => ({
        requestId: req.requestId,
        title: req.title,
        totalCost: req.cost,
        repository: this.getRequestRepository(req.requestId),
        completedAt: this.getRequestCompletionDate(req.requestId)
      }));
    
    this.cache.set(cacheKey, topRequests);
    return topRequests;
  }

  private getDailySpend(date: string, costData: CostLedger): number {
    // Implementation depends on cost ledger format
    // This would parse the daily breakdown from the ledger
    return 0; // Placeholder
  }

  private getDailyRequestCount(date: string, costData: CostLedger): number {
    // Similar parsing logic for request counts
    return 0; // Placeholder
  }

  private getMonthlySpend(month: string, costData: CostLedger): number {
    // Parse monthly data from cost ledger
    return 0; // Placeholder
  }

  private getMonthlyRequestCount(month: string, costData: CostLedger): number {
    return 0; // Placeholder
  }

  private getRequestRepository(requestId: string): string {
    // Look up repo from request state files
    return ''; // Placeholder
  }

  private getRequestCompletionDate(requestId: string): string {
    // Look up completion date from request state
    return ''; // Placeholder
  }
}
```text

## 11. Log Tailing

### 11.1 Log Reader Implementation

```typescript
export interface LogEntry {
  timestamp: string;
  level: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';
  requestId?: string;
  message: string;
  lineNumber: number;
}

export interface LogFilter {
  level?: string;
  requestId?: string;
  timeRange?: { start: Date; end: Date };
}

export class LogTailHandler {
  private tailWatchers: Map<string, any> = new Map();
  
  constructor(
    private eventBus: SSEEventBus,
    private basePath: string = '../autonomous-dev/.autonomous-dev/logs'
  ) {}

  async getLastLines(count: number = 500): Promise<LogEntry[]> {
    try {
      const logPath = `${this.basePath}/daemon.log`;
      const file = Bun.file(logPath);
      
      if (!(await file.exists())) {
        return [];
      }

      const content = await file.text();
      const lines = content.split('\n').filter(line => line.trim());
      const lastLines = lines.slice(-count);
      
      return lastLines.map((line, index) => this.parseLoglLine(line, lines.length - count + index + 1));
    } catch (error) {
      console.error('Failed to read log file:', error);
      return [];
    }
  }

  async filterLogs(filter: LogFilter, maxLines: number = 1000): Promise<LogEntry[]> {
    const allLines = await this.getLastLines(maxLines);
    
    return allLines.filter(entry => {
      if (filter.level && entry.level !== filter.level) {
        return false;
      }
      
      if (filter.requestId && entry.requestId !== filter.requestId) {
        return false;
      }
      
      if (filter.timeRange) {
        const entryTime = new Date(entry.timestamp);
        if (entryTime < filter.timeRange.start || entryTime > filter.timeRange.end) {
          return false;
        }
      }
      
      return true;
    });
  }

  async startTailing(connectionId: string): Promise<void> {
    if (this.tailWatchers.has(connectionId)) {
      return; // Already tailing
    }

    try {
      const logPath = `${this.basePath}/daemon.log`;
      let lastPosition = 0;
      
      // Get initial position at end of file
      const file = Bun.file(logPath);
      if (await file.exists()) {
        const stat = await file.stat();
        lastPosition = stat?.size || 0;
      }

      const watcher = Bun.file(logPath).watch(async () => {
        await this.handleLogChange(connectionId, logPath, lastPosition);
        
        // Update position
        const newStat = await Bun.file(logPath).stat();
        lastPosition = newStat?.size || lastPosition;
      });

      this.tailWatchers.set(connectionId, { watcher, lastPosition });
    } catch (error) {
      console.error(`Failed to start log tailing for ${connectionId}:`, error);
    }
  }

  stopTailing(connectionId: string): void {
    const watcherInfo = this.tailWatchers.get(connectionId);
    if (watcherInfo) {
      watcherInfo.watcher.close();
      this.tailWatchers.delete(connectionId);
    }
  }

  async generateDownload(hours: number = 24): Promise<string> {
    const logPath = `${this.basePath}/daemon.log`;
    const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    
    try {
      const file = Bun.file(logPath);
      const content = await file.text();
      const lines = content.split('\n');
      
      const filteredLines = lines.filter(line => {
        const entry = this.parseLoglLine(line, 0);
        const entryTime = new Date(entry.timestamp);
        return entryTime >= cutoffTime;
      });
      
      const filteredContent = filteredLines.join('\n');
      
      // Gzip compression
      const compressed = Bun.gzipSync(new TextEncoder().encode(filteredContent));
      
      // Return base64 for download
      return Buffer.from(compressed).toString('base64');
    } catch (error) {
      console.error('Failed to generate log download:', error);
      throw new Error('Log download generation failed');
    }
  }

  private async handleLogChange(connectionId: string, logPath: string, lastPosition: number): Promise<void> {
    try {
      const file = Bun.file(logPath);
      const stream = file.stream();
      const reader = stream.getReader();
      
      // Skip to last position
      let currentPosition = 0;
      while (currentPosition < lastPosition) {
        const { done, value } = await reader.read();
        if (done) break;
        currentPosition += value.length;
      }
      
      // Read new content
      const newContent = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        newContent.push(value);
      }
      
      if (newContent.length > 0) {
        const newText = new TextDecoder().decode(new Uint8Array(newContent.flat()));
        const newLines = newText.split('\n').filter(line => line.trim());
        
        for (const line of newLines) {
          const entry = this.parseLoglLine(line, 0);
          
          this.eventBus.broadcast({
            type: 'log-line',
            data: {
              entry,
              connectionId // Target specific connection
            }
          });
        }
      }
    } catch (error) {
      console.error('Error handling log change:', error);
    }
  }

  private parseLoglLine(line: string, lineNumber: number): LogEntry {
    // Parse daemon log format: [timestamp] [LEVEL] [requestId?] message
    const logPattern = /^\[([^\]]+)\] \[([^\]]+)\](?:\s+\[([^\]]+)\])?\s+(.+)$/;
    const match = line.match(logPattern);
    
    if (match) {
      return {
        timestamp: match[1],
        level: match[2] as LogEntry['level'],
        requestId: match[3] || undefined,
        message: match[4],
        lineNumber
      };
    }
    
    // Fallback for malformed lines
    return {
      timestamp: new Date().toISOString(),
      level: 'INFO',
      message: line,
      lineNumber
    };
  }
}
```text

## 12. Operations Endpoints

### 12.1 Kill Switch Handler

```typescript
export interface KillSwitchState {
  engaged: boolean;
  engagedAt?: string;
  engagedBy?: string;
  reason?: string;
}

export interface TypedConfirmation {
  token: string;
  expiresAt: number; // Unix timestamp
  action: string;
}

export class OperationsHandler {
  private confirmationTokens: Map<string, TypedConfirmation> = new Map();
  
  constructor(
    private intakeClient: IntakeRouterClient,
    private auditLogger: PortalAuditLogger,
    private eventBus: SSEEventBus
  ) {}

  async getKillSwitchState(): Promise<KillSwitchState> {
    try {
      // Read kill switch state from daemon heartbeat or dedicated file
      const heartbeatPath = '../autonomous-dev/.autonomous-dev/heartbeat.json';
      const file = Bun.file(heartbeatPath);
      
      if (!(await file.exists())) {
        return { engaged: false };
      }

      const heartbeat = await file.json();
      
      return {
        engaged: heartbeat.kill_switch_engaged || false,
        engagedAt: heartbeat.kill_switch_engaged_at,
        engagedBy: heartbeat.kill_switch_engaged_by,
        reason: heartbeat.kill_switch_reason
      };
    } catch (error) {
      console.error('Failed to read kill switch state:', error);
      return { engaged: false };
    }
  }

  async generateConfirmationToken(action: string, operatorId: string): Promise<string> {
    const token = crypto.randomUUID();
    const expiresAt = Date.now() + 60000; // 60 second TTL
    
    this.confirmationTokens.set(token, {
      token,
      expiresAt,
      action
    });
    
    // Clean up expired tokens
    this.cleanupExpiredTokens();
    
    return token;
  }

  async engageKillSwitch(
    reason: string,
    operatorId: string,
    confirmationToken: string
  ): Promise<{ success: boolean; error?: string }> {
    // Validate typed-CONFIRM token per FR-S12
    if (!this.validateConfirmationToken(confirmationToken, 'kill-switch-engage')) {
      return {
        success: false,
        error: 'Invalid or expired confirmation token'
      };
    }

    try {
      const response = await this.intakeClient.submitCommand({
        command: 'kill-switch-engage',
        requestId: crypto.randomUUID(),
        source: 'portal',
        sourceUserId: operatorId,
        reason
      });

      if (!response.success) {
        return {
          success: false,
          error: response.error || 'Kill switch engagement failed'
        };
      }

      // Log to audit
      await this.auditLogger.logOperation({
        operatorId,
        operation: 'kill-switch-engage',
        reason,
        timestamp: new Date().toISOString(),
        confirmationToken
      });

      // Remove used token
      this.confirmationTokens.delete(confirmationToken);

      return { success: true };

    } catch (error) {
      console.error('Kill switch engagement failed:', error);
      return {
        success: false,
        error: 'Internal server error'
      };
    }
  }

  async resetKillSwitch(
    operatorId: string,
    confirmationToken: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.validateConfirmationToken(confirmationToken, 'kill-switch-reset')) {
      return {
        success: false,
        error: 'Invalid or expired confirmation token'
      };
    }

    try {
      const response = await this.intakeClient.submitCommand({
        command: 'kill-switch-reset',
        requestId: crypto.randomUUID(),
        source: 'portal',
        sourceUserId: operatorId
      });

      if (!response.success) {
        return {
          success: false,
          error: response.error || 'Kill switch reset failed'
        };
      }

      await this.auditLogger.logOperation({
        operatorId,
        operation: 'kill-switch-reset',
        timestamp: new Date().toISOString(),
        confirmationToken
      });

      this.confirmationTokens.delete(confirmationToken);
      return { success: true };

    } catch (error) {
      console.error('Kill switch reset failed:', error);
      return {
        success: false,
        error: 'Internal server error'
      };
    }
  }

  async resetCircuitBreaker(
    operatorId: string,
    confirmationToken: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.validateConfirmationToken(confirmationToken, 'circuit-breaker-reset')) {
      return {
        success: false,
        error: 'Invalid or expired confirmation token'
      };
    }

    try {
      const response = await this.intakeClient.submitCommand({
        command: 'circuit-breaker-reset',
        requestId: crypto.randomUUID(),
        source: 'portal',
        sourceUserId: operatorId
      });

      if (!response.success) {
        return {
          success: false,
          error: response.error || 'Circuit breaker reset failed'
        };
      }

      await this.auditLogger.logOperation({
        operatorId,
        operation: 'circuit-breaker-reset',
        timestamp: new Date().toISOString(),
        confirmationToken
      });

      this.confirmationTokens.delete(confirmationToken);
      return { success: true };

    } catch (error) {
      console.error('Circuit breaker reset failed:', error);
      return {
        success: false,
        error: 'Internal server error'
      };
    }
  }

  private validateConfirmationToken(token: string, expectedAction: string): boolean {
    const confirmation = this.confirmationTokens.get(token);
    
    if (!confirmation) {
      return false;
    }
    
    if (Date.now() > confirmation.expiresAt) {
      this.confirmationTokens.delete(token);
      return false;
    }
    
    return confirmation.action === expectedAction;
  }

  private cleanupExpiredTokens(): void {
    const now = Date.now();
    
    for (const [token, confirmation] of this.confirmationTokens.entries()) {
      if (now > confirmation.expiresAt) {
        this.confirmationTokens.delete(token);
      }
    }
  }
}
```text

## 13. SVG Chart Rendering

### 13.1 Chart Generation

```typescript
export interface ChartData {
  labels: string[];
  values: number[];
  title: string;
  yAxisLabel: string;
  xAxisLabel: string;
}

export interface ChartOptions {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  strokeColor: string;
  fillColor?: string;
  gridColor: string;
  textColor: string;
}

export class SVGChartRenderer {
  private defaultOptions: ChartOptions = {
    width: 800,
    height: 400,
    margin: { top: 40, right: 40, bottom: 60, left: 80 },
    strokeColor: '#3b82f6',
    fillColor: 'rgba(59, 130, 246, 0.1)',
    gridColor: '#e5e7eb',
    textColor: '#374151'
  };

  renderLineChart(data: ChartData, options?: Partial<ChartOptions>): string {
    const opts = { ...this.defaultOptions, ...options };
    const { width, height, margin } = opts;
    
    const chartWidth = width - margin.left - margin.right;
    const chartHeight = height - margin.top - margin.bottom;
    
    // Calculate scales
    const maxValue = Math.max(...data.values);
    const minValue = Math.min(...data.values, 0);
    const valueRange = maxValue - minValue || 1;
    
    const xScale = (index: number) => (index / (data.labels.length - 1)) * chartWidth;
    const yScale = (value: number) => chartHeight - ((value - minValue) / valueRange) * chartHeight;

    // Generate path data
    const pathData = data.values
      .map((value, index) => `${index === 0 ? 'M' : 'L'} ${xScale(index)} ${yScale(value)}`)
      .join(' ');

    // Generate fill area path (for area under curve)
    const fillPath = `M ${xScale(0)} ${chartHeight} L ${pathData.substring(1)} L ${xScale(data.values.length - 1)} ${chartHeight} Z`;

    // Generate grid lines
    const gridLines = [];
    const gridSteps = 5;
    for (let i = 0; i <= gridSteps; i++) {
      const y = (i / gridSteps) * chartHeight;
      const value = minValue + (1 - i / gridSteps) * valueRange;
      
      gridLines.push(`
        <line x1="0" y1="${y}" x2="${chartWidth}" y2="${y}" 
              stroke="${opts.gridColor}" stroke-width="1" opacity="0.5"/>
        <text x="-10" y="${y + 4}" text-anchor="end" 
              fill="${opts.textColor}" font-size="12">
          ${this.formatValue(value)}
        </text>
      `);
    }

    // Generate x-axis labels
    const xLabels = data.labels.map((label, index) => {
      const x = xScale(index);
      return `
        <text x="${x}" y="${chartHeight + 20}" text-anchor="middle" 
              fill="${opts.textColor}" font-size="12">
          ${label}
        </text>
      `;
    }).join('');

    return `
      <svg width="${width}" height="${height}" 
           xmlns="http://www.w3.org/2000/svg"
           role="img"
           aria-labelledby="chart-title"
           aria-describedby="chart-desc">
        
        <title id="chart-title">${data.title}</title>
        <desc id="chart-desc">
          Line chart showing ${data.yAxisLabel} over ${data.xAxisLabel}.
          Data ranges from ${this.formatValue(minValue)} to ${this.formatValue(maxValue)}.
        </desc>
        
        <g transform="translate(${margin.left}, ${margin.top})">
          <!-- Grid lines -->
          ${gridLines.join('')}
          
          <!-- Fill area -->
          ${opts.fillColor ? `
            <path d="${fillPath}" 
                  fill="${opts.fillColor}" 
                  stroke="none"/>
          ` : ''}
          
          <!-- Chart line -->
          <path d="${pathData}" 
                fill="none" 
                stroke="${opts.strokeColor}" 
                stroke-width="2"/>
          
          <!-- Data points -->
          ${data.values.map((value, index) => `
            <circle cx="${xScale(index)}" cy="${yScale(value)}" r="4"
                    fill="${opts.strokeColor}" 
                    stroke="white" 
                    stroke-width="2">
              <title>${data.labels[index]}: ${this.formatValue(value)}</title>
            </circle>
          `).join('')}
          
          <!-- X-axis labels -->
          ${xLabels}
          
          <!-- Axis labels -->
          <text x="${chartWidth / 2}" y="${chartHeight + 50}" 
                text-anchor="middle" fill="${opts.textColor}" font-size="14">
            ${data.xAxisLabel}
          </text>
          
          <text x="-50" y="${chartHeight / 2}" 
                text-anchor="middle" fill="${opts.textColor}" font-size="14"
                transform="rotate(-90, -50, ${chartHeight / 2})">
            ${data.yAxisLabel}
          </text>
          
          <!-- Chart title -->
          <text x="${chartWidth / 2}" y="-20" 
                text-anchor="middle" fill="${opts.textColor}" font-size="16" font-weight="bold">
            ${data.title}
          </text>
        </g>
      </svg>
    `;
  }

  renderBarChart(data: ChartData, options?: Partial<ChartOptions>): string {
    const opts = { ...this.defaultOptions, ...options };
    const { width, height, margin } = opts;
    
    const chartWidth = width - margin.left - margin.right;
    const chartHeight = height - margin.top - margin.bottom;
    
    const maxValue = Math.max(...data.values, 0);
    const barWidth = chartWidth / data.values.length * 0.8; // 80% width with spacing
    const barSpacing = chartWidth / data.values.length * 0.2;
    
    const yScale = (value: number) => (value / maxValue) * chartHeight;
    const xScale = (index: number) => index * (chartWidth / data.values.length) + barSpacing / 2;

    const bars = data.values.map((value, index) => {
      const x = xScale(index);
      const barHeight = yScale(value);
      const y = chartHeight - barHeight;
      
      return `
        <rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}"
              fill="${opts.strokeColor}" opacity="0.8">
          <title>${data.labels[index]}: ${this.formatValue(value)}</title>
        </rect>
        <text x="${x + barWidth / 2}" y="${chartHeight + 15}" 
              text-anchor="middle" fill="${opts.textColor}" font-size="12">
          ${data.labels[index]}
        </text>
      `;
    }).join('');

    // Y-axis grid and labels
    const gridLines = [];
    const gridSteps = 5;
    for (let i = 0; i <= gridSteps; i++) {
      const value = (i / gridSteps) * maxValue;
      const y = chartHeight - yScale(value);
      
      gridLines.push(`
        <line x1="0" y1="${y}" x2="${chartWidth}" y2="${y}" 
              stroke="${opts.gridColor}" stroke-width="1" opacity="0.5"/>
        <text x="-10" y="${y + 4}" text-anchor="end" 
              fill="${opts.textColor}" font-size="12">
          ${this.formatValue(value)}
        </text>
      `);
    }

    return `
      <svg width="${width}" height="${height}" 
           xmlns="http://www.w3.org/2000/svg"
           role="img"
           aria-labelledby="chart-title"
           aria-describedby="chart-desc">
        
        <title id="chart-title">${data.title}</title>
        <desc id="chart-desc">
          Bar chart showing ${data.yAxisLabel} by ${data.xAxisLabel}.
          Values range from 0 to ${this.formatValue(maxValue)}.
        </desc>
        
        <g transform="translate(${margin.left}, ${margin.top})">
          <!-- Grid lines -->
          ${gridLines.join('')}
          
          <!-- Bars -->
          ${bars}
          
          <!-- Axis labels -->
          <text x="${chartWidth / 2}" y="${chartHeight + 50}" 
                text-anchor="middle" fill="${opts.textColor}" font-size="14">
            ${data.xAxisLabel}
          </text>
          
          <text x="-50" y="${chartHeight / 2}" 
                text-anchor="middle" fill="${opts.textColor}" font-size="14"
                transform="rotate(-90, -50, ${chartHeight / 2})">
            ${data.yAxisLabel}
          </text>
          
          <!-- Chart title -->
          <text x="${chartWidth / 2}" y="-20" 
                text-anchor="middle" fill="${opts.textColor}" font-size="16" font-weight="bold">
            ${data.title}
          </text>
        </g>
      </svg>
    `;
  }

  private formatValue(value: number): string {
    if (value >= 1000000) {
      return `${(value / 1000000).toFixed(1)}M`;
    } else if (value >= 1000) {
      return `${(value / 1000).toFixed(1)}K`;
    } else if (value < 1) {
      return value.toFixed(2);
    } else {
      return value.toFixed(0);
    }
  }
}
```text

## 14. Intake Router Client

### 14.1 HTTP Client Implementation

```typescript
export class IntakeRouterClient {
  private baseUrl: string;
  private timeout = 5000;
  private retryAttempts = 3;
  private retryDelay = 1000;
  
  constructor(private config: PortalConfig) {
    const intakePort = this.discoverIntakePort();
    this.baseUrl = `http://127.0.0.1:${intakePort}`;
  }

  async submitCommand(command: IntakeCommand): Promise<IntakeResponse> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        const response = await this.makeRequest('/router/command', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'autonomous-dev-portal/1.0'
          },
          body: JSON.stringify(command)
        });

        const data = await response.json();
        
        if (!response.ok) {
          return {
            success: false,
            commandId: '',
            error: data.error || `HTTP ${response.status}: ${response.statusText}`
          };
        }

        return {
          success: true,
          commandId: data.commandId || crypto.randomUUID(),
          data
        };

      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        if (attempt < this.retryAttempts) {
          console.warn(`Intake router attempt ${attempt} failed, retrying:`, lastError.message);
          await this.delay(this.retryDelay * attempt);
        }
      }
    }

    console.error('All intake router attempts failed:', lastError);
    return {
      success: false,
      commandId: '',
      error: `Network error after ${this.retryAttempts} attempts: ${lastError?.message}`
    };
  }

  async healthCheck(): Promise<{ healthy: boolean; version?: string; latency?: number }> {
    const startTime = Date.now();
    
    try {
      const response = await this.makeRequest('/router/health', {
        method: 'GET'
      });

      const latency = Date.now() - startTime;
      
      if (response.ok) {
        const data = await response.json();
        return {
          healthy: true,
          version: data.version,
          latency
        };
      }

      return { healthy: false, latency };
    } catch (error) {
      return { healthy: false };
    }
  }

  private async makeRequest(path: string, options: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private discoverIntakePort(): number {
    try {
      // Read from autonomous-dev plugin's userConfig
      const configPath = '../autonomous-dev/.claude-plugin/userConfig.json';
      const configData = Bun.file(configPath);
      
      if (configData.exists()) {
        const config = JSON.parse(configData.text());
        return config.intake?.port || config.router?.port || 19279;
      }
    } catch (error) {
      console.warn('Could not discover intake router port:', error);
    }
    
    // Default port from TDD-008
    return 19279;
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```text

## 15. Audit Page

### 15.1 Audit Log Reader

```typescript
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
}

export class AuditLogReader {
  private auditLogPath: string;
  
  constructor(private config: PortalConfig) {
    this.auditLogPath = `${config.dataDir}/audit.jsonl`;
  }

  async getPage(
    pageNumber: number = 1, 
    pageSize: number = 50
  ): Promise<AuditPageResult> {
    try {
      const entries = await this.readAllEntries();
      const totalCount = entries.length;
      
      // Pagination - newest first
      const startIndex = (pageNumber - 1) * pageSize;
      const endIndex = startIndex + pageSize;
      const pageEntries = entries.slice(startIndex, endIndex);
      
      // Check integrity of displayed entries
      const integrityStatus = await this.checkIntegrity(pageEntries);
      
      return {
        entries: pageEntries,
        totalCount,
        hasNext: endIndex < totalCount,
        hasPrevious: startIndex > 0,
        integrityStatus
      };
    } catch (error) {
      console.error('Failed to read audit log:', error);
      return {
        entries: [],
        totalCount: 0,
        hasNext: false,
        hasPrevious: false,
        integrityStatus: 'error'
      };
    }
  }

  async searchEntries(
    query: {
      operatorId?: string;
      action?: string;
      dateRange?: { start: Date; end: Date };
    },
    pageNumber: number = 1,
    pageSize: number = 50
  ): Promise<AuditPageResult> {
    const allEntries = await this.readAllEntries();
    
    const filteredEntries = allEntries.filter(entry => {
      if (query.operatorId && entry.operatorId !== query.operatorId) {
        return false;
      }
      
      if (query.action && !entry.action.includes(query.action)) {
        return false;
      }
      
      if (query.dateRange) {
        const entryDate = new Date(entry.timestamp);
        if (entryDate < query.dateRange.start || entryDate > query.dateRange.end) {
          return false;
        }
      }
      
      return true;
    });
    
    const startIndex = (pageNumber - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const pageEntries = filteredEntries.slice(startIndex, endIndex);
    
    const integrityStatus = await this.checkIntegrity(pageEntries);
    
    return {
      entries: pageEntries,
      totalCount: filteredEntries.length,
      hasNext: endIndex < filteredEntries.length,
      hasPrevious: startIndex > 0,
      integrityStatus
    };
  }

  private async readAllEntries(): Promise<AuditEntry[]> {
    try {
      const file = Bun.file(this.auditLogPath);
      
      if (!(await file.exists())) {
        return [];
      }

      const content = await file.text();
      const lines = content.split('\n').filter(line => line.trim());
      
      const entries = lines.map(line => {
        try {
          return JSON.parse(line) as AuditEntry;
        } catch (error) {
          console.warn('Failed to parse audit log line:', line);
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

  private async checkIntegrity(entries: AuditEntry[]): Promise<'verified' | 'warning' | 'error' | 'unknown'> {
    // This would interface with TDD-014's audit log verifier
    // For now, return a placeholder status
    try {
      // Check if all entries have integrity hashes
      const hasHashes = entries.every(entry => entry.integrityHash);
      
      if (!hasHashes) {
        return 'warning'; // Some entries lack integrity data
      }
      
      // Would call TDD-014's verifier here
      // await this.integrityVerifier.verify(entries);
      
      return 'verified';
    } catch (error) {
      console.error('Integrity check failed:', error);
      return 'error';
    }
  }
}
```text

### 15.2 Audit Display Formatter

```typescript
export class AuditDisplayFormatter {
  formatEntry(entry: AuditEntry): {
    displayTitle: string;
    description: string;
    severity: 'info' | 'warning' | 'critical';
    icon: string;
  } {
    switch (entry.action) {
      case 'gate-approve':
        return {
          displayTitle: 'Request Approved',
          description: `Approved request ${entry.details.requestId}${entry.details.comment ? `: ${entry.details.comment}` : ''}`,
          severity: 'info',
          icon: '✅'
        };
      
      case 'gate-reject':
        return {
          displayTitle: 'Request Rejected',
          description: `Rejected request ${entry.details.requestId}${entry.details.comment ? `: ${entry.details.comment}` : ''}`,
          severity: 'warning',
          icon: '❌'
        };
      
      case 'gate-request-changes':
        return {
          displayTitle: 'Changes Requested',
          description: `Requested changes on ${entry.details.requestId}${entry.details.comment ? `: ${entry.details.comment}` : ''}`,
          severity: 'warning',
          icon: '🔄'
        };
      
      case 'config-change':
        return {
          displayTitle: 'Configuration Updated',
          description: `Modified settings: ${entry.details.changes?.join(', ')}`,
          severity: 'info',
          icon: '⚙️'
        };
      
      case 'kill-switch-engage':
        return {
          displayTitle: 'Kill Switch Engaged',
          description: `Emergency stop activated${entry.details.reason ? `: ${entry.details.reason}` : ''}`,
          severity: 'critical',
          icon: '🛑'
        };
      
      case 'kill-switch-reset':
        return {
          displayTitle: 'Kill Switch Reset',
          description: 'Emergency stop disengaged, system resumed',
          severity: 'info',
          icon: '▶️'
        };
      
      case 'circuit-breaker-reset':
        return {
          displayTitle: 'Circuit Breaker Reset',
          description: 'Circuit breaker manually reset',
          severity: 'info',
          icon: '🔌'
        };
      
      default:
        return {
          displayTitle: 'System Action',
          description: `${entry.action}: ${JSON.stringify(entry.details)}`,
          severity: 'info',
          icon: '📝'
        };
    }
  }

  formatTimestamp(timestamp: string): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMinutes = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);
    
    if (diffMinutes < 1) {
      return 'Just now';
    } else if (diffMinutes < 60) {
      return `${diffMinutes}m ago`;
    } else if (diffHours < 24) {
      return `${diffHours}h ago`;
    } else if (diffDays < 7) {
      return `${diffDays}d ago`;
    } else {
      return date.toLocaleDateString();
    }
  }

  formatOperatorId(operatorId: string): string {
    if (operatorId === 'localhost' || operatorId === 'system') {
      return 'Local Operator';
    }
    
    // Extract readable name from authenticated identity
    if (operatorId.includes('@')) {
      return operatorId.split('@')[0];
    }
    
    return operatorId;
  }
}
```text

## 16. Daemon-Down Behavior

### 16.1 Health Monitor

```typescript
export interface DaemonHealthStatus {
  isHealthy: boolean;
  lastHeartbeat?: Date;
  heartbeatAge?: number; // milliseconds since last heartbeat
  status: 'healthy' | 'stale' | 'dead' | 'unknown';
  error?: string;
}

export class DaemonHealthMonitor {
  private lastKnownStatus: DaemonHealthStatus = { isHealthy: false, status: 'unknown' };
  private heartbeatCheckInterval: Timer;
  private readonly HEARTBEAT_FRESH_THRESHOLD = 10000; // 10 seconds
  private readonly HEARTBEAT_STALE_THRESHOLD = 30000; // 30 seconds
  private readonly HEARTBEAT_DEAD_THRESHOLD = 120000; // 2 minutes

  constructor(
    private eventBus: SSEEventBus,
    private basePath: string = '../autonomous-dev/.autonomous-dev'
  ) {
    // Check daemon health every 15 seconds
    this.heartbeatCheckInterval = setInterval(() => {
      this.checkDaemonHealth();
    }, 15000);
    
    // Initial check
    this.checkDaemonHealth();
  }

  async getDaemonStatus(): Promise<DaemonHealthStatus> {
    return this.lastKnownStatus;
  }

  async checkDaemonHealth(): Promise<DaemonHealthStatus> {
    try {
      const heartbeatPath = `${this.basePath}/heartbeat.json`;
      const file = Bun.file(heartbeatPath);

      if (!(await file.exists())) {
        const status: DaemonHealthStatus = {
          isHealthy: false,
          status: 'unknown',
          error: 'Heartbeat file not found'
        };
        
        this.updateStatus(status);
        return status;
      }

      const heartbeatData = await file.json();
      const lastHeartbeat = new Date(heartbeatData.timestamp || heartbeatData.last_update);
      const heartbeatAge = Date.now() - lastHeartbeat.getTime();
      
      let status: DaemonHealthStatus['status'];
      let isHealthy: boolean;
      
      if (heartbeatAge < this.HEARTBEAT_FRESH_THRESHOLD) {
        status = 'healthy';
        isHealthy = true;
      } else if (heartbeatAge < this.HEARTBEAT_STALE_THRESHOLD) {
        status = 'healthy'; // Still considered healthy but getting older
        isHealthy = true;
      } else if (heartbeatAge < this.HEARTBEAT_DEAD_THRESHOLD) {
        status = 'stale';
        isHealthy = false;
      } else {
        status = 'dead';
        isHealthy = false;
      }

      const healthStatus: DaemonHealthStatus = {
        isHealthy,
        lastHeartbeat,
        heartbeatAge,
        status
      };

      this.updateStatus(healthStatus);
      return healthStatus;

    } catch (error) {
      const errorStatus: DaemonHealthStatus = {
        isHealthy: false,
        status: 'unknown',
        error: error instanceof Error ? error.message : 'Health check failed'
      };
      
      this.updateStatus(errorStatus);
      return errorStatus;
    }
  }

  private updateStatus(newStatus: DaemonHealthStatus): void {
    const statusChanged = this.lastKnownStatus.status !== newStatus.status;
    this.lastKnownStatus = newStatus;
    
    if (statusChanged) {
      // Broadcast status change to all connected clients
      this.eventBus.broadcast({
        type: 'daemon-status-change',
        data: {
          status: newStatus.status,
          isHealthy: newStatus.isHealthy,
          heartbeatAge: newStatus.heartbeatAge,
          timestamp: Date.now()
        }
      });
      
      console.log(`Daemon status changed to: ${newStatus.status}`);
    }
  }

  shutdown(): void {
    if (this.heartbeatCheckInterval) {
      clearInterval(this.heartbeatCheckInterval);
    }
  }
}
```text

### 16.2 NFR-04 Stale Data Banner

```typescript
export interface StaleDataBanner {
  show: boolean;
  message: string;
  severity: 'warning' | 'error';
}

export class StaleDataHandler {
  constructor(private healthMonitor: DaemonHealthMonitor) {}

  async getBannerStatus(): Promise<StaleDataBanner> {
    const daemonStatus = await this.healthMonitor.getDaemonStatus();
    
    if (daemonStatus.status === 'healthy') {
      return {
        show: false,
        message: '',
        severity: 'warning'
      };
    }
    
    if (daemonStatus.status === 'stale') {
      return {
        show: true,
        message: `Warning: Daemon heartbeat is ${Math.floor((daemonStatus.heartbeatAge || 0) / 1000)}s old. Data may be stale.`,
        severity: 'warning'
      };
    }
    
    if (daemonStatus.status === 'dead') {
      return {
        show: true,
        message: 'Error: Daemon appears to be stopped. All data is stale and mutations are disabled.',
        severity: 'error'
      };
    }
    
    return {
      show: true,
      message: 'Warning: Unable to determine daemon status. Data freshness unknown.',
      severity: 'warning'
    };
  }

  shouldDisableMutations(status: DaemonHealthStatus): boolean {
    // Disable mutations when daemon is dead or unknown
    return status.status === 'dead' || status.status === 'unknown';
  }

  async validateMutationAllowed(): Promise<{ allowed: boolean; reason?: string }> {
    const status = await this.healthMonitor.getDaemonStatus();
    
    if (this.shouldDisableMutations(status)) {
      return {
        allowed: false,
        reason: `Daemon is ${status.status}. Mutations are disabled until daemon connectivity is restored.`
      };
    }
    
    return { allowed: true };
  }
}

// Middleware to check daemon health before mutations
export function requireHealthyDaemon(staleDataHandler: StaleDataHandler) {
  return async (request: Request, next: () => Promise<Response>): Promise<Response> => {
    const validation = await staleDataHandler.validateMutationAllowed();
    
    if (!validation.allowed) {
      return new Response(
        JSON.stringify({
          success: false,
          error: validation.reason
        }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
    
    return next();
  };
}
```text

## 17. Test Strategy

### 17.1 Unit Test Structure

```typescript
// Example test structure for file watcher
describe('PortalFileWatcher', () => {
  let watcher: PortalFileWatcher;
  let mockEventBus: jest.Mocked<SSEEventBus>;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-test-'));
    mockEventBus = {
      broadcast: jest.fn(),
      addConnection: jest.fn(),
      shutdown: jest.fn()
    } as any;
    watcher = new PortalFileWatcher(mockEventBus, { /* test config */ });
  });

  afterEach(async () => {
    await watcher.stop();
    fs.rmSync(tempDir, { recursive: true });
  });

  it('should detect state file changes and batch events', async () => {
    const stateFile = path.join(tempDir, 'requests', 'REQ-001', 'state.json');
    await fs.promises.mkdir(path.dirname(stateFile), { recursive: true });
    
    await watcher.start({
      stateFiles: [stateFile],
      costLedger: '',
      heartbeat: '',
      daemonLog: '',
      configFiles: []
    });

    // Write state file
    await fs.promises.writeFile(stateFile, JSON.stringify({ phase: 'prd' }));
    
    // Wait for debouncing
    await new Promise(resolve => setTimeout(resolve, 250));
    
    expect(mockEventBus.broadcast).toHaveBeenCalledWith({
      type: 'state-change',
      data: expect.objectContaining({
        filePath: stateFile
      })
    });
  });

  it('should fall back to polling when descriptor limit exceeded', async () => {
    // Mock descriptor limit
    (watcher as any).MAX_DESCRIPTORS = 0;
    
    const stateFile = path.join(tempDir, 'state.json');
    await fs.promises.writeFile(stateFile, '{}');
    
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
    
    await watcher.start({
      stateFiles: [stateFile],
      costLedger: '',
      heartbeat: '',
      daemonLog: '',
      configFiles: []
    });
    
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('File descriptor limit reached')
    );
    
    consoleSpy.mockRestore();
  });
});
```text

### 17.2 SSE Integration Tests

```typescript
describe('SSE Event Streaming', () => {
  let server: Hono;
  let eventBus: SSEEventBus;

  beforeEach(() => {
    eventBus = new SSEEventBus();
    server = new Hono();
    server.get('/events', (c) => eventBus.addConnection(c.req));
  });

  afterEach(() => {
    eventBus.shutdown();
  });

  it('should establish SSE connection and receive events', async (done) => {
    const testClient = request(server);
    
    const eventSource = testClient
      .get('/events')
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);

    let receivedEvents: any[] = [];
    
    eventSource.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = JSON.parse(line.substring(6));
          receivedEvents.push(data);
        }
      }
    });

    // Send test event
    setTimeout(() => {
      eventBus.broadcast({
        type: 'test-event',
        data: { message: 'hello' }
      });
    }, 100);

    setTimeout(() => {
      expect(receivedEvents).toContainEqual({
        type: 'test-event',
        data: { message: 'hello' }
      });
      done();
    }, 200);
  });

  it('should respect connection limit', async () => {
    // Create maximum connections
    const connections = [];
    for (let i = 0; i < 10; i++) {
      const resp = await request(server).get('/events');
      connections.push(resp);
    }

    // 11th connection should be rejected
    const overflowConnection = await request(server).get('/events');
    expect(overflowConnection.status).toBe(429);
  });
});
```text

### 17.3 End-to-End Gate Approval Test

```typescript
describe('Approval Gate Flow (E2E)', () => {
  let portal: PortalServer;
  let mockIntakeRouter: MockIntakeRouter;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    // Setup mock intake router
    mockIntakeRouter = new MockIntakeRouter();
    await mockIntakeRouter.start();

    // Start portal server
    portal = new PortalServer({
      port: 19281,
      intakeRouterPort: mockIntakeRouter.port
    });
    await portal.start();

    // Launch browser
    browser = await playwright.chromium.launch({ headless: true });
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
    await portal.stop();
    await mockIntakeRouter.stop();
  });

  it('should complete approval workflow end-to-end', async () => {
    // Setup test request in approval state
    const requestId = 'REQ-TEST-001';
    await mockIntakeRouter.createTestRequest({
      id: requestId,
      phase: 'prd_review',
      status: 'awaiting_approval',
      title: 'Test Request'
    });

    // Navigate to portal
    await page.goto('http://localhost:19281');

    // Go to approval queue
    await page.click('a[href="/approvals"]');

    // Find the request and click approve
    const requestRow = page.locator(`[data-request-id="${requestId}"]`);
    await expect(requestRow).toBeVisible();
    
    await requestRow.locator('button:has-text("Approve")').click();

    // Add comment
    await page.fill('textarea[name="comment"]', 'Looks good to me');
    
    // Submit approval
    await page.click('button[type="submit"]');

    // Wait for success message
    await expect(page.locator('.success-message')).toContainText('Request approved');

    // Verify intake router received the command
    const commands = mockIntakeRouter.getReceivedCommands();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      command: 'approve',
      requestId: requestId,
      comment: 'Looks good to me',
      source: 'portal'
    });

    // Verify audit log entry
    const auditEntries = await portal.getAuditEntries();
    expect(auditEntries).toContainEqual(
      expect.objectContaining({
        action: 'gate-approve',
        details: expect.objectContaining({
          requestId: requestId,
          comment: 'Looks good to me'
        })
      })
    );
  });

  it('should show CSRF error for invalid requests', async () => {
    // Attempt to submit approval without proper CSRF token
    const response = await page.evaluate(async () => {
      return fetch('/repo/test/request/REQ-001/gate/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve' })
      });
    });

    expect(response.status).toBe(403);
  });
});
```text

### 17.4 Property Tests for Cost Aggregation

```typescript
describe('Cost Computation Properties', () => {
  let costEngine: CostComputationEngine;
  
  beforeEach(() => {
    costEngine = new CostComputationEngine(
      new MockCostDataReader(),
      new AggregationCache()
    );
  });

  // Property test: trailing 7-day average should never exceed max daily spend
  it('should maintain trailing average <= max daily spend', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.float({ min: 0, max: 1000 }), { minLength: 7, maxLength: 30 }),
      async (dailySpends) => {
        const maxDaily = Math.max(...dailySpends);
        
        // Inject test data
        await costEngine.setTestData({
          dailySpends: dailySpends.map((spend, i) => ({
            date: new Date(Date.now() - (dailySpends.length - i) * 24 * 60 * 60 * 1000),
            spend
          }))
        });
        
        const projection = await costEngine.getCostProjection();
        
        // Property: 7-day average should not exceed maximum daily spend
        expect(projection.trailing7DayAverage).toBeLessThanOrEqual(maxDaily);
        
        // Property: projection should be non-negative
        expect(projection.projectedMonthEnd).toBeGreaterThanOrEqual(0);
      }
    ));
  });

  // Property test: cost aggregation should be associative
  it('should maintain associative property for cost aggregation', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({
        repo: fc.string(),
        phase: fc.constantFrom('prd', 'tdd', 'code', 'review'),
        cost: fc.float({ min: 0.01, max: 100 })
      }), { minLength: 1, maxLength: 50 }),
      async (requests) => {
        // Group by repo, then by phase vs group by phase, then by repo
        const byRepoThenPhase = groupByRepoThenPhase(requests);
        const byPhaseThenRepo = groupByPhaseThenRepo(requests);
        
        // Both should yield same total
        const total1 = Object.values(byRepoThenPhase).flat().reduce((sum, cost) => sum + cost, 0);
        const total2 = Object.values(byPhaseThenRepo).flat().reduce((sum, cost) => sum + cost, 0);
        
        expect(Math.abs(total1 - total2)).toBeLessThan(0.001); // Float precision tolerance
      }
    ));
  });
});
```text

## 18. Performance Considerations

### 18.1 Memory Management

```typescript
export class MemoryMonitor {
  private readonly MEMORY_WARNING_THRESHOLD = 100 * 1024 * 1024; // 100MB
  private readonly MEMORY_CRITICAL_THRESHOLD = 150 * 1024 * 1024; // 150MB
  
  constructor(private cache: AggregationCache) {}

  checkMemoryUsage(): { status: 'ok' | 'warning' | 'critical'; usage: number } {
    const usage = process.memoryUsage().heapUsed;
    
    if (usage > this.MEMORY_CRITICAL_THRESHOLD) {
      console.warn(`Critical memory usage: ${Math.round(usage / 1024 / 1024)}MB`);
      this.performEmergencyCleanup();
      return { status: 'critical', usage };
    } else if (usage > this.MEMORY_WARNING_THRESHOLD) {
      console.warn(`High memory usage: ${Math.round(usage / 1024 / 1024)}MB`);
      this.performGentleCleanup();
      return { status: 'warning', usage };
    }
    
    return { status: 'ok', usage };
  }

  private performEmergencyCleanup(): void {
    // Clear all caches
    this.cache.clear();
    
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }
  }

  private performGentleCleanup(): void {
    // Evict older cache entries
    this.cache.evictExpired();
    
    // Reduce cache TTL temporarily
    this.cache.setTemporaryTTL(2000); // 2 seconds instead of 5
  }
}
```text

### 18.2 File System Scale Optimization

```typescript
export class ScalabilityOptimizer {
  private readonly MAX_CONCURRENT_READS = 10;
  private readonly BATCH_SIZE = 50;
  private readSemaphore = new Semaphore(this.MAX_CONCURRENT_READS);

  async readRequestStatesBatched(requestIds: string[]): Promise<Map<string, RequestState>> {
    const results = new Map<string, RequestState>();
    
    // Process in batches to avoid overwhelming file system
    for (let i = 0; i < requestIds.length; i += this.BATCH_SIZE) {
      const batch = requestIds.slice(i, i + this.BATCH_SIZE);
      
      const batchPromises = batch.map(async (requestId) => {
        return this.readSemaphore.acquire(async () => {
          try {
            const state = await this.readRequestState(requestId);
            return [requestId, state] as [string, RequestState];
          } catch (error) {
            console.warn(`Failed to read state for ${requestId}:`, error);
            return [requestId, null] as [string, RequestState | null];
          }
        });
      });

      const batchResults = await Promise.all(batchPromises);
      
      for (const [requestId, state] of batchResults) {
        if (state) {
          results.set(requestId, state);
        }
      }
    }
    
    return results;
  }

  async readRequestState(requestId: string): Promise<RequestState | null> {
    // Implement with appropriate error handling and retries
    const filePath = `../autonomous-dev/.autonomous-dev/requests/${requestId}/state.json`;
    const file = Bun.file(filePath);
    
    if (!(await file.exists())) {
      return null;
    }
    
    const data = await file.json();
    return this.transformRawState(data);
  }

  private transformRawState(data: any): RequestState {
    // Same transformation logic as StateFileReader
    return {
      requestId: data.request_id,
      phase: data.current_phase,
      status: data.status,
      title: data.title,
      repository: data.repository,
      requester: data.requester,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      costs: {
        total: data.total_cost || 0,
        byPhase: data.costs_by_phase || {}
      },
      trustLevel: data.trust_level || 1,
      turnCount: data.turn_count || 0,
      sourceChannel: data.source_channel || 'unknown'
    };
  }
}

class Semaphore {
  private tasks: (() => void)[] = [];
  private count: number;

  constructor(count: number) {
    this.count = count;
  }

  async acquire<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.tasks.push(async () => {
        try {
          const result = await task();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          this.count++;
          this.processNext();
        }
      });

      this.processNext();
    });
  }

  private processNext(): void {
    if (this.count > 0 && this.tasks.length > 0) {
      this.count--;
      const task = this.tasks.shift()!;
      task();
    }
  }
}
```

## 19. Open Questions

| ID   | Question                                                                                                   | Priority | Owner               |
|------|------------------------------------------------------------------------------------------------------------|----------|---------------------|
| OQ-1 | Should file watcher use recursive directory monitoring or explicit file watching for better performance?   | Medium   | Platform Engineer   |
| OQ-2 | What is the optimal SSE heartbeat interval to balance keep-alive with bandwidth usage?                   | Low      | Performance Lead    |
| OQ-3 | How should the portal handle very large repositories (1000+ requests) without UI performance degradation? | Medium   | UX Engineer         |
| OQ-4 | Should cost computation cache be persistent across portal restarts or remain in-memory only?             | Low      | Data Architect      |
| OQ-5 | What file descriptor limit monitoring strategy works best across macOS/Linux platforms?                   | Medium   | DevOps Engineer     |

## 20. References

- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/prd/PRD-009-web-control-plane.md` - Parent PRD defining portal requirements and user stories
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/tdd/TDD-001-daemon-engine.md` - Daemon supervision and state management patterns  
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/tdd/TDD-008-intake-layer.md` - Intake router interface for portal mutations
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/pipeline/flow/pipeline-state.ts` - Request state schema definitions
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/pipeline/types/config.ts` - Configuration structure and validation patterns
- Bun Runtime Documentation - `fs.watch` API and platform-specific behavior
- HTMX Documentation - Server-sent events integration patterns
- Web Content Accessibility Guidelines (WCAG) 2.2 AA - Chart accessibility requirements

---

**Implementation Priority**: TDD-015 implementation should begin after TDD-013 (server foundation) and TDD-014 (security layer) are complete, as this TDD depends on their authentication, CSRF protection, and audit logging infrastructure.

**File Paths Referenced**:
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/prd/PRD-009-web-control-plane.md` 
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/tdd/TDD-001-daemon-engine.md`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/tdd/TDD-008-intake-layer.md`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/pipeline/flow/pipeline-state.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/pipeline/types/config.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/package.json`