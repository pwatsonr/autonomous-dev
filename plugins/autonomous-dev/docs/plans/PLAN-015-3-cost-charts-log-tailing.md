# PLAN-015-3: Cost Analysis + SVG Charts + Log Tailing

## Metadata

- **Title**: Cost Analysis Dashboard with SVG Charts and Log Tailing
- **Parent TDD**: TDD-015-portal-live-data-settings
- **Estimated effort**: 3-4 days  
- **Dependencies**: ["PLAN-015-1"]
- **Blocked by**: []
- **Priority**: P1
- **Author**: Plan Author Agent
- **Date**: 2026-04-17
- **Version**: 1.0

### Summary
Implement comprehensive cost tracking and visualization capabilities with server-side SVG chart generation and real-time log tailing functionality. This plan delivers daily/monthly cost aggregation, per-repository and per-phase cost breakdowns, interactive charts rendered as SVG on the server, and live log streaming with filtering capabilities.

### Total Estimated Effort
- **Total**: 28 hours (3.5 days)
- **Critical path length**: 22 hours across 8 sequential tasks
- **Number of parallel tracks**: 3

### Critical Path
The critical path flows through: TASK-001 → TASK-002 → TASK-003 → TASK-004 → TASK-007 → TASK-008 → TASK-009 → TASK-010

## Scope

### In-Scope

**Cost Analysis & Aggregation:**
- Cost ledger aggregation from `cost-ledger.json` with date bucketing for daily/monthly views
- Per-repository breakdown showing cost attribution across different repositories
- Per-phase breakdown showing costs across PRD/TDD/Plan/Spec/Code/Review/Deploy phases
- Top-10 most expensive requests identification with drill-down links to request detail pages
- 7-day trailing projection using simple averaging algorithm (no ML complexity per PR-8 review)
- Cost cap monitoring showing current daily/monthly spend vs. configured limits
- Month-end projection based on current burn rate

**SVG Chart Rendering:**
- Server-side SVG generation without client-side JavaScript dependencies
- Daily spend line chart covering last 30 days with trend visualization
- Monthly spend bar chart covering last 12 months
- Accessibility features including `<title>`, `<desc>`, and ARIA labels for screen readers
- Color-blind safe palette implementation
- Responsive scaling and proper axis labeling
- Grid lines and value annotations for chart readability

**Cost Page Implementation:**
- Route handler for `/cost` endpoint with HTMX-aware response logic
- Full page rendering vs. fragment refresh based on request headers
- Integration with existing portal authentication and session management
- Per-repository and per-phase breakdown tables with sortable columns
- Cost cap status indicators with visual alerts for approaching limits

**Log Tailing Infrastructure:**
- Route handler for `/logs` endpoint displaying last 500 lines from `daemon.log`
- Live log appending via Server-Sent Events (SSE) using log-line event type
- Log filtering by level (ERROR/WARN/INFO/DEBUG), request ID exact match, and time range
- Time range filters for last 1h/4h/24h with server-side log reduction
- Filter implementation using HTMX hx-include pattern for seamless UX
- Gzip download endpoint for last 24 hours of logs with proper compression headers

### Out-of-Scope

**Deferred to Other Plans:**
- File watcher and SSE infrastructure (handled by PLAN-015-1)
- Approval gates and settings management (handled by PLAN-015-2) 
- Operational endpoints and audit trails (handled by PLAN-015-4)
- Authentication and authorization (handled by PLAN-014-* series)
- Advanced analytics or machine learning cost predictions
- Real-time cost tracking during active requests
- Cost alerting via external channels (email/SMS/Slack)

## Task List

### TASK-001: Cost Ledger Data Models and Aggregation Engine
- **ID**: TASK-001
- **Title**: Implement Cost Aggregation and Data Models
- **Description**: Create the `CostAggregator` class responsible for reading and processing `cost-ledger.json` entries. Implement date bucketing algorithms for daily and monthly rollups, per-repository attribution, and per-phase cost categorization. Design efficient data structures for rapid aggregation queries.
- **Files**: 
  - `/src/portal/cost/CostAggregator.ts`
  - `/src/portal/cost/types.ts`
  - `/src/portal/cost/queries.ts`
- **Dependencies**: []
- **Acceptance Criteria**: 
  - CostAggregator can read cost-ledger.json and parse entries correctly
  - Daily bucketing produces accurate sums for each calendar date
  - Monthly bucketing aggregates to calendar month boundaries  
  - Per-repository breakdown correctly attributes costs using repository field
  - Per-phase breakdown maps request phases to cost categories
  - Top-10 expensive requests query returns sorted results with drill-down URLs
  - 7-day projection algorithm uses simple trailing average
- **Lint/Test Commands**: `npm run test:unit -- cost/CostAggregator.test.ts && npm run lint`
- **Estimated Effort**: 4 hours
- **Track**: Track 1 (Core)
- **Risks**: 
  - Medium: Cost ledger format may vary between request types - Mitigation: Implement robust JSON parsing with schema validation
  - Low: Large cost ledgers may cause memory issues - Mitigation: Implement streaming parser for files >10MB

```typescript
// Core interfaces for cost aggregation
interface CostLedgerEntry {
  timestamp: string;
  request_id: string;
  repository: string;
  phase: 'PRD' | 'TDD' | 'Plan' | 'Spec' | 'Code' | 'Review' | 'Deploy';
  cost_tokens: number;
  cost_usd: number;
  model: string;
  operation: string;
}

interface DailyCostSummary {
  date: string; // YYYY-MM-DD
  total_cost_usd: number;
  total_tokens: number;
  request_count: number;
}

interface MonthlyCostSummary {
  month: string; // YYYY-MM
  total_cost_usd: number;
  total_tokens: number;
  request_count: number;
}

class CostAggregator {
  async loadLedger(filePath: string): Promise<CostLedgerEntry[]>;
  aggregateByDay(entries: CostLedgerEntry[], startDate: string, endDate: string): DailyCostSummary[];
  aggregateByMonth(entries: CostLedgerEntry[], startMonth: string, endMonth: string): MonthlyCostSummary[];
  aggregateByRepository(entries: CostLedgerEntry[]): Map<string, number>;
  aggregateByPhase(entries: CostLedgerEntry[]): Map<string, number>;
  getTopExpensiveRequests(entries: CostLedgerEntry[], limit: number): Array<{request_id: string, cost: number, repository: string}>;
  projectSevenDaySpend(recentEntries: CostLedgerEntry[]): number;
}
```

### TASK-002: SVG Line Chart Generator for Daily Spend
- **ID**: TASK-002  
- **Title**: Daily Spend Line Chart SVG Generator
- **Description**: Implement `SVGLineChart` class that generates daily spend visualization as pure SVG markup. Include axis rendering, grid lines, data point plotting, trend lines, and accessibility metadata. Chart must be responsive and render correctly without JavaScript.
- **Files**:
  - `/src/portal/charts/SVGLineChart.ts`
  - `/src/portal/charts/ChartBase.ts`
  - `/src/portal/charts/accessibility.ts`
- **Dependencies**: [TASK-001]
- **Acceptance Criteria**:
  - SVG output is valid XML that renders in all major browsers
  - X-axis shows dates with appropriate spacing and rotation for readability
  - Y-axis shows cost values with currency formatting ($0.00)
  - Grid lines provide visual reference points
  - Data points are connected with smooth lines
  - Hover areas provide tooltips via SVG `<title>` elements
  - Color palette is color-blind safe (uses shapes + colors for differentiation)
  - Chart scales correctly for both high and low spend ranges
  - Accessibility: proper `<title>`, `<desc>`, and ARIA labels
- **Lint/Test Commands**: `npm run test:unit -- charts/SVGLineChart.test.ts && npm run lint`  
- **Estimated Effort**: 3 hours
- **Track**: Track 1 (Core)
- **Risks**:
  - High: SVG text positioning may break on different browsers - Mitigation: Use standard SVG text positioning and test across Chrome/Firefox/Safari
  - Medium: Date axis labels may overlap on narrow displays - Mitigation: Implement responsive label rotation and selective label display

```typescript
interface ChartDataPoint {
  date: string;
  value: number;
  label?: string;
}

class SVGLineChart {
  constructor(
    private width: number = 800,
    private height: number = 400,
    private margins = { top: 20, right: 30, bottom: 40, left: 60 }
  ) {}

  render(data: ChartDataPoint[], title: string): string {
    // Returns complete SVG markup string
  }

  private renderAxes(data: ChartDataPoint[]): string;
  private renderGridlines(data: ChartDataPoint[]): string; 
  private renderDataLine(data: ChartDataPoint[]): string;
  private renderDataPoints(data: ChartDataPoint[]): string;
  private renderAccessibility(title: string, description: string): string;
  private scaleX(date: string): number;
  private scaleY(value: number): number;
}
```

### TASK-003: SVG Bar Chart Generator for Monthly Spend  
- **ID**: TASK-003
- **Title**: Monthly Spend Bar Chart SVG Generator
- **Description**: Implement `SVGBarChart` class for monthly spend visualization. Focus on clear bar rendering, value labels, comparative analysis between months, and consistent styling with the line chart component.
- **Files**:
  - `/src/portal/charts/SVGBarChart.ts`
  - `/src/portal/charts/ChartBase.ts` (extend from TASK-002)
- **Dependencies**: [TASK-002]
- **Acceptance Criteria**:
  - Bars render with consistent width and spacing
  - Month labels display clearly on X-axis (MMM YYYY format)
  - Value labels appear above each bar with currency formatting
  - Bars use color gradient or pattern to indicate relative spend levels
  - Zero-value months display placeholder bars for consistency
  - Chart handles edge cases (no data, single month, very large values)
  - Accessibility metadata matches line chart implementation
  - Visual consistency with daily spend chart (colors, fonts, spacing)
- **Lint/Test Commands**: `npm run test:unit -- charts/SVGBarChart.test.ts && npm run lint`
- **Estimated Effort**: 2.5 hours
- **Track**: Track 1 (Core)
- **Risks**:
  - Medium: Bar width calculation may cause overflow on many months - Mitigation: Implement adaptive bar width based on data count
  - Low: Value label positioning may overlap with bars - Mitigation: Use configurable label offset and collision detection

### TASK-004: Cost Dashboard Page Handler
- **ID**: TASK-004
- **Title**: Cost Dashboard Route Handler and Page Rendering
- **Description**: Create the `/cost` endpoint handler that integrates cost aggregation with chart generation. Implement HTMX-aware response logic for both full page loads and partial updates, cost cap status monitoring, and responsive layout.
- **Files**:
  - `/src/portal/routes/cost.ts`
  - `/src/portal/templates/cost-dashboard.hbs`
  - `/src/portal/components/cost-summary.hbs`
  - `/src/portal/components/cost-breakdown.hbs`
- **Dependencies**: [TASK-001, TASK-002, TASK-003]
- **Acceptance Criteria**:
  - GET /cost returns full dashboard page with charts and tables
  - HTMX requests (HX-Request header) return only updated fragments
  - Daily and monthly charts render correctly in page layout
  - Per-repository breakdown table is sortable and searchable
  - Per-phase breakdown shows clear cost attribution
  - Top-10 expensive requests include drill-down links to /requests/:id
  - Cost cap status shows current vs. limit with visual indicators
  - 7-day projection displays prominently with trend indicator
  - Page loads in under 2 seconds with typical cost ledger size
  - Mobile responsive layout works on 320px+ screens
- **Lint/Test Commands**: `npm run test:integration -- routes/cost.test.ts && npm run lint`
- **Estimated Effort**: 4 hours  
- **Track**: Track 1 (Core)
- **Risks**:
  - High: Large cost ledgers may cause page timeout - Mitigation: Implement pagination for breakdowns and chart data sampling
  - Medium: HTMX fragment updates may break chart rendering - Mitigation: Use stable chart container IDs and test fragment replacement

### TASK-005: Log Filter Implementation
- **ID**: TASK-005
- **Title**: Log Filtering Logic and Query Processing
- **Description**: Implement `LogFilter` class that processes daemon.log entries according to level, request ID, and time range filters. Design efficient filtering algorithms that work with large log files and integrate with HTMX form submissions.
- **Files**:
  - `/src/portal/logs/LogFilter.ts`
  - `/src/portal/logs/LogParser.ts`
  - `/src/portal/logs/types.ts`
- **Dependencies**: []
- **Acceptance Criteria**:
  - Level filter correctly matches ERROR/WARN/INFO/DEBUG entries
  - Request ID filter performs exact string match on request_id field
  - Time range filter supports 1h/4h/24h relative to current time
  - Filters can be combined (AND logic) for precise log narrowing
  - Filter processing completes in <500ms for 10K log entries
  - Malformed log entries are skipped gracefully with warning count
  - Filter state is serializable for URL query parameters
- **Lint/Test Commands**: `npm run test:unit -- logs/LogFilter.test.ts && npm run lint`
- **Estimated Effort**: 2 hours
- **Track**: Track 2 (Logs)
- **Risks**:
  - Medium: Log parsing may fail on malformed JSON entries - Mitigation: Implement robust JSON parsing with error recovery
  - Low: Large log files may cause memory issues - Mitigation: Implement streaming line reader for files >50MB

```typescript
interface LogEntry {
  timestamp: string;
  level: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';
  pid: number;
  iteration: number;
  message: string;
  request_id?: string;
  context?: Record<string, any>;
}

interface LogFilterCriteria {
  level?: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';
  request_id?: string;
  time_range?: '1h' | '4h' | '24h';
  start_time?: string;
  end_time?: string;
}

class LogFilter {
  apply(entries: LogEntry[], criteria: LogFilterCriteria): LogEntry[];
  private matchesLevel(entry: LogEntry, level?: string): boolean;
  private matchesRequestId(entry: LogEntry, requestId?: string): boolean;
  private withinTimeRange(entry: LogEntry, range?: string): boolean;
}
```

### TASK-006: Log Tailing Route Handler
- **ID**: TASK-006
- **Title**: Log Tailing HTTP Route and SSE Integration  
- **Description**: Create `/logs` endpoint that displays recent log entries with filtering UI and integrates with SSE stream from PLAN-015-1 for live updates. Implement gzip download endpoint for log export functionality.
- **Files**:
  - `/src/portal/routes/logs.ts`
  - `/src/portal/templates/log-viewer.hbs`
  - `/src/portal/components/log-filter-form.hbs`
  - `/src/portal/components/log-entry.hbs`
- **Dependencies**: [TASK-005]
- **Acceptance Criteria**:
  - GET /logs displays last 500 log entries with filter form
  - Filter form uses HTMX to update log display without page reload
  - SSE connection automatically appends new log entries matching current filters
  - Log entries display with proper timestamp formatting and level styling
  - Filter persistence maintains state across page refreshes via URL params
  - GET /logs/download returns gzipped log file with proper headers
  - Log viewer handles rapid log updates without UI blocking
  - Error states (log file missing, parse errors) display user-friendly messages
- **Lint/Test Commands**: `npm run test:integration -- routes/logs.test.ts && npm run lint`
- **Estimated Effort**: 3 hours
- **Track**: Track 2 (Logs)  
- **Risks**:
  - High: SSE connection drops may cause missed log entries - Mitigation: Implement connection recovery and last-seen timestamp tracking
  - Medium: Rapid log updates may overwhelm browser rendering - Mitigation: Implement client-side rate limiting and batch updates

### TASK-007: Chart Accessibility and Color-Blind Support
- **ID**: TASK-007
- **Title**: Chart Accessibility Features and Color-Blind Safe Palette
- **Description**: Enhance SVG charts with comprehensive accessibility support including screen reader compatibility, keyboard navigation, and color-blind safe visual design. Implement WCAG 2.1 AA compliance.
- **Files**:
  - `/src/portal/charts/accessibility.ts`
  - `/src/portal/charts/ColorPalette.ts`
  - Update: `/src/portal/charts/SVGLineChart.ts`
  - Update: `/src/portal/charts/SVGBarChart.ts`
- **Dependencies**: [TASK-002, TASK-003]
- **Acceptance Criteria**:
  - Charts include proper ARIA roles and labels
  - Screen readers can navigate chart data via tabular fallback
  - Color palette provides 4.5:1 contrast ratio for all text
  - Color-blind safe palette tested with simulators (protanopia, deuteranopia, tritanopia)
  - Charts use both color and pattern/shape for data differentiation
  - Keyboard navigation allows focus cycling through data points
  - Chart data available as hidden table for assistive technology
  - All accessibility features work without JavaScript
- **Lint/Test Commands**: `npm run test:a11y -- charts/ && npm run lint`
- **Estimated Effort**: 2 hours
- **Track**: Track 3 (Polish)
- **Risks**:
  - Medium: Accessibility features may conflict with visual design - Mitigation: Implement progressive enhancement that preserves visual appeal
  - Low: Screen reader testing may reveal navigation issues - Mitigation: Test with multiple screen readers (NVDA, JAWS, VoiceOver)

### TASK-008: Cost Cap Monitoring and Alerts
- **ID**: TASK-008  
- **Title**: Cost Cap Status Monitoring and Visual Indicators
- **Description**: Implement cost cap monitoring that compares current spend against configured daily/monthly limits. Create visual indicators and status calculations for the cost dashboard.
- **Files**:
  - `/src/portal/cost/CostCapMonitor.ts`
  - `/src/portal/components/cost-cap-status.hbs`
  - Update: `/src/portal/routes/cost.ts`
- **Dependencies**: [TASK-001, TASK-004]
- **Acceptance Criteria**:
  - Daily cost cap comparison shows current vs. limit with percentage
  - Monthly cost cap includes month-to-date spend and projected total
  - Visual indicators use color coding (green/yellow/red) for status levels
  - Cost cap status updates in real-time via HTMX polling
  - Approaching limits (80%+) display warning messages
  - Exceeded limits display prominent alert styling
  - Historical cap breach tracking for trend analysis
  - Cost cap configuration reads from portal settings
- **Lint/Test Commands**: `npm run test:unit -- cost/CostCapMonitor.test.ts && npm run lint`
- **Estimated Effort**: 2 hours
- **Track**: Track 1 (Core)
- **Risks**:
  - Low: Cost cap calculations may have timezone issues - Mitigation: Use consistent UTC timestamps and proper date arithmetic
  - Low: Real-time updates may cause UI flicker - Mitigation: Implement smooth transitions and update debouncing

### TASK-009: Gzip Log Download Endpoint
- **ID**: TASK-009
- **Title**: Compressed Log Download and Export Functionality
- **Description**: Create endpoint for downloading recent logs as compressed files with proper HTTP headers, integrity verification, and progress indication for large files.
- **Files**:
  - `/src/portal/routes/logs-download.ts`
  - `/src/portal/utils/compression.ts`
- **Dependencies**: [TASK-005, TASK-006]
- **Acceptance Criteria**:
  - GET /logs/download/{timeRange} returns gzipped log data
  - Supports time ranges: 1h, 4h, 24h with proper filtering
  - HTTP headers include content-type, content-encoding, content-length
  - File integrity verified via checksum in response headers
  - Large log files (>10MB) use streaming compression
  - Download filename includes timestamp range for organization
  - Progress indication for downloads >5MB
  - Proper error handling for missing/corrupted log files
- **Lint/Test Commands**: `npm run test:integration -- routes/logs-download.test.ts && npm run lint`
- **Estimated Effort**: 1.5 hours
- **Track**: Track 2 (Logs)
- **Risks**:
  - Medium: Large log compression may cause server timeout - Mitigation: Implement streaming compression with chunk processing
  - Low: Browser download handling may vary - Mitigation: Use standard HTTP download patterns and test across browsers

### TASK-010: Integration Testing and End-to-End Validation
- **ID**: TASK-010
- **Title**: Comprehensive Testing of Cost Analysis and Log Tailing Features
- **Description**: Develop integration tests that validate the complete cost analysis and log tailing workflows from data ingestion through user interaction. Test HTMX interactions, SSE connections, and chart rendering.
- **Files**:
  - `/tests/integration/cost-dashboard.test.ts`
  - `/tests/integration/log-tailing.test.ts`
  - `/tests/e2e/cost-workflow.test.ts`
  - `/tests/fixtures/cost-ledger-sample.json`
  - `/tests/fixtures/daemon-log-sample.jsonl`
- **Dependencies**: [TASK-004, TASK-006, TASK-007, TASK-008, TASK-009]
- **Acceptance Criteria**:
  - Cost dashboard loads with real sample data in under 2 seconds
  - Chart rendering produces pixel-perfect SVG output matching snapshots
  - Log filtering reduces 1000+ entries to correct subset in under 500ms
  - HTMX partial updates work correctly for both cost and log pages
  - SSE log streaming handles connection drops and recovery gracefully
  - Gzip download produces files that decompress to original content
  - Mobile responsive layout works correctly on 320px and 768px viewports
  - All accessibility features pass automated and manual testing
  - Performance benchmarks meet requirements under load
- **Lint/Test Commands**: `npm run test:integration && npm run test:e2e && npm run lint`
- **Estimated Effort**: 3 hours
- **Track**: Track 1 (Core)
- **Risks**:
  - High: Integration tests may be brittle with timing dependencies - Mitigation: Use deterministic test data and proper async waiting patterns
  - Medium: E2E tests may fail due to environment differences - Mitigation: Use containerized test environment and stable test fixtures

## Dependency Graph

```
TASK-001 (Cost Aggregator)
    ↓
TASK-002 (SVG Line Chart) → TASK-003 (SVG Bar Chart)
    ↓                           ↓
TASK-004 (Cost Dashboard) ← ————┘
    ↓
TASK-008 (Cost Cap Monitor)
    ↓
TASK-010 (Integration Testing)

TASK-005 (Log Filter)
    ↓
TASK-006 (Log Tailing) → TASK-009 (Gzip Download)
    ↓                        ↓
TASK-010 (Integration Testing) ←┘

TASK-002/TASK-003 → TASK-007 (Accessibility)
                        ↓
                   TASK-010 (Integration Testing)
```

**Critical Path**: TASK-001 → TASK-002 → TASK-003 → TASK-004 → TASK-008 → TASK-010 (22 hours)

## Parallel Execution Schedule

### Track 1 (Core) - 15 hours
1. TASK-001: Cost Aggregator (4h) [Day 1]
2. TASK-002: SVG Line Chart (3h) [Day 1] 
3. TASK-003: SVG Bar Chart (2.5h) [Day 2]
4. TASK-004: Cost Dashboard (4h) [Day 2-3]
5. TASK-008: Cost Cap Monitor (2h) [Day 3]
6. TASK-010: Integration Testing (3h) [Day 4]

### Track 2 (Logs) - 6.5 hours  
1. TASK-005: Log Filter (2h) [Day 1]
2. TASK-006: Log Tailing (3h) [Day 2]
3. TASK-009: Gzip Download (1.5h) [Day 3]

### Track 3 (Polish) - 2 hours
1. TASK-007: Accessibility (2h) [Day 3, after TASK-002/003 complete]

**Total Wall-Clock Time**: 3.5 days with 3 parallel tracks
**Total Effort**: 28 hours across all tracks

## Test Coverage Strategy

### Unit Tests (60% of testing effort)
- **Cost Aggregation**: Date bucketing accuracy, repository attribution, phase categorization
- **Chart Generation**: SVG output validation, axis scaling, accessibility metadata  
- **Log Filtering**: Filter combinations, edge cases, performance with large datasets
- **Utilities**: Compression, date handling, string manipulation

### Integration Tests (25% of testing effort)  
- **Route Handlers**: Full request/response cycles, HTMX header handling
- **Template Rendering**: Handlebars compilation, data binding, fragment updates
- **SSE Integration**: Connection lifecycle, message filtering, error recovery

### End-to-End Tests (15% of testing effort)
- **User Workflows**: Complete cost analysis workflow from navigation to chart interaction
- **Responsive Design**: Cross-device compatibility, mobile usability
- **Accessibility**: Screen reader navigation, keyboard interaction, color contrast

## Performance Requirements

### Response Time Targets
- Cost dashboard page load: <2 seconds with 30-day cost data
- Chart SVG generation: <500ms per chart  
- Log filtering: <500ms for 10,000 entries
- SSE log updates: <100ms latency for new entries

### Scalability Constraints
- Cost ledger size: Up to 100MB (approximately 1M entries)
- Concurrent log viewers: Up to 10 simultaneous SSE connections
- Chart data points: Up to 1000 points per chart with data sampling
- Memory usage: <50MB per request during peak operations

## Security Considerations

### Input Validation
- Log filter parameters sanitized against injection attacks
- Cost ledger file access restricted to configured directory
- Request ID validation prevents directory traversal
- Time range parameters validated against allowed values

### Data Protection  
- Cost data accessible only to authenticated portal users
- Log download requires admin privileges for sensitive entries
- SSE connections inherit portal session authentication
- No cost or log data cached in browser storage

## Browser Compatibility

### Supported Browsers
- **Chrome**: 90+ (full feature support)
- **Firefox**: 88+ (full feature support)  
- **Safari**: 14+ (full feature support)
- **Edge**: 90+ (full feature support)

### Progressive Enhancement
- Charts render as SVG without JavaScript dependency
- HTMX provides enhanced UX but degrades gracefully
- SSE log streaming falls back to manual refresh
- Mobile responsive design works on all supported browsers

## Deployment Considerations

### Configuration Requirements
- Cost ledger file path configurable via environment variable
- Log file path configurable via environment variable  
- Cost cap thresholds configurable in portal settings
- Chart dimensions and colors configurable via CSS variables

### Monitoring Points
- Cost aggregation performance metrics
- Chart rendering time tracking
- SSE connection health monitoring  
- Log file access error rates
- Memory usage during large data processing

## Risk Assessment

### High-Risk Items
1. **Large cost ledger performance**: Cost aggregation may timeout with very large datasets
   - **Mitigation**: Implement streaming aggregation and data pagination
   - **Contingency**: Add database storage for pre-aggregated cost data

2. **SSE connection reliability**: Log streaming may drop connections frequently  
   - **Mitigation**: Implement automatic reconnection with last-seen tracking
   - **Contingency**: Fall back to polling-based updates

3. **SVG browser compatibility**: Charts may render inconsistently across browsers
   - **Mitigation**: Extensive cross-browser testing and SVG standardization
   - **Contingency**: Provide PNG fallback generation for problematic browsers

### Medium-Risk Items
1. **HTMX fragment updates**: Partial page updates may break with complex interactions
   - **Mitigation**: Comprehensive integration testing of HTMX workflows
   - **Contingency**: Full page refresh fallback for critical operations

2. **Memory usage with large logs**: Log processing may consume excessive memory
   - **Mitigation**: Streaming log processing and configurable limits
   - **Contingency**: Temporary file storage for large log processing

### Low-Risk Items
1. **Color accessibility compliance**: Charts may not meet WCAG requirements
   - **Mitigation**: Use established color-blind safe palettes
   - **Contingency**: Provide high-contrast mode option

2. **Mobile responsive design**: Layout may break on small screens
   - **Mitigation**: Mobile-first responsive design approach
   - **Contingency**: Separate mobile-optimized views

## Definition of Done

### Functional Requirements
- [ ] Cost dashboard displays daily/monthly charts with accurate aggregated data
- [ ] Per-repository and per-phase cost breakdowns show correct attributions  
- [ ] Top-10 expensive requests list includes functional drill-down links
- [ ] 7-day spend projection displays with simple averaging algorithm
- [ ] Cost cap status shows current vs. configured limits with visual indicators
- [ ] Log viewer displays last 500 entries with working filter controls
- [ ] Live log streaming via SSE updates display in real-time
- [ ] Log filtering by level/request ID/time range produces correct results
- [ ] Gzip log download generates proper compressed files
- [ ] All routes handle HTMX requests with appropriate fragment responses

### Quality Requirements
- [ ] All unit tests pass with >90% code coverage
- [ ] Integration tests validate complete workflows
- [ ] SVG charts render correctly without JavaScript
- [ ] Charts meet WCAG 2.1 AA accessibility standards
- [ ] Color-blind safe palette tested with simulators  
- [ ] Mobile responsive design works on 320px+ screens
- [ ] Performance targets met for all operations
- [ ] No ESLint errors or warnings
- [ ] TypeScript compilation succeeds without errors

### Production Readiness
- [ ] Error handling covers all failure scenarios with user-friendly messages
- [ ] Logging includes appropriate debug information for troubleshooting
- [ ] Configuration allows deployment-time customization
- [ ] Security review confirms no data leakage or injection vulnerabilities
- [ ] Documentation covers installation, configuration, and usage
- [ ] Monitoring hooks provide visibility into system health

### Code Quality
- [ ] Code follows established TypeScript and Node.js conventions
- [ ] Functions are well-documented with JSDoc comments
- [ ] Complex algorithms include explanatory comments
- [ ] No duplicate code or unnecessary dependencies
- [ ] Git commits follow conventional commit format
- [ ] All code reviewed by at least one other developer

This plan delivers comprehensive cost analysis and log tailing capabilities while maintaining high code quality, performance, and accessibility standards. The parallel execution strategy minimizes total development time while ensuring proper dependency management and integration testing coverage.