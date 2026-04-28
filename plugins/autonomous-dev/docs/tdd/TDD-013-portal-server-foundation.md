# TDD-013: Portal Server Foundation (Bun + Hono + HTMX)

| Field        | Value                                              |
|--------------|----------------------------------------------------|
| **Title**    | Portal Server Foundation (Bun + Hono + HTMX)       |
| **TDD ID**   | TDD-013                                            |
| **Version**  | 1.0                                                |
| **Date**     | 2026-04-28                                         |
| **Status**   | Draft                                              |
| **Author**   | Patrick Watson                                     |
| **Parent PRD** | PRD-009: Web Control Plane                       |
| **Plugin**   | autonomous-dev-portal (new)                        |

---

## 1. Summary

This TDD defines the foundation layer for the autonomous-dev web portal: a Bun-powered HTTP server using Hono + HTMX that provides the infrastructure for the operator-facing web interface defined in PRD-009. This foundation enables portfolio dashboards, request detail views, approval workflows, and configuration management through a server-rendered web application that maintains consistency with the existing autonomous-dev plugin architecture.

**Core responsibilities:**
- HTTP server initialization and lifecycle management via Claude Code plugin system
- Route handling for all portal pages (dashboard, request detail, approvals, settings, costs, ops, logs, audit)
- HTMX-based templating architecture for progressive enhancement without client-side framework overhead
- Static asset serving (HTMX library, CSS, icons) with appropriate caching headers
- Plugin packaging as a separate `autonomous-dev-portal` plugin with dependency on `autonomous-dev`
- User configuration management for portal-specific settings (port, auth mode, SSE intervals)

**Architectural boundaries:**
- **Security (TDD-014):** Authentication, CSRF protection, input validation, secret handling
- **Live Data & Mutations (TDD-015):** File watchers, SSE streaming, settings form submission, gate actions
- **Read-only foundation (this TDD):** Server bootstrap, routing, templating, static assets, plugin lifecycle

This foundation creates the substrate upon which TDD-014 security middleware and TDD-015 dynamic features operate, establishing patterns that scale from Phase A (read-only views) through Phase D (full operational control).

---

## 2. Goals & Non-Goals

### Goals

| ID | Goal |
|----|------|
| G-01 | Provide HTTP server foundation supporting all PRD-009 pages with < 500ms p95 page load times and < 150MB memory footprint |
| G-02 | Implement HTMX-based templating architecture enabling progressive enhancement without client-side JavaScript frameworks |
| G-03 | Package as standalone `autonomous-dev-portal` plugin with proper dependency management on `autonomous-dev` plugin |
| G-04 | Support plugin lifecycle integration via MCP server registration, including SessionStart hooks and graceful shutdown |
| G-05 | Establish user configuration surface for portal-specific settings (port, auth modes, SSE intervals, path policies) |
| G-06 | Deliver static assets (HTMX 1.9.x, portal CSS, icons) with versioning and CSP-compliant serving |

### Non-Goals

| ID | Non-Goal |
|----|----------|
| NG-01 | Authentication implementation (deferred to TDD-014) — this TDD assumes localhost-only operation |
| NG-02 | File watching and SSE streaming (deferred to TDD-015) — this TDD renders static snapshots |
| NG-03 | Form submission handling for settings or gate actions (deferred to TDD-015) — this TDD serves read-only forms |
| NG-04 | State file parsing and aggregation logic (minimal implementation for basic page rendering only) |
| NG-05 | Multi-user session management or horizontal scaling (single-operator design) |

---

## 3. Background

### Why a New Plugin?

The autonomous-dev system requires a web control plane (PRD-009 §1) but the existing `autonomous-dev` plugin focuses on pipeline execution, not HTTP serving. Creating `autonomous-dev-portal` as a separate plugin provides:

1. **Separation of concerns:** Pipeline execution vs. web interface remain independent
2. **Optional deployment:** Operators can run the daemon without the portal if desired
3. **Independent lifecycles:** Portal can restart/upgrade without affecting pipeline operations
4. **Clear dependency model:** Portal depends on daemon state; daemon is unaware of portal

### Technology Decisions

**Bun Runtime:** Native TypeScript execution, < 100ms cold start, no build step required. Matches project preference for minimal toolchain complexity while providing modern runtime capabilities.

**Hono Framework:** 14KB framework with native TypeScript support, built-in JSX templating, and SSE capabilities. Provides HTTP primitives without heavyweight abstractions like Express middleware chains.

**HTMX Architecture:** Server-rendered HTML with progressive enhancement via HTMX attributes. Eliminates client-side build chains, reduces JavaScript complexity, and enables graceful degradation when JavaScript fails. Aligns with PRD-009 NG-04 (not a SPA).

**No Client Framework:** React, Vue, or similar frameworks introduce build complexity, client-side state management, and hydration concerns that conflict with the project's operational simplicity goals.

---

## 4. Architecture

### System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         Browser                                 │
│  ┌─────────────────┐    ┌─────────────────┐                    │
│  │   Portal Pages  │    │  SSE Connection │  ← TDD-015         │
│  │   (HTMX)        │    │  (live updates) │                    │
│  └─────────────────┘    └─────────────────┘                    │
└─────────────────────────────────────────────────────────────────┘
                           │                 │
                    HTTP   │                 │ SSE
                    GET/   │                 │ 
                    POST   │                 │
                           ▼                 ▼
┌─────────────────────────────────────────────────────────────────┐
│              Portal Server (Hono + HTMX)                       │
│                                                                 │
│  ┌─────────────────┐    ┌─────────────────┐                    │
│  │   HTTP Routes   │    │   Static Assets │                    │
│  │                 │    │   - htmx.min.js │                    │
│  │  /dashboard     │    │   - portal.css  │                    │
│  │  /repo/{id}     │    │   - icons/      │                    │
│  │  /approvals     │    └─────────────────┘                    │
│  │  /settings      │                                           │
│  │  /costs         │    ┌─────────────────┐                    │
│  │  /ops           │    │  HTMX Templates │                    │
│  │  /logs          │    │                 │                    │
│  │  /audit         │    │  - layout/      │                    │
│  └─────────────────┘    │  - fragments/   │                    │
│                         └─────────────────┘                    │
│                                                                 │
│  ┌─────────────────┐    ┌─────────────────────────────────────┐ │
│  │  Security       │    │        Plugin Lifecycle            │ │
│  │  Middleware     │    │                                     │ │
│  │  (TDD-014)      │    │  SessionStart → bun install         │ │
│  └─────────────────┘    │  Shutdown → cleanup                 │ │
│                         └─────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                                 │
                         ┌───────┴───────┐
                         ▼               ▼
          ┌─────────────────────┐    ┌─────────────────────┐
          │   Daemon State      │    │   Portal Config     │
          │   (read-only)       │    │   (userConfig)      │
          │                     │    │                     │
          │ - state.json files  │    │ - port: 19280       │
          │ - cost-ledger.json  │    │ - auth_mode         │
          │ - events.jsonl      │    │ - sse_interval      │
          │ - config files      │    │ - path_policy       │
          │ - daemon.log        │    └─────────────────────┘
          └─────────────────────┘
```

### Request Flow

1. **Browser** sends HTTP request to portal server
2. **Security middleware** (TDD-014) validates Origin, CSRF tokens, authentication
3. **Route handler** determines page type and required data
4. **Template engine** renders HTMX fragments with daemon state data
5. **Response** includes rendered HTML + HTMX attributes for progressive enhancement
6. **SSE connection** (TDD-015) provides live updates without page refresh

### Integration Boundaries

- **TDD-014 Security:** Middleware chain includes auth verification, CSRF validation, input sanitization
- **TDD-015 Live Data:** File watchers monitor daemon state, SSE streams updates, forms submit mutations
- **autonomous-dev plugin:** Portal reads state files but never writes them; all mutations flow through intake router

---

## 5. Plugin Packaging Design

### Directory Structure

```
plugins/autonomous-dev-portal/
├── .claude-plugin/
│   └── plugin.json                     # Plugin metadata, MCP server config
├── package.json                        # Bun dependencies (hono, marked, etc.)
├── bun.lockb                          # Bun lockfile for reproducible installs
├── .mcp.json                          # MCP server registration
├── server/
│   ├── server.ts                      # Main Hono application entry point
│   ├── routes/                        # HTTP route handlers
│   │   ├── dashboard.ts               # Portfolio dashboard (FR-901-905)
│   │   ├── request-detail.ts          # Request detail view (FR-906-911)
│   │   ├── approvals.ts               # Approval queue (FR-917-921)
│   │   ├── settings.ts                # Configuration management (FR-922-927)
│   │   ├── costs.ts                   # Cost analysis (FR-928-933)
│   │   ├── ops.ts                     # Operations dashboard (FR-934-938)
│   │   ├── logs.ts                    # Logs interface (FR-939-942)
│   │   ├── audit.ts                   # Audit trail (FR-943-946)
│   │   └── health.ts                  # Health check endpoint
│   ├── templates/
│   │   ├── layout/
│   │   │   ├── base.tsx               # HTML shell with nav, status indicators
│   │   │   └── error.tsx              # Error page template (404, 422, 503)
│   │   └── fragments/
│   │       ├── repo-card.tsx          # Repository status card
│   │       ├── request-timeline.tsx   # Phase history timeline
│   │       ├── approval-item.tsx      # Approval queue entry
│   │       ├── cost-chart.tsx         # SVG chart generation
│   │       └── navigation.tsx         # Site navigation with status
│   ├── lib/
│   │   ├── config.ts                  # userConfig loading and validation
│   │   ├── state-reader.ts            # Daemon state file reading utilities
│   │   ├── template-utils.ts          # HTMX rendering helpers
│   │   └── daemon-health.ts           # Heartbeat checking for NFR-04
│   └── types/
│       ├── portal-config.ts           # Portal-specific configuration types
│       ├── daemon-state.ts            # Types for reading autonomous-dev state
│       └── http-types.ts              # Request/response type definitions
├── static/
│   ├── htmx.min.js                    # HTMX 1.9.x (pinned version)
│   ├── portal.css                     # Portal-specific styles (~3KB)
│   └── icons/                         # SVG icons for status indicators
│       ├── daemon-running.svg
│       ├── daemon-stale.svg
│       ├── kill-switch-active.svg
│       └── attention-needed.svg
├── config/
│   └── portal-defaults.json           # Default portal configuration values
└── README.md                          # Installation and setup guide
```

### Plugin.json Configuration

```json
{
  "name": "autonomous-dev-portal",
  "version": "0.1.0",
  "description": "Web control plane for autonomous-dev system",
  "author": {
    "name": "Patrick Watson",
    "email": "pwatsonr@gmail.com"
  },
  "dependencies": [
    "autonomous-dev"
  ],
  "runtime": {
    "name": "bun",
    "version": ">=1.0.0",
    "install_command": "bun install"
  },
  "userConfig": {
    "port": {
      "type": "number",
      "default": 19280,
      "description": "HTTP server port"
    },
    "auth_mode": {
      "type": "string",
      "enum": ["localhost", "tailscale", "oauth"],
      "default": "localhost",
      "description": "Authentication mode"
    },
    "tailscale_tailnet": {
      "type": "string",
      "description": "Tailscale tailnet name (when auth_mode=tailscale)"
    },
    "oauth_provider": {
      "type": "string",
      "enum": ["github", "google"],
      "description": "OAuth provider (when auth_mode=oauth)"
    },
    "sse_update_interval_seconds": {
      "type": "number",
      "default": 5,
      "min": 1,
      "max": 60,
      "description": "Server-Sent Events update interval"
    },
    "portal.path_policy.allowed_roots": {
      "type": "array",
      "items": { "type": "string" },
      "default": ["${HOME}"],
      "description": "Allowed root directories for repository paths"
    }
  },
  "lifecycle": {
    "sessionStart": "scripts/session-start.sh",
    "sessionEnd": "scripts/session-end.sh"
  }
}
```

### MCP Server Registration

```json
{
  "mcpServers": {
    "autonomous-dev-portal": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "server/server.ts"],
      "cwd": ".",
      "env": {
        "CLAUDE_PLUGIN_ROOT": "${CLAUDE_PLUGIN_ROOT}",
        "CLAUDE_PLUGIN_DATA": "${CLAUDE_PLUGIN_DATA}"
      }
    }
  }
}
```

---

## 6. Server Bootstrap Design

### server.ts Entry Point

```typescript
import { serve } from 'bun';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { securityHeaders } from 'hono/security-headers';

import { loadPortalConfig } from './lib/config';
import { registerRoutes } from './routes';
import { setupGracefulShutdown } from './lib/shutdown';

interface PortalConfig {
  port: number;
  auth_mode: 'localhost' | 'tailscale' | 'oauth';
  sse_update_interval_seconds: number;
  // Additional config from userConfig...
}

async function startServer() {
  // 1. Load and validate configuration
  const config = await loadPortalConfig();
  
  // 2. Initialize Hono app
  const app = new Hono();
  
  // 3. Setup middleware chain (order matters!)
  app.use('*', logger());                    // Request logging
  app.use('*', securityHeaders());           // Basic security headers
  app.use('*', cors({
    origin: config.auth_mode === 'localhost' 
      ? `http://127.0.0.1:${config.port}` 
      : config.allowed_origins,
    credentials: true
  }));
  
  // Security middleware from TDD-014 will be inserted here:
  // app.use('*', csrfValidation());
  // app.use('*', authenticationMiddleware());
  
  // 4. Mount routes
  await registerRoutes(app, config);
  
  // 5. Static asset serving
  app.get('/static/*', async (c) => {
    const path = c.req.path.replace('/static/', '');
    const file = Bun.file(`./static/${path}`);
    
    if (!(await file.exists())) {
      return c.notFound();
    }
    
    // Set appropriate cache headers
    const headers: Record<string, string> = {};
    if (path.endsWith('.js') || path.endsWith('.css')) {
      headers['Cache-Control'] = 'public, max-age=86400'; // 24 hours
    }
    if (path.endsWith('.svg')) {
      headers['Content-Type'] = 'image/svg+xml';
    }
    
    return new Response(file, { headers });
  });
  
  // 6. Error handling
  app.onError((err, c) => {
    console.error('Portal error:', err);
    return c.html(renderErrorPage(500, err.message), 500);
  });
  
  app.notFound((c) => {
    return c.html(renderErrorPage(404, 'Page not found'), 404);
  });
  
  // 7. Start server
  const server = serve({
    port: config.port,
    hostname: config.auth_mode === 'localhost' ? '127.0.0.1' : '0.0.0.0',
    fetch: app.fetch,
  });
  
  console.log(`Portal server listening on port ${config.port}`);
  
  // 8. Setup graceful shutdown
  setupGracefulShutdown(server);
  
  return server;
}

// Standalone mode (bun run server.ts)
if (import.meta.main) {
  startServer().catch(console.error);
}

export { startServer };
```

### Configuration Loading

```typescript
// server/lib/config.ts
interface PortalConfig {
  port: number;
  auth_mode: 'localhost' | 'tailscale' | 'oauth';
  tailscale_tailnet?: string;
  oauth_provider?: 'github' | 'google';
  sse_update_interval_seconds: number;
  portal: {
    path_policy: {
      allowed_roots: string[];
    };
  };
}

export async function loadPortalConfig(): Promise<PortalConfig> {
  // Load defaults from config/portal-defaults.json
  const defaultsFile = Bun.file('./config/portal-defaults.json');
  const defaults = await defaultsFile.json();
  
  // Load user config from Claude Code userConfig
  const userConfigPath = process.env.CLAUDE_PLUGIN_CONFIG;
  let userConfig = {};
  
  if (userConfigPath) {
    const userConfigFile = Bun.file(userConfigPath);
    if (await userConfigFile.exists()) {
      userConfig = await userConfigFile.json();
    }
  }
  
  // Merge with precedence: user config > defaults
  const config: PortalConfig = {
    ...defaults,
    ...userConfig,
    portal: {
      ...defaults.portal,
      ...userConfig.portal,
    },
  };
  
  // Validation
  if (config.port < 1024 || config.port > 65535) {
    throw new Error(`Invalid port: ${config.port}`);
  }
  
  if (config.sse_update_interval_seconds < 1) {
    throw new Error(`Invalid SSE interval: ${config.sse_update_interval_seconds}`);
  }
  
  // Auth mode validation (TDD-014 will extend this)
  if (!['localhost', 'tailscale', 'oauth'].includes(config.auth_mode)) {
    throw new Error(`Invalid auth_mode: ${config.auth_mode}`);
  }
  
  return config;
}
```

---

## 7. Route Inventory

| Route | Method | Handler | Template | SSE Updates | Purpose |
|-------|--------|---------|----------|-------------|---------|
| `/` | GET | `dashboard.ts#showDashboard` | `layout/base.tsx` + `fragments/repo-card.tsx` | Yes (TDD-015) | Portfolio dashboard (FR-901-905) |
| `/repo/{repo}/request/{id}` | GET | `request-detail.ts#showRequest` | `layout/base.tsx` + `fragments/request-timeline.tsx` | Yes | Request detail view (FR-906-911) |
| `/approvals` | GET | `approvals.ts#showQueue` | `layout/base.tsx` + `fragments/approval-item.tsx` | Yes | Approval queue (FR-917-921) |
| `/settings` | GET | `settings.ts#showSettings` | `layout/base.tsx` + settings form | No | Configuration management (FR-922-927) |
| `/costs` | GET | `costs.ts#showCosts` | `layout/base.tsx` + `fragments/cost-chart.tsx` | No | Cost analysis (FR-928-933) |
| `/ops` | GET | `ops.ts#showOps` | `layout/base.tsx` + ops dashboard | Yes | Operations dashboard (FR-934-938) |
| `/logs` | GET | `logs.ts#showLogs` | `layout/base.tsx` + logs viewer | Yes | Logs interface (FR-939-942) |
| `/audit` | GET | `audit.ts#showAudit` | `layout/base.tsx` + audit table | No | Audit trail (FR-943-946) |
| `/health` | GET | `health.ts#healthCheck` | JSON response | No | Health check for monitoring |

### Route Handler Pattern

```typescript
// server/routes/dashboard.ts
import { Context } from 'hono';
import { readDaemonState } from '../lib/state-reader';
import { BaseLayout } from '../templates/layout/base';
import { RepoCard } from '../templates/fragments/repo-card';

export async function showDashboard(c: Context) {
  try {
    // Read daemon state (minimal implementation for foundation)
    const repos = await readDaemonState().getRepositories();
    const globalMetrics = await readDaemonState().getGlobalMetrics();
    
    // Render with HTMX attributes for live updates (TDD-015)
    const content = (
      <div hx-ext="sse" sse-connect="/api/events" sse-swap="dashboard">
        <div class="global-metrics">
          <div class="metric-card">
            <span class="label">Active Requests</span>
            <span class="value">{globalMetrics.activeRequests}</span>
          </div>
          <div class="metric-card">
            <span class="label">Daily Spend</span>
            <span class="value">${globalMetrics.dailySpend.toFixed(2)}</span>
          </div>
        </div>
        
        <div class="repo-grid">
          {repos.map(repo => 
            <RepoCard 
              key={repo.name}
              name={repo.name}
              activeRequests={repo.activeRequests}
              lastActivity={repo.lastActivity}
              costThisMonth={repo.costThisMonth}
              needsAttention={repo.needsAttention}
            />
          )}
        </div>
      </div>
    );
    
    return c.html(
      <BaseLayout title="Portfolio Dashboard">
        {content}
      </BaseLayout>
    );
  } catch (error) {
    console.error('Dashboard error:', error);
    return c.html(renderErrorPage(503, 'Daemon unreachable'), 503);
  }
}
```

---

## 8. Templating Architecture

### Hono JSX vs String Templates Decision

**Decision: Use Hono's built-in JSX templating**

**Rationale:**
1. **Type safety:** JSX provides compile-time checking of component props and HTML structure
2. **Hono native:** Built into the framework, no additional dependencies or compilation steps
3. **Familiar syntax:** Matches React-like patterns developers expect
4. **Template composition:** Enables reusable fragments and layout inheritance

### Layout Inheritance Pattern

```typescript
// server/templates/layout/base.tsx
import { FC, PropsWithChildren } from 'hono/jsx';
import { Navigation } from '../fragments/navigation';

interface BaseLayoutProps {
  title: string;
  showDaemonStatus?: boolean;
}

export const BaseLayout: FC<PropsWithChildren<BaseLayoutProps>> = ({ 
  title, 
  showDaemonStatus = true, 
  children 
}) => {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title} - Autonomous Dev Portal</title>
        <link rel="stylesheet" href="/static/portal.css" />
        <script src="/static/htmx.min.js"></script>
        <meta 
          http-equiv="Content-Security-Policy" 
          content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; object-src 'none'; frame-ancestors 'none'"
        />
      </head>
      <body>
        <header>
          <Navigation currentPath={/* derived from request */} />
          {showDaemonStatus && (
            <div id="daemon-status" hx-get="/api/daemon-status" hx-trigger="every 30s">
              {/* Will be populated by TDD-015 SSE updates */}
            </div>
          )}
        </header>
        
        <main>
          {children}
        </main>
        
        <footer>
          <div class="footer-content">
            <span>Autonomous Dev Portal v0.1.0</span>
            <a href="/audit">Audit Log</a>
          </div>
        </footer>
      </body>
    </html>
  );
};
```

### Fragment Composition

```typescript
// server/templates/fragments/repo-card.tsx
interface RepoCardProps {
  name: string;
  activeRequests: number;
  lastActivity: string;
  costThisMonth: number;
  needsAttention: boolean;
}

export const RepoCard: FC<RepoCardProps> = ({ 
  name, 
  activeRequests, 
  lastActivity, 
  costThisMonth, 
  needsAttention 
}) => {
  const cardClass = needsAttention 
    ? 'repo-card needs-attention' 
    : 'repo-card';
    
  return (
    <div class={cardClass}>
      <div class="repo-header">
        <h3>{name}</h3>
        {needsAttention && (
          <span class="attention-badge" title="Approval needed">
            <img src="/static/icons/attention-needed.svg" alt="Attention" />
          </span>
        )}
      </div>
      
      <div class="repo-metrics">
        <div class="metric">
          <span class="label">Active Requests</span>
          <span class="value">{activeRequests}</span>
        </div>
        <div class="metric">
          <span class="label">Last Activity</span>
          <span class="value">{lastActivity}</span>
        </div>
        <div class="metric">
          <span class="label">Cost This Month</span>
          <span class="value">${costThisMonth.toFixed(2)}</span>
        </div>
      </div>
      
      <div class="repo-actions">
        <a href={`/repo/${name}`} class="btn btn-secondary">View Details</a>
      </div>
    </div>
  );
};
```

### HTMX Integration Patterns

Templates include HTMX attributes that will be activated by TDD-015:

```typescript
// Live updating content
<div 
  hx-ext="sse" 
  sse-connect="/api/events" 
  sse-swap="repo-updates"
  hx-trigger="sse:repo-updates"
>
  {/* Content updated via SSE */}
</div>

// Form submissions (TDD-015)
<form 
  hx-post="/api/settings/trust-level"
  hx-target="#settings-result"
  hx-indicator="#saving-spinner"
>
  {/* Form fields */}
</form>

// Confirmation modals (TDD-015)
<button 
  hx-delete="/api/ops/kill-switch"
  hx-confirm="Type CONFIRM to activate kill switch"
  hx-target="#ops-status"
>
  Activate Kill Switch
</button>
```

---

## 9. Static Assets

### Asset Inventory

| File | Size | Purpose | Caching |
|------|------|---------|---------|
| `htmx.min.js` | ~14KB | HTMX 1.9.x library | 24h cache |
| `portal.css` | ~3KB | Portal-specific styles | 24h cache |
| `icons/*.svg` | ~1KB each | Status indicators, UI icons | 7d cache |

### CSS Strategy

**Minimal framework approach:** Hand-written CSS (~3KB total) using:
- CSS Grid for layout (repo cards, dashboard grid)
- CSS Custom Properties for theming
- Progressive enhancement patterns
- WCAG 2.2 AA contrast compliance

```css
/* static/portal.css - excerpt */
:root {
  --primary-color: #2563eb;
  --success-color: #16a34a;
  --warning-color: #d97706;
  --danger-color: #dc2626;
  --bg-primary: #ffffff;
  --bg-secondary: #f8fafc;
  --text-primary: #1e293b;
  --text-secondary: #64748b;
  --border-color: #e2e8f0;
}

.repo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 1rem;
  padding: 1rem;
}

.repo-card {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 1rem;
  transition: box-shadow 0.2s ease;
}

.repo-card.needs-attention {
  border-color: var(--warning-color);
  border-width: 2px;
}

.repo-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

/* Accessibility */
.btn:focus-visible {
  outline: 2px solid var(--primary-color);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  * {
    transition-duration: 0.01ms !important;
  }
}
```

### Version Pinning

**HTMX 1.9.x:** Pinned to avoid breaking changes. Downloaded and bundled locally to avoid CDN dependencies and CSP complications.

**No CDN dependencies:** All assets served from `/static/` to maintain offline operation and reduce external dependencies.

### CSP Compliance

Static assets served with headers compatible with TDD-014 CSP policy:
- `script-src 'self'` - only local HTMX
- `style-src 'self' 'unsafe-inline'` - local CSS + minimal inline styles
- `img-src 'self' data:` - local icons + data URIs

---

## 10. Plugin Lifecycle

### SessionStart Hook

```bash
#!/bin/bash
# scripts/session-start.sh

set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
PACKAGE_JSON="${PLUGIN_ROOT}/package.json"
LOCK_FILE="${PLUGIN_ROOT}/bun.lockb"
CACHE_FILE="${PLUGIN_ROOT}/.install-cache"

# Check if dependencies need installation
NEEDS_INSTALL=false

# Check if package.json changed
if [ -f "${PACKAGE_JSON}" ]; then
  CURRENT_HASH=$(shasum -a 256 "${PACKAGE_JSON}" | cut -d' ' -f1)
  
  if [ -f "${CACHE_FILE}" ]; then
    CACHED_HASH=$(cat "${CACHE_FILE}")
    if [ "${CURRENT_HASH}" != "${CACHED_HASH}" ]; then
      NEEDS_INSTALL=true
    fi
  else
    NEEDS_INSTALL=true
  fi
fi

# Check if lockfile exists
if [ ! -f "${LOCK_FILE}" ]; then
  NEEDS_INSTALL=true
fi

# Install dependencies if needed
if [ "${NEEDS_INSTALL}" = true ]; then
  echo "Installing portal dependencies..."
  cd "${PLUGIN_ROOT}"
  
  if command -v bun >/dev/null 2>&1; then
    bun install
    echo "${CURRENT_HASH}" > "${CACHE_FILE}"
    echo "Dependencies installed successfully"
  else
    echo "Warning: Bun runtime not found. Install from https://bun.sh"
    echo "Falling back to Node.js (if available)..."
    
    if command -v npm >/dev/null 2>&1; then
      npm install
      echo "${CURRENT_HASH}" > "${CACHE_FILE}"
    else
      echo "Error: Neither Bun nor npm found. Cannot install dependencies."
      exit 1
    fi
  fi
fi

echo "Portal session start complete"
```

### SessionEnd Hook

```bash
#!/bin/bash
# scripts/session-end.sh

set -euo pipefail

echo "Stopping portal server..."

# Find and gracefully stop portal process
PORTAL_PID=$(pgrep -f "server/server.ts" || true)

if [ -n "${PORTAL_PID}" ]; then
  echo "Sending SIGTERM to portal process ${PORTAL_PID}"
  kill -TERM "${PORTAL_PID}" 2>/dev/null || true
  
  # Wait up to 5 seconds for graceful shutdown
  for i in {1..5}; do
    if ! kill -0 "${PORTAL_PID}" 2>/dev/null; then
      echo "Portal stopped gracefully"
      break
    fi
    sleep 1
  done
  
  # Force kill if still running
  if kill -0 "${PORTAL_PID}" 2>/dev/null; then
    echo "Force killing portal process"
    kill -KILL "${PORTAL_PID}" 2>/dev/null || true
  fi
fi

echo "Portal session end complete"
```

### Standalone Mode

```typescript
// Support for `bun run server.ts` outside Claude Code
async function detectStandaloneMode(): Promise<boolean> {
  return !process.env.CLAUDE_PLUGIN_ROOT;
}

async function main() {
  const isStandalone = await detectStandaloneMode();
  
  if (isStandalone) {
    console.log('Running in standalone mode');
    // Use default config values
    process.env.CLAUDE_PLUGIN_ROOT = process.cwd();
    process.env.CLAUDE_PLUGIN_DATA = './data';
  }
  
  await startServer();
}
```

### Graceful Shutdown

```typescript
// server/lib/shutdown.ts
export function setupGracefulShutdown(server: any) {
  const shutdown = async () => {
    console.log('Graceful shutdown initiated...');
    
    // Close HTTP server
    server.stop();
    
    // Close SSE connections (TDD-015)
    // await sseManager.closeAll();
    
    // Clean up file watchers (TDD-015)
    // await fileWatcher.close();
    
    console.log('Shutdown complete');
    process.exit(0);
  };
  
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  
  // Uncaught exception handling
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    shutdown();
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection at:', promise, 'reason:', reason);
    shutdown();
  });
}
```

---

## 11. User Configuration Surface

### Configuration Schema

```typescript
interface PortalUserConfig {
  // Server configuration
  port: number;                                    // Default: 19280
  bind_host: string;                              // Default: '127.0.0.1'
  
  // Authentication (TDD-014 implementation)
  auth_mode: 'localhost' | 'tailscale' | 'oauth'; // Default: 'localhost'
  tailscale_tailnet?: string;                     // Required when auth_mode = 'tailscale'
  oauth_provider?: 'github' | 'google';           // Required when auth_mode = 'oauth'
  oauth_client_id?: string;                       // Required when auth_mode = 'oauth'
  oauth_client_secret_env?: string;               // Env var name for secret
  
  // Live updates (TDD-015 implementation)
  sse_update_interval_seconds: number;            // Default: 5
  sse_max_connections: number;                    // Default: 10
  file_watch_debounce_ms: number;                 // Default: 100
  
  // Security and validation
  portal: {
    path_policy: {
      allowed_roots: string[];                    // Default: ['${HOME}']
      max_path_depth: number;                     // Default: 10
    };
    csrf: {
      token_lifetime_minutes: number;             // Default: 60
    };
    rate_limiting: {
      requests_per_minute: number;                // Default: 60
      burst_size: number;                         // Default: 10
    };
  };
  
  // Performance tuning
  performance: {
    page_cache_seconds: number;                   // Default: 30
    state_read_timeout_ms: number;                // Default: 1000
    max_concurrent_requests: number;              // Default: 50
  };
  
  // Logging and monitoring
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';  // Default: 'info'
    access_log: boolean;                          // Default: true
    audit_log_retention_days: number;            // Default: 90
  };
}
```

### Configuration Loading with Layering

```typescript
export async function loadPortalConfig(): Promise<PortalUserConfig> {
  const layers = [
    // 1. Built-in defaults
    await loadDefaultConfig(),
    
    // 2. Global userConfig from autonomous-dev plugin
    await loadGlobalUserConfig(),
    
    // 3. Portal-specific userConfig
    await loadPortalUserConfig(),
    
    // 4. Environment variable overrides
    loadEnvironmentOverrides(),
  ];
  
  const mergedConfig = deepMerge(...layers);
  
  // Validation
  await validateConfig(mergedConfig);
  
  return mergedConfig;
}

async function loadDefaultConfig(): Promise<Partial<PortalUserConfig>> {
  const file = Bun.file('./config/portal-defaults.json');
  return await file.json();
}

async function loadGlobalUserConfig(): Promise<Partial<PortalUserConfig>> {
  // Read from autonomous-dev plugin config that might affect portal
  const autonomousDevConfigPath = '../autonomous-dev/.claude-plugin/userConfig.json';
  const file = Bun.file(autonomousDevConfigPath);
  
  if (!(await file.exists())) {
    return {};
  }
  
  const autonomousConfig = await file.json();
  
  // Extract portal-relevant settings
  return {
    logging: {
      level: autonomousConfig.logging?.level || 'info',
    },
  };
}

function loadEnvironmentOverrides(): Partial<PortalUserConfig> {
  const overrides: Partial<PortalUserConfig> = {};
  
  if (process.env.PORTAL_PORT) {
    overrides.port = parseInt(process.env.PORTAL_PORT, 10);
  }
  
  if (process.env.PORTAL_AUTH_MODE) {
    overrides.auth_mode = process.env.PORTAL_AUTH_MODE as any;
  }
  
  if (process.env.PORTAL_LOG_LEVEL) {
    overrides.logging = {
      level: process.env.PORTAL_LOG_LEVEL as any,
    };
  }
  
  return overrides;
}
```

### Configuration Validation

```typescript
async function validateConfig(config: PortalUserConfig): Promise<void> {
  // Port validation
  if (config.port < 1024 || config.port > 65535) {
    throw new ConfigurationError(`Port must be between 1024-65535, got: ${config.port}`);
  }
  
  // Auth mode validation
  if (!['localhost', 'tailscale', 'oauth'].includes(config.auth_mode)) {
    throw new ConfigurationError(`Invalid auth_mode: ${config.auth_mode}`);
  }
  
  // Auth mode dependency validation
  if (config.auth_mode === 'tailscale' && !config.tailscale_tailnet) {
    throw new ConfigurationError('tailscale_tailnet required when auth_mode=tailscale');
  }
  
  if (config.auth_mode === 'oauth') {
    if (!config.oauth_provider) {
      throw new ConfigurationError('oauth_provider required when auth_mode=oauth');
    }
    if (!config.oauth_client_id) {
      throw new ConfigurationError('oauth_client_id required when auth_mode=oauth');
    }
  }
  
  // Path policy validation
  for (const rootPath of config.portal.path_policy.allowed_roots) {
    try {
      // Expand environment variables
      const expandedPath = rootPath.replace(/\$\{(\w+)\}/g, (_, varName) => 
        process.env[varName] || ''
      );
      
      // Check if path exists and is accessible
      await Bun.file(expandedPath).exists();
    } catch (error) {
      console.warn(`Warning: allowed_root path not accessible: ${rootPath}`);
    }
  }
  
  // Performance bounds validation
  if (config.sse_update_interval_seconds < 1 || config.sse_update_interval_seconds > 60) {
    throw new ConfigurationError('sse_update_interval_seconds must be between 1-60');
  }
  
  if (config.sse_max_connections < 1 || config.sse_max_connections > 100) {
    throw new ConfigurationError('sse_max_connections must be between 1-100');
  }
}

class ConfigurationError extends Error {
  constructor(message: string) {
    super(`Portal configuration error: ${message}`);
    this.name = 'ConfigurationError';
  }
}
```

---

## 12. Bun Runtime Requirements

### Runtime Detection and Installation

```typescript
// server/lib/runtime.ts
export interface RuntimeInfo {
  runtime: 'bun' | 'node';
  version: string;
  features: {
    nativeTypeScript: boolean;
    fastStartup: boolean;
    fileWatcher: boolean;
  };
}

export async function detectRuntime(): Promise<RuntimeInfo> {
  // Check for Bun
  try {
    const bunVersion = await $`bun --version`.text();
    return {
      runtime: 'bun',
      version: bunVersion.trim(),
      features: {
        nativeTypeScript: true,
        fastStartup: true,
        fileWatcher: true,
      },
    };
  } catch {
    // Bun not available
  }
  
  // Check for Node.js
  try {
    const nodeVersion = process.version;
    return {
      runtime: 'node',
      version: nodeVersion,
      features: {
        nativeTypeScript: false,
        fastStartup: false,
        fileWatcher: true, // via fs.watch
      },
    };
  } catch {
    throw new Error('Neither Bun nor Node.js runtime found');
  }
}

export async function checkRuntimeRequirements(): Promise<void> {
  const runtime = await detectRuntime();
  
  if (runtime.runtime === 'bun') {
    const versionParts = runtime.version.split('.').map(Number);
    if (versionParts[0] < 1) {
      throw new Error(`Bun version >= 1.0 required, found: ${runtime.version}`);
    }
    console.log(`Using Bun ${runtime.version} - optimal performance`);
    return;
  }
  
  if (runtime.runtime === 'node') {
    const versionParts = runtime.version.replace('v', '').split('.').map(Number);
    if (versionParts[0] < 18) {
      throw new Error(`Node.js version >= 18 required, found: ${runtime.version}`);
    }
    console.warn(`Using Node.js ${runtime.version} - consider installing Bun for better performance`);
    console.warn('TypeScript compilation will be required');
    return;
  }
}
```

### Node.js Compatibility Layer

```typescript
// When running on Node.js instead of Bun
if (process.versions.bun === undefined) {
  // TypeScript compilation required
  console.log('Compiling TypeScript for Node.js...');
  
  // Use ts-node for development or require pre-compilation for production
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Portal requires pre-compilation when using Node.js in production');
  }
  
  // Development mode: use ts-node
  require('ts-node/register');
}
```

### Installation Documentation

```markdown
## Bun Installation

### macOS/Linux
```bash
curl -fsSL https://bun.sh/install | bash
```

### Windows
```powershell
irm bun.sh/install.ps1 | iex
```

### Verification
```bash
bun --version  # Should show >= 1.0.0
```

### Alternative: Node.js Mode
If Bun is unavailable, the portal supports Node.js 18+ with TypeScript compilation:

```bash
npm install -g ts-node typescript
export NODE_ENV=development
npm start
```

Note: Node.js mode has slower startup times and requires TypeScript compilation.
```

---

## 13. Error Pages and HTTP Handling

### Error Page Templates

```typescript
// server/templates/layout/error.tsx
interface ErrorPageProps {
  statusCode: number;
  message: string;
  details?: string;
  isDaemonDown?: boolean;
}

export const ErrorPage: FC<ErrorPageProps> = ({ 
  statusCode, 
  message, 
  details, 
  isDaemonDown 
}) => {
  const getErrorIcon = (code: number) => {
    switch (code) {
      case 404: return '🔍';
      case 422: return '❌';
      case 503: return '⚠️';
      default: return '💥';
    }
  };
  
  return (
    <BaseLayout title={`Error ${statusCode}`} showDaemonStatus={false}>
      <div class="error-page">
        <div class="error-icon">{getErrorIcon(statusCode)}</div>
        <h1>Error {statusCode}</h1>
        <p class="error-message">{message}</p>
        
        {details && (
          <details class="error-details">
            <summary>Technical Details</summary>
            <pre>{details}</pre>
          </details>
        )}
        
        {isDaemonDown && (
          <div class="daemon-down-banner" role="alert">
            <h2>Daemon Unreachable</h2>
            <p>
              The autonomous-dev daemon appears to be stopped or unreachable. 
              This portal displays cached data that may be stale.
            </p>
            <p>
              <strong>All mutation actions are disabled</strong> until daemon connectivity is restored.
            </p>
            <div class="daemon-troubleshooting">
              <h3>Troubleshooting Steps:</h3>
              <ol>
                <li>Check if the daemon is running: <code>ps aux | grep autonomous-dev</code></li>
                <li>Check daemon logs: <code>tail ~/.autonomous-dev/logs/daemon.log</code></li>
                <li>Restart the daemon if needed</li>
                <li>Refresh this page once the daemon is restored</li>
              </ol>
            </div>
          </div>
        )}
        
        <div class="error-actions">
          <a href="/" class="btn btn-primary">Return to Dashboard</a>
          <button onclick="location.reload()" class="btn btn-secondary">Retry</button>
        </div>
      </div>
    </BaseLayout>
  );
};
```

### HTTP Error Handlers

```typescript
// server/lib/error-handlers.ts
export function registerErrorHandlers(app: Hono) {
  // 404 Not Found
  app.notFound((c) => {
    const isApiRequest = c.req.path.startsWith('/api/');
    
    if (isApiRequest) {
      return c.json({ error: 'Endpoint not found' }, 404);
    }
    
    return c.html(
      <ErrorPage 
        statusCode={404} 
        message="Page not found" 
        details={`The requested path "${c.req.path}" does not exist.`}
      />,
      404
    );
  });
  
  // Global error handler
  app.onError((error, c) => {
    console.error('Portal error:', error);
    
    // Determine error type and appropriate response
    const statusCode = determineStatusCode(error);
    const isDaemonDown = error.name === 'DaemonUnreachableError';
    
    const isApiRequest = c.req.path.startsWith('/api/');
    
    if (isApiRequest) {
      return c.json({
        error: error.message,
        code: error.name,
        isDaemonDown,
      }, statusCode);
    }
    
    return c.html(
      <ErrorPage 
        statusCode={statusCode}
        message={getErrorMessage(error)}
        details={process.env.NODE_ENV === 'development' ? error.stack : undefined}
        isDaemonDown={isDaemonDown}
      />,
      statusCode
    );
  });
}

function determineStatusCode(error: Error): number {
  if (error.name === 'ConfigurationError') return 422;
  if (error.name === 'ValidationError') return 422;
  if (error.name === 'AuthenticationError') return 401;
  if (error.name === 'AuthorizationError') return 403;
  if (error.name === 'DaemonUnreachableError') return 503;
  return 500;
}

function getErrorMessage(error: Error): string {
  switch (error.name) {
    case 'DaemonUnreachableError':
      return 'The autonomous-dev daemon is unreachable';
    case 'ConfigurationError':
      return 'Configuration validation failed';
    case 'ValidationError':
      return 'Input validation failed';
    default:
      return 'An internal error occurred';
  }
}
```

### Daemon Health Detection

```typescript
// server/lib/daemon-health.ts
interface DaemonHealth {
  status: 'healthy' | 'stale' | 'unreachable';
  lastHeartbeat?: Date;
  stalenessSeconds?: number;
}

export async function checkDaemonHealth(): Promise<DaemonHealth> {
  try {
    const heartbeatPath = '../autonomous-dev/.autonomous-dev/heartbeat.json';
    const heartbeatFile = Bun.file(heartbeatPath);
    
    if (!(await heartbeatFile.exists())) {
      return { status: 'unreachable' };
    }
    
    const heartbeat = await heartbeatFile.json();
    const lastHeartbeat = new Date(heartbeat.timestamp);
    const stalenessSeconds = (Date.now() - lastHeartbeat.getTime()) / 1000;
    
    // Health thresholds (configurable via userConfig)
    const staleThreshold = 60;  // 2x typical polling interval
    const deadThreshold = 300;  // 5x typical polling interval
    
    if (stalenessSeconds > deadThreshold) {
      return { status: 'unreachable', lastHeartbeat, stalenessSeconds };
    } else if (stalenessSeconds > staleThreshold) {
      return { status: 'stale', lastHeartbeat, stalenessSeconds };
    } else {
      return { status: 'healthy', lastHeartbeat, stalenessSeconds };
    }
  } catch (error) {
    console.error('Error checking daemon health:', error);
    return { status: 'unreachable' };
  }
}

export class DaemonUnreachableError extends Error {
  constructor(message = 'Daemon is unreachable') {
    super(message);
    this.name = 'DaemonUnreachableError';
  }
}

// Middleware to check daemon health before processing requests
export async function daemonHealthMiddleware(c: Context, next: () => Promise<void>) {
  const health = await checkDaemonHealth();
  
  // Store health status for templates
  c.set('daemonHealth', health);
  
  // For mutation endpoints, block if daemon is unhealthy
  if (c.req.method !== 'GET' && health.status !== 'healthy') {
    throw new DaemonUnreachableError('Cannot perform mutations while daemon is unreachable');
  }
  
  await next();
}
```

---

## 14. Test Strategy

### Unit Testing with Hono Test Client

```typescript
// tests/unit/routes/dashboard.test.ts
import { describe, test, expect, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { showDashboard } from '../../../server/routes/dashboard';

describe('Dashboard Route', () => {
  let app: Hono;
  
  beforeEach(() => {
    app = new Hono();
    app.get('/', showDashboard);
  });
  
  test('renders dashboard with repository cards', async () => {
    // Mock daemon state
    const mockRepos = [
      {
        name: 'test-repo',
        activeRequests: 2,
        lastActivity: '2 minutes ago',
        costThisMonth: 15.75,
        needsAttention: false,
      },
    ];
    
    // Mock state reader
    jest.mock('../../../server/lib/state-reader', () => ({
      readDaemonState: () => ({
        getRepositories: () => Promise.resolve(mockRepos),
        getGlobalMetrics: () => Promise.resolve({
          activeRequests: 5,
          dailySpend: 8.25,
        }),
      }),
    }));
    
    const res = await app.request('/');
    
    expect(res.status).toBe(200);
    
    const html = await res.text();
    expect(html).toContain('Portfolio Dashboard');
    expect(html).toContain('test-repo');
    expect(html).toContain('$15.75');
    expect(html).toContain('hx-ext="sse"'); // HTMX attributes
  });
  
  test('returns 503 when daemon is unreachable', async () => {
    // Mock daemon error
    jest.mock('../../../server/lib/state-reader', () => ({
      readDaemonState: () => ({
        getRepositories: () => Promise.reject(new DaemonUnreachableError()),
        getGlobalMetrics: () => Promise.reject(new DaemonUnreachableError()),
      }),
    }));
    
    const res = await app.request('/');
    
    expect(res.status).toBe(503);
    
    const html = await res.text();
    expect(html).toContain('daemon appears to be stopped');
    expect(html).toContain('mutation actions are disabled');
  });
});
```

### Template Snapshot Testing

```typescript
// tests/unit/templates/repo-card.test.ts
import { describe, test, expect } from 'bun:test';
import { render } from 'hono/jsx/dom';
import { RepoCard } from '../../../server/templates/fragments/repo-card';

describe('RepoCard Component', () => {
  test('renders basic repository information', () => {
    const props = {
      name: 'my-awesome-repo',
      activeRequests: 3,
      lastActivity: '5 minutes ago',
      costThisMonth: 42.50,
      needsAttention: false,
    };
    
    const component = <RepoCard {...props} />;
    const html = render(component);
    
    expect(html).toMatchSnapshot();
  });
  
  test('shows attention badge when needs attention', () => {
    const props = {
      name: 'urgent-repo',
      activeRequests: 1,
      lastActivity: '1 hour ago',
      costThisMonth: 5.25,
      needsAttention: true,
    };
    
    const component = <RepoCard {...props} />;
    const html = render(component);
    
    expect(html).toContain('needs-attention');
    expect(html).toContain('attention-needed.svg');
  });
});
```

### Plugin Lifecycle Integration Test

```typescript
// tests/integration/plugin-lifecycle.test.ts
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startServer } from '../../server/server';
import { execSync } from 'child_process';

describe('Plugin Lifecycle', () => {
  let server: any;
  
  beforeAll(async () => {
    // Set up test environment
    process.env.CLAUDE_PLUGIN_ROOT = './tests/fixtures/plugin-root';
    process.env.CLAUDE_PLUGIN_DATA = './tests/fixtures/plugin-data';
  });
  
  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });
  
  test('SessionStart hook installs dependencies when package.json changes', async () => {
    // Modify package.json
    const packageJson = JSON.parse(await Bun.file('./package.json').text());
    packageJson.version = '0.2.0-test';
    await Bun.write('./tests/fixtures/plugin-root/package.json', JSON.stringify(packageJson));
    
    // Run SessionStart hook
    const result = execSync('./scripts/session-start.sh', {
      cwd: './tests/fixtures/plugin-root',
      encoding: 'utf8',
    });
    
    expect(result).toContain('Installing portal dependencies');
    expect(result).toContain('Dependencies installed successfully');
  });
  
  test('server starts and serves health check endpoint', async () => {
    server = await startServer();
    
    const res = await fetch('http://127.0.0.1:19280/health');
    expect(res.status).toBe(200);
    
    const health = await res.json();
    expect(health.status).toBe('healthy');
    expect(health.daemon).toBeDefined();
  });
  
  test('graceful shutdown works correctly', async () => {
    server = await startServer();
    
    // Send SIGTERM
    process.kill(process.pid, 'SIGTERM');
    
    // Wait for graceful shutdown (timeout after 10s)
    await new Promise((resolve) => {
      let attempts = 0;
      const checkShutdown = async () => {
        try {
          await fetch('http://127.0.0.1:19280/health');
          if (attempts++ < 50) {
            setTimeout(checkShutdown, 100);
          } else {
            resolve(void 0); // Timeout - server should be down
          }
        } catch {
          resolve(void 0); // Server is down
        }
      };
      checkShutdown();
    });
  });
});
```

### Security Testing Matrix

```typescript
// tests/security/csrf-protection.test.ts
import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';

describe('CSRF Protection', () => {
  test('rejects POST requests without Origin header', async () => {
    const app = new Hono();
    app.post('/api/settings', (c) => c.json({ success: true }));
    
    const res = await app.request('/api/settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ key: 'value' }),
    });
    
    expect(res.status).toBe(403);
  });
  
  test('rejects POST requests with invalid Origin', async () => {
    const app = new Hono();
    app.post('/api/settings', (c) => c.json({ success: true }));
    
    const res = await app.request('/api/settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://evil.com',
      },
      body: JSON.stringify({ key: 'value' }),
    });
    
    expect(res.status).toBe(403);
  });
  
  test('accepts POST requests with valid Origin', async () => {
    const app = new Hono();
    
    // Mock CSRF middleware to accept localhost
    app.use('*', (c, next) => {
      const origin = c.req.header('Origin');
      if (!origin || !origin.startsWith('http://127.0.0.1:')) {
        return c.text('CSRF validation failed', 403);
      }
      return next();
    });
    
    app.post('/api/settings', (c) => c.json({ success: true }));
    
    const res = await app.request('/api/settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'http://127.0.0.1:19280',
      },
      body: JSON.stringify({ key: 'value' }),
    });
    
    expect(res.status).toBe(200);
  });
});
```

---

## 15. Performance Considerations

### Page Load Optimization

**Target: < 500ms p95 page load time**

1. **Server-side rendering:** All HTML generated server-side, no client hydration delay
2. **Minimal JavaScript:** Only HTMX library (~14KB), no framework overhead
3. **Static asset optimization:** CSS/JS served with cache headers, compressed when possible
4. **Database-free architecture:** Direct file system reads, no database query overhead

### Memory Management

**Target: < 150MB resident memory**

```typescript
// Memory-efficient state reading
export class StateReader {
  private cache = new Map<string, { data: any; timestamp: number }>();
  private readonly CACHE_TTL = 30_000; // 30 seconds
  
  async readStateFile(path: string): Promise<any> {
    const cached = this.cache.get(path);
    const now = Date.now();
    
    if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
      return cached.data;
    }
    
    const file = Bun.file(path);
    const data = await file.json();
    
    this.cache.set(path, { data, timestamp: now });
    
    // Cleanup old cache entries
    if (this.cache.size > 100) {
      this.cleanupCache();
    }
    
    return data;
  }
  
  private cleanupCache(): void {
    const now = Date.now();
    for (const [path, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.CACHE_TTL) {
        this.cache.delete(path);
      }
    }
  }
}
```

### Startup Time Optimization

**Target: < 10 seconds startup**

1. **Bun runtime:** < 100ms cold start vs Node.js seconds
2. **No compilation step:** Native TypeScript execution
3. **Lazy route loading:** Routes loaded on-demand rather than at startup
4. **Minimal dependency tree:** Only essential packages (hono, marked, dompurify)

### Concurrent Connection Limits

```typescript
// Connection management for SSE and HTTP
export class ConnectionManager {
  private sseConnections = new Set<WebSocket>();
  private readonly MAX_SSE_CONNECTIONS = 10;
  private readonly MAX_HTTP_CONCURRENT = 50;
  private httpRequestCount = 0;
  
  async addSSEConnection(ws: WebSocket): Promise<boolean> {
    if (this.sseConnections.size >= this.MAX_SSE_CONNECTIONS) {
      return false; // Reject new connection
    }
    
    this.sseConnections.add(ws);
    
    ws.addEventListener('close', () => {
      this.sseConnections.delete(ws);
    });
    
    return true;
  }
  
  async withHttpRequest<T>(handler: () => Promise<T>): Promise<T> {
    if (this.httpRequestCount >= this.MAX_HTTP_CONCURRENT) {
      throw new Error('Too many concurrent requests');
    }
    
    this.httpRequestCount++;
    
    try {
      return await handler();
    } finally {
      this.httpRequestCount--;
    }
  }
}
```

### File System Monitoring Efficiency

```typescript
// Efficient file watching for state changes (TDD-015 will implement)
export class FileWatchManager {
  private watchers = new Map<string, any>();
  private debounceTimers = new Map<string, Timer>();
  
  watchStateFiles(callback: (path: string) => void): void {
    const stateDirs = [
      '../autonomous-dev/.autonomous-dev/requests',
      '../autonomous-dev/.autonomous-dev/logs',
    ];
    
    for (const dir of stateDirs) {
      // Use platform-specific efficient watchers
      const watcher = Bun.watch(dir, {
        recursive: true,
        filter: (path) => path.endsWith('.json') || path.endsWith('.log'),
      });
      
      watcher.on('change', (path) => {
        // Debounce rapid file changes
        const existing = this.debounceTimers.get(path);
        if (existing) {
          clearTimeout(existing);
        }
        
        this.debounceTimers.set(path, setTimeout(() => {
          callback(path);
          this.debounceTimers.delete(path);
        }, 100));
      });
      
      this.watchers.set(dir, watcher);
    }
  }
  
  cleanup(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
    
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}
```

---

## 16. Migration & Rollout Strategy

### Phase A Implementation (Read-Only Views)

**Scope for initial release:**
- Portfolio dashboard with repository cards and global metrics
- Request detail pages with timeline and artifact rendering
- Cost analysis with basic charts
- Operations health monitoring
- Static navigation and error pages

**What ships first:**
```typescript
// Phase A route handlers - read-only implementations
const phaseARoutes = [
  'GET /dashboard',
  'GET /repo/{repo}/request/{id}',
  'GET /costs',
  'GET /ops',
  'GET /health',
  'GET /static/*',
];
```

**TDD-014 and TDD-015 features explicitly deferred:**
- No authentication beyond localhost binding
- No SSE live updates (static page refresh)
- No form submissions or mutations
- No file watching
- No settings editor

### Installation Process

**Step 1: Plugin deployment**
```bash
# Install portal plugin alongside autonomous-dev
cd ~/.claude/plugins
git clone <portal-repo> autonomous-dev-portal
cd autonomous-dev-portal
bun install
```

**Step 2: Configuration**
```json
// ~/.claude/autonomous-dev-portal.json
{
  "port": 19280,
  "auth_mode": "localhost",
  "sse_update_interval_seconds": 5
}
```

**Step 3: Verification**
```bash
# Start portal in standalone mode for testing
cd ~/.claude/plugins/autonomous-dev-portal
bun run server.ts

# Verify in browser: http://127.0.0.1:19280
```

### Migration Safety

**No data migration required:**
- Portal reads existing daemon state files
- No portal-specific state to migrate
- Existing CLI/chat workflows unaffected

**Rollback plan:**
- Stop portal server (kill process or disable plugin)
- Remove portal plugin directory
- No daemon restart required

**Compatibility:**
- Portal requires autonomous-dev plugin >= v0.1.0
- Dependency enforced in plugin.json
- Graceful degradation when daemon unavailable

### Operator Communication

**Setup wizard integration (Phase 11):**
```
Portal Setup (Optional)

The autonomous-dev portal provides a web interface for managing your
development pipeline. This is purely optional - CLI and chat interfaces
continue to work normally.

✓ Bun runtime detected (optimal performance)
✓ autonomous-dev plugin found
✓ Starting portal server on localhost:19280

🌐 Open in browser: http://127.0.0.1:19280

📋 Features in this phase:
  - Portfolio dashboard
  - Request timeline views  
  - Cost analysis charts
  - Operations monitoring

⚠️  Security note: Portal currently binds to localhost only.
   For network access, see portal-setup skill for auth configuration.

Continue to Phase 12? [y/N]
```

### Feature Rollout Sequencing

**Phase A → B → C → D progression:**

| Phase | Features | Duration | Dependencies |
|-------|----------|----------|--------------|
| Phase A | Read-only views, localhost auth | 2 weeks | TDD-013 only |
| Phase B | Approval actions, audit trail | 2 weeks | TDD-013 + TDD-014 + TDD-015 |
| Phase C | Settings forms, live updates | 1 week | All TDDs complete |
| Phase D | Advanced ops, network auth | 1 week | Full feature validation |

**Incremental deployment:**
- Each phase can be deployed independently
- Backward compatibility maintained
- Feature flags for early access testing

---

## 17. Open Questions

### Q1: HTMX Version Strategy

**Question:** Should we pin HTMX to 1.9.x indefinitely or establish an upgrade path to 2.x when it releases?

**Context:** HTMX 2.0 will introduce breaking changes, but 1.9.x is stable and meets all current requirements.

**Proposal:** Pin to 1.9.x for initial release; evaluate 2.x upgrade as a separate TDD when it stabilizes.

### Q2: Node.js Compatibility Priority

**Question:** How much engineering effort should we invest in Node.js compatibility vs. encouraging Bun adoption?

**Context:** Bun provides significant performance benefits but Node.js has broader deployment compatibility.

**Proposal:** Document Node.js support but optimize for Bun; provide clear upgrade path guidance.

### Q3: State File Reading Strategy

**Question:** Should we implement a sophisticated caching layer for daemon state files or keep it simple with 30-second cache TTL?

**Context:** State files can be large (100KB+) and read frequently, but complexity adds maintenance burden.

**Proposal:** Start with simple 30-second cache; add sophistication only if performance testing shows necessity.

### Q4: Error Page Localization

**Question:** Do we need internationalization support for error messages and portal UI?

**Context:** PRD-009 doesn't mention localization, but operational tools sometimes need it for global teams.

**Proposal:** Defer localization as out of scope; use English-only for initial release.

### Q5: Accessibility Testing Automation

**Question:** Should we integrate automated accessibility testing (axe-core) into CI pipeline or rely on manual testing?

**Context:** PRD-009 requires WCAG 2.2 AA compliance but doesn't specify testing approach.

**Proposal:** Add axe-core to test suite for regression prevention; supplement with manual testing for nuanced UX.

---

## 18. References

### Primary Requirements
- **PRD-009**: Web Control Plane - complete functional requirements and user stories
- **PRD-008**: Unified Request Submission - intake router integration and setup wizard coordination

### Related TDDs
- **TDD-001**: Daemon Engine - architectural patterns and configuration management approach
- **TDD-008**: Intake & Communication Layer - adapter pattern and state handling conventions
- **TDD-014**: Portal Security (upcoming) - authentication, CSRF protection, input validation
- **TDD-015**: Portal Live Data & Mutations (upcoming) - SSE streaming, file watching, form handling

### Technology Documentation
- **Hono Framework**: https://hono.dev/ - HTTP framework and JSX templating
- **HTMX Documentation**: https://htmx.org/ - progressive enhancement patterns
- **Bun Runtime**: https://bun.sh/ - TypeScript execution and package management
- **WCAG 2.2 Guidelines**: https://www.w3.org/WAI/WCAG22/quickref/ - accessibility standards

### Implementation Standards
- **Plugin Architecture**: autonomous-dev plugin patterns and conventions
- **Configuration Layering**: userConfig merging and validation approaches
- **Error Handling**: consistent error types and HTTP status code usage
- **File System Patterns**: daemon state reading and file watching strategies

The portal server foundation creates the infrastructure that enables all subsequent portal features while maintaining architectural consistency with the autonomous-dev ecosystem.