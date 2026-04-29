# PLAN-013-4: Static Assets + Error Pages + Daemon-Down Banner

## Metadata
- **Parent TDD**: TDD-013-portal-server-foundation
- **Estimated effort**: 2 days
- **Dependencies**: ["PLAN-013-2", "PLAN-013-3"]
- **Priority**: P1
- **Author**: Patrick Watson
- **Version**: 1.0
- **Date**: 2026-04-17

## Objective

Deliver the static asset serving infrastructure, error handling system, and daemon health monitoring capabilities for the autonomous-dev portal. This plan implements TDD-013 sections 9 (Static Assets), 13 (Error Pages), and 11 (Daemon Health) to create the foundational UI layer and resilient error handling required by NFR-04 daemon-down detection.

This plan produces a portal that can serve versioned static assets with appropriate caching headers, detect daemon connectivity issues through heartbeat monitoring, inject status banners into page layouts, guard mutation endpoints when the daemon is unreachable, and render accessibility-compliant error pages for all HTTP error conditions.

## Scope

### In Scope
- **Static Asset Infrastructure**: File serving from `static/` directory with MIME type detection, gzip/brotli compression middleware, cache-control headers (immutable for hashed assets, short TTL for unhashed)
- **HTMX Library Vendoring**: Download and pin HTMX v1.9.x locally, serve from `/static/htmx.min.js` without CDN dependencies
- **Portal CSS Authoring**: Hand-rolled ~3KB stylesheet using CSS Grid, custom properties, WCAG 2.2 AA compliance, progressive enhancement patterns
- **SVG Icon System**: Curated icon set for daemon status, request phases, UI controls with accessibility metadata (title/desc elements)
- **Daemon Health Monitoring**: Heartbeat file reader with configurable staleness thresholds, middleware for dependency health checking per NFR-04
- **Daemon-Down Banner**: Template injection system adding status banners to page layouts when daemon connectivity degrades
- **Mutation Guard Middleware**: HTTP 503 responses for non-GET requests when daemon is unreachable, preserving data consistency
- **Error Page Templates**: Complete 404/422/500/503 error pages with HTMX fragment compatibility, daemon status context injection
- **Asset Hashing System**: Build-time hash generation for cache-busting, manifest file for asset resolution
- **Accessibility Conformance**: ARIA labels, semantic HTML, focus management, screen reader compatibility across all static assets

### Out of Scope
- **Live Data Layer**: File watching, SSE streaming, real-time dashboard updates (PLAN-015-*)
- **Settings Editor Mutations**: Form submission handling, configuration updates (PLAN-015-*)
- **Gate Action Endpoints**: Kill switch, circuit breaker controls, approval actions (PLAN-015-*)
- **Security Middleware**: Authentication, CSRF protection, input validation (PLAN-014-*)
- **State File Parsing**: Comprehensive daemon state reading beyond health checking (PLAN-013-5)

## Tasks

### TASK-001: Vendor HTMX Library
**Description**: Download and integrate HTMX v1.9.x as a local static asset to eliminate CDN dependencies and ensure consistent versioning across portal deployments. Per TDD-013 §9, serve from `/static/htmx.min.js` with 24-hour cache headers.

**Files**:
- Create: `/static/htmx.min.js`
- Create: `/static/htmx.min.js.LICENSE`
- Create: `/scripts/vendor-htmx.sh`
- Modify: `/package.json` (add build script)

**Dependencies**: None

**Acceptance Criteria**:
- HTMX v1.9.12 (latest stable) downloaded and verified against published SHA256
- Library served at `/static/htmx.min.js` with correct MIME type (`application/javascript`)
- License file includes HTMX BSD-2-Clause license text
- Version pinning prevents automatic updates without explicit re-vendoring
- Build script supports offline operation after initial download

**Lint/Test Commands**:
```bash
# Verify download integrity
cd /Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev-portal
shasum -a 256 static/htmx.min.js
bun test tests/unit/static-assets.test.ts --match="HTMX library"
```

**Estimated Effort**: 1 hour
**Track**: Static Assets
**Risks**: 
- **Medium Risk**: HTMX version incompatibility with existing portal code
- **Mitigation**: Test against TDD-013 HTMX attribute patterns before finalizing version

### TASK-002: Author Portal CSS Framework
**Description**: Create the complete portal.css stylesheet implementing TDD-013 §9 design system. Hand-rolled CSS using CSS Grid for layouts, custom properties for theming, and progressive enhancement patterns. Target ~3KB total size with WCAG 2.2 AA compliance.

**Files**:
- Create: `/static/portal.css`
- Create: `/src/styles/variables.css` (source file)
- Create: `/src/styles/layout.css` (source file)
- Create: `/src/styles/components.css` (source file)
- Create: `/src/styles/utilities.css` (source file)
- Create: `/scripts/build-css.sh`

**Dependencies**: None

**Acceptance Criteria**:
- CSS Grid layouts for dashboard repo cards, request timelines, navigation
- CSS custom properties define complete color palette and spacing scale
- WCAG 2.2 AA contrast ratios (4.5:1 normal text, 3:1 large text)
- Focus indicators meet WCAG requirements (2px solid outline, visible offset)
- `prefers-reduced-motion` support disables all animations
- Responsive breakpoints support 320px to 1920px viewport widths
- Component classes for repo cards, status badges, daemon banners, error pages
- Total compiled size under 3KB gzipped

**Lint/Test Commands**:
```bash
# CSS validation and size check
bun run build:css
wc -c static/portal.css
# Accessibility audit
axe-core static/portal.css
bun test tests/unit/css-framework.test.ts
```

**Estimated Effort**: 4 hours
**Track**: Static Assets
**Risks**:
- **Low Risk**: CSS size exceeding 3KB budget
- **Mitigation**: Progressive enhancement allows deferring decorative styles to meet budget

### TASK-003: Generate SVG Icon Set
**Description**: Create SVG icon library for daemon status indicators, request phase markers, and UI controls. Each icon includes accessibility metadata (title/desc elements) and follows consistent design language from TDD-013 visual specifications.

**Files**:
- Create: `/static/icons/daemon-running.svg`
- Create: `/static/icons/daemon-stale.svg`
- Create: `/static/icons/daemon-unreachable.svg`
- Create: `/static/icons/request-pending.svg`
- Create: `/static/icons/request-approved.svg`
- Create: `/static/icons/request-rejected.svg`
- Create: `/static/icons/request-executing.svg`
- Create: `/static/icons/request-complete.svg`
- Create: `/static/icons/attention-needed.svg`
- Create: `/static/icons/settings-gear.svg`
- Create: `/static/icons/cost-chart.svg`
- Create: `/static/icons/logs-viewer.svg`
- Create: `/scripts/optimize-svg.sh`
- Create: `/src/icons/icon-manifest.ts`

**Dependencies**: None

**Acceptance Criteria**:
- All SVGs include `<title>` and `<desc>` elements for screen readers
- Icons sized at 16px, 24px, and 32px variants with crisp pixel alignment
- Consistent stroke width (1.5px) and corner radius (2px) across icon set
- Color values use CSS custom properties for theming compatibility
- ARIA `role="img"` and `aria-labelledby` attributes reference title elements
- SVG optimization removes unnecessary metadata while preserving accessibility
- Each icon under 1KB file size
- TypeScript manifest provides type-safe icon name enumeration

**Lint/Test Commands**:
```bash
# SVG optimization and validation
./scripts/optimize-svg.sh
svgo --config=.svgorc.json static/icons/*.svg
bun test tests/unit/svg-icons.test.ts
# Accessibility check
axe-core static/icons/*.svg
```

**Estimated Effort**: 3 hours
**Track**: Static Assets
**Risks**:
- **Medium Risk**: Icon accessibility requirements increase complexity
- **Mitigation**: Use SVG template pattern to ensure consistent accessibility metadata

### TASK-004: Implement Static File Serving Middleware
**Description**: Create Hono middleware for serving static assets from `/static/` directory with proper MIME type detection, security headers, and caching policies. Implements TDD-013 §9 asset serving requirements with CSP compliance.

**Files**:
- Create: `/server/middleware/static-assets.ts`
- Create: `/server/lib/mime-types.ts`
- Modify: `/server/server.ts` (integrate middleware)
- Create: `/tests/unit/static-serving.test.ts`

**Dependencies**: ["TASK-001", "TASK-002", "TASK-003"]

**Acceptance Criteria**:
- MIME type detection based on file extension (.js, .css, .svg, .ico, .png, .woff2)
- `X-Content-Type-Options: nosniff` header prevents MIME confusion attacks
- Cache-Control headers: `immutable, max-age=31536000` for hashed files, `max-age=86400` for unhashed
- ETag generation based on file modification time and size
- 404 responses for missing static assets with proper error handling
- Range request support for large assets
- Security headers prevent directory traversal attacks
- Gzip/Brotli compression for compressible assets (JS, CSS, SVG)

**Lint/Test Commands**:
```bash
# Static serving tests
bun test tests/unit/static-serving.test.ts
# Security validation
bun test tests/security/directory-traversal.test.ts
# Performance check
curl -H "Accept-Encoding: gzip" http://localhost:19280/static/portal.css -w "%{size_download}\n"
```

**Estimated Effort**: 3 hours
**Track**: Static Assets
**Risks**:
- **Low Risk**: Directory traversal vulnerability in path handling
- **Mitigation**: Use path normalization and allowlist validation for served files

### TASK-005: Implement Compression Middleware
**Description**: Add gzip and brotli compression middleware for JavaScript, CSS, and HTML responses. Optimizes bandwidth usage and page load times per TDD-013 performance targets (<500ms p95).

**Files**:
- Create: `/server/middleware/compression.ts`
- Modify: `/server/server.ts` (integrate compression)
- Create: `/tests/unit/compression.test.ts`
- Create: `/tests/performance/asset-compression.test.ts`

**Dependencies**: ["TASK-004"]

**Acceptance Criteria**:
- Brotli compression preferred when client supports (`Accept-Encoding: br`)
- Gzip fallback for clients without Brotli support
- Compression applied to MIME types: `text/*`, `application/javascript`, `application/json`, `image/svg+xml`
- Minimum file size threshold (1KB) to avoid compression overhead on small assets
- Compression level 6 for optimal size/speed balance
- `Content-Encoding` header correctly set based on compression method
- No compression for pre-compressed files or images
- Memory-efficient streaming compression for large responses

**Lint/Test Commands**:
```bash
# Compression functionality
bun test tests/unit/compression.test.ts
# Performance validation
bun test tests/performance/asset-compression.test.ts
# Integration check
curl -H "Accept-Encoding: br,gzip" http://localhost:19280/static/portal.css -w "%{size_download}\n"
```

**Estimated Effort**: 2 hours
**Track**: Static Assets
**Risks**:
- **Low Risk**: Compression overhead on small files reduces performance
- **Mitigation**: Size threshold prevents compression of assets under 1KB

### TASK-006: Implement Heartbeat Reader and Freshness Classifier
**Description**: Create daemon health monitoring system that reads heartbeat.json from autonomous-dev state directory and classifies daemon connectivity status. Implements NFR-04 daemon-down detection per TDD-013 §11.

**Files**:
- Create: `/server/lib/daemon-health.ts`
- Create: `/server/lib/heartbeat-reader.ts`
- Create: `/tests/unit/daemon-health.test.ts`
- Create: `/tests/fixtures/heartbeat-samples/`

**Dependencies**: None

**Acceptance Criteria**:
- Reads heartbeat.json from `../autonomous-dev/.autonomous-dev/heartbeat.json`
- Calculates staleness based on timestamp comparison with current time
- Health classification: `healthy` (<60s), `stale` (60-300s), `unreachable` (>300s or missing file)
- Configurable thresholds via portal configuration
- Handles malformed JSON, missing files, and permission errors gracefully
- Exports `DaemonUnreachableError` class for consistent error handling
- Performance optimized with caching (30-second TTL) to avoid excessive file reads
- Logs health transitions for operational visibility

**Lint/Test Commands**:
```bash
# Daemon health tests
bun test tests/unit/daemon-health.test.ts
# Heartbeat reader tests
bun test tests/unit/heartbeat-reader.test.ts
# Error handling validation
bun test tests/unit/daemon-health.test.ts --match="error scenarios"
```

**Estimated Effort**: 3 hours
**Track**: Health Monitoring
**Risks**:
- **Medium Risk**: Race conditions between heartbeat writes and reads
- **Mitigation**: Add file locking or retry logic to handle concurrent access

### TASK-007: Implement Daemon Status Banner Injection
**Description**: Create template injection system that adds daemon status banners to page layouts when connectivity issues are detected. Banners provide user feedback and disable mutation controls per NFR-04.

**Files**:
- Create: `/server/templates/fragments/daemon-status-banner.tsx`
- Modify: `/server/templates/layout/base.tsx` (banner integration)
- Create: `/server/middleware/banner-injection.ts`
- Create: `/tests/unit/daemon-status-banner.test.ts`

**Dependencies**: ["TASK-006"]

**Acceptance Criteria**:
- Warning banner for `stale` daemon status (yellow background, informational tone)
- Error banner for `unreachable` daemon status (red background, blocking tone)
- No banner for `healthy` status
- ARIA `role="alert"` for screen reader announcements
- Troubleshooting steps include daemon restart commands and log file locations
- Banner dismissal via HTMX with session persistence
- Banner content updates via SSE when health status changes (integration point for TDD-015)
- CSS animations respect `prefers-reduced-motion` preference

**Lint/Test Commands**:
```bash
# Banner rendering tests
bun test tests/unit/daemon-status-banner.test.ts
# Accessibility validation
axe-core tests/fixtures/banner-samples.html
# HTMX integration test
bun test tests/integration/banner-htmx.test.ts
```

**Estimated Effort**: 2.5 hours
**Track**: Health Monitoring
**Risks**:
- **Low Risk**: Banner persistence conflicts with SSE updates
- **Mitigation**: Design dismissal state to reset when health status changes

### TASK-008: Implement Mutation Guard Middleware
**Description**: Create middleware that returns HTTP 503 responses for non-GET requests when daemon is unreachable. Prevents data corruption and provides consistent error handling per NFR-04 requirements.

**Files**:
- Create: `/server/middleware/mutation-guard.ts`
- Modify: `/server/server.ts` (integrate guard middleware)
- Create: `/tests/unit/mutation-guard.test.ts`
- Create: `/tests/integration/daemon-down-protection.test.ts`

**Dependencies**: ["TASK-006"]

**Acceptance Criteria**:
- Block POST, PUT, DELETE, PATCH requests when daemon health is not `healthy`
- Return 503 status code with `DaemonUnreachableError` message
- Allow GET requests to proceed (show cached/stale data with warnings)
- Allow OPTIONS and HEAD requests for CORS preflight and health checks
- Include `Retry-After` header suggesting retry interval (60 seconds)
- JSON responses for API endpoints, HTML error pages for browser requests
- Middleware applied selectively to mutation endpoints only
- Performance optimized to avoid health checks on static asset requests

**Lint/Test Commands**:
```bash
# Mutation blocking tests
bun test tests/unit/mutation-guard.test.ts
# Integration scenarios
bun test tests/integration/daemon-down-protection.test.ts
# API endpoint validation
curl -X POST http://localhost:19280/api/settings -i
```

**Estimated Effort**: 2 hours
**Track**: Health Monitoring
**Risks**:
- **Medium Risk**: False positives block legitimate requests during brief daemon restarts
- **Mitigation**: Implement health check retry logic with exponential backoff

### TASK-009: Author Error Page Templates
**Description**: Create complete error page templates for 404, 422, 500, and 503 HTTP status codes with HTMX fragment compatibility and daemon status context injection. Templates meet WCAG accessibility requirements.

**Files**:
- Create: `/server/templates/pages/error.tsx`
- Create: `/server/templates/fragments/error-details.tsx`
- Create: `/server/templates/fragments/troubleshooting-steps.tsx`
- Create: `/server/lib/error-context.ts`
- Create: `/tests/unit/error-templates.test.ts`
- Create: `/tests/accessibility/error-pages.test.ts`

**Dependencies**: ["TASK-006", "TASK-007"]

**Acceptance Criteria**:
- Error-specific messaging and icons for each status code
- 404: "Page not found" with navigation suggestions and search functionality
- 422: "Validation failed" with input error details and correction guidance
- 500: "Internal error" with incident tracking and support contact information
- 503: "Service unavailable" with daemon status context and retry guidance
- HTMX compatibility for partial page updates and fragment rendering
- Semantic HTML structure with proper heading hierarchy
- ARIA labels and error announcements for screen readers
- Error details collapsible section for technical information
- Consistent layout with main portal navigation and branding

**Lint/Test Commands**:
```bash
# Template rendering tests
bun test tests/unit/error-templates.test.ts
# Accessibility compliance
bun test tests/accessibility/error-pages.test.ts
axe-core tests/fixtures/error-page-samples/*.html
# HTMX fragment validation
bun test tests/integration/htmx-error-fragments.test.ts
```

**Estimated Effort**: 4 hours
**Track**: Error Handling
**Risks**:
- **Low Risk**: Error template complexity impacts page load performance
- **Mitigation**: Keep error pages simple with minimal CSS/JS dependencies

### TASK-010: Implement Asset Hash Generation System
**Description**: Create build-time asset hashing for cache-busting and version management. Generate manifest file mapping logical asset names to hashed filenames for template resolution.

**Files**:
- Create: `/scripts/hash-assets.sh`
- Create: `/server/lib/asset-manifest.ts`
- Modify: `/package.json` (build script integration)
- Create: `/server/helpers/asset-url.ts`
- Create: `/tests/unit/asset-hashing.test.ts`

**Dependencies**: ["TASK-001", "TASK-002", "TASK-003"]

**Acceptance Criteria**:
- SHA256-based hash generation for JS, CSS, SVG, and font assets
- Asset manifest JSON file maps logical names to hashed filenames
- Template helper function resolves asset URLs: `assetUrl('portal.css')` → `/static/portal-a1b2c3.css`
- Build script integration updates manifest on asset changes
- Fallback to unhashed names in development mode
- Atomic manifest updates prevent serving broken asset references
- Hash verification during deployment to detect corruption
- Cleanup script removes orphaned hashed assets from previous builds

**Lint/Test Commands**:
```bash
# Asset hashing functionality
bun run build:assets
bun test tests/unit/asset-hashing.test.ts
# Manifest validation
jq '.' static/asset-manifest.json
# Template integration test
bun test tests/integration/asset-url-resolution.test.ts
```

**Estimated Effort**: 3 hours
**Track**: Build System
**Risks**:
- **Medium Risk**: Asset manifest corruption breaks all static asset loading
- **Mitigation**: Atomic writes and validation checks prevent partial manifest updates

### TASK-011: Document SVG Accessibility Standards
**Description**: Create comprehensive documentation for SVG accessibility implementation including title/desc element requirements, ARIA attribute usage, and screen reader compatibility patterns.

**Files**:
- Create: `/docs/accessibility/svg-guidelines.md`
- Create: `/docs/accessibility/icon-usage-patterns.md`
- Create: `/tests/accessibility/svg-validation.test.ts`
- Modify: `/README.md` (accessibility section)

**Dependencies**: ["TASK-003"]

**Acceptance Criteria**:
- Complete guide for adding new SVG icons with accessibility metadata
- Title/desc element content guidelines with examples
- ARIA attribute patterns for different icon usage contexts
- Screen reader testing procedures and validation scripts
- Color contrast requirements for icon visibility
- Alternative text strategies for decorative vs. informational icons
- Code examples demonstrating proper JSX integration
- Automated testing setup to validate accessibility compliance

**Lint/Test Commands**:
```bash
# Documentation link validation
bun test tests/docs/accessibility-links.test.ts
# SVG accessibility validation
bun test tests/accessibility/svg-validation.test.ts
# Screen reader compatibility
bun test tests/accessibility/screen-reader.test.ts
```

**Estimated Effort**: 2 hours
**Track**: Documentation
**Risks**:
- **Low Risk**: Documentation becomes outdated as icon set evolves
- **Mitigation**: Include documentation updates in icon addition process

### TASK-012: Create Asset Build Script Integration
**Description**: Integrate all asset building tasks (CSS compilation, SVG optimization, HTMX vendoring, asset hashing) into unified build system with development/production modes.

**Files**:
- Create: `/scripts/build-assets.sh`
- Create: `/scripts/watch-assets.sh` (development mode)
- Modify: `/package.json` (npm scripts)
- Create: `/bun.config.js` (asset build configuration)
- Create: `/tests/integration/build-system.test.ts`

**Dependencies**: ["TASK-001", "TASK-002", "TASK-003", "TASK-010"]

**Acceptance Criteria**:
- Single command builds all static assets: `bun run build:assets`
- Development mode with file watching: `bun run dev:assets`
- Production build includes compression, hashing, and optimization
- Build artifacts cleaned between runs to prevent stale assets
- Error reporting for failed asset builds with actionable messages
- Performance metrics (build time, asset sizes) logged during builds
- CI/CD integration with exit codes for build failures
- Incremental builds skip unchanged assets to improve performance

**Lint/Test Commands**:
```bash
# Build system validation
bun test tests/integration/build-system.test.ts
# Production build test
bun run build:assets --production
# Development mode test
timeout 10 bun run dev:assets || true
```

**Estimated Effort**: 2.5 hours
**Track**: Build System
**Risks**:
- **Medium Risk**: Build complexity increases maintenance burden
- **Mitigation**: Keep build scripts simple with clear error messages and fallback behaviors

## Dependencies & Integration Points

### Exposes to Other Plans
- **Static Asset Infrastructure**: `/server/middleware/static-assets.ts` middleware used by PLAN-013-5 route handlers
- **Daemon Health Monitoring**: `/server/lib/daemon-health.ts` used by PLAN-015-* for SSE health events and mutation blocking
- **Error Page Templates**: `/server/templates/pages/error.tsx` used by all portal plans for consistent error handling
- **CSS Framework**: `/static/portal.css` provides styling for all portal pages and components
- **Asset URL Resolution**: `/server/helpers/asset-url.ts` helper used in all template rendering
- **Compression Middleware**: Applied to all HTTP responses across portal server

### Consumes from Other Plans
- **PLAN-013-2**: Base server infrastructure and Hono application setup
- **PLAN-013-3**: JSX templating system and layout components
- **Plugin Configuration**: User configuration loading for health check thresholds and caching policies

### External Dependencies
- **Autonomous-Dev Daemon**: Heartbeat file at `~/.autonomous-dev/heartbeat.json` for health monitoring
- **Bun Runtime**: File serving, compression, and asset hashing capabilities
- **HTMX Library**: Downloaded and vendored for client-side interactivity

## Testing Strategy

### Unit Testing
- **Static Asset Serving**: MIME type detection, caching headers, security headers validation
- **Daemon Health Monitoring**: Heartbeat parsing, staleness calculation, error handling edge cases
- **Error Template Rendering**: Status code-specific content, accessibility compliance, HTMX compatibility
- **Asset Hashing**: Hash generation, manifest updates, URL resolution accuracy
- **Compression Middleware**: Encoding negotiation, compression ratios, streaming performance

### Integration Testing
- **End-to-End Asset Loading**: Browser requests through full middleware stack with timing validation
- **Daemon Down Scenarios**: Simulated daemon failures with mutation blocking and banner display
- **Error Page Workflows**: HTTP error conditions trigger appropriate templates with correct status codes
- **Build System Validation**: Complete asset build cycles with verification of outputs

### Performance Testing
- **Asset Load Times**: Static asset serving meets <500ms p95 target from TDD-013
- **Compression Efficiency**: Bandwidth reduction validation for CSS/JS assets
- **Health Check Performance**: Daemon health monitoring overhead under 10ms per check

### Accessibility Testing
- **Screen Reader Compatibility**: Error pages and banners work with NVDA, JAWS, VoiceOver
- **Keyboard Navigation**: Focus management and tab ordering for error page elements
- **Color Contrast Validation**: WCAG 2.2 AA compliance across all visual elements
- **SVG Icon Accessibility**: Screen reader announcements for all status indicators

## CSS Framework Detail

The complete portal.css implementation provides the visual foundation for the autonomous-dev portal:

```css
/* /static/portal.css - Complete Implementation */

/* ===== CSS CUSTOM PROPERTIES ===== */
:root {
  /* Brand Colors */
  --primary-color: #2563eb;
  --primary-hover: #1d4ed8;
  --secondary-color: #64748b;
  
  /* Status Colors */
  --success-color: #16a34a;
  --success-light: #dcfce7;
  --warning-color: #d97706;
  --warning-light: #fef3c7;
  --danger-color: #dc2626;
  --danger-light: #fef2f2;
  --info-color: #0891b2;
  --info-light: #cffafe;
  
  /* Neutral Colors */
  --bg-primary: #ffffff;
  --bg-secondary: #f8fafc;
  --bg-tertiary: #f1f5f9;
  --text-primary: #1e293b;
  --text-secondary: #64748b;
  --text-muted: #94a3b8;
  --border-color: #e2e8f0;
  --border-hover: #cbd5e1;
  
  /* Spacing Scale */
  --space-xs: 0.25rem;
  --space-sm: 0.5rem;
  --space-md: 1rem;
  --space-lg: 1.5rem;
  --space-xl: 2rem;
  --space-2xl: 3rem;
  
  /* Typography Scale */
  --text-xs: 0.75rem;
  --text-sm: 0.875rem;
  --text-base: 1rem;
  --text-lg: 1.125rem;
  --text-xl: 1.25rem;
  --text-2xl: 1.5rem;
  --text-3xl: 1.875rem;
  
  /* Border Radius */
  --radius-sm: 0.25rem;
  --radius-md: 0.375rem;
  --radius-lg: 0.5rem;
  --radius-xl: 0.75rem;
  
  /* Shadows */
  --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
  --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
  
  /* Z-Index Scale */
  --z-dropdown: 1000;
  --z-banner: 1010;
  --z-modal: 1020;
  --z-tooltip: 1030;
}

/* ===== RESET AND BASE STYLES ===== */
*, *::before, *::after {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: var(--text-base);
  line-height: 1.5;
  color: var(--text-primary);
  background-color: var(--bg-secondary);
}

/* ===== LAYOUT SYSTEM ===== */
.container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 var(--space-md);
}

.main-layout {
  display: grid;
  grid-template-columns: 250px 1fr;
  grid-template-rows: auto 1fr auto;
  grid-template-areas:
    "header header"
    "sidebar main"
    "footer footer";
  min-height: 100vh;
}

.main-header {
  grid-area: header;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-color);
  padding: var(--space-md);
}

.main-sidebar {
  grid-area: sidebar;
  background: var(--bg-primary);
  border-right: 1px solid var(--border-color);
  padding: var(--space-md);
}

.main-content {
  grid-area: main;
  padding: var(--space-lg);
  overflow-x: auto;
}

.main-footer {
  grid-area: footer;
  background: var(--bg-primary);
  border-top: 1px solid var(--border-color);
  padding: var(--space-md);
  text-align: center;
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

/* ===== NAVIGATION ===== */
.nav-menu {
  list-style: none;
  padding: 0;
  margin: 0;
}

.nav-item {
  margin-bottom: var(--space-xs);
}

.nav-link {
  display: flex;
  align-items: center;
  padding: var(--space-sm) var(--space-md);
  color: var(--text-secondary);
  text-decoration: none;
  border-radius: var(--radius-md);
  transition: background-color 0.2s ease, color 0.2s ease;
}

.nav-link:hover {
  background-color: var(--bg-tertiary);
  color: var(--text-primary);
}

.nav-link.active {
  background-color: var(--primary-color);
  color: white;
}

.nav-icon {
  width: 20px;
  height: 20px;
  margin-right: var(--space-sm);
}

/* ===== REPOSITORY GRID ===== */
.repo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: var(--space-lg);
  padding: var(--space-md) 0;
}

.repo-card {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: var(--space-lg);
  transition: box-shadow 0.2s ease, border-color 0.2s ease;
}

.repo-card:hover {
  box-shadow: var(--shadow-md);
  border-color: var(--border-hover);
}

.repo-card.needs-attention {
  border-color: var(--warning-color);
  border-width: 2px;
}

.repo-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: var(--space-md);
}

.repo-name {
  font-size: var(--text-lg);
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.repo-status-badge {
  display: inline-flex;
  align-items: center;
  padding: var(--space-xs) var(--space-sm);
  font-size: var(--text-xs);
  font-weight: 500;
  border-radius: var(--radius-sm);
  text-transform: uppercase;
  letter-spacing: 0.025em;
}

.repo-status-badge.healthy {
  background-color: var(--success-light);
  color: var(--success-color);
}

.repo-status-badge.attention {
  background-color: var(--warning-light);
  color: var(--warning-color);
}

.repo-status-badge.error {
  background-color: var(--danger-light);
  color: var(--danger-color);
}

.repo-metrics {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-md);
  margin-bottom: var(--space-md);
}

.metric-item {
  text-align: center;
}

.metric-value {
  display: block;
  font-size: var(--text-xl);
  font-weight: 600;
  color: var(--text-primary);
}

.metric-label {
  display: block;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  margin-top: var(--space-xs);
}

/* ===== DAEMON STATUS BANNER ===== */
.daemon-status-banner {
  position: relative;
  margin: var(--space-md) 0;
  padding: var(--space-md) var(--space-lg);
  border-radius: var(--radius-md);
  border-left: 4px solid;
  z-index: var(--z-banner);
}

.daemon-status-banner.warning {
  background-color: var(--warning-light);
  border-left-color: var(--warning-color);
  color: #92400e;
}

.daemon-status-banner.error {
  background-color: var(--danger-light);
  border-left-color: var(--danger-color);
  color: #991b1b;
}

.daemon-status-banner h2 {
  margin: 0 0 var(--space-sm) 0;
  font-size: var(--text-lg);
  font-weight: 600;
}

.daemon-status-banner p {
  margin: var(--space-sm) 0;
}

.daemon-troubleshooting {
  margin-top: var(--space-md);
  padding-top: var(--space-md);
  border-top: 1px solid rgba(0, 0, 0, 0.1);
}

.daemon-troubleshooting h3 {
  margin: 0 0 var(--space-sm) 0;
  font-size: var(--text-base);
  font-weight: 600;
}

.daemon-troubleshooting ol {
  margin: var(--space-sm) 0;
  padding-left: var(--space-lg);
}

.daemon-troubleshooting code {
  background: rgba(0, 0, 0, 0.1);
  padding: var(--space-xs) var(--space-sm);
  border-radius: var(--radius-sm);
  font-family: "SF Mono", "Monaco", "Inconsolata", "Roboto Mono", monospace;
  font-size: var(--text-sm);
}

.banner-dismiss {
  position: absolute;
  top: var(--space-md);
  right: var(--space-md);
  background: none;
  border: none;
  font-size: var(--text-lg);
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 0.2s ease;
}

.banner-dismiss:hover {
  opacity: 1;
}

/* ===== ERROR PAGES ===== */
.error-page {
  text-align: center;
  padding: var(--space-2xl) var(--space-md);
  max-width: 600px;
  margin: 0 auto;
}

.error-icon {
  font-size: 4rem;
  margin-bottom: var(--space-lg);
  opacity: 0.8;
}

.error-page h1 {
  font-size: var(--text-3xl);
  margin-bottom: var(--space-md);
  color: var(--text-primary);
}

.error-message {
  font-size: var(--text-lg);
  color: var(--text-secondary);
  margin-bottom: var(--space-xl);
}

.error-details {
  text-align: left;
  margin-top: var(--space-lg);
  padding: var(--space-md);
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
}

.error-details summary {
  font-weight: 600;
  cursor: pointer;
  padding: var(--space-sm);
  margin: -var(--space-sm);
  border-radius: var(--radius-sm);
}

.error-details summary:hover {
  background: var(--bg-secondary);
}

.error-details pre {
  margin-top: var(--space-md);
  padding: var(--space-md);
  background: var(--bg-primary);
  border-radius: var(--radius-sm);
  overflow-x: auto;
  font-size: var(--text-sm);
  color: var(--text-primary);
}

/* ===== BUTTONS AND CONTROLS ===== */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-sm) var(--space-md);
  font-size: var(--text-base);
  font-weight: 500;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  cursor: pointer;
  text-decoration: none;
  transition: all 0.2s ease;
}

.btn:focus-visible {
  outline: 2px solid var(--primary-color);
  outline-offset: 2px;
}

.btn-primary {
  background-color: var(--primary-color);
  color: white;
}

.btn-primary:hover {
  background-color: var(--primary-hover);
}

.btn-secondary {
  background-color: transparent;
  color: var(--text-secondary);
  border-color: var(--border-color);
}

.btn-secondary:hover {
  background-color: var(--bg-tertiary);
  border-color: var(--border-hover);
  color: var(--text-primary);
}

.btn-danger {
  background-color: var(--danger-color);
  color: white;
}

.btn-danger:hover {
  background-color: #b91c1c;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* ===== FORMS ===== */
.form-group {
  margin-bottom: var(--space-lg);
}

.form-label {
  display: block;
  font-weight: 500;
  margin-bottom: var(--space-sm);
  color: var(--text-primary);
}

.form-input {
  display: block;
  width: 100%;
  padding: var(--space-sm) var(--space-md);
  font-size: var(--text-base);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background-color: var(--bg-primary);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.form-input:focus {
  outline: none;
  border-color: var(--primary-color);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
}

.form-input:invalid {
  border-color: var(--danger-color);
}

.form-help {
  display: block;
  margin-top: var(--space-xs);
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.form-error {
  display: block;
  margin-top: var(--space-xs);
  font-size: var(--text-sm);
  color: var(--danger-color);
}

/* ===== CHARTS AND VISUALIZATIONS ===== */
.chart-container {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: var(--space-lg);
  margin-bottom: var(--space-lg);
}

.chart-title {
  font-size: var(--text-lg);
  font-weight: 600;
  margin-bottom: var(--space-md);
  color: var(--text-primary);
}

.chart-svg {
  width: 100%;
  height: 300px;
}

/* ===== RESPONSIVE DESIGN ===== */
@media (max-width: 768px) {
  .main-layout {
    grid-template-columns: 1fr;
    grid-template-areas:
      "header"
      "main"
      "footer";
  }
  
  .main-sidebar {
    display: none;
  }
  
  .repo-grid {
    grid-template-columns: 1fr;
  }
  
  .container {
    padding: 0 var(--space-sm);
  }
}

/* ===== ACCESSIBILITY ===== */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg-primary: #1e293b;
    --bg-secondary: #0f172a;
    --bg-tertiary: #334155;
    --text-primary: #f8fafc;
    --text-secondary: #cbd5e1;
    --text-muted: #64748b;
    --border-color: #334155;
    --border-hover: #475569;
  }
}

/* High contrast mode support */
@media (prefers-contrast: high) {
  :root {
    --border-color: #000000;
    --text-secondary: #000000;
  }
  
  .btn:focus-visible {
    outline: 3px solid currentColor;
  }
}

/* ===== LOADING STATES ===== */
.loading {
  position: relative;
  opacity: 0.6;
}

.loading::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 20px;
  height: 20px;
  margin-top: -10px;
  margin-left: -10px;
  border: 2px solid var(--border-color);
  border-top-color: var(--primary-color);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ===== UTILITY CLASSES ===== */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.text-center { text-align: center; }
.text-left { text-align: left; }
.text-right { text-align: right; }

.mt-0 { margin-top: 0; }
.mt-xs { margin-top: var(--space-xs); }
.mt-sm { margin-top: var(--space-sm); }
.mt-md { margin-top: var(--space-md); }
.mt-lg { margin-top: var(--space-lg); }
.mt-xl { margin-top: var(--space-xl); }

.mb-0 { margin-bottom: 0; }
.mb-xs { margin-bottom: var(--space-xs); }
.mb-sm { margin-bottom: var(--space-sm); }
.mb-md { margin-bottom: var(--space-md); }
.mb-lg { margin-bottom: var(--space-lg); }
.mb-xl { margin-bottom: var(--space-xl); }

.hidden { display: none; }
.block { display: block; }
.inline { display: inline; }
.inline-block { display: inline-block; }
.flex { display: flex; }
.grid { display: grid; }
```

## Daemon Health Middleware Implementation

Complete implementation of the NFR-04 daemon health monitoring system:

```typescript
// /server/lib/daemon-health.ts
import { readFile, stat } from 'fs/promises';
import { join } from 'path';

export interface DaemonHealth {
  status: 'healthy' | 'stale' | 'unreachable';
  lastHeartbeat?: Date;
  stalenessSeconds?: number;
  message?: string;
}

export interface HealthConfig {
  staleThreshold: number;    // Default: 60 seconds
  deadThreshold: number;     // Default: 300 seconds
  cacheTtl: number;         // Default: 30 seconds
}

export class DaemonHealthChecker {
  private cache: { health: DaemonHealth; timestamp: number } | null = null;
  private readonly config: HealthConfig;
  private readonly heartbeatPath: string;

  constructor(config: Partial<HealthConfig> = {}) {
    this.config = {
      staleThreshold: 60,
      deadThreshold: 300,
      cacheTtl: 30000,
      ...config,
    };
    
    // Path relative to portal plugin directory
    this.heartbeatPath = join('..', 'autonomous-dev', '.autonomous-dev', 'heartbeat.json');
  }

  async checkHealth(): Promise<DaemonHealth> {
    // Return cached result if still fresh
    if (this.cache && Date.now() - this.cache.timestamp < this.config.cacheTtl) {
      return this.cache.health;
    }

    const health = await this.performHealthCheck();
    this.cache = { health, timestamp: Date.now() };
    return health;
  }

  private async performHealthCheck(): Promise<DaemonHealth> {
    try {
      // Check if heartbeat file exists
      const stats = await stat(this.heartbeatPath);
      const heartbeatContent = await readFile(this.heartbeatPath, 'utf-8');
      
      // Parse heartbeat JSON
      let heartbeat;
      try {
        heartbeat = JSON.parse(heartbeatContent);
      } catch (parseError) {
        return {
          status: 'unreachable',
          message: 'Heartbeat file contains invalid JSON',
        };
      }

      // Validate heartbeat structure
      if (!heartbeat.timestamp || !heartbeat.pid) {
        return {
          status: 'unreachable',
          message: 'Heartbeat file is missing required fields',
        };
      }

      // Calculate staleness
      const lastHeartbeat = new Date(heartbeat.timestamp);
      const stalenessSeconds = (Date.now() - lastHeartbeat.getTime()) / 1000;

      // Classify health status
      if (stalenessSeconds > this.config.deadThreshold) {
        return {
          status: 'unreachable',
          lastHeartbeat,
          stalenessSeconds,
          message: `Daemon heartbeat is ${Math.floor(stalenessSeconds)}s old (threshold: ${this.config.deadThreshold}s)`,
        };
      }

      if (stalenessSeconds > this.config.staleThreshold) {
        return {
          status: 'stale',
          lastHeartbeat,
          stalenessSeconds,
          message: `Daemon heartbeat is ${Math.floor(stalenessSeconds)}s old (threshold: ${this.config.staleThreshold}s)`,
        };
      }

      return {
        status: 'healthy',
        lastHeartbeat,
        stalenessSeconds,
        message: 'Daemon is responding normally',
      };

    } catch (error) {
      if (error.code === 'ENOENT') {
        return {
          status: 'unreachable',
          message: 'Daemon heartbeat file not found - daemon may not be running',
        };
      }

      if (error.code === 'EACCES') {
        return {
          status: 'unreachable',
          message: 'Permission denied reading heartbeat file',
        };
      }

      return {
        status: 'unreachable',
        message: `Error reading heartbeat: ${error.message}`,
      };
    }
  }

  // Clear cache to force fresh health check
  clearCache(): void {
    this.cache = null;
  }
}

export class DaemonUnreachableError extends Error {
  constructor(message = 'Daemon is unreachable', public health?: DaemonHealth) {
    super(message);
    this.name = 'DaemonUnreachableError';
  }
}

// Singleton instance for application-wide use
export const daemonHealthChecker = new DaemonHealthChecker();

// Convenience function for simple health checks
export async function checkDaemonHealth(): Promise<DaemonHealth> {
  return daemonHealthChecker.checkHealth();
}
```

```typescript
// /server/middleware/daemon-health.ts
import type { Context, Next } from 'hono';
import { checkDaemonHealth, DaemonUnreachableError } from '../lib/daemon-health';

// Middleware to inject daemon health into request context
export async function injectDaemonHealth(c: Context, next: Next) {
  const health = await checkDaemonHealth();
  c.set('daemonHealth', health);
  await next();
}

// Middleware to block mutations when daemon is unhealthy
export async function guardMutations(c: Context, next: Next) {
  // Skip guard for GET, HEAD, OPTIONS requests
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    await next();
    return;
  }

  const health = await checkDaemonHealth();
  
  if (health.status !== 'healthy') {
    const error = new DaemonUnreachableError(
      `Cannot perform ${c.req.method} request: ${health.message}`,
      health
    );

    // Return appropriate response based on request type
    if (c.req.path.startsWith('/api/')) {
      return c.json(
        {
          error: 'Service Unavailable',
          message: error.message,
          retryAfter: 60,
          daemonStatus: health.status,
        },
        503,
        {
          'Retry-After': '60',
        }
      );
    }

    // For HTML requests, throw error to be handled by error page middleware
    throw error;
  }

  await next();
}
```

## Error Page Templates

Complete error page implementation with daemon status integration:

```tsx
// /server/templates/pages/error.tsx
import type { FC } from 'hono/jsx';
import { BaseLayout } from '../layout/base';
import type { DaemonHealth } from '../../lib/daemon-health';

interface ErrorPageProps {
  statusCode: number;
  message: string;
  details?: string;
  requestPath?: string;
  daemonHealth?: DaemonHealth;
}

export const ErrorPage: FC<ErrorPageProps> = ({ 
  statusCode, 
  message, 
  details,
  requestPath,
  daemonHealth,
}) => {
  const getErrorIcon = (code: number): string => {
    switch (code) {
      case 404: return '🔍';
      case 422: return '❌';
      case 500: return '💥';
      case 503: return '⚠️';
      default: return '⚠️';
    }
  };

  const getErrorTitle = (code: number): string => {
    switch (code) {
      case 404: return 'Page Not Found';
      case 422: return 'Invalid Request';
      case 500: return 'Internal Server Error';
      case 503: return 'Service Unavailable';
      default: return 'Error';
    }
  };

  const getHelpText = (code: number): string => {
    switch (code) {
      case 404:
        return 'The page you\'re looking for doesn\'t exist. Check the URL or navigate back to the dashboard.';
      case 422:
        return 'The request contains invalid data. Please check your input and try again.';
      case 500:
        return 'Something went wrong on our end. The error has been logged and will be investigated.';
      case 503:
        return 'The service is temporarily unavailable. This usually indicates the daemon is not running.';
      default:
        return 'An unexpected error occurred. Please try again or contact support if the problem persists.';
    }
  };

  const isDaemonDown = daemonHealth && daemonHealth.status !== 'healthy';

  return (
    <BaseLayout title={`${getErrorTitle(statusCode)} - Autonomous Dev Portal`} showDaemonStatus={false}>
      <div class="error-page">
        <div class="error-icon" aria-hidden="true">
          {getErrorIcon(statusCode)}
        </div>
        
        <h1>Error {statusCode}</h1>
        <p class="error-message">{message}</p>
        <p class="error-help">{getHelpText(statusCode)}</p>

        {/* Navigation suggestions for 404 errors */}
        {statusCode === 404 && (
          <div class="error-navigation">
            <h2>Try one of these pages:</h2>
            <ul>
              <li><a href="/" class="btn btn-secondary">Portfolio Dashboard</a></li>
              <li><a href="/approvals" class="btn btn-secondary">Approval Queue</a></li>
              <li><a href="/settings" class="btn btn-secondary">Settings</a></li>
              <li><a href="/ops" class="btn btn-secondary">Operations</a></li>
            </ul>
          </div>
        )}

        {/* Daemon status information for 503 errors */}
        {statusCode === 503 && isDaemonDown && (
          <div class="daemon-status-info">
            <h2>Daemon Status: {daemonHealth?.status}</h2>
            <p>{daemonHealth?.message}</p>
            
            {daemonHealth?.lastHeartbeat && (
              <p>
                <strong>Last heartbeat:</strong> {daemonHealth.lastHeartbeat.toLocaleString()}
                <br />
                <strong>Age:</strong> {Math.floor(daemonHealth.stalenessSeconds || 0)} seconds
              </p>
            )}

            <div class="daemon-troubleshooting">
              <h3>Troubleshooting Steps:</h3>
              <ol>
                <li>Check if the autonomous-dev daemon is running:
                  <code>ps aux | grep supervisor-loop</code>
                </li>
                <li>Start the daemon if stopped:
                  <code>claude daemon start</code>
                </li>
                <li>Check daemon logs for errors:
                  <code>tail -f ~/.autonomous-dev/logs/daemon.log</code>
                </li>
                <li>Restart the portal after daemon is healthy:
                  <code>claude portal restart</code>
                </li>
              </ol>
            </div>
          </div>
        )}

        {/* Technical details (collapsible) */}
        {details && (
          <details class="error-details">
            <summary>Technical Details</summary>
            <div class="error-details-content">
              {requestPath && (
                <p><strong>Request Path:</strong> <code>{requestPath}</code></p>
              )}
              <pre><code>{details}</code></pre>
            </div>
          </details>
        )}

        {/* Action buttons */}
        <div class="error-actions">
          <button onclick="window.history.back()" class="btn btn-secondary">
            Go Back
          </button>
          <a href="/" class="btn btn-primary">
            Return to Dashboard
          </a>
        </div>
      </div>
    </BaseLayout>
  );
};
```

```tsx
// /server/templates/fragments/daemon-status-banner.tsx
import type { FC } from 'hono/jsx';
import type { DaemonHealth } from '../../lib/daemon-health';

interface DaemonStatusBannerProps {
  health: DaemonHealth;
  dismissible?: boolean;
}

export const DaemonStatusBanner: FC<DaemonStatusBannerProps> = ({ 
  health, 
  dismissible = true 
}) => {
  // Don't render banner for healthy daemon
  if (health.status === 'healthy') {
    return null;
  }

  const isError = health.status === 'unreachable';
  const bannerClass = isError ? 'daemon-status-banner error' : 'daemon-status-banner warning';

  return (
    <div 
      class={bannerClass} 
      role="alert"
      aria-live="polite"
      hx-ext="sse" 
      sse-connect="/api/daemon/health-stream"
      sse-swap="daemon-banner"
    >
      {dismissible && (
        <button 
          class="banner-dismiss" 
          hx-delete="/api/banner/dismiss"
          hx-target="closest .daemon-status-banner"
          hx-swap="outerHTML"
          aria-label="Dismiss banner"
        >
          ×
        </button>
      )}

      <h2>
        {isError ? 'Daemon Unreachable' : 'Daemon Connection Issues'}
      </h2>
      
      <p>{health.message}</p>

      {health.lastHeartbeat && (
        <p>
          <strong>Last seen:</strong> {health.lastHeartbeat.toLocaleString()}
          {health.stalenessSeconds && (
            <span> ({Math.floor(health.stalenessSeconds)} seconds ago)</span>
          )}
        </p>
      )}

      {isError && (
        <p>
          <strong>All mutation actions are disabled</strong> until daemon connectivity is restored.
          The portal will display cached data that may be stale.
        </p>
      )}

      <div class="daemon-troubleshooting">
        <h3>Quick Fix:</h3>
        <ol>
          <li>Restart the daemon: <code>claude daemon restart</code></li>
          <li>Check status: <code>claude daemon status</code></li>
          <li>View logs: <code>tail ~/.autonomous-dev/logs/daemon.log</code></li>
        </ol>
      </div>
    </div>
  );
};
```

## HTMX Vendor Script Integration

```html
<!-- Complete HTMX integration pattern -->
<!-- /server/templates/layout/base.tsx - excerpt -->

<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{title}</title>
  
  <!-- Portal CSS -->
  <link rel="stylesheet" href={assetUrl('portal.css')} />
  
  <!-- HTMX Library -->
  <script src={assetUrl('htmx.min.js')} defer></script>
  
  <!-- CSP-compliant inline script for HTMX configuration -->
  <script defer>
    document.addEventListener('DOMContentLoaded', function() {
      // Configure HTMX defaults
      htmx.config.defaultSwapStyle = 'outerHTML';
      htmx.config.defaultSettleDelay = 20;
      htmx.config.historyCacheSize = 10;
      
      // Global error handler
      document.body.addEventListener('htmx:responseError', function(evt) {
        if (evt.detail.xhr.status === 503) {
          // Handle daemon unreachable errors
          document.querySelector('.main-content').insertAdjacentHTML('afterbegin',
            '<div class="daemon-status-banner error" role="alert">' +
            '<h2>Service Unavailable</h2>' +
            '<p>The autonomous-dev daemon is unreachable. Please check daemon status.</p>' +
            '</div>'
          );
        }
      });
      
      // Auto-refresh daemon health banner every 30 seconds
      setInterval(function() {
        const banner = document.querySelector('[sse-connect]');
        if (banner) {
          htmx.trigger(banner, 'sse:daemon-health-check');
        }
      }, 30000);
    });
  </script>
</head>
```

## Test Plan

### Static Asset Serving Tests
```typescript
// /tests/unit/static-serving.test.ts
import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import { staticAssets } from '../../server/middleware/static-assets';

describe('Static Asset Serving', () => {
  test('serves CSS with correct MIME type and cache headers', async () => {
    const app = new Hono();
    app.use('/static/*', staticAssets);
    
    const res = await app.request('/static/portal.css');
    
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/css; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toContain('max-age=86400');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  test('serves JavaScript with compression when requested', async () => {
    const app = new Hono();
    app.use('/static/*', staticAssets);
    
    const res = await app.request('/static/htmx.min.js', {
      headers: { 'Accept-Encoding': 'gzip, br' }
    });
    
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/javascript; charset=utf-8');
    expect(['gzip', 'br'].includes(res.headers.get('Content-Encoding'))).toBe(true);
  });

  test('returns 404 for missing assets', async () => {
    const app = new Hono();
    app.use('/static/*', staticAssets);
    
    const res = await app.request('/static/nonexistent.css');
    expect(res.status).toBe(404);
  });
});
```

### Daemon Health Monitoring Tests
```typescript
// /tests/unit/daemon-health.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { DaemonHealthChecker } from '../../server/lib/daemon-health';

describe('Daemon Health Monitoring', () => {
  const testHeartbeatPath = './test-heartbeat.json';
  let checker: DaemonHealthChecker;

  beforeEach(async () => {
    checker = new DaemonHealthChecker();
    await mkdir('./test-data', { recursive: true });
  });

  afterEach(async () => {
    try {
      await unlink(testHeartbeatPath);
    } catch {}
  });

  test('reports healthy status for recent heartbeat', async () => {
    const recentHeartbeat = {
      timestamp: new Date().toISOString(),
      pid: 12345,
      iteration: 100,
    };

    await writeFile(testHeartbeatPath, JSON.stringify(recentHeartbeat));
    const health = await checker.checkHealth();

    expect(health.status).toBe('healthy');
    expect(health.stalenessSeconds).toBeLessThan(10);
  });

  test('reports stale status for old heartbeat', async () => {
    const staleHeartbeat = {
      timestamp: new Date(Date.now() - 90000).toISOString(), // 90 seconds ago
      pid: 12345,
      iteration: 100,
    };

    await writeFile(testHeartbeatPath, JSON.stringify(staleHeartbeat));
    const health = await checker.checkHealth();

    expect(health.status).toBe('stale');
    expect(health.stalenessSeconds).toBeGreaterThan(60);
  });

  test('reports unreachable status for missing heartbeat file', async () => {
    const health = await checker.checkHealth();

    expect(health.status).toBe('unreachable');
    expect(health.message).toContain('not found');
  });

  test('handles malformed JSON gracefully', async () => {
    await writeFile(testHeartbeatPath, 'invalid json content');
    const health = await checker.checkHealth();

    expect(health.status).toBe('unreachable');
    expect(health.message).toContain('invalid JSON');
  });
});
```

### Banner Injection Tests
```typescript
// /tests/unit/daemon-status-banner.test.ts
import { describe, test, expect } from 'bun:test';
import { render } from 'hono/jsx/dom';
import { DaemonStatusBanner } from '../../server/templates/fragments/daemon-status-banner';

describe('Daemon Status Banner', () => {
  test('renders warning banner for stale daemon', () => {
    const health = {
      status: 'stale' as const,
      message: 'Daemon heartbeat is 75 seconds old',
      lastHeartbeat: new Date(),
      stalenessSeconds: 75,
    };

    const banner = render(<DaemonStatusBanner health={health} />);

    expect(banner).toContain('daemon-status-banner warning');
    expect(banner).toContain('Daemon Connection Issues');
    expect(banner).toContain('75 seconds old');
    expect(banner).toContain('claude daemon restart');
  });

  test('renders error banner for unreachable daemon', () => {
    const health = {
      status: 'unreachable' as const,
      message: 'Heartbeat file not found',
    };

    const banner = render(<DaemonStatusBanner health={health} />);

    expect(banner).toContain('daemon-status-banner error');
    expect(banner).toContain('Daemon Unreachable');
    expect(banner).toContain('mutation actions are disabled');
    expect(banner).toContain('not found');
  });

  test('renders nothing for healthy daemon', () => {
    const health = {
      status: 'healthy' as const,
      message: 'Daemon is responding normally',
      lastHeartbeat: new Date(),
      stalenessSeconds: 10,
    };

    const banner = render(<DaemonStatusBanner health={health} />);
    expect(banner).toBe(null);
  });
});
```

### Error Page Rendering Tests
```typescript
// /tests/unit/error-templates.test.ts
import { describe, test, expect } from 'bun:test';
import { render } from 'hono/jsx/dom';
import { ErrorPage } from '../../server/templates/pages/error';

describe('Error Page Templates', () => {
  test('renders 404 error with navigation suggestions', () => {
    const props = {
      statusCode: 404,
      message: 'Page not found',
      requestPath: '/nonexistent-page',
    };

    const page = render(<ErrorPage {...props} />);

    expect(page).toContain('Error 404');
    expect(page).toContain('Page Not Found');
    expect(page).toContain('🔍');
    expect(page).toContain('Portfolio Dashboard');
    expect(page).toContain('/nonexistent-page');
  });

  test('renders 503 error with daemon troubleshooting', () => {
    const props = {
      statusCode: 503,
      message: 'Service unavailable',
      daemonHealth: {
        status: 'unreachable' as const,
        message: 'Heartbeat file not found',
      },
    };

    const page = render(<ErrorPage {...props} />);

    expect(page).toContain('Error 503');
    expect(page).toContain('Service Unavailable');
    expect(page).toContain('⚠️');
    expect(page).toContain('claude daemon start');
    expect(page).toContain('Heartbeat file not found');
  });

  test('includes technical details when provided', () => {
    const props = {
      statusCode: 500,
      message: 'Internal server error',
      details: 'TypeError: Cannot read property "foo" of undefined\n  at handler.js:42',
    };

    const page = render(<ErrorPage {...props} />);

    expect(page).toContain('Technical Details');
    expect(page).toContain('TypeError: Cannot read property');
    expect(page).toContain('handler.js:42');
  });
});
```

This implementation plan provides comprehensive static asset infrastructure, daemon health monitoring, and error handling capabilities that form the foundation for the autonomous-dev portal's resilient operation and user experience.