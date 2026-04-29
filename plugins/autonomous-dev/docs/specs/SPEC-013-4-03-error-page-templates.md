# SPEC-013-4-03: Error Page Templates with Safe Rendering (No Stack Trace Leaks)

## Metadata
- **Parent Plan**: PLAN-013-4
- **Tasks Covered**: TASK-009 (error page templates), partial TASK-007 (banner integration into error layout), TASK-011 (SVG accessibility documentation)
- **Estimated effort**: 5 hours

## Description
Author the unified `ErrorPage` JSX template that renders 404, 403, 422, 500, and 503 status codes with status-specific iconography, messaging, and contextual help. Implement `error-context.ts` to sanitize technical details — stack traces, environment paths, and internal error messages MUST be redacted in production and only surface to clients in development mode. The 503 variant integrates daemon health context (consumed from SPEC-013-4-01 middleware) and renders troubleshooting steps. All variants meet WCAG 2.2 AA: semantic heading hierarchy, ARIA error announcements, focus management on action buttons.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `server/templates/pages/error.tsx` | Create | Unified `ErrorPage` FC with status switch |
| `server/templates/fragments/error-details.tsx` | Create | Collapsible technical details (sanitized) |
| `server/templates/fragments/troubleshooting-steps.tsx` | Create | 503-specific daemon recovery steps |
| `server/lib/error-context.ts` | Create | `sanitizeError()` + `buildErrorContext()` |
| `server/middleware/error-handler.ts` | Create | Hono `onError` hook → renders `ErrorPage` |
| `server/server.ts` | Modify | Register `app.notFound()` and `app.onError()` |

## Implementation Details

### Error Context Builder (`server/lib/error-context.ts`)

```typescript
interface ErrorContext {
  statusCode: 403 | 404 | 422 | 500 | 503;
  message: string;        // user-safe message, NEVER raw error.message in production
  details?: string;       // sanitized stack/details, undefined in production
  requestPath?: string;
  daemonHealth?: DaemonHealth;
}

buildErrorContext(err: unknown, c: Context): ErrorContext
sanitizeError(err: unknown, mode: 'development' | 'production'): { message: string; details?: string }
```

`sanitizeError` rules:
- **Production mode** (`NODE_ENV=production` OR `mode === 'production'`):
  - For known error subclasses (`DaemonUnreachableError`, `ValidationError`, `NotFoundError`): use the safe `userMessage` property if present, else the generic message for the status code.
  - For unknown errors: return ONLY the generic status message ("Internal Server Error", "Page Not Found", etc.). NEVER include `err.message`, `err.stack`, file paths, env vars, or SQL fragments.
  - `details` is `undefined`.
- **Development mode**:
  - `message`: original `err.message` (truncated at 500 chars).
  - `details`: `err.stack` with home directory paths replaced by `~` (e.g. `/Users/<user>/` → `~/`).

`buildErrorContext` rules:
- Map error types to status codes: `NotFoundError → 404`, `ValidationError → 422`, `DaemonUnreachableError → 503`, `ForbiddenError → 403`, anything else → 500.
- `requestPath`: `c.req.path` (strip query string).
- `daemonHealth`: pull from `c.get('daemonHealth')` if status is 503 (set by middleware in SPEC-013-4-01).

### Generic Status Messages

| Code | Title | Default User Message |
|------|-------|----------------------|
| 403 | Forbidden | You do not have permission to access this resource. |
| 404 | Page Not Found | The requested page does not exist. |
| 422 | Invalid Request | The request contains invalid data. Please check your input. |
| 500 | Internal Server Error | Something went wrong. The error has been logged. |
| 503 | Service Unavailable | The service is temporarily unavailable. |

### Error Page Template (`server/templates/pages/error.tsx`)

```typescript
ErrorPage(props: ErrorContext) -> JSX.Element
```

Structure (semantic HTML):
```jsx
<BaseLayout title={`${title} | Autonomous Dev Portal`} showDaemonStatus={false}>
  <main class="error-page" role="main" aria-labelledby="error-heading">
    <div class="error-icon" aria-hidden="true">{getIconSvg(statusCode)}</div>
    <h1 id="error-heading">Error {statusCode}</h1>
    <p class="error-message" role="alert">{message}</p>
    <p class="error-help">{getHelpText(statusCode)}</p>

    {statusCode === 404 && <NavigationSuggestions />}
    {statusCode === 503 && daemonHealth && <TroubleshootingSteps health={daemonHealth} />}
    {details && <ErrorDetails details={details} requestPath={requestPath} />}

    <div class="error-actions">
      <button type="button" onclick="window.history.back()" class="btn btn-secondary">
        Go Back
      </button>
      <a href="/" class="btn btn-primary" autofocus>Return to Dashboard</a>
    </div>
  </main>
</BaseLayout>
```

Icon resolution: use SVG `<use href="/static/icons/<name>.svg#icon"/>` references — `attention-needed` for 403/422/500, `daemon-unreachable` for 503, `request-rejected` for 404. NO emoji. Inline SVGs from icon manifest (SPEC-013-4-02).

`<NavigationSuggestions>`: list with links to `/`, `/approvals`, `/settings`, `/ops` styled as `btn btn-secondary`.

### Error Details Fragment (`server/templates/fragments/error-details.tsx`)

```typescript
ErrorDetails(props: { details: string; requestPath?: string }) -> JSX.Element
```

```jsx
<details class="error-details">
  <summary>Technical Details</summary>
  <div class="error-details-content">
    {requestPath && <p><strong>Request Path:</strong> <code>{requestPath}</code></p>}
    <pre><code>{details}</code></pre>
  </div>
</details>
```

Renders nothing (returns `null`) when `details` is `undefined` (i.e. production mode).

### Troubleshooting Steps Fragment (`server/templates/fragments/troubleshooting-steps.tsx`)

```typescript
TroubleshootingSteps(props: { health: DaemonHealth }) -> JSX.Element
```

```jsx
<section class="daemon-status-info" role="region" aria-labelledby="ts-heading">
  <h2 id="ts-heading">Daemon Status: {health.status}</h2>
  <p>{health.message}</p>
  {health.lastHeartbeat && (
    <p><strong>Last heartbeat:</strong> <time>{health.lastHeartbeat.toISOString()}</time>
       <strong>Age:</strong> {Math.floor(health.stalenessSeconds ?? 0)}s</p>
  )}
  <div class="daemon-troubleshooting">
    <h3>Troubleshooting Steps</h3>
    <ol>
      <li>Check daemon process: <code>ps aux | grep supervisor-loop</code></li>
      <li>Start daemon: <code>claude daemon start</code></li>
      <li>View logs: <code>tail -f ~/.autonomous-dev/logs/daemon.log</code></li>
      <li>Restart portal: <code>claude portal restart</code></li>
    </ol>
  </div>
</section>
```

### Error Handler Middleware (`server/middleware/error-handler.ts`)

```typescript
registerErrorHandlers(app: Hono): void
```

```typescript
app.notFound((c) => {
  const ctx = buildErrorContext(new NotFoundError(c.req.path), c);
  return c.html(<ErrorPage {...ctx} />, 404);
});

app.onError((err, c) => {
  console.error('[error-handler]', err);  // full stack to server logs
  const ctx = buildErrorContext(err, c);
  // HTMX fragment requests get the error fragment only
  if (c.req.header('HX-Request') === 'true') {
    return c.html(<ErrorDetails details={ctx.details ?? ''} requestPath={ctx.requestPath} />,
                  ctx.statusCode);
  }
  return c.html(<ErrorPage {...ctx} />, ctx.statusCode);
});
```

The full error (stack, message) is logged server-side via `console.error`. The client receives ONLY the sanitized `ErrorContext`.

## Acceptance Criteria

- [ ] `GET /nonexistent-page` returns 404 with `<h1>Error 404</h1>` and Navigation Suggestions list rendered
- [ ] `GET /api/blocked` (returning a `ForbiddenError`) returns 403 with the generic forbidden message
- [ ] In production mode, an unhandled `throw new Error("DB connection failed at /Users/foo/db.ts:42")` returns 500 with body containing "Something went wrong" but NOT containing "DB connection failed", "/Users/foo", or "db.ts"
- [ ] In development mode, the same error renders `<details>` with `<pre><code>` containing the stack — but home-directory paths are replaced with `~`
- [ ] 503 response when daemon is unreachable renders the `TroubleshootingSteps` section with `claude daemon start` code block
- [ ] All error pages render `role="main"` and `<h1>` with `id="error-heading"` referenced by `aria-labelledby`
- [ ] `<p class="error-message">` carries `role="alert"` for screen reader announcement
- [ ] HTMX requests (`HX-Request: true`) receive only the `ErrorDetails` fragment, not the full layout
- [ ] `Return to Dashboard` button has `autofocus` attribute for keyboard users
- [ ] Server logs contain the full unredacted stack via `console.error('[error-handler]', err)` for every 5xx
- [ ] No error path leaks `process.env`, file paths, SQL strings, or `node_modules` paths to the client in production
- [ ] `ValidationError` thrown from a route renders 422 with the error's safe `userMessage` (not raw `err.message`)
- [ ] All five status codes (403, 404, 422, 500, 503) render distinct titles and icons

## Dependencies

- **Upstream**: SPEC-013-4-01 (asset middleware serving icons), SPEC-013-4-02 (`portal.css` `.error-page` styles, icon SVGs), PLAN-013-3 (`BaseLayout` component)
- **Daemon health context**: produced by SPEC-013-4-01 middleware that injects into `c` before any handler runs
- **Error subclass conventions**: `NotFoundError`, `ValidationError`, `ForbiddenError`, `DaemonUnreachableError` exported from `server/lib/errors.ts` (existing)
- **Consumed by**: SPEC-013-4-04 (rendering and sanitization tests)

## Notes

- The "no stack trace leaks" requirement is a security boundary, not a UX preference. Stack traces have historically leaked: home directory usernames, dependency versions with known CVEs, internal route paths, database column names, secret material in error context. The sanitization step is non-bypassable via configuration in production builds — `NODE_ENV=production` is the only way to enable detail rendering, and it MUST be inverted.
- Generic status messages are intentionally bland. Operators see the full error in server logs; users see "Something went wrong." This trade-off is correct for a portal exposed beyond a tightly-trusted network.
- HTMX fragment rendering is critical: a full-page 500 swapped into a `<div>` would break the layout. The `HX-Request` header check returns just the error details fragment so HTMX can swap it in place.
- Icon `<use>` references depend on hashed asset URLs in production. Use `assetUrl('icons/daemon-unreachable.svg')` rather than hard-coded paths.
- `TroubleshootingSteps` content is hard-coded for now. Future plans (PLAN-015-*) may make these dynamic based on detected failure mode.
- Banner injection from TASK-007 happens in `BaseLayout`, not here. Error pages explicitly opt out via `showDaemonStatus={false}` because the 503 page already presents the daemon status prominently.
