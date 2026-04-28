# TDD-014: Portal Security & Authentication

| Field        | Value                                              |
|--------------|----------------------------------------------------|
| **Title**    | Portal Security & Authentication                   |
| **TDD ID**   | TDD-014                                            |
| **Version**  | 1.0                                                |
| **Date**     | 2026-04-28                                         |
| **Status**   | Draft                                              |
| **Author**   | Patrick Watson                                     |
| **Parent PRD** | PRD-009: Web Control Plane                       |
| **Plugin**   | autonomous-dev-portal                              |

---

## 1. Summary

This TDD specifies the security architecture for the autonomous-dev-portal plugin. The portal provides a web interface for managing autonomous-dev operations, presenting a high-value attack surface that requires comprehensive security controls. This design implements defense-in-depth against Cross-Site Request Forgery (CSRF), Cross-Site Scripting (XSS), path traversal, Regular Expression Denial of Service (ReDoS), and unauthorized access attacks.

The security model supports three authentication modes: localhost-only (default), Tailscale identity, and OAuth 2.0 with PKCE. Each mode enforces TLS requirements, origin validation, and audit logging appropriate to its threat model. The system implements typed confirmation modals for destructive operations, comprehensive input validation with sandboxed execution, and an append-only audit log with HMAC integrity chains.

Security is not a bolt-on feature but the architectural foundation: every endpoint, every form field, every dynamic content rendering, and every file system operation is designed with explicit security invariants that pass automated testing at 100% coverage for security-critical paths.

## 2. Goals & Non-Goals

### Goals

- **Fail-safe defaults**: The portal defaults to localhost-only mode with no network exposure. Network modes require explicit opt-in with mandatory TLS and authentication.
- **Defense-in-depth**: Multiple independent security layers (authentication, CSRF tokens, origin validation, CSP, input sanitization) protect against single-point failures.
- **Audit integrity**: Every portal-initiated action creates a tamper-evident audit trail with cryptographic integrity verification.
- **Attack surface minimization**: The portal surface is read-only by default; mutations flow through the existing intake router with the same validation as CLI operations.
- **Zero-trust input handling**: All user inputs are validated, sanitized, and executed in sandboxed contexts regardless of authentication status.

### Non-Goals

- **Multi-tenancy**: The portal serves a single operator organization and does not implement tenant isolation.
- **Advanced authentication**: Integration with enterprise SSO, SAML, or certificate-based authentication is out of scope.
- **Rate limiting**: The portal assumes a trusted single operator; DoS protection is handled at the infrastructure level.
- **Cryptographic key management**: HMAC keys are generated locally and not distributed; no PKI infrastructure required.

## 3. Threat Model

### 3.1 Attacker Profiles

**Local User (Trusted Environment)**
- Description: Another user account on the same machine where the portal runs
- Capabilities: Can read portal configuration files, send requests to localhost:19280
- Limitations: Cannot access other users' browser sessions or cookies
- Motivation: Accidental misconfiguration, curiosity, privilege escalation

**Browser Extension (Hostile Content)**
- Description: Malicious browser extension running in the operator's browser
- Capabilities: Can make HTTP requests using the operator's credentials and session cookies
- Limitations: Subject to same-origin policy and CSP restrictions
- Motivation: Data exfiltration, unauthorized actions using operator credentials

**Network Attacker (Tailnet Compromise)**
- Description: Attacker who has gained access to the Tailscale network
- Capabilities: Can make requests to the portal from other tailnet nodes
- Limitations: Cannot forge Tailscale identity headers (verified by tailscaled)
- Motivation: Lateral movement, access to development infrastructure

**Remote Unauthenticated (Internet Exposure)**
- Description: Attacker scanning for exposed web services
- Capabilities: Can send arbitrary HTTP requests if portal is misconfigured to bind 0.0.0.0
- Limitations: No access to authentication credentials or network segments
- Motivation: Reconnaissance, exploitation of unprotected services

### 3.2 Assets & Protection Requirements

**Configuration Files**
- Asset: Trust levels, cost caps, allowlists, API keys, webhook URLs
- Requirement: Confidentiality (secrets redacted in UI), integrity (atomic writes with validation)
- Threat: Information disclosure, unauthorized configuration changes

**Audit Log**
- Asset: Portal-initiated actions with operator attribution and timestamps  
- Requirement: Integrity (append-only, HMAC chain), availability (must not be deletable via portal)
- Threat: Log tampering, audit trail deletion, false audit entries

**Kill-switch State**
- Asset: Emergency halt capability for entire autonomous-dev system
- Requirement: Integrity (only authenticated operators), availability (must function during incidents)
- Threat: Unauthorized activation causing development halt, inability to halt during emergencies

**Session Cookies**
- Asset: Authentication state for network-exposed portal modes
- Requirement: Confidentiality (httpOnly, Secure), integrity (tamper protection)
- Threat: Session hijacking, session fixation, cross-site authentication bypass

**Secrets in Configuration**
- Asset: API keys, webhook tokens, GitHub tokens stored in configuration
- Requirement: Confidentiality (last-4 redaction), non-repudiation (env-var indirection in audit)
- Threat: Secret disclosure via UI, secret leakage in audit logs

### 3.3 Trust Boundaries

**Portal Process ↔ Daemon State**
- Boundary: Portal reads state files, never writes directly
- Control: File system permissions, read-only file handles per FR-S43
- Threat: Portal corruption of daemon state, unauthorized state modification

**Portal Process ↔ Intake Router**
- Boundary: Portal sends HTTP requests to intake router for all mutations
- Control: Portal carries `source: 'portal'` and `source_user_id` attribution per FR-915
- Threat: Portal bypassing intake validation, unauthenticated mutations

**Browser ↔ Portal Server**
- Boundary: HTTP requests cross network boundary in tailscale/oauth modes
- Control: TLS encryption, origin validation, CSRF tokens, CSP headers
- Threat: Man-in-the-middle attacks, cross-site request forgery, XSS injection

**Portal ↔ File System**
- Boundary: Portal reads configuration files, writes audit log and temporary files
- Control: Path canonicalization, symlink rejection, allowed-roots enforcement per FR-S20
- Threat: Directory traversal, symlink attacks, unauthorized file access

## 4. Authentication Architecture

### 4.1 Mode Selection Logic

```typescript
interface PortalConfig {
  auth_mode: 'localhost' | 'tailscale' | 'oauth';
  bind_address: string;
  port: number;
  tailscale_tailnet?: string;
  oauth_provider?: 'github' | 'google';
  tls_cert_path?: string;
  tls_key_path?: string;
}

// Startup validation per FR-S01
function validateAuthConfig(config: PortalConfig): void {
  if (config.auth_mode === 'localhost') {
    if (config.bind_address !== '127.0.0.1' && config.bind_address !== 'localhost') {
      throw new Error('localhost mode requires bind_address of 127.0.0.1 or localhost');
    }
    return; // No TLS or auth provider required
  }

  // Network modes require TLS per FR-S04
  if (!config.tls_cert_path && !process.env.TAILSCALE_FUNNEL) {
    throw new Error(`${config.auth_mode} mode requires TLS certificate or Tailscale Funnel`);
  }

  if (config.bind_address === '0.0.0.0' && !config.tls_cert_path) {
    throw new Error('Refusing to bind 0.0.0.0 without TLS in network mode');
  }

  // Mode-specific validation
  switch (config.auth_mode) {
    case 'tailscale':
      if (!config.tailscale_tailnet) {
        throw new Error('tailscale mode requires tailscale_tailnet configuration');
      }
      break;
    case 'oauth':
      if (!config.oauth_provider) {
        throw new Error('oauth mode requires oauth_provider configuration');
      }
      break;
  }
}
```

### 4.2 Localhost Mode (Default)

Localhost mode assumes a trusted local environment with no network exposure.

```typescript
// No authentication middleware in localhost mode
function createLocalhostServer(config: PortalConfig): Hono {
  const app = new Hono();
  
  // Apply security headers even in localhost mode
  app.use(securityHeaders);
  app.use(csrfProtection);
  
  // Source attribution for intake calls per FR-915
  app.use(async (c, next) => {
    c.set('source_user_id', 'localhost');
    await next();
  });
  
  return app;
}
```

### 4.3 Tailscale Mode Sequence Diagram

```
User Browser         Portal Server         Tailscale Daemon      Intake Router
      |                     |                     |                   |
      |-- HTTPS Request ---->|                     |                   |
      |                     |-- Validate Origin -->|                   |
      |                     |-- Check Tailscale-  |                   |
      |                     |   User-Login header |                   |
      |                     |<-- Header verified --|                   |
      |                     |-- Extract user_id ---|                   |
      |                     |-- Generate CSRF ----->|                   |
      |                     |-- Render page ------>|                   |
      |<-- HTML + CSRF token|                     |                   |
      |                     |                     |                   |
      |-- Form Submit ------>|                     |                   |
      |                     |-- Validate CSRF ---->|                   |
      |                     |-- Validate Origin --->|                   |
      |                     |                     |                   |
      |                     |-- Intake Call -------|------------------>|
      |                     |   source: 'portal'   |                   |
      |                     |   source_user_id: 'user@tailnet'         |
      |                     |<-- Response ----------|<------------------|
      |<-- Success/Error ----|                     |                   |
```

```typescript
// Tailscale authentication middleware per FR-S02
function tailscaleAuth(c: Context, next: NextFunction): Promise<void> {
  const userLogin = c.req.header('Tailscale-User-Login');
  const userName = c.req.header('Tailscale-User-Name');
  
  if (!userLogin) {
    return c.json({ error: 'Unauthorized: Missing Tailscale identity headers' }, 403);
  }
  
  // Verify request originated from tailnet
  const clientIP = c.req.header('X-Real-IP') || c.req.header('X-Forwarded-For');
  if (!isTailscaleIP(clientIP, c.env.TAILSCALE_TAILNET)) {
    return c.json({ error: 'Forbidden: Request not from tailnet' }, 403);
  }
  
  // Store verified identity for audit logging per FR-S05
  c.set('source_user_id', userLogin);
  c.set('user_display_name', userName || userLogin);
  
  return next();
}

function isTailscaleIP(ip: string, tailnet: string): boolean {
  // Verify IP is from the configured tailnet
  // Implementation depends on Tailscale API or local node status
  return tailscale.verifyNodeIP(ip, tailnet);
}
```

### 4.4 OAuth Mode with PKCE

OAuth mode implements Authorization Code + PKCE flow for GitHub and Google providers.

```typescript
interface OAuthSession {
  user_id: string;
  email: string;
  provider: 'github' | 'google';
  created_at: number;
  last_activity: number;
  csrf_token: string;
}

// OAuth configuration per FR-S03
const OAUTH_CONFIG = {
  github: {
    client_id: process.env.GITHUB_CLIENT_ID,
    authorize_url: 'https://github.com/login/oauth/authorize',
    token_url: 'https://github.com/login/oauth/access_token',
    user_url: 'https://api.github.com/user',
    scope: 'user:email'
  },
  google: {
    client_id: process.env.GOOGLE_CLIENT_ID,
    authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_url: 'https://oauth2.googleapis.com/token',
    user_url: 'https://www.googleapis.com/oauth2/v2/userinfo',
    scope: 'openid email profile'
  }
};

// Session management with security timeouts per FR-S03
class SessionManager {
  private sessions = new Map<string, OAuthSession>();
  
  private readonly IDLE_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours
  private readonly ABSOLUTE_TIMEOUT = 30 * 24 * 60 * 60 * 1000; // 30 days
  
  createSession(userInfo: any, provider: string): string {
    const sessionId = crypto.randomUUID();
    const now = Date.now();
    
    this.sessions.set(sessionId, {
      user_id: userInfo.login || userInfo.email,
      email: userInfo.email,
      provider,
      created_at: now,
      last_activity: now,
      csrf_token: crypto.randomUUID()
    });
    
    return sessionId;
  }
  
  validateSession(sessionId: string): OAuthSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    
    const now = Date.now();
    
    // Check absolute timeout
    if (now - session.created_at > this.ABSOLUTE_TIMEOUT) {
      this.sessions.delete(sessionId);
      return null;
    }
    
    // Check idle timeout
    if (now - session.last_activity > this.IDLE_TIMEOUT) {
      this.sessions.delete(sessionId);
      return null;
    }
    
    // Update last activity
    session.last_activity = now;
    return session;
  }
}

// OAuth middleware
function oauthAuth(c: Context, next: NextFunction): Promise<void> {
  const sessionId = c.req.cookie('portal_session');
  if (!sessionId) {
    return c.redirect('/auth/login');
  }
  
  const session = sessionManager.validateSession(sessionId);
  if (!session) {
    c.res.clearCookie('portal_session');
    return c.redirect('/auth/login');
  }
  
  // Store for intake router attribution per FR-S05
  c.set('source_user_id', session.user_id);
  c.set('session', session);
  
  return next();
}
```

## 5. Cross-Site Request Forgery (CSRF) Defense

### 5.1 Origin Header Validation (FR-S10)

```typescript
// Expected origins per authentication mode
function getExpectedOrigins(config: PortalConfig): string[] {
  switch (config.auth_mode) {
    case 'localhost':
      return [`http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`];
    case 'tailscale':
      return [`https://${config.tailscale_tailnet}`, 'https://localhost:19280'];
    case 'oauth':
      return [`https://${config.domain}`];
    default:
      throw new Error(`Unknown auth_mode: ${config.auth_mode}`);
  }
}

// Origin validation middleware per FR-S10
function validateOrigin(c: Context, next: NextFunction): Promise<void> {
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return next(); // Safe methods exempt from origin check
  }
  
  const origin = c.req.header('Origin');
  if (!origin) {
    console.warn('CSRF attempt: Missing Origin header', {
      method,
      url: c.req.url,
      userAgent: c.req.header('User-Agent')
    });
    return c.json({ error: 'Forbidden: Missing Origin header' }, 403);
  }
  
  const expectedOrigins = getExpectedOrigins(c.env.PORTAL_CONFIG);
  if (!expectedOrigins.includes(origin)) {
    console.warn('CSRF attempt: Invalid Origin', {
      origin,
      expected: expectedOrigins,
      method,
      url: c.req.url
    });
    return c.json({ error: 'Forbidden: Invalid Origin' }, 403);
  }
  
  return next();
}
```

### 5.2 CSRF Token Generation and Validation (FR-S11)

```typescript
// CSRF token management per FR-S11
class CSRFTokenManager {
  private tokens = new Map<string, { token: string; expires: number }>();
  private readonly TOKEN_TTL = 60 * 60 * 1000; // 1 hour
  
  generateToken(sessionId: string): string {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + this.TOKEN_TTL;
    
    this.tokens.set(sessionId, { token, expires });
    return token;
  }
  
  validateToken(sessionId: string, submittedToken: string): boolean {
    const stored = this.tokens.get(sessionId);
    if (!stored || Date.now() > stored.expires) {
      this.tokens.delete(sessionId);
      return false;
    }
    
    // Timing-safe comparison to prevent timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(stored.token),
      Buffer.from(submittedToken)
    );
  }
  
  cleanExpiredTokens(): void {
    const now = Date.now();
    for (const [sessionId, data] of this.tokens) {
      if (now > data.expires) {
        this.tokens.delete(sessionId);
      }
    }
  }
}

// CSRF middleware for mutating endpoints per FR-S11
function csrfProtection(c: Context, next: NextFunction): Promise<void> {
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return next(); // Safe methods exempt from CSRF check
  }
  
  const sessionId = c.get('session_id') || 'localhost';
  const submittedToken = c.req.header('X-CSRF-Token') || 
                         c.req.header('X-Requested-With'); // HTMX fallback
  
  if (!submittedToken) {
    auditLog.append({
      event: 'csrf_token_missing',
      session_id: sessionId,
      method,
      url: c.req.url,
      timestamp: new Date().toISOString()
    });
    return c.json({ error: 'Forbidden: Missing CSRF token' }, 403);
  }
  
  if (!csrfManager.validateToken(sessionId, submittedToken)) {
    auditLog.append({
      event: 'csrf_token_invalid',
      session_id: sessionId,
      method,
      url: c.req.url,
      timestamp: new Date().toISOString()
    });
    return c.json({ error: 'Forbidden: Invalid CSRF token' }, 403);
  }
  
  return next();
}
```

### 5.3 Typed-CONFIRM Modal Implementation (FR-S12)

```typescript
// One-time confirmation tokens for destructive operations per FR-S12
class ConfirmationTokenManager {
  private tokens = new Map<string, { 
    sessionId: string; 
    action: string; 
    expires: number; 
  }>();
  
  private readonly CONFIRM_TTL = 60 * 1000; // 60 seconds
  
  generateConfirmToken(sessionId: string, action: string): string {
    const token = crypto.randomUUID();
    const expires = Date.now() + this.CONFIRM_TTL;
    
    this.tokens.set(token, { sessionId, action, expires });
    return token;
  }
  
  validateConfirmToken(token: string, sessionId: string, action: string): boolean {
    const stored = this.tokens.get(token);
    if (!stored) return false;
    
    if (Date.now() > stored.expires || 
        stored.sessionId !== sessionId || 
        stored.action !== action) {
      this.tokens.delete(token);
      return false;
    }
    
    // One-time use
    this.tokens.delete(token);
    return true;
  }
}

// Destructive operations requiring typed confirmation per FR-S12
const DESTRUCTIVE_ACTIONS = [
  'kill_switch_engage',
  'kill_switch_reset', 
  'circuit_breaker_reset',
  'allowlist_remove',
  'trust_level_reduce'
] as const;

function requireConfirmation(action: string) {
  return async (c: Context, next: NextFunction) => {
    if (!DESTRUCTIVE_ACTIONS.includes(action as any)) {
      return next();
    }
    
    const confirmToken = c.req.form('confirm_token');
    const typedConfirm = c.req.form('typed_confirm');
    const sessionId = c.get('session_id') || 'localhost';
    
    if (typedConfirm !== 'CONFIRM') {
      return c.json({ 
        error: 'Must type CONFIRM to proceed with destructive action' 
      }, 400);
    }
    
    if (!confirmToken || 
        !confirmManager.validateConfirmToken(confirmToken, sessionId, action)) {
      return c.json({ 
        error: 'Invalid or expired confirmation token' 
      }, 403);
    }
    
    // Log destructive action with confirmation
    auditLog.append({
      event: 'destructive_action_confirmed',
      action,
      session_id: sessionId,
      user_id: c.get('source_user_id'),
      timestamp: new Date().toISOString()
    });
    
    return next();
  };
}
```

## 6. Content Security Policy and XSS Prevention

### 6.1 CSP Header Configuration (FR-S32)

```typescript
// Content Security Policy per FR-S32
const CSP_DIRECTIVE = [
  "default-src 'self'",           // Only same-origin resources by default
  "script-src 'self'",            // Only same-origin scripts (HTMX served locally)
  "style-src 'self' 'unsafe-inline'", // Allow inline styles for server-rendered CSS
  "img-src 'self' data:",         // Same-origin images plus data URLs for SVG charts  
  "font-src 'self'",              // Same-origin fonts
  "object-src 'none'",            // No plugins/objects
  "frame-ancestors 'none'",       // Prevent framing (clickjacking defense)
  "base-uri 'self'",              // Restrict base tag
  "form-action 'self'"            // Only same-origin form submissions
].join('; ');

// Security headers middleware per FR-S33
function securityHeaders(c: Context, next: NextFunction): Promise<void> {
  c.res.headers.set('Content-Security-Policy', CSP_DIRECTIVE);
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('Referrer-Policy', 'same-origin');
  
  // HSTS for HTTPS connections
  if (c.req.url.startsWith('https://')) {
    c.res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  
  return next();
}
```

### 6.2 Markdown Sanitization Pipeline (FR-S30)

```typescript
import { marked } from 'marked';
import DOMPurify from 'isomorphic-dompurify';

// Markdown sanitization configuration per FR-S30
class MarkdownSanitizer {
  private readonly marked: typeof marked;
  private readonly purify: typeof DOMPurify;
  
  constructor() {
    // Configure marked with security-focused options
    this.marked = marked.setOptions({
      gfm: true,               // GitHub-flavored markdown
      breaks: true,            // Line breaks become <br>
      sanitize: false,         // We handle sanitization with DOMPurify
      smartLists: true,
      smartypants: false       // Disable smart quotes to avoid encoding issues
    });
    
    // Configure DOMPurify with strict HTML5 profile
    this.purify = DOMPurify();
    this.purify.setConfig({
      ALLOWED_TAGS: [
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'p', 'br', 'strong', 'em', 'u', 'del',
        'ul', 'ol', 'li', 'blockquote',
        'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'a', 'img'
      ],
      ALLOWED_ATTR: [
        'href', 'title', 'alt', 'src',
        'class' // For syntax highlighting
      ],
      ALLOWED_URI_REGEXP: /^(?:(?:https?|ftp):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
      FORBID_ATTR: ['onclick', 'onerror', 'onload', 'style'],
      KEEP_CONTENT: false,     // Remove content of forbidden tags
      RETURN_DOM: false,       // Return HTML string
      RETURN_DOM_FRAGMENT: false
    });
  }
  
  // Fixed pipeline: marked -> DOMPurify -> return per FR-S30
  sanitizeMarkdown(content: string): string {
    if (!content || typeof content !== 'string') {
      return '';
    }
    
    try {
      // Step 1: Parse markdown to HTML
      const html = this.marked.parse(content);
      
      // Step 2: Sanitize HTML with DOMPurify
      const sanitized = this.purify.sanitize(html);
      
      // Step 3: Return clean HTML
      return sanitized;
    } catch (error) {
      console.error('Markdown sanitization failed:', error);
      // Return escaped plain text as fallback
      return this.escapeHtml(content);
    }
  }
  
  private escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }
}

// Usage in template rendering
function renderArtifact(content: string, type: 'markdown' | 'diff'): string {
  if (type === 'markdown') {
    return sanitizer.sanitizeMarkdown(content);
  } else {
    // Code diffs get HTML entity encoding per FR-S31
    return sanitizer.escapeHtml(content);
  }
}
```

### 6.3 Safe DOM Update Pattern (FR-S34)

```typescript
// HTMX integration with server-sanitized content per FR-S34
class SafeTemplateRenderer {
  // Never use innerHTML or dangerouslySetInnerHTML per FR-S34
  renderFragment(templateName: string, data: any): string {
    const template = this.getTemplate(templateName);
    const sanitizedData = this.sanitizeTemplateData(data);
    return this.executeTemplate(template, sanitizedData);
  }
  
  private sanitizeTemplateData(data: any): any {
    if (typeof data === 'string') {
      return this.escapeHtml(data);
    }
    
    if (Array.isArray(data)) {
      return data.map(item => this.sanitizeTemplateData(item));
    }
    
    if (data && typeof data === 'object') {
      const sanitized: any = {};
      for (const [key, value] of Object.entries(data)) {
        // Special handling for markdown content
        if (key.endsWith('_markdown') && typeof value === 'string') {
          sanitized[key.replace('_markdown', '_html')] = 
            sanitizer.sanitizeMarkdown(value);
        } else {
          sanitized[key] = this.sanitizeTemplateData(value);
        }
      }
      return sanitized;
    }
    
    return data;
  }
  
  private escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[char] || char);
  }
}

// HTMX response with pre-sanitized content
app.post('/approve/:requestId', async (c) => {
  const requestId = c.req.param('requestId');
  const action = c.req.form('action');
  
  // Process approval through intake router
  const result = await intakeRouter.approve(requestId, {
    action,
    source: 'portal',
    source_user_id: c.get('source_user_id')
  });
  
  // Return pre-sanitized HTML fragment
  return c.html(templateRenderer.renderFragment('approval_success', {
    request_id: requestId,
    action,
    timestamp: new Date().toISOString()
  }));
});
```

## 7. Input Validation and Path Security

### 7.1 Path Canonicalization and Symlink Protection (FR-S20)

```typescript
import { realpath } from 'fs/promises';
import { dirname, resolve, relative } from 'path';

// Path validation configuration per FR-S20
interface PathPolicy {
  allowed_roots: string[];
  follow_symlinks: boolean;
  max_depth: number;
}

class PathValidator {
  private policy: PathPolicy;
  
  constructor(policy: PathPolicy) {
    this.policy = {
      allowed_roots: policy.allowed_roots.map(root => resolve(root)),
      follow_symlinks: false, // Always false for security
      max_depth: Math.max(1, policy.max_depth)
    };
  }
  
  // Path validation with symlink escape detection per FR-S20
  async validatePath(inputPath: string): Promise<{ valid: boolean; canonical?: string; error?: string }> {
    try {
      if (!inputPath || typeof inputPath !== 'string') {
        return { valid: false, error: 'Path must be a non-empty string' };
      }
      
      // Resolve to absolute path
      const absolutePath = resolve(inputPath);
      
      // Check path depth to prevent deep recursion
      const depth = absolutePath.split('/').length;
      if (depth > this.policy.max_depth) {
        return { valid: false, error: `Path depth ${depth} exceeds maximum ${this.policy.max_depth}` };
      }
      
      // Canonicalize path and detect symlink escapes
      let canonical: string;
      try {
        canonical = await realpath(absolutePath);
      } catch (error) {
        return { valid: false, error: `Path does not exist or is inaccessible: ${error.message}` };
      }
      
      // Check if canonical path is within allowed roots
      const isAllowed = this.policy.allowed_roots.some(root => {
        const rel = relative(root, canonical);
        return rel && !rel.startsWith('..') && !rel.includes('../');
      });
      
      if (!isAllowed) {
        return { 
          valid: false, 
          error: `Path ${canonical} is outside allowed roots: ${this.policy.allowed_roots.join(', ')}` 
        };
      }
      
      // Detect symlink escapes by comparing absolute vs canonical
      if (canonical !== absolutePath) {
        // Additional check: ensure symlink doesn't escape allowed roots
        const symlinkCheck = this.policy.allowed_roots.some(root => {
          const relToCanonical = relative(root, canonical);
          const relToAbsolute = relative(root, absolutePath);
          return relToCanonical && !relToCanonical.startsWith('..') &&
                 relToAbsolute && !relToAbsolute.startsWith('..');
        });
        
        if (!symlinkCheck) {
          return {
            valid: false,
            error: 'Symlink escapes allowed directory tree'
          };
        }
      }
      
      return { valid: true, canonical };
    } catch (error) {
      return { 
        valid: false, 
        error: `Path validation failed: ${error.message}` 
      };
    }
  }
}
```

### 7.2 Git Repository Verification (FR-S21)

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Git repository verification per FR-S21
class GitValidator {
  private readonly TIMEOUT_MS = 2000; // 2 seconds per FR-S21
  
  async verifyGitRepository(path: string): Promise<{ valid: boolean; error?: string }> {
    try {
      // Use execFile (not shell) with explicit argv for security per FR-S23
      const { stdout, stderr } = await execFileAsync(
        'git',
        ['-C', path, 'rev-parse', '--git-dir'],
        {
          timeout: this.TIMEOUT_MS,
          encoding: 'utf8'
        }
      );
      
      if (stderr) {
        return { valid: false, error: `Git error: ${stderr.trim()}` };
      }
      
      // Verify output indicates a valid git repository
      const gitDir = stdout.trim();
      if (!gitDir || gitDir === '') {
        return { valid: false, error: 'Invalid git repository: no git directory found' };
      }
      
      return { valid: true };
    } catch (error) {
      if (error.code === 'ETIMEDOUT') {
        return { valid: false, error: 'Git verification timed out after 2 seconds' };
      }
      
      return { 
        valid: false, 
        error: `Git verification failed: ${error.message}` 
      };
    }
  }
}

// Usage in allowlist form validation
app.post('/settings/allowlist/add', async (c) => {
  const inputPath = c.req.form('path');
  
  // Step 1: Path validation
  const pathResult = await pathValidator.validatePath(inputPath);
  if (!pathResult.valid) {
    return c.json({ 
      error: `Invalid path: ${pathResult.error}` 
    }, 422);
  }
  
  // Step 2: Git repository verification per FR-S21
  const gitResult = await gitValidator.verifyGitRepository(pathResult.canonical);
  if (!gitResult.valid) {
    return c.json({ 
      error: `Not a git repository: ${gitResult.error}` 
    }, 422);
  }
  
  // Step 3: Add to allowlist via intake router
  const result = await intakeRouter.addToAllowlist({
    path: pathResult.canonical,
    source: 'portal',
    source_user_id: c.get('source_user_id')
  });
  
  return c.json({ success: true, path: pathResult.canonical });
});
```

### 7.3 ReDoS Defense with Regex Sandboxing (FR-S22)

```typescript
// Regex sandboxing to prevent ReDoS attacks per FR-S22
class RegexValidator {
  private readonly MAX_EXEC_TIME = 100; // 100ms per FR-S22
  private readonly MAX_INPUT_SIZE = 1000; // 1KB per FR-S22
  
  async validateRegex(pattern: string, testInput?: string): Promise<{
    valid: boolean;
    compiled?: RegExp;
    error?: string;
  }> {
    if (!pattern || typeof pattern !== 'string') {
      return { valid: false, error: 'Pattern must be a non-empty string' };
    }
    
    if (pattern.length > 500) {
      return { valid: false, error: 'Pattern too long (max 500 characters)' };
    }
    
    // Test compilation in worker thread to prevent main thread blocking
    try {
      const compiled = await this.compileInSandbox(pattern);
      
      // If test input provided, validate execution time
      if (testInput) {
        const execResult = await this.testExecution(compiled, testInput);
        if (!execResult.safe) {
          return { valid: false, error: execResult.error };
        }
      }
      
      return { valid: true, compiled };
    } catch (error) {
      return { valid: false, error: `Regex compilation failed: ${error.message}` };
    }
  }
  
  private async compileInSandbox(pattern: string): Promise<RegExp> {
    return new Promise((resolve, reject) => {
      // Use setTimeout to enforce compilation timeout
      const timeout = setTimeout(() => {
        reject(new Error('Regex compilation timed out'));
      }, this.MAX_EXEC_TIME);
      
      try {
        const regex = new RegExp(pattern);
        clearTimeout(timeout);
        resolve(regex);
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }
  
  private async testExecution(regex: RegExp, input: string): Promise<{
    safe: boolean;
    error?: string;
  }> {
    if (input.length > this.MAX_INPUT_SIZE) {
      return { 
        safe: false, 
        error: `Input too large (${input.length} > ${this.MAX_INPUT_SIZE} bytes)` 
      };
    }
    
    return new Promise((resolve) => {
      const start = Date.now();
      
      const timeout = setTimeout(() => {
        resolve({ 
          safe: false, 
          error: `Regex execution exceeded ${this.MAX_EXEC_TIME}ms timeout` 
        });
      }, this.MAX_EXEC_TIME);
      
      try {
        regex.test(input);
        const elapsed = Date.now() - start;
        clearTimeout(timeout);
        
        if (elapsed > this.MAX_EXEC_TIME / 2) {
          resolve({ 
            safe: false, 
            error: `Regex execution took ${elapsed}ms (threshold: ${this.MAX_EXEC_TIME / 2}ms)` 
          });
        } else {
          resolve({ safe: true });
        }
      } catch (error) {
        clearTimeout(timeout);
        resolve({ safe: false, error: error.message });
      }
    });
  }
}

// Form validation with regex testing
app.post('/settings/notification/pattern', async (c) => {
  const pattern = c.req.form('regex_pattern');
  const testInput = c.req.form('test_input') || 'test@example.com';
  
  // Validate regex safely per FR-S22
  const result = await regexValidator.validateRegex(pattern, testInput);
  if (!result.valid) {
    return c.json({ 
      error: `Invalid regex: ${result.error}` 
    }, 422);
  }
  
  // Save via intake router
  const saveResult = await intakeRouter.updateConfig({
    notification_pattern: pattern,
    source: 'portal',
    source_user_id: c.get('source_user_id')
  });
  
  return c.json({ success: true });
});
```

## 8. Audit Log Integrity and Secret Handling

### 8.1 Append-Only Audit Log with HMAC Chain (FR-S40, FR-S41)

```typescript
import { createHmac, randomBytes } from 'crypto';
import { open, constants } from 'fs/promises';

// Audit log with HMAC integrity chain per FR-S41
class AuditLogger {
  private logPath: string;
  private hmacKey: Buffer;
  private sequenceNumber: number = 0;
  private lastHmac: string = '';
  
  constructor(logPath: string) {
    this.logPath = logPath;
    this.hmacKey = this.loadOrGenerateKey();
    this.initializeSequence();
  }
  
  private loadOrGenerateKey(): Buffer {
    const keyPath = `${process.env.CLAUDE_PLUGIN_DATA}/.audit-key`;
    try {
      return readFileSync(keyPath);
    } catch (error) {
      // Generate new 32-byte key per FR-S41
      const key = randomBytes(32);
      writeFileSync(keyPath, key, { mode: 0o600 }); // Readable only by user
      return key;
    }
  }
  
  private async initializeSequence(): Promise<void> {
    try {
      const content = await readFile(this.logPath, 'utf8');
      const lines = content.trim().split('\n').filter(line => line);
      
      if (lines.length === 0) {
        this.sequenceNumber = 0;
        this.lastHmac = '';
      } else {
        const lastEntry = JSON.parse(lines[lines.length - 1]);
        this.sequenceNumber = lastEntry.sequence + 1;
        this.lastHmac = lastEntry.hmac;
      }
    } catch (error) {
      // File doesn't exist yet
      this.sequenceNumber = 0;
      this.lastHmac = '';
    }
  }
  
  // Append-only logging per FR-S40
  async append(entry: AuditEntry): Promise<void> {
    const timestamp = new Date().toISOString();
    const enrichedEntry = {
      ...entry,
      sequence: this.sequenceNumber,
      timestamp,
      previous_hmac: this.lastHmac
    };
    
    // Calculate HMAC over entry content + previous HMAC per FR-S41
    const entryJson = JSON.stringify(enrichedEntry);
    const hmac = createHmac('sha256', this.hmacKey);
    hmac.update(this.lastHmac);
    hmac.update(entryJson);
    const currentHmac = hmac.digest('hex');
    
    const finalEntry = {
      ...enrichedEntry,
      hmac: currentHmac
    };
    
    // Append to file with O_APPEND flag per FR-S40
    const fd = await open(this.logPath, constants.O_APPEND | constants.O_WRONLY | constants.O_CREAT, 0o644);
    try {
      await fd.writeFile(JSON.stringify(finalEntry) + '\n');
    } finally {
      await fd.close();
    }
    
    // Update state for next entry
    this.sequenceNumber++;
    this.lastHmac = currentHmac;
  }
}

interface AuditEntry {
  event: string;
  user_id?: string;
  action?: string;
  resource?: string;
  old_value_hash?: string;
  new_value_hash?: string;
  session_id?: string;
  [key: string]: any;
}

// CLI tool for audit verification per FR-S41
class AuditVerifier {
  static async verify(logPath: string, keyPath: string): Promise<{
    valid: boolean;
    totalEntries: number;
    errors: string[];
  }> {
    const errors: string[] = [];
    const key = readFileSync(keyPath);
    const content = readFileSync(logPath, 'utf8');
    const lines = content.trim().split('\n').filter(line => line);
    
    let expectedSequence = 0;
    let lastHmac = '';
    
    for (const [index, line] of lines.entries()) {
      try {
        const entry = JSON.parse(line);
        
        // Verify sequence number
        if (entry.sequence !== expectedSequence) {
          errors.push(`Line ${index + 1}: sequence ${entry.sequence} != expected ${expectedSequence}`);
        }
        
        // Verify previous HMAC
        if (entry.previous_hmac !== lastHmac) {
          errors.push(`Line ${index + 1}: previous_hmac mismatch`);
        }
        
        // Verify current HMAC
        const { hmac: storedHmac, ...entryForHmac } = entry;
        const hmac = createHmac('sha256', key);
        hmac.update(lastHmac);
        hmac.update(JSON.stringify(entryForHmac));
        const calculatedHmac = hmac.digest('hex');
        
        if (storedHmac !== calculatedHmac) {
          errors.push(`Line ${index + 1}: HMAC verification failed`);
        }
        
        expectedSequence++;
        lastHmac = storedHmac;
      } catch (error) {
        errors.push(`Line ${index + 1}: JSON parse error: ${error.message}`);
      }
    }
    
    return {
      valid: errors.length === 0,
      totalEntries: lines.length,
      errors
    };
  }
}
```

### 8.2 Secret Redaction and Secure Display

```typescript
// Secret handling per FR-S02 requirements and PRD-009 §8.3
class SecretManager {
  private readonly SECRET_FIELDS = [
    'webhook_url',
    'api_key', 
    'bot_token',
    'client_secret',
    'password'
  ];
  
  // Last-4 redaction with floor for short secrets
  redactSecret(value: string): string {
    if (!value || typeof value !== 'string') {
      return '';
    }
    
    if (value.length <= 8) {
      // For short secrets, show only first and last character
      return value.length <= 2 ? '***' : `${value[0]}***${value[value.length - 1]}`;
    }
    
    // For longer secrets, show last 4 characters
    return '***' + value.slice(-4);
  }
  
  // Redact configuration for UI display
  redactConfigForDisplay(config: any): any {
    if (!config || typeof config !== 'object') {
      return config;
    }
    
    const redacted = JSON.parse(JSON.stringify(config));
    
    this.walkObject(redacted, (key, value) => {
      if (this.isSecretField(key) && typeof value === 'string') {
        return this.redactSecret(value);
      }
      return value;
    });
    
    return redacted;
  }
  
  // Create hashes for audit log storage
  hashValue(value: any): string {
    if (!value) return '';
    
    const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
    return createHash('sha256').update(valueStr).digest('hex').substring(0, 16);
  }
  
  // Environment variable indirection in audit log
  formatValueForAudit(key: string, value: any): string {
    if (this.isSecretField(key)) {
      if (typeof value === 'string' && value.startsWith('$')) {
        return value; // Environment variable reference - safe to log
      }
      return this.hashValue(value); // Hash the actual secret
    }
    
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  
  private isSecretField(key: string): boolean {
    const lowerKey = key.toLowerCase();
    return this.SECRET_FIELDS.some(field => lowerKey.includes(field));
  }
  
  private walkObject(obj: any, transform: (key: string, value: any) => any): void {
    for (const [key, value] of Object.entries(obj)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        this.walkObject(value, transform);
      } else {
        obj[key] = transform(key, value);
      }
    }
  }
}

// Configuration display endpoint
app.get('/settings/view', async (c) => {
  const rawConfig = await configLoader.load();
  const redactedConfig = secretManager.redactConfigForDisplay(rawConfig);
  
  return c.html(templateRenderer.render('settings_view', {
    config: redactedConfig,
    csrf_token: csrfManager.generateToken(c.get('session_id'))
  }));
});

// Configuration update with audit logging
app.post('/settings/update', async (c) => {
  const formData = await c.req.formData();
  const updates: Record<string, any> = {};
  
  for (const [key, value] of formData.entries()) {
    updates[key] = value;
  }
  
  // Load current config for diff
  const oldConfig = await configLoader.load();
  
  // Update via intake router
  const result = await intakeRouter.updateConfig({
    ...updates,
    source: 'portal',
    source_user_id: c.get('source_user_id')
  });
  
  if (result.success) {
    // Audit log with value hashes per FR-S26
    await auditLogger.append({
      event: 'config_updated',
      user_id: c.get('source_user_id'),
      old_config_hash: secretManager.hashValue(oldConfig),
      new_config_hash: secretManager.hashValue(result.newConfig),
      fields_changed: Object.keys(updates)
    });
  }
  
  return c.json(result);
});
```

## 9. Source Attribution for Portal-Initiated Actions

### 9.1 Intake Router Integration (FR-915)

```typescript
// Source attribution for all portal-initiated intake calls per FR-915
class IntakeRouterClient {
  private baseUrl: string;
  
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }
  
  async approve(requestId: string, options: {
    action: 'approve' | 'request-changes' | 'reject';
    comment?: string;
    source_user_id: string;
  }): Promise<any> {
    return this.makeRequest('POST', `/requests/${requestId}/approve`, {
      action: options.action,
      comment: options.comment,
      source: 'portal',           // Required per FR-915
      source_user_id: options.source_user_id // Required per FR-915
    });
  }
  
  async updateConfig(updates: Record<string, any> & {
    source_user_id: string;
  }): Promise<any> {
    return this.makeRequest('POST', '/config/update', {
      ...updates,
      source: 'portal',           // Required per FR-915
      source_user_id: updates.source_user_id // Required per FR-915
    });
  }
  
  async killSwitchEngage(options: { source_user_id: string }): Promise<any> {
    return this.makeRequest('POST', '/kill-switch/engage', {
      source: 'portal',           // Required per FR-915
      source_user_id: options.source_user_id // Required per FR-915
    });
  }
  
  async killSwitchReset(options: { source_user_id: string }): Promise<any> {
    return this.makeRequest('POST', '/kill-switch/reset', {
      source: 'portal',           // Required per FR-915
      source_user_id: options.source_user_id // Required per FR-915
    });
  }
  
  async circuitBreakerReset(options: { source_user_id: string }): Promise<any> {
    return this.makeRequest('POST', '/circuit-breaker/reset', {
      source: 'portal',           // Required per FR-915
      source_user_id: options.source_user_id // Required per FR-915
    });
  }
  
  private async makeRequest(method: string, path: string, body: any): Promise<any> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'autonomous-dev-portal/1.0'
      },
      body: JSON.stringify(body)
    });
    
    if (!response.ok) {
      throw new Error(`Intake router error: ${response.status} ${response.statusText}`);
    }
    
    return response.json();
  }
}

// Route handler with proper source attribution
app.post('/approve/:requestId', requireConfirmation('approve'), async (c) => {
  const requestId = c.req.param('requestId');
  const action = c.req.form('action') as 'approve' | 'request-changes' | 'reject';
  const comment = c.req.form('comment') || '';
  
  try {
    // All portal actions carry source attribution per FR-915
    const result = await intakeRouter.approve(requestId, {
      action,
      comment,
      source_user_id: c.get('source_user_id') // From auth middleware
    });
    
    // Portal audit log
    await auditLogger.append({
      event: 'approval_action',
      user_id: c.get('source_user_id'),
      request_id: requestId,
      action,
      comment: comment ? secretManager.hashValue(comment) : undefined,
      intake_response: result.success
    });
    
    return c.json({ success: true, result });
  } catch (error) {
    await auditLogger.append({
      event: 'approval_action_failed',
      user_id: c.get('source_user_id'),
      request_id: requestId,
      action,
      error: error.message
    });
    
    return c.json({ 
      error: 'Approval action failed', 
      details: error.message 
    }, 500);
  }
});
```

## 10. Security Testing Strategy

### 10.1 CSRF Protection Test Suite

```typescript
// Comprehensive CSRF testing per requirements
describe('CSRF Protection', () => {
  test('rejects POST without Origin header', async () => {
    const response = await request(app)
      .post('/settings/update')
      .send({ trust_level: 'L2' });
    
    expect(response.status).toBe(403);
    expect(response.body.error).toContain('Missing Origin header');
  });
  
  test('rejects POST with invalid Origin', async () => {
    const response = await request(app)
      .post('/settings/update')
      .set('Origin', 'https://evil.com')
      .send({ trust_level: 'L2' });
    
    expect(response.status).toBe(403);
    expect(response.body.error).toContain('Invalid Origin');
  });
  
  test('rejects POST without CSRF token', async () => {
    const response = await request(app)
      .post('/settings/update')
      .set('Origin', 'http://localhost:19280')
      .send({ trust_level: 'L2' });
    
    expect(response.status).toBe(403);
    expect(response.body.error).toContain('Missing CSRF token');
  });
  
  test('rejects POST with invalid CSRF token', async () => {
    const response = await request(app)
      .post('/settings/update')
      .set('Origin', 'http://localhost:19280')
      .set('X-CSRF-Token', 'invalid-token')
      .send({ trust_level: 'L2' });
    
    expect(response.status).toBe(403);
    expect(response.body.error).toContain('Invalid CSRF token');
  });
  
  test('accepts valid CSRF token from same session', async () => {
    // Get CSRF token
    const getResponse = await request(app).get('/settings');
    const csrfToken = extractCSRFToken(getResponse.text);
    
    const response = await request(app)
      .post('/settings/update')
      .set('Origin', 'http://localhost:19280')
      .set('X-CSRF-Token', csrfToken)
      .set('Cookie', getResponse.headers['set-cookie'])
      .send({ trust_level: 'L2' });
    
    expect(response.status).toBe(200);
  });
});
```

### 10.2 XSS Prevention Test Suite

```typescript
// XSS injection test cases per FR-S30
describe('XSS Prevention', () => {
  const maliciousPayloads = [
    '<script>alert("xss")</script>',
    '<img src=x onerror=alert("xss")>',
    '<svg onload=alert("xss")>',
    'javascript:alert("xss")',
    '<iframe src="javascript:alert(\'xss\')">',
    '<object data="data:text/html,<script>alert(\'xss\')</script>">',
    '<embed src="data:text/html,<script>alert(\'xss\')</script>">'
  ];
  
  test('sanitizes markdown content', () => {
    for (const payload of maliciousPayloads) {
      const sanitized = sanitizer.sanitizeMarkdown(`# Test\n${payload}\nSafe content`);
      
      // Should not contain script tags or event handlers
      expect(sanitized).not.toMatch(/<script/i);
      expect(sanitized).not.toMatch(/onerror/i);
      expect(sanitized).not.toMatch(/onload/i);
      expect(sanitized).not.toMatch(/javascript:/i);
    }
  });
  
  test('escapes code diff content', () => {
    const maliciousCode = `
      function evil() {
        // <script>alert("xss")</script>
        document.write('<img src=x onerror=alert("xss")>');
      }
    `;
    
    const escaped = sanitizer.escapeHtml(maliciousCode);
    expect(escaped).not.toMatch(/<script/);
    expect(escaped).toContain('&lt;script&gt;');
    expect(escaped).toContain('&lt;img');
  });
  
  test('CSP headers prevent inline scripts', async () => {
    const response = await request(app).get('/dashboard');
    const csp = response.headers['content-security-policy'];
    
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-inline'");
  });
});
```

### 10.3 Path Traversal Test Suite

```typescript
// Path traversal attack testing per FR-S20
describe('Path Traversal Protection', () => {
  const traversalPayloads = [
    '../../../etc/passwd',
    '..\\..\\..\\windows\\system32\\config\\sam',
    '/etc/passwd',
    '....//....//....//etc/passwd',
    '%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '..%252f..%252f..%252fetc%252fpasswd',
    '/var/log/../../../etc/passwd',
    'symlink-to-etc-passwd'
  ];
  
  test('rejects directory traversal attempts', async () => {
    for (const payload of traversalPayloads) {
      const response = await request(app)
        .post('/settings/allowlist/add')
        .set('Origin', 'http://localhost:19280')
        .set('X-CSRF-Token', 'valid-token')
        .send({ path: payload });
      
      expect(response.status).toBe(422);
      expect(response.body.error).toMatch(/invalid path|outside allowed roots/i);
    }
  });
  
  test('validates symlink targets', async () => {
    // Create symlink pointing outside allowed roots
    const symlinkPath = '/tmp/portal-test-symlink';
    fs.symlinkSync('/etc/passwd', symlinkPath);
    
    const response = await request(app)
      .post('/settings/allowlist/add')
      .set('Origin', 'http://localhost:19280') 
      .set('X-CSRF-Token', 'valid-token')
      .send({ path: symlinkPath });
    
    expect(response.status).toBe(422);
    expect(response.body.error).toContain('escapes allowed directory tree');
    
    fs.unlinkSync(symlinkPath);
  });
});
```

### 10.4 ReDoS Attack Test Suite

```typescript
// Regular expression denial of service testing per FR-S22
describe('ReDoS Protection', () => {
  const redosPatterns = [
    '(a+)+b',
    '^(a+)+$', 
    '(a|a)*b',
    '^(([a-z])+.)+[A-Z]([a-z])+$',
    '([a-zA-Z]+)*$',
    '^((ab)*)+$'
  ];
  
  const attackString = 'a'.repeat(1000);
  
  test('times out malicious regex patterns', async () => {
    for (const pattern of redosPatterns) {
      const result = await regexValidator.validateRegex(pattern, attackString);
      
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/timeout|exceeded/i);
    }
  });
  
  test('accepts safe regex patterns', async () => {
    const safePatterns = [
      '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$', // Email
      '^\\d{3}-\\d{3}-\\d{4}$', // Phone
      '^[A-Z]{2,3}-\\d{3}$' // Document ID
    ];
    
    for (const pattern of safePatterns) {
      const result = await regexValidator.validateRegex(pattern, 'test@example.com');
      expect(result.valid).toBe(true);
    }
  });
  
  test('rejects oversized input', async () => {
    const largeInput = 'a'.repeat(2000);
    const result = await regexValidator.validateRegex('^[a-z]+$', largeInput);
    
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Input too large');
  });
});
```

### 10.5 Audit Log Integrity Test Suite

```typescript
// Audit log tampering detection per FR-S41
describe('Audit Log Integrity', () => {
  test('detects sequence number gaps', async () => {
    await auditLogger.append({ event: 'test1', user_id: 'user1' });
    await auditLogger.append({ event: 'test2', user_id: 'user1' });
    
    // Manually corrupt sequence
    const logContent = fs.readFileSync(auditLogger.logPath, 'utf8');
    const corrupted = logContent.replace('"sequence":1', '"sequence":5');
    fs.writeFileSync(auditLogger.logPath, corrupted);
    
    const verification = await AuditVerifier.verify(auditLogger.logPath, auditLogger.keyPath);
    expect(verification.valid).toBe(false);
    expect(verification.errors).toContain(expect.stringMatching(/sequence.*!= expected/));
  });
  
  test('detects HMAC tampering', async () => {
    await auditLogger.append({ event: 'test1', user_id: 'user1' });
    
    // Manually corrupt HMAC
    const logContent = fs.readFileSync(auditLogger.logPath, 'utf8');
    const corrupted = logContent.replace(/("hmac":")([^"]+)/, '$1tampered');
    fs.writeFileSync(auditLogger.logPath, corrupted);
    
    const verification = await AuditVerifier.verify(auditLogger.logPath, auditLogger.keyPath);
    expect(verification.valid).toBe(false);
    expect(verification.errors).toContain(expect.stringMatching(/HMAC verification failed/));
  });
  
  test('prevents log truncation attacks', async () => {
    await auditLogger.append({ event: 'sensitive1', user_id: 'user1' });
    await auditLogger.append({ event: 'sensitive2', user_id: 'user1' });
    
    // Try to truncate log
    const logContent = fs.readFileSync(auditLogger.logPath, 'utf8');
    const lines = logContent.split('\n');
    fs.writeFileSync(auditLogger.logPath, lines.slice(0, 1).join('\n') + '\n');
    
    // Next append should detect missing sequence
    await auditLogger.append({ event: 'test3', user_id: 'user1' });
    
    const verification = await AuditVerifier.verify(auditLogger.logPath, auditLogger.keyPath);
    expect(verification.valid).toBe(false);
  });
});
```

## 11. Implementation Plan

### Phase 1: Foundation Security (Week 1-2)
- **Task 1.1**: Implement authentication modes (localhost, tailscale, oauth) with startup validation per FR-S01-S05
- **Task 1.2**: Deploy CSRF protection with origin validation and token management per FR-S10-S11
- **Task 1.3**: Implement typed-CONFIRM modal system for destructive operations per FR-S12
- **Task 1.4**: Deploy security headers and CSP configuration per FR-S32-S33
- **Acceptance**: All authentication modes pass security test suite, CSRF tests pass at 100%

### Phase 2: Input Validation & Sanitization (Week 3-4)
- **Task 2.1**: Implement path validation with symlink protection per FR-S20-S21
- **Task 2.2**: Deploy regex sandboxing for ReDoS protection per FR-S22
- **Task 2.3**: Implement markdown sanitization pipeline with marked + DOMPurify per FR-S30
- **Task 2.4**: Create safe template rendering system per FR-S34
- **Acceptance**: Path traversal tests pass 100%, XSS injection attempts fail 100%, ReDoS patterns time out correctly

### Phase 3: Audit & Source Attribution (Week 5-6)
- **Task 3.1**: Implement append-only audit log with HMAC integrity per FR-S40-S41
- **Task 3.2**: Build audit verification CLI tool per FR-S41
- **Task 3.3**: Implement source attribution for all intake router calls per FR-915
- **Task 3.4**: Deploy secret redaction and secure configuration display
- **Acceptance**: Audit log passes tamper detection tests, source attribution appears in all intake calls

### Phase 4: Security Testing & Hardening (Week 7-8)
- **Task 4.1**: Complete security test matrix implementation (CSRF, XSS, path traversal, ReDoS, audit tampering)
- **Task 4.2**: Penetration testing with external security assessment
- **Task 4.3**: Performance testing under attack conditions (ReDoS, large input validation)
- **Task 4.4**: Documentation and security runbook completion
- **Acceptance**: Security test suite passes at 100%, penetration test findings resolved

## 12. Open Questions

| ID   | Question | Priority | Reviewer |
|------|----------|----------|----------|
| OQ-1 | Should the portal support hardware security keys (WebAuthn) for high-security environments? | Medium | Security Lead |
| OQ-2 | What is the appropriate audit log rotation strategy to prevent disk space exhaustion while maintaining integrity? | High | Operations Lead |
| OQ-3 | Should the portal implement rate limiting per IP address in tailscale/oauth modes to prevent abuse? | Medium | Security Lead |
| OQ-4 | How should the portal handle HMAC key rotation for long-running installations with large audit logs? | Medium | Security Lead |

## 13. References

- **OWASP CSRF Prevention Cheat Sheet**: Origin validation and token-based CSRF defense patterns
- **OWASP XSS Prevention Cheat Sheet**: Content sanitization and CSP implementation guidance  
- **RFC 7636**: Proof Key for Code Exchange (PKCE) specification for OAuth 2.0 flows
- **Helmet.js Documentation**: Security header best practices and implementation patterns
- **DOMPurify Documentation**: HTML sanitization configuration for strict content filtering
- **NIST SP 800-63B**: Authentication and lifecycle management guidelines
- **PRD-009 Section 8**: Security requirements FR-S01 through FR-S43
- **TDD-013**: Portal server foundation and routing architecture
- **TDD-015**: Live data updates and settings editor mutation flow
- **TDD-009**: Trust escalation and kill-switch integration patterns

---

## 22. Review-Driven Design Updates (Post-Review Revision)

This section captures design changes made in response to the security review pass. Each item updates or supersedes earlier design decisions.

### 22.1 Tailscale Mode: IP Origin Verification (Supersedes §6)

**Issue (SEC-001 CRITICAL)**: Trusting `Tailscale-User-Login` headers without verifying request origin allows local-network attackers to forge identity by sending direct HTTP requests with crafted headers.

**Updated design**:
1. Tailscale mode SHALL bind ONLY to the Tailscale network interface (`tailscale0` on Linux, equivalent on macOS), not `0.0.0.0`. Determine the bind address via `tailscale ip --4` at startup.
2. Before trusting Tailscale identity headers, the request peer IP SHALL be verified to be within the operator's tailnet IP range. The portal queries `tailscale status --json` at startup to determine the tailnet CIDR and rejects requests from non-tailnet IPs with HTTP 403.
3. As defense-in-depth, the portal SHALL also verify the `Tailscale-User-Login` header against the Tailscale local API at `http://100.100.100.100/whois?addr=<peer_ip>` for high-value mutating operations (kill-switch, config-set, gate actions). Read-only requests can rely on the bind+CIDR check alone for performance.
4. If the `tailscale` CLI is not available at startup, Tailscale mode SHALL refuse to start with a clear error.

### 22.2 ReDoS Defense: Worker Thread Sandboxing (Supersedes §15)

**Issue (SEC-002 HIGH)**: A `setTimeout`-based timeout in the main event loop does not interrupt regex execution; it only checks elapsed time after the regex returns. Catastrophic backtracking blocks the main thread until the regex completes, regardless of the timeout value.

**Updated design**:
1. Regex compilation and matching SHALL execute in a Node.js Worker Thread (`worker_threads`), not the main event loop.
2. The worker SHALL be terminated via `worker.terminate()` if execution exceeds 100ms wall-clock.
3. Input is capped at 1KB before being sent to the worker.
4. The worker is short-lived: spawned per regex test, terminated on completion. Pool reuse is a future optimization.
5. Bun-on-Linux provides equivalent worker-threads support; Bun-on-macOS may have minor differences — implementations MUST verify worker termination actually kills the V8 isolate before promoting to production.

### 22.3 HMAC Key Storage: Platform Keystore Integration (Supersedes §16.2)

**Issue (SEC-003 HIGH)**: A 32-byte HMAC key in a 0600 file is sufficient against passive attackers but is recoverable by any process running as the operator (malware, sibling tools, accidentally checked-in dotfiles).

**Updated design**:
1. **Default** (low-friction): key stored at `${CLAUDE_PLUGIN_DATA}/.audit-key` with mode 0600 (existing design; suitable for development and single-user homelab use).
2. **Recommended for shared/production**: key stored in the platform keystore — macOS Keychain via `security` CLI, Linux Secret Service (libsecret) via `secret-tool`, Windows Credential Manager via `cmdkey`. Key reference: `autonomous-dev-portal-audit/<install-id>`.
3. The `userConfig` key `portal.audit_key_storage` SHALL accept values `file` (default) and `keystore`. Operators choose based on threat model.
4. Key rotation: a new key SHALL be generated every 90 days. The old key is retained for audit-log verification of historical entries; new entries chain off the new key. The verifier tool understands key generations.

### 22.4 Path Validation: File Descriptor Mitigation for TOCTOU (Supersedes §14)

**Issue (SEC-004 MEDIUM)**: `realpath()` returns a valid path snapshot; a symlink swap between validation and the file operation makes the check stale.

**Updated design**:
1. After `realpath()` validation, the portal SHALL `open()` the validated path with `O_NOFOLLOW` and pass the resulting file descriptor to the read operation. Bun's `Bun.file(fd)` and Node's `fs.readSync(fd, ...)` accept descriptors.
2. For directory listings, use `readdirSync` with the validated absolute path inside an `O_NOFOLLOW`-opened directory FD.
3. For paths added to the allowlist (settings editor): the stored config records the validated absolute path string AND the device-inode pair. At consumption time, both are compared; mismatch causes the entry to be soft-rejected with an audit log entry.

### 22.5 Secret Redaction: Minimum Length Floor (Supersedes §17.1)

**Issue (SEC-005 MEDIUM)**: Last-4 redaction of a 4-character secret reveals the entire secret.

**Updated design**:
1. Secrets shorter than 8 characters SHALL be displayed as a fixed `••••` (4 bullet characters) with no character disclosure.
2. Secrets 8–11 characters SHALL be displayed as `••••<last-2>` (revealing only 2 trailing characters).
3. Secrets 12+ characters SHALL be displayed as `••••<last-4>` (the original last-4 design).
4. The portal SHALL refuse to accept secrets shorter than 8 characters in any field that uses redacted display. Discord/Slack tokens and OAuth client secrets are always >8 characters; this rule is enforced as a validation, not a redaction artifact.

---
