# PLAN-013-2: Server Bootstrap + Hono Application + Middleware Chain

## Metadata
- **Parent TDD**: TDD-013-portal-server-foundation
- **Estimated effort**: 3-4 days
- **Dependencies**: ["PLAN-013-1"]
- **Blocked by**: []
- **Priority**: P0

## Objective
Implement the foundational server infrastructure for the autonomous-dev portal: a Hono-based HTTP server with proper middleware ordering, configuration management, graceful shutdown handling, and JSX templating foundation. This plan delivers a production-ready server skeleton that accepts HTTP requests, applies security middleware, serves static assets, handles errors gracefully, and shuts down cleanly on signals. The server binds only to localhost (127.0.0.1) unless TLS+authentication is properly configured, preventing accidental external exposure during development.

## Scope

### In Scope
- **Core Server Bootstrap**: `server/server.ts` main entry point with Hono app initialization
- **Port Binding Strategy**: Bind to `127.0.0.1:port` from userConfig with security validation
- **Middleware Chain Implementation**: Logger → Security Headers → CORS → Extension points for TDD-014 auth/CSRF → Route handlers
- **Error Handling**: Structured JSON error responses and HTML error pages with proper status codes
- **Graceful Shutdown**: SIGTERM/SIGINT handlers with connection draining and cleanup sequence
- **Signal Handling**: Process signal registration and safe shutdown coordination
- **Request Correlation**: Request-ID middleware for distributed tracing and log correlation
- **Configuration Management**: Multi-layered config loading (defaults + user overrides + environment)
- **JSX Templating Setup**: Hono JSX configuration and base layout architecture
- **Package Dependencies**: `package.json` with pinned Hono 3.12.x and Bun runtime requirement
- **Static Asset Serving**: `/static/*` route with proper caching headers and MIME types
- **Startup Self-Check**: Configuration validation, dependency verification, and daemon state path accessibility
- **Development Utilities**: Hot reload preparation and standalone mode support

### Out of Scope
- **Plugin Packaging**: Plugin manifest and MCP server configuration (handled by PLAN-013-1)
- **Route Content Implementation**: Actual dashboard, settings, and operational routes (PLAN-013-3)
- **Static Asset Content**: CSS styling, icons, and JavaScript files (PLAN-013-4)  
- **Authentication/Authorization**: Login, session management, CSRF tokens (TDD-014 plans)
- **Live Data Integration**: SSE connections, file watching, daemon state reading (TDD-015 plans)
- **Template Content**: Specific page layouts and component implementations (PLAN-013-3)

## Tasks

### TASK-001: Install Hono Dependencies and Setup Package.json
**Description**: Create and configure `package.json` with Hono 3.12.x pinned version, TypeScript configuration, and Bun runtime requirements. Install all necessary middleware packages for the complete middleware chain.

**Files to create/modify**:
- `package.json`
- `tsconfig.json`
- `.gitignore`

**Dependencies**: []

**Acceptance Criteria**:
- Hono version is pinned to `^3.12.0` to avoid breaking changes
- TypeScript configured for JSX with Hono JSX factory
- Bun runtime requirement specified in `engines` field
- All middleware dependencies available: `hono/cors`, `hono/logger`, `hono/security-headers`
- Development dependencies include type definitions
- `bun install` completes without errors
- `bun run typecheck` passes without TypeScript errors

**Lint/Test Commands**:
```bash
bun install
bun run typecheck
bun run lint
```

**Estimated Effort**: 1.5 hours

**Track**: Setup

**Risks**: 
- Medium risk: Hono 3.12.x may have API changes from current version. **Mitigation**: Pin exact version and test compatibility.
- Low risk: TypeScript JSX configuration conflicts. **Mitigation**: Use official Hono JSX setup guide.

### TASK-002: Scaffold Core Server Structure
**Description**: Create the basic `server/server.ts` file with imports, interface definitions, and the main server function skeleton. Implement the foundation for configuration loading and app initialization without actual middleware or route logic.

**Files to create/modify**:
- `server/server.ts`
- `server/lib/config.ts`
- `config/portal-defaults.json`

**Dependencies**: [TASK-001]

**Acceptance Criteria**:
- Server starts and listens on configured port without errors
- Configuration loading function exists and reads defaults
- App instance creation and basic Hono setup complete
- Standalone mode detection working (`bun run server.ts`)
- Server can be stopped gracefully with Ctrl+C
- TypeScript compilation succeeds without errors

**Lint/Test Commands**:
```bash
bun run server.ts &
sleep 2
curl -f http://127.0.0.1:19280/health || echo "Expected 404"
kill %1
```

**Estimated Effort**: 2 hours

**Track**: Core

**Risks**:
- Low risk: Port conflicts during testing. **Mitigation**: Use configurable test port and check availability.

### TASK-003: Implement Configuration Management System
**Description**: Build the complete configuration system with defaults loading, user config merging, environment variable overrides, and validation. Implement the four-layer configuration approach outlined in TDD Section 11.

**Files to create/modify**:
- `server/lib/config.ts`
- `config/portal-defaults.json`
- `server/lib/validation.ts`

**Dependencies**: [TASK-002]

**Acceptance Criteria**:
- Default configuration loads from `config/portal-defaults.json` with all required fields
- User configuration merging works with nested object override semantics
- Environment variable overrides functional for `PORTAL_PORT`, `PORTAL_AUTH_MODE`, `PORTAL_LOG_LEVEL`
- Configuration validation rejects invalid port numbers (< 1024 or > 65535)
- Invalid JSON in user config produces clear error message and exits gracefully
- Missing user config file is handled gracefully (not an error condition)
- Configuration loading completes in under 50ms for performance

**Lint/Test Commands**:
```bash
bun test tests/unit/config.test.ts
PORTAL_PORT=8080 bun run server.ts --validate-config
```

**Estimated Effort**: 3.5 hours

**Track**: Core

**Risks**:
- Medium risk: Complex nested merge semantics may not handle edge cases. **Mitigation**: Comprehensive test cases for merge scenarios.
- Low risk: Environment variable parsing edge cases. **Mitigation**: Explicit type validation and error handling.

### TASK-004: Implement Middleware Chain with Extension Points
**Description**: Implement the complete middleware stack with proper ordering: request logging, security headers, CORS configuration, and clearly defined extension points where TDD-014 authentication and CSRF protection will be inserted.

**Files to create/modify**:
- `server/middleware/request-id.ts`
- `server/middleware/logging.ts`
- `server/middleware/security.ts`
- `server/middleware/cors.ts`
- `server/middleware/index.ts`

**Dependencies**: [TASK-003]

**Acceptance Criteria**:
- Request-ID middleware generates unique correlation IDs for each request
- Structured logging middleware outputs JSON format with timestamp, method, path, status, duration
- Security headers middleware sets all required headers from TDD CSP policy
- CORS middleware configured correctly for localhost and configurable origins
- Middleware ordering enforced and documented with clear extension points
- All middleware functions properly with Hono's middleware pattern
- Performance impact < 5ms per request through middleware chain

**Lint/Test Commands**:
```bash
bun test tests/unit/middleware.test.ts
curl -v http://127.0.0.1:19280/health 2>&1 | grep "X-Request-ID"
```

**Estimated Effort**: 4 hours

**Track**: Middleware

**Risks**:
- Medium risk: Middleware ordering conflicts causing issues. **Mitigation**: Clear documentation and integration tests.
- Low risk: CORS configuration too restrictive for development. **Mitigation**: Environment-aware CORS settings.

### TASK-005: Implement Error Handling and Response System
**Description**: Create comprehensive error handling with both JSON API responses and HTML error pages, proper HTTP status codes, error logging with context, and user-friendly error messages while preventing information disclosure.

**Files to create/modify**:
- `server/lib/errors.ts`
- `server/templates/error.tsx`
- `server/middleware/error-handler.ts`

**Dependencies**: [TASK-004]

**Acceptance Criteria**:
- Global error handler catches all unhandled exceptions and produces proper responses
- JSON error responses include error code, message, and request ID (no stack traces in production)
- HTML error pages rendered using JSX templates with proper styling
- 404, 500, and 503 error cases handled with appropriate status codes
- Error details logged with full context but sanitized for client response
- Error handling performance does not degrade under load
- Security: no sensitive information leaked through error messages

**Lint/Test Commands**:
```bash
bun test tests/unit/error-handling.test.ts
curl http://127.0.0.1:19280/nonexistent | jq '.error'
```

**Estimated Effort**: 3 hours

**Track**: Core

**Risks**:
- Medium risk: Error handling may expose sensitive information. **Mitigation**: Explicit sanitization and security review.
- Low risk: JSX error template rendering failures. **Mitigation**: Fallback plain text error responses.

### TASK-006: Implement Port Binding with Security Validation
**Description**: Implement secure port binding logic that refuses to bind to `0.0.0.0` unless TLS and authentication are properly configured, implements port availability checking, and provides clear error messages for common binding failures.

**Files to create/modify**:
- `server/lib/binding.ts`
- `server/lib/security-validation.ts`

**Dependencies**: [TASK-003]

**Acceptance Criteria**:
- Server binds only to `127.0.0.1` by default for security
- Binding to `0.0.0.0` or external interfaces blocked unless `auth_mode` is not `localhost`
- Port availability check before binding attempt with clear error message if occupied
- Graceful handling of permission errors (ports < 1024 without privileges)
- Configuration validation ensures host/port combination is secure
- Fast binding failure detection (< 1 second timeout)

**Lint/Test Commands**:
```bash
bun test tests/unit/binding.test.ts
# Test port conflict detection
bun run server.ts & sleep 1; bun run server.ts; kill %1
```

**Estimated Effort**: 2.5 hours

**Track**: Security

**Risks**:
- High risk: Accidental external binding could expose development server. **Mitigation**: Strict default configuration and validation.
- Medium risk: Port conflict detection edge cases. **Mitigation**: Robust port availability checking.

### TASK-007: Implement Graceful Shutdown Sequence
**Description**: Build the complete graceful shutdown system with signal handlers, connection draining, resource cleanup coordination, and timeout handling to ensure clean process termination under all conditions.

**Files to create/modify**:
- `server/lib/shutdown.ts`
- `server/lib/signal-handlers.ts`

**Dependencies**: [TASK-002]

**Acceptance Criteria**:
- SIGTERM and SIGINT handlers registered and functioning correctly
- HTTP server stops accepting new connections immediately on shutdown signal
- In-flight requests allowed to complete with configurable timeout (default 10 seconds)
- All resources properly cleaned up: file handles, timers, event listeners
- Shutdown process logs detailed progress for debugging
- Forced termination after timeout to prevent hanging processes
- Exit code 0 for clean shutdown, 1 for forced termination

**Lint/Test Commands**:
```bash
bun test tests/unit/shutdown.test.ts
# Manual test: Start server, send SIGTERM, verify logs
```

**Estimated Effort**: 3 hours

**Track**: Core

**Risks**:
- Medium risk: Shutdown timeout edge cases causing hanging processes. **Mitigation**: Forced termination fallback.
- Low risk: Signal handling conflicts with other libraries. **Mitigation**: Explicit signal handler registration order.

### TASK-008: Implement JSX Templating Foundation
**Description**: Configure Hono JSX templating system, create base layout components, implement template composition patterns, and establish the architecture for all future template development.

**Files to create/modify**:
- `server/templates/layout/base.tsx`
- `server/templates/fragments/navigation.tsx`
- `server/templates/error.tsx`
- `server/lib/jsx-config.ts`

**Dependencies**: [TASK-001, TASK-005]

**Acceptance Criteria**:
- JSX factory properly configured for Hono JSX engine
- Base layout template renders valid HTML5 with proper metadata
- Navigation component structure defined (content implementation in PLAN-013-3)
- Template composition working with layout inheritance pattern
- Error templates rendering properly with styled error pages
- TypeScript compilation working for JSX files without errors
- Performance: template rendering < 10ms for simple pages

**Lint/Test Commands**:
```bash
bun test tests/unit/templates.test.ts
bun run typecheck
```

**Estimated Effort**: 2.5 hours

**Track**: Templates

**Risks**:
- Medium risk: JSX configuration conflicts with TypeScript setup. **Mitigation**: Follow Hono JSX documentation exactly.
- Low risk: Template rendering performance issues. **Mitigation**: Performance testing and benchmarking.

### TASK-009: Implement Static Asset Serving
**Description**: Create the `/static/*` route handler with proper MIME type detection, caching headers, security headers for static content, and performance optimizations for common asset types.

**Files to create/modify**:
- `server/routes/static.ts`
- `server/lib/mime-types.ts`
- `static/.gitkeep` (placeholder)

**Dependencies**: [TASK-004]

**Acceptance Criteria**:
- Static assets served from `/static/` path with correct MIME types
- Cache headers set appropriately: 24h for JS/CSS, 7d for images, no-cache for development
- Security headers applied to static content (CSP, X-Content-Type-Options)
- 404 handling for missing static assets
- Performance: static asset serving < 5ms for files under 100KB
- Support for common file types: `.js`, `.css`, `.svg`, `.png`, `.ico`, `.json`

**Lint/Test Commands**:
```bash
bun test tests/unit/static-assets.test.ts
curl -I http://127.0.0.1:19280/static/test.css
```

**Estimated Effort**: 2 hours

**Track**: Assets

**Risks**:
- Low risk: MIME type detection failures. **Mitigation**: Explicit MIME type mapping for all supported formats.
- Low risk: Cache header configuration issues. **Mitigation**: Environment-aware cache settings.

### TASK-010: Implement Startup Self-Check System
**Description**: Build comprehensive startup validation that checks configuration validity, verifies daemon state path accessibility, validates dependencies, measures startup performance, and provides detailed diagnostic information on failures.

**Files to create/modify**:
- `server/lib/startup-checks.ts`
- `server/lib/diagnostics.ts`

**Dependencies**: [TASK-003, TASK-006]

**Acceptance Criteria**:
- Configuration validation runs automatically on startup
- Daemon state paths checked for read/write accessibility
- Dependency verification (Bun runtime version, required modules)
- Startup performance measured and logged (target: < 10 seconds)
- Detailed diagnostic output on startup failures with actionable error messages
- Health check endpoint (`/health`) returns startup validation status
- Self-check failures cause graceful startup abort with exit code 1

**Lint/Test Commands**:
```bash
bun test tests/unit/startup-checks.test.ts
timeout 15s bun run server.ts --self-check
```

**Estimated Effort**: 3 hours

**Track**: Core

**Risks**:
- Medium risk: Startup checks may be too slow, delaying server availability. **Mitigation**: Parallel checks where possible, time budgets.
- Low risk: False positive startup failures. **Mitigation**: Graceful degradation for non-critical checks.

### TASK-011: Implement Request Logging and Correlation
**Description**: Create structured request logging with correlation IDs, performance metrics collection, configurable log levels, and integration with the global logging system for debugging and monitoring.

**Files to create/modify**:
- `server/lib/request-logger.ts`
- `server/middleware/correlation.ts`

**Dependencies**: [TASK-004]

**Acceptance Criteria**:
- Each request assigned unique correlation ID accessible throughout request lifecycle
- Structured JSON logging with timestamp, method, path, status code, duration, user agent
- Request/response size logging for performance analysis
- Configurable log levels (debug, info, warn, error) from user configuration
- Log correlation ID passed to all downstream components and error messages
- Performance metrics: p50, p95, p99 response times tracked in logs
- Log output compatible with standard log aggregation tools

**Lint/Test Commands**:
```bash
bun test tests/unit/request-logging.test.ts
curl http://127.0.0.1:19280/health 2>&1 | grep "request_id"
```

**Estimated Effort**: 2.5 hours

**Track**: Middleware

**Risks**:
- Low risk: Logging overhead impacting request performance. **Mitigation**: Asynchronous logging and performance benchmarks.
- Low risk: Correlation ID conflicts or collisions. **Mitigation**: UUID v4 generation for uniqueness.

### TASK-012: Write Comprehensive Test Suite
**Description**: Create unit tests, integration tests, and smoke tests covering all server components with focus on edge cases, error conditions, and performance requirements.

**Files to create/modify**:
- `tests/unit/server.test.ts`
- `tests/unit/config.test.ts`
- `tests/unit/middleware.test.ts`
- `tests/unit/error-handling.test.ts`
- `tests/unit/shutdown.test.ts`
- `tests/integration/full-server.test.ts`
- `tests/smoke/startup-performance.test.ts`

**Dependencies**: [TASK-001, TASK-002, TASK-003, TASK-004, TASK-005, TASK-007]

**Acceptance Criteria**:
- Unit test coverage > 90% for all server components
- Integration tests cover full request lifecycle from middleware to response
- Error condition testing: invalid config, port conflicts, shutdown during requests
- Performance tests verify startup time < 10s, response time < 100ms for health checks
- Edge case testing: malformed requests, oversized payloads, signal handling during startup
- All tests pass consistently without flaky behavior
- Test execution time < 30 seconds for full suite

**Lint/Test Commands**:
```bash
bun test
bun test --coverage
bun test tests/integration/
bun test tests/smoke/
```

**Estimated Effort**: 6 hours

**Track**: Testing

**Risks**:
- Medium risk: Integration tests may be flaky due to timing issues. **Mitigation**: Proper setup/teardown and retry logic.
- Low risk: Test coverage gaps in edge cases. **Mitigation**: Systematic test case design and code review.

### TASK-013: Performance Optimization and Benchmarking
**Description**: Optimize server startup time, request handling performance, memory usage, and implement performance monitoring with benchmark targets for production readiness.

**Files to create/modify**:
- `server/lib/performance.ts`
- `tests/benchmarks/startup-time.test.ts`
- `tests/benchmarks/request-throughput.test.ts`
- `scripts/performance-monitor.ts`

**Dependencies**: [TASK-012]

**Acceptance Criteria**:
- Startup time consistently under 10 seconds on development hardware
- Request handling throughput > 100 req/sec for simple routes
- Memory usage stable under load (no memory leaks detected)
- Response time p95 < 100ms for health checks and static assets
- Performance monitoring integrated into application with metrics logging
- Benchmark regression tests prevent performance degradation
- Resource usage optimized: CPU usage < 5% at idle

**Lint/Test Commands**:
```bash
bun test tests/benchmarks/
bun run scripts/performance-monitor.ts --duration 60s
```

**Estimated Effort**: 3 hours

**Track**: Optimization

**Risks**:
- Medium risk: Performance targets may not be achievable on all hardware. **Mitigation**: Hardware-specific benchmarks and graceful degradation.
- Low risk: Performance monitoring overhead. **Mitigation**: Minimal instrumentation with sampling.

## Dependencies & Integration Points

### Exposes to Other Plans
- **PLAN-013-3**: Complete Hono application with middleware chain ready for route registration
- **PLAN-013-4**: Static asset serving infrastructure ready for CSS, JS, and icon deployment
- **TDD-014 Plans**: Middleware extension points for authentication and CSRF protection integration
- **TDD-015 Plans**: Server instance and error handling for SSE connections and live data integration

### Consumes from Other Plans  
- **PLAN-013-1**: Plugin packaging, MCP server configuration, and deployment structure

### Integration Points
- **Configuration System**: Multi-layered config loading provides foundation for all feature configuration
- **Middleware Architecture**: Extension points designed specifically for TDD-014 security components
- **Error Handling**: Centralized error system ready for operational error reporting (TDD-015)
- **JSX Templates**: Template foundation ready for dashboard and operational page content (PLAN-013-3)

## Testing Strategy

### Unit Testing (8 hours estimated)
- **Configuration Management**: Default loading, user overrides, environment variables, validation edge cases
- **Middleware Chain**: Individual middleware functions, ordering, extension point integration
- **Error Handling**: Error transformation, sanitization, response formatting for different content types
- **Shutdown Logic**: Signal handling, connection draining, timeout scenarios, resource cleanup
- **Security Validation**: Port binding restrictions, host configuration, authentication mode validation

### Integration Testing (4 hours estimated)  
- **Full Server Lifecycle**: Startup → configuration → middleware → request handling → shutdown
- **Request Flow**: End-to-end request processing through complete middleware chain
- **Error Propagation**: Error handling across middleware boundaries and template rendering
- **Performance Under Load**: Concurrent requests, memory usage, response time consistency

### Smoke Testing (2 hours estimated)
- **Startup Performance**: Cold start time measurement and consistency across multiple runs
- **Basic Functionality**: Health check, static asset serving, error page rendering
- **Configuration Scenarios**: Different config combinations, environment variable overrides
- **Signal Handling**: Clean shutdown behavior under different termination conditions

## Code Examples

### Server Skeleton (server.ts)

```typescript
import { serve } from 'bun';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { securityHeaders } from 'hono/security-headers';

import { loadPortalConfig, PortalConfig } from './lib/config';
import { setupGracefulShutdown } from './lib/shutdown';
import { validateStartupConditions } from './lib/startup-checks';
import { requestIdMiddleware } from './middleware/request-id';
import { structuredLogger } from './middleware/logging';
import { errorHandler } from './middleware/error-handler';
import { securityValidation } from './lib/security-validation';
import { renderErrorPage } from './templates/error';

interface ServerState {
  server?: ReturnType<typeof serve>;
  shutdownInProgress: boolean;
  startTime: number;
}

const state: ServerState = {
  shutdownInProgress: false,
  startTime: Date.now(),
};

export async function startServer(): Promise<ReturnType<typeof serve>> {
  console.log('Starting portal server...');
  
  try {
    // 1. Load and validate configuration
    const config = await loadPortalConfig();
    console.log(`Loaded configuration: port=${config.port}, auth_mode=${config.auth_mode}`);
    
    // 2. Run startup self-checks
    await validateStartupConditions(config);
    
    // 3. Validate security requirements
    await securityValidation.validateBindingConfig(config);
    
    // 4. Initialize Hono application
    const app = new Hono();
    
    // 5. Setup middleware chain (order is critical!)
    app.use('*', requestIdMiddleware());
    app.use('*', structuredLogger(config.logging.level));
    app.use('*', securityHeaders({
      contentSecurityPolicy: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; object-src 'none'; frame-ancestors 'none'",
      referrerPolicy: 'strict-origin-when-cross-origin',
    }));
    
    app.use('*', cors({
      origin: config.auth_mode === 'localhost' 
        ? [`http://127.0.0.1:${config.port}`, `https://127.0.0.1:${config.port}`]
        : config.allowed_origins || false,
      credentials: true,
      allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-CSRF-Token'],
    }));
    
    // 6. Extension points for TDD-014 security middleware
    // app.use('*', csrfValidation()); // Will be added by TDD-014 
    // app.use('*', authenticationMiddleware()); // Will be added by TDD-014
    
    // 7. Static asset serving
    app.get('/static/*', async (c) => {
      const path = c.req.path.replace('/static/', '');
      const file = Bun.file(`./static/${path}`);
      
      if (!(await file.exists())) {
        return c.notFound();
      }
      
      // Set appropriate cache and security headers
      const headers: Record<string, string> = {
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': path.includes('.') 
          ? 'public, max-age=86400' // 24 hours for versioned assets
          : 'no-cache', // No cache for development
      };
      
      // MIME type detection
      if (path.endsWith('.js')) {
        headers['Content-Type'] = 'application/javascript';
      } else if (path.endsWith('.css')) {
        headers['Content-Type'] = 'text/css';
      } else if (path.endsWith('.svg')) {
        headers['Content-Type'] = 'image/svg+xml';
      }
      
      return new Response(file, { headers });
    });
    
    // 8. Health check endpoint
    app.get('/health', (c) => {
      const uptime = Date.now() - state.startTime;
      return c.json({
        status: 'healthy',
        uptime: uptime,
        version: process.env.npm_package_version || '0.1.0',
        auth_mode: config.auth_mode,
        timestamp: new Date().toISOString(),
      });
    });
    
    // 9. Route placeholder (PLAN-013-3 will implement actual routes)
    app.get('/', (c) => {
      return c.html(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Portal Server Running</title>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
        </head>
        <body>
          <h1>Autonomous Dev Portal</h1>
          <p>Server is running on port ${config.port}</p>
          <p>Auth mode: ${config.auth_mode}</p>
          <ul>
            <li><a href="/health">Health Check</a></li>
            <li><a href="/static/">Static Assets</a> (will be 404 until PLAN-013-4)</li>
          </ul>
        </body>
        </html>
      `);
    });
    
    // 10. Global error handler
    app.onError((err, c) => {
      const requestId = c.get('requestId') || 'unknown';
      console.error(`Request ${requestId} error:`, {
        error: err.message,
        stack: err.stack,
        path: c.req.path,
        method: c.req.method,
      });
      
      // Return appropriate error response
      if (c.req.header('accept')?.includes('application/json')) {
        return c.json({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'An internal server error occurred',
            requestId: requestId,
          },
        }, 500);
      } else {
        return c.html(renderErrorPage(500, 'Internal Server Error', requestId), 500);
      }
    });
    
    app.notFound((c) => {
      const requestId = c.get('requestId') || 'unknown';
      
      if (c.req.header('accept')?.includes('application/json')) {
        return c.json({
          error: {
            code: 'NOT_FOUND',
            message: 'The requested resource was not found',
            requestId: requestId,
          },
        }, 404);
      } else {
        return c.html(renderErrorPage(404, 'Page Not Found', requestId), 404);
      }
    });
    
    // 11. Start server with secure binding
    const hostname = config.auth_mode === 'localhost' ? '127.0.0.1' : config.bind_host || '127.0.0.1';
    const server = serve({
      port: config.port,
      hostname: hostname,
      fetch: app.fetch,
      error: (err) => {
        console.error('Server error:', err);
      },
    });
    
    state.server = server;
    
    const startupTime = Date.now() - state.startTime;
    console.log(`Portal server listening on ${hostname}:${config.port} (startup: ${startupTime}ms)`);
    
    // 12. Setup graceful shutdown
    setupGracefulShutdown(server, state);
    
    return server;
    
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Standalone mode detection and execution
async function detectStandaloneMode(): Promise<boolean> {
  return !process.env.CLAUDE_PLUGIN_ROOT;
}

// Main execution for standalone mode (bun run server.ts)
if (import.meta.main) {
  const isStandalone = await detectStandaloneMode();
  
  if (isStandalone) {
    console.log('Running in standalone mode');
    // Set environment variables for standalone operation
    process.env.CLAUDE_PLUGIN_ROOT = process.cwd();
    process.env.CLAUDE_PLUGIN_DATA = './data';
    process.env.CLAUDE_PLUGIN_CONFIG = './config/user-config.json';
  }
  
  startServer().catch((error) => {
    console.error('Startup failed:', error);
    process.exit(1);
  });
}

export { startServer };
```

### Middleware Chain Configuration (middleware/index.ts)

```typescript
import { Hono } from 'hono';
import { PortalConfig } from '../lib/config';
import { requestIdMiddleware } from './request-id';
import { structuredLogger } from './logging';
import { corsConfiguration } from './cors';
import { securityHeadersConfiguration } from './security';

export interface MiddlewareExtensionPoint {
  name: string;
  priority: number;
  handler: (app: Hono) => void;
}

export class MiddlewareChain {
  private extensionPoints: MiddlewareExtensionPoint[] = [];
  
  constructor(private config: PortalConfig) {}
  
  /**
   * Register extension point for TDD-014 security middleware
   */
  registerExtension(extension: MiddlewareExtensionPoint): void {
    this.extensionPoints.push(extension);
    this.extensionPoints.sort((a, b) => a.priority - b.priority);
  }
  
  /**
   * Apply all middleware to the Hono app in the correct order
   */
  applyMiddleware(app: Hono): void {
    // 1. Request correlation and logging (highest priority)
    app.use('*', requestIdMiddleware());
    app.use('*', structuredLogger(this.config.logging.level));
    
    // 2. Security headers (before any content processing)
    app.use('*', securityHeadersConfiguration(this.config));
    
    // 3. CORS (before authentication to handle preflight)
    app.use('*', corsConfiguration(this.config));
    
    // 4. Extension points for TDD-014 (CSRF, authentication, etc.)
    // These will be inserted here by TDD-014 plans:
    for (const extension of this.extensionPoints) {
      extension.handler(app);
    }
    
    console.log(`Middleware chain configured with ${this.extensionPoints.length} extensions`);
  }
}

export function createMiddlewareChain(config: PortalConfig): MiddlewareChain {
  return new MiddlewareChain(config);
}
```

### Graceful Shutdown Implementation (lib/shutdown.ts)

```typescript
import type { Server } from 'bun';
import { ServerState } from '../server';

interface ShutdownOptions {
  gracePeriodMs: number;
  forceTimeoutMs: number;
  logProgress: boolean;
}

const DEFAULT_OPTIONS: ShutdownOptions = {
  gracePeriodMs: 10000, // 10 seconds for graceful shutdown
  forceTimeoutMs: 15000, // 15 seconds before force kill
  logProgress: true,
};

export function setupGracefulShutdown(
  server: Server, 
  state: ServerState, 
  options: Partial<ShutdownOptions> = {}
): void {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  const shutdown = async (signal: string) => {
    if (state.shutdownInProgress) {
      console.log(`Already shutting down, ignoring ${signal}`);
      return;
    }
    
    state.shutdownInProgress = true;
    console.log(`Graceful shutdown initiated by ${signal}...`);
    
    const shutdownStart = Date.now();
    let forceShutdownTimeout: Timer;
    
    try {
      // Set force shutdown timeout
      forceShutdownTimeout = setTimeout(() => {
        console.error('Graceful shutdown timeout exceeded, forcing exit');
        process.exit(1);
      }, opts.forceTimeoutMs);
      
      // Step 1: Stop accepting new connections
      if (opts.logProgress) {
        console.log('Stopping HTTP server...');
      }
      
      server.stop();
      
      // Step 2: Wait for existing connections to drain
      if (opts.logProgress) {
        console.log(`Waiting up to ${opts.gracePeriodMs}ms for connections to drain...`);
      }
      
      // In a real implementation, you'd track active connections
      // For now, we'll just wait a short period for requests to complete
      await new Promise(resolve => setTimeout(resolve, Math.min(2000, opts.gracePeriodMs)));
      
      // Step 3: Close additional resources (will be extended by TDD-015)
      if (opts.logProgress) {
        console.log('Cleaning up resources...');
      }
      
      // TODO: Close SSE connections (TDD-015)
      // TODO: Close file watchers (TDD-015) 
      // TODO: Close database connections (if any)
      // TODO: Flush logs and metrics
      
      // Step 4: Final cleanup
      clearTimeout(forceShutdownTimeout);
      
      const shutdownDuration = Date.now() - shutdownStart;
      console.log(`Shutdown complete (${shutdownDuration}ms)`);
      process.exit(0);
      
    } catch (error) {
      console.error('Error during graceful shutdown:', error);
      clearTimeout(forceShutdownTimeout);
      process.exit(1);
    }
  };
  
  // Register signal handlers
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  
  // Handle uncaught exceptions and unhandled rejections
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    shutdown('uncaughtException');
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection at:', promise, 'reason:', reason);
    shutdown('unhandledRejection');
  });
  
  if (opts.logProgress) {
    console.log('Graceful shutdown handlers registered');
  }
}

export interface ConnectionTracker {
  activeConnections: Set<any>;
  
  trackConnection(connection: any): void;
  releaseConnection(connection: any): void;
  waitForDrain(timeoutMs: number): Promise<boolean>;
}

export class HttpConnectionTracker implements ConnectionTracker {
  public activeConnections = new Set<any>();
  
  trackConnection(connection: any): void {
    this.activeConnections.add(connection);
    connection.on('close', () => {
      this.activeConnections.delete(connection);
    });
  }
  
  releaseConnection(connection: any): void {
    this.activeConnections.delete(connection);
  }
  
  async waitForDrain(timeoutMs: number): Promise<boolean> {
    const startTime = Date.now();
    
    while (this.activeConnections.size > 0 && (Date.now() - startTime) < timeoutMs) {
      console.log(`Waiting for ${this.activeConnections.size} connections to close...`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    return this.activeConnections.size === 0;
  }
}
```

### Signal Handler Implementation (lib/signal-handlers.ts)

```typescript
interface SignalHandler {
  signal: NodeJS.Signals;
  handler: () => void | Promise<void>;
  registered: boolean;
}

class SignalManager {
  private handlers: Map<NodeJS.Signals, SignalHandler[]> = new Map();
  private shutdownInProgress = false;
  
  register(signal: NodeJS.Signals, handler: () => void | Promise<void>): void {
    if (!this.handlers.has(signal)) {
      this.handlers.set(signal, []);
      
      // Register the actual process signal handler
      process.on(signal, async () => {
        if (this.shutdownInProgress && (signal === 'SIGTERM' || signal === 'SIGINT')) {
          console.log(`Shutdown already in progress, ignoring ${signal}`);
          return;
        }
        
        if (signal === 'SIGTERM' || signal === 'SIGINT') {
          this.shutdownInProgress = true;
        }
        
        const signalHandlers = this.handlers.get(signal) || [];
        console.log(`Processing ${signalHandlers.length} handlers for ${signal}`);
        
        for (const signalHandler of signalHandlers) {
          try {
            await signalHandler.handler();
          } catch (error) {
            console.error(`Error in ${signal} handler:`, error);
          }
        }
      });
    }
    
    this.handlers.get(signal)!.push({
      signal,
      handler,
      registered: true,
    });
  }
  
  unregister(signal: NodeJS.Signals, handler: () => void | Promise<void>): void {
    const signalHandlers = this.handlers.get(signal);
    if (signalHandlers) {
      const index = signalHandlers.findIndex(h => h.handler === handler);
      if (index >= 0) {
        signalHandlers.splice(index, 1);
      }
    }
  }
  
  clear(): void {
    for (const signal of this.handlers.keys()) {
      process.removeAllListeners(signal);
    }
    this.handlers.clear();
    this.shutdownInProgress = false;
  }
}

export const signalManager = new SignalManager();

export function registerShutdownHandler(handler: () => void | Promise<void>): void {
  signalManager.register('SIGTERM', handler);
  signalManager.register('SIGINT', handler);
}

export function registerSignalHandler(
  signal: NodeJS.Signals, 
  handler: () => void | Promise<void>
): void {
  signalManager.register(signal, handler);
}

// Cleanup function for tests
export function clearSignalHandlers(): void {
  signalManager.clear();
}
```

### Error Handler Implementation (middleware/error-handler.ts)

```typescript
import type { Context, Next } from 'hono';
import { renderErrorPage } from '../templates/error';

export interface ErrorContext {
  requestId: string;
  path: string;
  method: string;
  userAgent?: string;
  timestamp: string;
}

export interface ApiError {
  code: string;
  message: string;
  statusCode: number;
  context?: Record<string, any>;
}

export class PortalError extends Error implements ApiError {
  public code: string;
  public statusCode: number;
  public context?: Record<string, any>;
  
  constructor(
    code: string, 
    message: string, 
    statusCode: number = 500, 
    context?: Record<string, any>
  ) {
    super(message);
    this.name = 'PortalError';
    this.code = code;
    this.statusCode = statusCode;
    this.context = context;
  }
}

export function errorHandler() {
  return async (c: Context, next: Next) => {
    try {
      await next();
    } catch (error) {
      const requestId = c.get('requestId') || generateRequestId();
      const errorContext: ErrorContext = {
        requestId,
        path: c.req.path,
        method: c.req.method,
        userAgent: c.req.header('user-agent'),
        timestamp: new Date().toISOString(),
      };
      
      // Log the error with full context
      console.error('Request error:', {
        ...errorContext,
        error: {
          message: error.message,
          stack: error.stack,
          code: error.code,
        },
      });
      
      // Determine response format based on Accept header
      const acceptsJson = c.req.header('accept')?.includes('application/json');
      const acceptsHtml = c.req.header('accept')?.includes('text/html');
      
      if (error instanceof PortalError) {
        // Known application error
        if (acceptsJson || (!acceptsHtml && !acceptsJson)) {
          return c.json({
            error: {
              code: error.code,
              message: sanitizeErrorMessage(error.message),
              requestId: requestId,
            },
          }, error.statusCode);
        } else {
          return c.html(
            renderErrorPage(error.statusCode, error.message, requestId), 
            error.statusCode
          );
        }
      } else {
        // Unknown/internal error - don't expose details
        const statusCode = 500;
        const safeMessage = 'An internal server error occurred';
        
        if (acceptsJson || (!acceptsHtml && !acceptsJson)) {
          return c.json({
            error: {
              code: 'INTERNAL_ERROR',
              message: safeMessage,
              requestId: requestId,
            },
          }, statusCode);
        } else {
          return c.html(
            renderErrorPage(statusCode, safeMessage, requestId), 
            statusCode
          );
        }
      }
    }
  };
}

function sanitizeErrorMessage(message: string): string {
  // Remove potential sensitive information from error messages
  return message
    .replace(/\/Users\/[^\/\s]+/g, '~')  // Replace user paths
    .replace(/\/home\/[^\/\s]+/g, '~')   // Replace home paths  
    .replace(/password[=:]\s*\S+/gi, 'password=***')  // Hide passwords
    .replace(/token[=:]\s*\S+/gi, 'token=***')        // Hide tokens
    .replace(/key[=:]\s*\S+/gi, 'key=***');           // Hide keys
}

function generateRequestId(): string {
  return Math.random().toString(36).substring(2, 15) + 
         Math.random().toString(36).substring(2, 15);
}

// Common error factory functions
export const Errors = {
  NotFound: (resource: string = 'Resource') => 
    new PortalError('NOT_FOUND', `${resource} not found`, 404),
    
  BadRequest: (message: string) => 
    new PortalError('BAD_REQUEST', message, 400),
    
  Unauthorized: (message: string = 'Authentication required') => 
    new PortalError('UNAUTHORIZED', message, 401),
    
  Forbidden: (message: string = 'Access denied') => 
    new PortalError('FORBIDDEN', message, 403),
    
  ValidationError: (message: string) => 
    new PortalError('VALIDATION_ERROR', message, 422),
    
  InternalError: (message: string = 'Internal server error') => 
    new PortalError('INTERNAL_ERROR', message, 500),
    
  ServiceUnavailable: (service: string) => 
    new PortalError('SERVICE_UNAVAILABLE', `${service} is currently unavailable`, 503),
};
```

### Request ID Correlation Middleware (middleware/request-id.ts)

```typescript
import type { Context, Next } from 'hono';
import { v4 as uuidv4 } from 'uuid';

interface RequestIdOptions {
  header: string;
  generateId: () => string;
  setResponseHeader: boolean;
}

const DEFAULT_OPTIONS: RequestIdOptions = {
  header: 'x-request-id',
  generateId: () => uuidv4(),
  setResponseHeader: true,
};

export function requestIdMiddleware(options: Partial<RequestIdOptions> = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  return async (c: Context, next: Next) => {
    // Check if request already has an ID (from upstream proxy/load balancer)
    let requestId = c.req.header(opts.header);
    
    if (!requestId) {
      requestId = opts.generateId();
    }
    
    // Store in context for use by other middleware and handlers
    c.set('requestId', requestId);
    
    // Add to response header for debugging
    if (opts.setResponseHeader) {
      c.header(opts.header, requestId);
    }
    
    // Add to structured logging context
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    const originalConsoleWarn = console.warn;
    
    console.log = (...args: any[]) => {
      if (typeof args[0] === 'string') {
        originalConsoleLog(`[${requestId}]`, ...args);
      } else if (typeof args[0] === 'object' && args[0] !== null) {
        originalConsoleLog({ requestId, ...args[0] }, ...args.slice(1));
      } else {
        originalConsoleLog(`[${requestId}]`, ...args);
      }
    };
    
    console.error = (...args: any[]) => {
      if (typeof args[0] === 'string') {
        originalConsoleError(`[${requestId}]`, ...args);
      } else if (typeof args[0] === 'object' && args[0] !== null) {
        originalConsoleError({ requestId, ...args[0] }, ...args.slice(1));
      } else {
        originalConsoleError(`[${requestId}]`, ...args);
      }
    };
    
    console.warn = (...args: any[]) => {
      if (typeof args[0] === 'string') {
        originalConsoleWarn(`[${requestId}]`, ...args);
      } else if (typeof args[0] === 'object' && args[0] !== null) {
        originalConsoleWarn({ requestId, ...args[0] }, ...args.slice(1));
      } else {
        originalConsoleWarn(`[${requestId}]`, ...args);
      }
    };
    
    try {
      await next();
    } finally {
      // Restore original console methods
      console.log = originalConsoleLog;
      console.error = originalConsoleError;
      console.warn = originalConsoleWarn;
    }
  };
}

export function getRequestId(c: Context): string | undefined {
  return c.get('requestId');
}

export function requireRequestId(c: Context): string {
  const requestId = getRequestId(c);
  if (!requestId) {
    throw new Error('Request ID not found in context');
  }
  return requestId;
}
```

## Edge Cases and Error Scenarios

### Port Binding Edge Cases

1. **Port Already in Use**: When the configured port is occupied by another process
```typescript
// server/lib/binding.ts - Port conflict detection
async function checkPortAvailability(port: number, hostname: string): Promise<boolean> {
  try {
    const testServer = serve({
      port,
      hostname,
      fetch: () => new Response('test'),
    });
    
    testServer.stop();
    return true;
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      throw new PortalError(
        'PORT_IN_USE',
        `Port ${port} is already in use. Please choose a different port or stop the conflicting service.`,
        500,
        { port, hostname, pid: process.pid }
      );
    }
    throw error;
  }
}
```

2. **Permission Denied (Low Port Numbers)**: When trying to bind to ports < 1024 without privileges
```typescript
async function validatePortPermissions(port: number): Promise<void> {
  if (port < 1024 && process.getuid() !== 0) {
    throw new PortalError(
      'INSUFFICIENT_PRIVILEGES',
      `Port ${port} requires root privileges. Use a port >= 1024 or run with appropriate permissions.`,
      500,
      { port, uid: process.getuid() }
    );
  }
}
```

3. **Invalid Network Interface**: When the bind hostname is invalid or unavailable
```typescript
async function validateNetworkInterface(hostname: string): Promise<void> {
  const { networkInterfaces } = await import('os');
  const interfaces = networkInterfaces();
  
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '0.0.0.0') {
    const validAddresses = Object.values(interfaces)
      .flat()
      .map(iface => iface?.address)
      .filter(Boolean);
      
    if (!validAddresses.includes(hostname)) {
      throw new PortalError(
        'INVALID_NETWORK_INTERFACE',
        `Network interface ${hostname} is not available on this system.`,
        500,
        { hostname, availableInterfaces: validAddresses }
      );
    }
  }
}
```

### Signal Handling Edge Cases

1. **Signal During Startup**: When shutdown signals are received before server is fully initialized
```typescript
export function setupGracefulShutdown(server: Server | undefined, state: ServerState): void {
  const shutdown = async (signal: string) => {
    if (!server) {
      console.log(`Received ${signal} during startup, exiting immediately`);
      process.exit(1);
    }
    
    // Continue with normal shutdown process...
  };
}
```

2. **Multiple Rapid Signals**: When multiple SIGTERM/SIGINT signals are received in quick succession
```typescript
let shutdownCount = 0;
const shutdown = async (signal: string) => {
  shutdownCount++;
  
  if (shutdownCount === 1) {
    console.log(`Graceful shutdown initiated by ${signal}...`);
    // Normal graceful shutdown
  } else if (shutdownCount === 2) {
    console.log(`Second ${signal} received, forcing immediate shutdown...`);
    process.exit(1);
  } else {
    console.log(`Multiple shutdown signals received, ignoring...`);
  }
};
```

3. **Shutdown Timeout**: When graceful shutdown exceeds the timeout period
```typescript
const FORCE_SHUTDOWN_TIMEOUT = 15000; // 15 seconds

const forceShutdownTimer = setTimeout(() => {
  console.error('Graceful shutdown timeout exceeded, forcing exit');
  console.error(`Active connections: ${connectionTracker.activeConnections.size}`);
  process.exit(1);
}, FORCE_SHUTDOWN_TIMEOUT);

// Clear timeout on successful shutdown
try {
  await gracefulShutdownSequence();
  clearTimeout(forceShutdownTimer);
  process.exit(0);
} catch (error) {
  console.error('Shutdown error:', error);
  clearTimeout(forceShutdownTimer);
  process.exit(1);
}
```

### Configuration Edge Cases

1. **Malformed JSON Configuration**: When user config contains invalid JSON syntax
```typescript
async function loadUserConfig(configPath: string): Promise<object> {
  try {
    const file = Bun.file(configPath);
    if (!(await file.exists())) {
      return {}; // Missing config is not an error
    }
    
    const content = await file.text();
    if (content.trim() === '') {
      return {}; // Empty file is not an error
    }
    
    return JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new PortalError(
        'INVALID_CONFIG_SYNTAX',
        `Configuration file ${configPath} contains invalid JSON: ${error.message}`,
        500,
        { configPath, syntaxError: error.message }
      );
    }
    throw error;
  }
}
```

2. **Configuration Value Type Mismatches**: When config values have wrong types
```typescript
function validateConfigTypes(config: any): void {
  const validators = {
    port: (val: any) => Number.isInteger(val) && val >= 1024 && val <= 65535,
    auth_mode: (val: any) => ['localhost', 'tailscale', 'oauth'].includes(val),
    sse_update_interval_seconds: (val: any) => Number.isInteger(val) && val > 0,
    'logging.level': (val: any) => ['debug', 'info', 'warn', 'error'].includes(val),
  };
  
  for (const [path, validator] of Object.entries(validators)) {
    const value = getConfigValue(config, path);
    if (value !== undefined && !validator(value)) {
      throw new PortalError(
        'INVALID_CONFIG_VALUE',
        `Configuration value for '${path}' is invalid: ${JSON.stringify(value)}`,
        500,
        { path, value, expectedType: validator.toString() }
      );
    }
  }
}
```

3. **Environment Variable Override Edge Cases**: When environment variables contain invalid values
```typescript
function parseEnvironmentOverrides(): Partial<PortalConfig> {
  const overrides: Partial<PortalConfig> = {};
  
  // Parse PORTAL_PORT with validation
  if (process.env.PORTAL_PORT) {
    const port = parseInt(process.env.PORTAL_PORT, 10);
    if (isNaN(port)) {
      throw new PortalError(
        'INVALID_ENV_PORT',
        `PORTAL_PORT environment variable must be a valid integer, got: ${process.env.PORTAL_PORT}`,
        500,
        { envValue: process.env.PORTAL_PORT }
      );
    }
    overrides.port = port;
  }
  
  // Parse PORTAL_AUTH_MODE with validation
  if (process.env.PORTAL_AUTH_MODE) {
    const authMode = process.env.PORTAL_AUTH_MODE;
    if (!['localhost', 'tailscale', 'oauth'].includes(authMode)) {
      throw new PortalError(
        'INVALID_ENV_AUTH_MODE',
        `PORTAL_AUTH_MODE must be one of: localhost, tailscale, oauth. Got: ${authMode}`,
        500,
        { envValue: authMode }
      );
    }
    overrides.auth_mode = authMode as any;
  }
  
  return overrides;
}
```

### Middleware Chain Edge Cases

1. **Middleware Exception Handling**: When individual middleware throws unhandled exceptions
```typescript
export function middlewareWrapper(middleware: Function, name: string) {
  return async (c: Context, next: Next) => {
    try {
      await middleware(c, next);
    } catch (error) {
      console.error(`Middleware '${name}' error:`, {
        error: error.message,
        stack: error.stack,
        requestId: c.get('requestId'),
        path: c.req.path,
        method: c.req.method,
      });
      
      // Don't let middleware errors kill the request
      // Continue to next middleware
      await next();
    }
  };
}
```

2. **CORS Preflight Edge Cases**: When OPTIONS requests have unusual headers or origins
```typescript
app.options('*', async (c) => {
  const origin = c.req.header('Origin');
  const method = c.req.header('Access-Control-Request-Method');
  const headers = c.req.header('Access-Control-Request-Headers');
  
  // Log suspicious CORS requests for security monitoring
  if (origin && !isAllowedOrigin(origin)) {
    console.warn('CORS preflight from disallowed origin:', {
      origin,
      method,
      headers,
      userAgent: c.req.header('user-agent'),
      requestId: c.get('requestId'),
    });
  }
  
  // Always respond to preflight to avoid browser CORS errors
  return c.text('', 200, {
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? origin : '',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': headers || '',
    'Access-Control-Max-Age': '86400',
  });
});
```

3. **Request Size Limits**: When requests exceed reasonable size limits
```typescript
app.use('*', async (c, next) => {
  const contentLength = c.req.header('content-length');
  const maxSize = 10 * 1024 * 1024; // 10MB limit
  
  if (contentLength && parseInt(contentLength) > maxSize) {
    throw new PortalError(
      'PAYLOAD_TOO_LARGE',
      `Request payload size (${contentLength} bytes) exceeds maximum allowed size (${maxSize} bytes)`,
      413,
      { contentLength: parseInt(contentLength), maxSize }
    );
  }
  
  await next();
});
```

### Startup Self-Check Edge Cases

1. **Daemon State Path Access**: When daemon state directories are not readable/writable
```typescript
async function validateDaemonStatePaths(): Promise<void> {
  const requiredPaths = [
    process.env.AUTONOMOUS_DEV_STATE_DIR || '~/.autonomous-dev',
    process.env.AUTONOMOUS_DEV_LOGS_DIR || '~/.autonomous-dev/logs',
  ];
  
  for (const path of requiredPaths) {
    try {
      const resolvedPath = path.startsWith('~') ? 
        `${process.env.HOME}${path.slice(1)}` : path;
        
      // Check if directory exists and is accessible
      const stat = await fs.stat(resolvedPath);
      if (!stat.isDirectory()) {
        throw new PortalError(
          'INVALID_STATE_PATH',
          `Daemon state path ${resolvedPath} exists but is not a directory`,
          500,
          { path: resolvedPath }
        );
      }
      
      // Test read/write access
      const testFile = `${resolvedPath}/.portal-access-test`;
      await Bun.write(testFile, 'test');
      await fs.unlink(testFile);
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new PortalError(
          'MISSING_STATE_PATH',
          `Daemon state directory ${path} does not exist. Please ensure the autonomous-dev daemon has been initialized.`,
          500,
          { path, resolvedPath }
        );
      } else if (error.code === 'EACCES') {
        throw new PortalError(
          'STATE_PATH_ACCESS_DENIED',
          `Cannot access daemon state directory ${path}. Please check permissions.`,
          500,
          { path, resolvedPath }
        );
      }
      throw error;
    }
  }
}
```

2. **Startup Performance Monitoring**: When startup takes longer than expected
```typescript
async function validateStartupPerformance(): Promise<void> {
  const startTime = Date.now();
  const TARGET_STARTUP_TIME = 10000; // 10 seconds
  
  // Run startup checks with timeout
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new PortalError(
        'STARTUP_TIMEOUT',
        `Server startup exceeded ${TARGET_STARTUP_TIME}ms timeout`,
        500,
        { timeoutMs: TARGET_STARTUP_TIME }
      ));
    }, TARGET_STARTUP_TIME);
  });
  
  try {
    await Promise.race([
      performAllStartupChecks(),
      timeoutPromise,
    ]);
    
    const startupDuration = Date.now() - startTime;
    if (startupDuration > TARGET_STARTUP_TIME * 0.8) {
      console.warn(`Slow startup detected: ${startupDuration}ms (target: ${TARGET_STARTUP_TIME}ms)`);
    }
    
    console.log(`Startup completed in ${startupDuration}ms`);
    
  } catch (error) {
    const startupDuration = Date.now() - startTime;
    console.error(`Startup failed after ${startupDuration}ms:`, error);
    throw error;
  }
}
```

3. **Dependency Version Validation**: When Bun runtime version is incompatible
```typescript
async function validateBunVersion(): Promise<void> {
  const MINIMUM_BUN_VERSION = '1.0.0';
  
  try {
    const versionOutput = await $`bun --version`.text();
    const currentVersion = versionOutput.trim();
    
    if (!isVersionCompatible(currentVersion, MINIMUM_BUN_VERSION)) {
      throw new PortalError(
        'INCOMPATIBLE_RUNTIME_VERSION',
        `Bun version ${currentVersion} is not compatible. Minimum required: ${MINIMUM_BUN_VERSION}`,
        500,
        { currentVersion, requiredVersion: MINIMUM_BUN_VERSION }
      );
    }
    
    console.log(`Bun runtime validated: ${currentVersion}`);
    
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new PortalError(
        'MISSING_RUNTIME',
        'Bun runtime not found in PATH. Please install Bun from https://bun.sh',
        500,
        { runtime: 'bun' }
      );
    }
    throw error;
  }
}

function isVersionCompatible(current: string, minimum: string): boolean {
  const currentParts = current.split('.').map(n => parseInt(n, 10));
  const minimumParts = minimum.split('.').map(n => parseInt(n, 10));
  
  for (let i = 0; i < Math.max(currentParts.length, minimumParts.length); i++) {
    const currentPart = currentParts[i] || 0;
    const minimumPart = minimumParts[i] || 0;
    
    if (currentPart > minimumPart) return true;
    if (currentPart < minimumPart) return false;
  }
  
  return true; // Equal versions are compatible
}
```

## Performance Targets and Monitoring

### Startup Performance Requirements

1. **Cold Start Time**: Server must be ready to accept requests within 10 seconds
2. **Configuration Loading**: All configuration layers processed within 500ms
3. **Dependency Validation**: Runtime and dependency checks completed within 2 seconds
4. **Memory Usage**: Initial memory footprint under 50MB

### Runtime Performance Requirements

1. **Request Throughput**: > 100 requests/second for health checks and static assets
2. **Response Times**: 
   - Health check: p95 < 50ms
   - Static assets: p95 < 100ms
   - Error pages: p95 < 200ms
3. **Memory Stability**: No memory leaks under sustained load
4. **Connection Handling**: Support for 50+ concurrent connections

### Performance Monitoring Implementation

```typescript
// server/lib/performance.ts
export class PerformanceMonitor {
  private startTime = Date.now();
  private requestCount = 0;
  private responseTimes: number[] = [];
  
  recordRequest(durationMs: number): void {
    this.requestCount++;
    this.responseTimes.push(durationMs);
    
    // Keep only last 1000 requests for percentile calculation
    if (this.responseTimes.length > 1000) {
      this.responseTimes = this.responseTimes.slice(-1000);
    }
  }
  
  getMetrics() {
    const uptime = Date.now() - this.startTime;
    const memoryUsage = process.memoryUsage();
    
    return {
      uptime,
      requestCount: this.requestCount,
      requestsPerSecond: this.requestCount / (uptime / 1000),
      responseTimeP50: this.percentile(this.responseTimes, 0.5),
      responseTimeP95: this.percentile(this.responseTimes, 0.95),
      responseTimeP99: this.percentile(this.responseTimes, 0.99),
      memoryUsageMB: {
        rss: Math.round(memoryUsage.rss / 1024 / 1024),
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
      },
    };
  }
  
  private percentile(values: number[], p: number): number {
    const sorted = values.slice().sort((a, b) => a - b);
    const index = Math.floor(sorted.length * p);
    return sorted[index] || 0;
  }
}
```

## Quality Assurance

### Definition of Done

- [ ] `server/server.ts` starts successfully and binds to configured port
- [ ] Configuration system loads defaults, user overrides, and environment variables correctly
- [ ] Middleware chain processes requests in correct order with extension points ready
- [ ] Error handling produces proper JSON and HTML responses with sanitized messages
- [ ] Graceful shutdown responds to SIGTERM/SIGINT within 15 seconds
- [ ] Static asset serving works with proper cache and security headers
- [ ] JSX templating renders valid HTML with no TypeScript compilation errors
- [ ] Startup self-check validates all critical dependencies and configuration
- [ ] Request correlation IDs generated and propagated through log messages
- [ ] Security validation prevents binding to external interfaces in localhost mode
- [ ] All unit tests pass with >90% code coverage
- [ ] Integration tests verify full request lifecycle
- [ ] Performance benchmarks meet targets: <10s startup, >100 req/sec throughput
- [ ] Edge case handling verified: port conflicts, malformed config, shutdown timeouts
- [ ] No security vulnerabilities in error message handling or configuration exposure

### Code Review Checklist

- [ ] **Security**: No sensitive information leaked in error messages or logs
- [ ] **Performance**: No blocking operations in request processing path
- [ ] **Reliability**: Proper error handling and graceful degradation for all failure modes
- [ ] **Maintainability**: Clear separation of concerns and well-documented extension points
- [ ] **Compatibility**: Works correctly with both Bun and Node.js runtimes
- [ ] **Testing**: Comprehensive test coverage including edge cases and error conditions

---

**Estimated Total Effort**: 40-50 hours across all tasks
**Critical Path**: TASK-001 → TASK-002 → TASK-003 → TASK-006 → TASK-007 (Core server functionality)
**Parallel Tracks**: Setup, Core, Middleware, Templates, Security, Assets, Testing, Optimization

This plan provides the solid foundation for the autonomous-dev portal server with production-ready infrastructure, comprehensive error handling, and clear extension points for future TDD implementations.