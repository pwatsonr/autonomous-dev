# SPEC-015-4-03: Daemon-Down Detection, Stale Banner & Graceful Degradation

## Metadata
- **Parent Plan**: PLAN-015-4
- **Tasks Covered**: TASK-001 (DaemonHealthMonitor), TASK-002 (Stale data handler + middleware), TASK-011 (BaseLayout banner injection)
- **Estimated effort**: 7.5 hours

## Description
Implement the portal's daemon-health monitoring layer that polls `heartbeat.json` every 15 seconds, classifies daemon state into `healthy|stale|dead|unknown`, broadcasts state changes over the SSE event bus from PLAN-015-1, and applies the result two ways: (1) a `requireHealthyDaemon` middleware that returns HTTP 503 on mutation endpoints when the daemon is dead/unknown; (2) a `staleBanner` template variable injected into every `BaseLayout` render via middleware so read-only pages keep working but always show a prominent banner with the heartbeat age. Read-only pages NEVER block — operators can always inspect state even when the daemon is gone.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/portal/health/health-types.ts` | Create | `DaemonStatus`, `BannerSeverity`, `MutationValidation` types |
| `src/portal/health/daemon-health-monitor.ts` | Create | Polling + status classification + SSE broadcast |
| `src/portal/health/stale-data-handler.ts` | Create | Banner config + mutation validation |
| `src/portal/middleware/daemon-health-middleware.ts` | Create | `requireHealthyDaemon` + `injectBannerData` |
| `src/portal/middleware/banner-injection-middleware.ts` | Create | Adds `staleBanner` to template ctx for all pages |
| `src/portal/templates/components/stale-data-banner.tsx` | Create | Banner JSX component (Hono JSX per SPEC-013-3-03) |
| `src/portal/templates/layouts/base.tsx` | Modify | Conditionally render banner at top of page |

## Implementation Details

### Types

```typescript
// src/portal/health/health-types.ts

export type DaemonStatus = 'healthy' | 'stale' | 'dead' | 'unknown';

export interface DaemonHealth {
  status: DaemonStatus;
  heartbeatTimestamp: number | null;   // epoch millis, null if file missing
  heartbeatAgeMs: number | null;       // null if file missing
  pid: number | null;
  iteration: number | null;
  observedAt: number;                   // when this snapshot was taken
}

export type BannerSeverity = 'none' | 'warning' | 'error';

export interface BannerConfig {
  severity: BannerSeverity;
  ariaRole: 'status' | 'alert';        // status for warning, alert for error
  message: string;
  details: string;                      // e.g. "Heartbeat age 45s"
  showRetry: boolean;                   // true when dead/unknown
}

export interface MutationValidation {
  allowed: boolean;
  reason?: string;                      // populated when not allowed
}
```

### DaemonHealthMonitor

```typescript
// src/portal/health/daemon-health-monitor.ts

const POLL_INTERVAL_MS = 15_000;
const HEALTHY_THRESHOLD_MS = 30_000;
const STALE_THRESHOLD_MS = 120_000;

export class DaemonHealthMonitor {
  private current: DaemonHealth = makeUnknown();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private heartbeatPath: string,            // e.g. ~/.autonomous-dev/heartbeat.json
    private eventBus: SseEventBus              // from PLAN-015-1 / SPEC-015-1-02
  ) {}

  start(): void {
    if (this.timer) return;
    void this.poll();                          // immediate poll
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getDaemonStatus(): DaemonHealth {
    return this.current;
  }

  private async poll(): Promise<void> {
    const previous = this.current;
    this.current = await this.readHeartbeat();
    if (previous.status !== this.current.status) {
      this.eventBus.broadcast({
        type: 'daemon-status-changed',
        data: this.current,
      });
    }
  }

  private async readHeartbeat(): Promise<DaemonHealth> {
    try {
      const raw = await Bun.file(this.heartbeatPath).text();
      const parsed = JSON.parse(raw) as { timestamp: string; pid?: number; iteration?: number };
      const ts = Date.parse(parsed.timestamp);
      if (!Number.isFinite(ts)) return makeUnknown();
      const age = Date.now() - ts;
      const status: DaemonStatus =
        age < HEALTHY_THRESHOLD_MS ? 'healthy' :
        age < STALE_THRESHOLD_MS ? 'stale' : 'dead';
      return { status, heartbeatTimestamp: ts, heartbeatAgeMs: age, pid: parsed.pid ?? null, iteration: parsed.iteration ?? null, observedAt: Date.now() };
    } catch (err) {
      // ENOENT → dead; parse error → unknown (defensive)
      const code = (err as NodeJS.ErrnoException).code;
      const status: DaemonStatus = code === 'ENOENT' ? 'dead' : 'unknown';
      return { status, heartbeatTimestamp: null, heartbeatAgeMs: null, pid: null, iteration: null, observedAt: Date.now() };
    }
  }
}

function makeUnknown(): DaemonHealth {
  return { status: 'unknown', heartbeatTimestamp: null, heartbeatAgeMs: null, pid: null, iteration: null, observedAt: Date.now() };
}
```

### StaleDataHandler

```typescript
// src/portal/health/stale-data-handler.ts

export class StaleDataHandler {
  constructor(private monitor: DaemonHealthMonitor) {}

  getBannerStatus(): BannerConfig {
    const h = this.monitor.getDaemonStatus();
    switch (h.status) {
      case 'healthy':
        return { severity: 'none', ariaRole: 'status', message: '', details: '', showRetry: false };
      case 'stale':
        return {
          severity: 'warning',
          ariaRole: 'status',
          message: 'Daemon heartbeat is stale. Data may be out of date.',
          details: `Heartbeat age ${formatAge(h.heartbeatAgeMs)}`,
          showRetry: false,
        };
      case 'dead':
        return {
          severity: 'error',
          ariaRole: 'alert',
          message: 'Daemon is unreachable. Read-only mode.',
          details: h.heartbeatAgeMs !== null ? `Last heartbeat ${formatAge(h.heartbeatAgeMs)} ago` : 'Heartbeat file missing',
          showRetry: true,
        };
      case 'unknown':
        return {
          severity: 'error',
          ariaRole: 'alert',
          message: 'Daemon status cannot be determined.',
          details: 'Heartbeat file is malformed or unreadable',
          showRetry: true,
        };
    }
  }

  validateMutationAllowed(): MutationValidation {
    const status = this.monitor.getDaemonStatus().status;
    if (status === 'dead' || status === 'unknown') {
      return { allowed: false, reason: 'Daemon is unavailable. Mutations are disabled.' };
    }
    return { allowed: true };
  }
}

function formatAge(ms: number | null): string {
  if (ms === null) return 'unknown';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}
```

### Middleware

```typescript
// src/portal/middleware/daemon-health-middleware.ts

export function requireHealthyDaemon(handler: StaleDataHandler) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const v = handler.validateMutationAllowed();
    if (!v.allowed) {
      return c.json({ success: false, error: v.reason }, 503);
    }
    return next();
  };
}

// src/portal/middleware/banner-injection-middleware.ts

export function injectBannerData(handler: StaleDataHandler) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    c.set('staleBanner', handler.getBannerStatus());
    return next();
  };
}
```

### Banner Template Component

```tsx
// src/portal/templates/components/stale-data-banner.tsx

export const StaleDataBanner = ({ banner }: { banner: BannerConfig }) => {
  if (banner.severity === 'none') return null;
  const cls = banner.severity === 'warning' ? 'banner banner--warning' : 'banner banner--error';
  return (
    <div class={cls} role={banner.ariaRole} aria-live={banner.ariaRole === 'alert' ? 'assertive' : 'polite'}>
      <strong>{banner.message}</strong>
      <span class="banner__details"> {banner.details}</span>
      {banner.showRetry && (
        <button hx-get="/health" hx-trigger="click" hx-swap="none" class="banner__retry">Retry</button>
      )}
    </div>
  );
};
```

### BaseLayout Integration

```tsx
// src/portal/templates/layouts/base.tsx (modify)

export const BaseLayout = ({ children, banner, ...props }: BaseLayoutProps) => (
  <html>
    <head>...</head>
    <body>
      {banner && <StaleDataBanner banner={banner} />}
      <Navigation ... />
      <main id="main-content">{children}</main>
    </body>
  </html>
);
```

The `banner` prop is injected by `injectBannerData` middleware via `c.var.staleBanner`. Every route handler that calls `renderPage(...)` automatically gets the current banner without per-route changes.

### Wiring (in server bootstrap)

```typescript
// src/portal/server/server.ts (additions)

const monitor = new DaemonHealthMonitor(heartbeatPath, eventBus);
monitor.start();
const staleHandler = new StaleDataHandler(monitor);

// Inject banner into ALL routes (read-only safe)
app.use('*', injectBannerData(staleHandler));

// Gate mutation routes only
app.use('/ops/kill-switch/*', requireHealthyDaemon(staleHandler));
app.use('/ops/circuit-breaker/*', requireHealthyDaemon(staleHandler));
app.use('/settings/save', requireHealthyDaemon(staleHandler));
// ... any other mutation route
```

## Acceptance Criteria

- [ ] `DaemonHealthMonitor` polls `heartbeat.json` every 15s
- [ ] Status classification: healthy <30s, stale 30-120s, dead >120s OR file missing, unknown on parse error
- [ ] Status changes broadcast via SSE event bus (`type: 'daemon-status-changed'`)
- [ ] `StaleDataHandler.getBannerStatus()` returns the correct banner config for each of the 4 statuses
- [ ] Banner severity: none/warning/error mapped per status
- [ ] `requireHealthyDaemon` middleware returns 503 when status is dead or unknown
- [ ] `requireHealthyDaemon` allows mutations when status is healthy or stale
- [ ] Banner injection middleware adds `staleBanner` to context for ALL routes
- [ ] BaseLayout conditionally renders the banner (skipped when severity=none)
- [ ] Banner uses correct ARIA role (status for warning, alert for error)
- [ ] Banner retry button uses HTMX to re-fetch `/health` and trigger SSE update
- [ ] Read-only pages (`/audit`, `/`, `/cost`) work normally when daemon dead — only banner appears
- [ ] Mutation pages cleanly fail with 503 (caught by frontend HTMX error handler)

## Dependencies

- **PLAN-015-1 / SPEC-015-1-02**: SSE event bus (`SseEventBus`) for status broadcasts
- **SPEC-013-3-03**: Hono JSX templating engine for the banner component
- **SPEC-013-2-02**: middleware chain (banner injection slots in after auth, before route handlers)
- Bun stdlib (`Bun.file`)

## Notes

- The daemon-down case is the safety-critical path: read-only access to historical state is ALWAYS preserved. An operator inspecting why the daemon crashed must not be locked out.
- Polling cadence (15s) is a deliberate trade-off vs file-watch: the heartbeat file is rewritten frequently, file-watch creates noisy events; a fixed 15s poll matches the daemon's heartbeat interval.
- The banner component uses ARIA `role="alert"` for `dead`/`unknown` so screen readers announce the issue immediately. `role="status"` for `stale` is less aggressive (announced when convenient).
- The retry button does NOT bypass mutation gating — it just triggers a fresh poll. If the daemon is back, the next poll will detect it within ~15s and the next request will succeed.
- We deliberately allow mutations in `stale` state. The daemon may be slow but is still alive. Forcing 503 here would be over-cautious.
