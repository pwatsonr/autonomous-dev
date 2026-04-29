# PLAN-015-2: Approval Gate Flow + Settings Editor + Intake-Router HTTP Client

## Metadata
- **Parent TDD**: TDD-015-portal-live-data-settings
- **Estimated effort**: 4-5 days
- **Dependencies**: ["PLAN-014-1", "PLAN-014-2", "PLAN-015-1"]
- **Priority**: P0

## Objective

Implement the approval gate flow, settings editor, and intake router HTTP client for the autonomous-dev web portal. This plan delivers interactive approval workflows where operators can approve, request changes, or reject pending requests through gate action panels, plus a comprehensive settings editor for live configuration management with server-side validation and daemon reload triggering. All mutations flow through the intake router HTTP client to maintain data consistency.

The implementation integrates typed-CONFIRM modal flows from TDD-014 for destructive operations (reject actions on high-cost requests >$50), provides form-based configuration mutation with real-time validation, and establishes robust HTTP communication with the intake router including retry logic and port discovery.

## Scope

### In Scope

**Approval Gate Flow (TDD-015 §8)**:
- `POST /repo/:repo/request/:id/gate/{approve,request-changes,reject}` endpoint handlers
- Each gate action calls intake router with `source: 'portal'` and operator identity (FR-S05 from PLAN-014-1)
- Gate action panel UI component (3 buttons: approve, request changes, reject + comment field)
- Confirmation modal flow with typed-CONFIRM integration for reject actions on requests >$50 cost
- After-action workflow: redirect to approval queue with success message
- SSE broadcast integration when gate actions update state.json

**Settings Editor Flow (TDD-015 §9)**:
- `POST /settings` endpoint for form-based configuration mutations
- Form fields: trust level per repo (dropdown), cost caps (currency input), allowlist add/remove with git-repo verification
- Server-side validation chain composing PLAN-014-3 primitives (path validation, regex test-compile)
- 422 HTTP responses with human-readable error messages for invalid submissions
- Daemon-reload signal for active-behavior changes (cost caps, trust levels)
- Settings mutations write via intake router `config-set` command (not direct file write)

**Intake Router HTTP Client (TDD-015 §14)**:
- HTTP client class for portal-to-intake communication with IncomingCommand shape
- Intake server port discovery via shared config or daemon registration
- HTTP client retry/timeout/auth semantics with exponential backoff
- Health check endpoint integration
- Error handling and graceful degradation when intake router is unavailable

### Out of Scope

- File watcher + SSE + data accessors (PLAN-015-1)
- Cost analysis + charts (PLAN-015-3)
- Logs/operations/audit UI (PLAN-015-4)
- CSRF/auth middleware implementation (PLAN-014-1, PLAN-014-2)
- Intake router server implementation (exists; we only call it)
- Dashboard layout and navigation (PLAN-013-2)

## Tasks

### TASK-001: Intake Router HTTP Client Foundation
**Dependencies**: []
**Estimated Effort**: 3 hours

Create the core IntakeRouterClient class with port discovery, retry logic, and basic command submission capabilities.

**Files to create:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/lib/intake-router-client.ts`

**Files to modify:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/lib/index.ts`

**Implementation Details:**
```typescript
export interface IntakeCommand {
  command: string;
  requestId: string;
  comment?: string;
  source: string; // Always 'portal' for portal-initiated actions  
  sourceUserId: string; // Operator identity from auth or "localhost"
  configChanges?: Record<string, any>; // For config-set commands
}

export interface IntakeResponse {
  success: boolean;
  commandId: string;
  error?: string;
  data?: any;
}

export class IntakeRouterClient {
  private baseUrl: string;
  private timeout = 5000;
  private retryAttempts = 3;
  private retryDelay = 1000;
  
  constructor(private config: PortalConfig) {
    const intakePort = this.discoverIntakePort();
    this.baseUrl = `http://127.0.0.1:${intakePort}`;
  }

  async submitCommand(command: IntakeCommand): Promise<IntakeResponse>
  async healthCheck(): Promise<{ healthy: boolean; version?: string; latency?: number }>
  private discoverIntakePort(): number
  private makeRequest(path: string, options: RequestInit): Promise<Response>
  private delay(ms: number): Promise<void>
}
```

**Acceptance Criteria:**
- Client discovers intake router port from `../autonomous-dev/.claude-plugin/userConfig.json`
- Falls back to default port 19279 from TDD-008
- Implements exponential backoff with 3 retry attempts
- 5-second timeout per request with AbortSignal
- Health check endpoint returns latency and version information
- Unit tests cover port discovery, retry logic, and error scenarios

**Lint/Test Commands:**
```bash
cd /Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev
bun run lint:portal
bun test src/portal/lib/intake-router-client.test.ts
```

### TASK-002: Gate Action Panel Template Component
**Dependencies**: [TASK-001]
**Estimated Effort**: 2 hours

Create the HTML template fragment for gate action panels with approve/request-changes/reject buttons and comment field.

**Files to create:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/templates/fragments/gate-action-panel.hbs`

**Files to modify:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/templates/partials/index.ts`

**Template Structure:**
```handlebars
<div class="gate-action-panel" data-request-id="{{requestId}}">
  <div class="gate-actions">
    <button class="gate-btn gate-approve" data-action="approve">
      <svg>{{> icon-check}}</svg>
      Approve
    </button>
    <button class="gate-btn gate-request-changes" data-action="request-changes">
      <svg>{{> icon-edit}}</svg>
      Request Changes
    </button>
    <button class="gate-btn gate-reject" data-action="reject" {{#if isHighCost}}data-requires-confirm="true"{{/if}}>
      <svg>{{> icon-x}}</svg>
      Reject
    </button>
  </div>
  
  <div class="comment-section">
    <textarea 
      id="gate-comment-{{requestId}}" 
      placeholder="Optional comment (required for request-changes)"
      class="comment-input"
      maxlength="1000">
    </textarea>
    <div class="comment-meta">
      <span class="char-count">0/1000</span>
    </div>
  </div>
</div>
```

**Acceptance Criteria:**
- Panel renders with three distinct action buttons
- Comment textarea with character counting (0/1000)
- High-cost requests (>$50) mark reject button with `data-requires-confirm="true"`
- CSS classes follow portal design system from PLAN-013-2
- Template includes proper ARIA labels for accessibility

**Lint/Test Commands:**
```bash
bun run lint:templates
bun test src/portal/templates/fragments/gate-action-panel.test.ts
```

### TASK-003: Confirmation Modal Integration
**Dependencies**: [TASK-002]
**Estimated Effort**: 2.5 hours

Integrate typed-CONFIRM modal system from TDD-014 for destructive gate actions (reject of high-cost requests).

**Files to create:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/js/gate-confirmation.ts`

**Files to modify:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/templates/layouts/base.hbs`

**Implementation Details:**
```typescript
interface ConfirmationConfig {
  action: string;
  requestId: string;
  requestTitle: string;
  costAmount?: number;
  confirmText: string; // e.g., "REJECT"
}

class GateConfirmationHandler {
  private confirmationTokenManager: ConfirmationTokenManager;

  async showConfirmationModal(config: ConfirmationConfig): Promise<string | null> {
    // Generate one-time confirmation token
    const token = this.confirmationTokenManager.generateConfirmToken(
      getCurrentSessionId(), 
      `${config.action}_${config.requestId}`
    );

    // Show modal with typed-CONFIRM field
    const modal = this.createConfirmationModal(config, token);
    const result = await this.waitForUserInput(modal);
    
    if (result.confirmed && result.typedText === config.confirmText) {
      return token;
    }
    
    return null;
  }

  private createConfirmationModal(config: ConfirmationConfig, token: string): HTMLElement
  private waitForUserInput(modal: HTMLElement): Promise<{confirmed: boolean, typedText: string}>
}
```

**Acceptance Criteria:**
- Reject actions on requests >$50 cost trigger typed-CONFIRM modal
- Modal requires user to type "REJECT" exactly (case-sensitive)
- Confirmation tokens are single-use with 60-second TTL
- Approve and request-changes actions bypass confirmation modal
- Modal includes request details (title, cost) for context
- Modal can be cancelled without side effects

**Lint/Test Commands:**
```bash
bun run lint:frontend
bun test src/portal/js/gate-confirmation.test.ts
```

### TASK-004: Gate Action Endpoint Handlers
**Dependencies**: [TASK-001, TASK-003]
**Estimated Effort**: 4 hours

Implement the three gate action POST endpoints with CSRF validation, intake router communication, and audit logging.

**Files to create:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/routes/gate-actions.ts`

**Files to modify:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/app.ts`

**Implementation Details:**
```typescript
export interface GateActionRequest {
  requestId: string;
  action: 'approve' | 'request-changes' | 'reject';
  comment?: string;
  confirmationToken?: string; // For destructive actions requiring typed-CONFIRM
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
    if (request.action === 'reject' && this.isHighCostRequest(request.requestId)) {
      if (!request.confirmationToken) {
        throw new Error('Confirmation token required for high-cost rejection');
      }
      
      const isValidToken = await this.confirmationTokenManager.validateToken(
        request.confirmationToken,
        operatorId,
        `reject_${request.requestId}`
      );
      
      if (!isValidToken) {
        throw new Error('Invalid or expired confirmation token');
      }
    }

    // 3. Call intake router with portal source attribution
    const intakeResponse = await this.intakeClient.submitCommand({
      command: request.action,
      requestId: request.requestId,
      comment: request.comment,
      source: 'portal',
      sourceUserId: operatorId
    });

    // 4. Record audit entry
    // 5. Return success with redirect target
  }

  private isHighCostRequest(requestId: string): boolean
}

// Route handlers
app.post('/repo/:repo/request/:id/gate/approve', gateActionHandler)
app.post('/repo/:repo/request/:id/gate/request-changes', gateActionHandler)  
app.post('/repo/:repo/request/:id/gate/reject', gateActionHandler)
```

**Acceptance Criteria:**
- All three gate endpoints validate CSRF tokens via TDD-014 middleware
- Reject actions on high-cost requests require valid confirmation tokens
- Successful actions redirect to approval queue with success flash message
- Failed actions return 422 with error details in JSON format
- Audit entries include operator ID, action type, comment, and intake response ID
- Intake router communication failures return 503 with retry suggestion

**Lint/Test Commands:**
```bash
bun run lint:backend
bun test src/portal/routes/gate-actions.test.ts
```

### TASK-005: Settings Page Form Rendering
**Dependencies**: []
**Estimated Effort**: 3 hours

Create the settings page with form fields for trust levels, cost caps, allowlist management, and notification settings.

**Files to create:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/templates/pages/settings.hbs`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/js/settings-form.ts`

**Files to modify:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/routes/pages.ts`

**Template Structure:**
```handlebars
<div class="settings-editor">
  <form id="settings-form" method="POST" action="/settings">
    {{> csrf-token}}
    
    <section class="cost-controls">
      <h3>Cost Management</h3>
      <div class="form-row">
        <label for="cost-daily">Daily Cost Cap ($)</label>
        <input type="number" id="cost-daily" name="costCaps.daily" 
               value="{{settings.costCaps.daily}}" min="0" step="0.01" required>
      </div>
      <div class="form-row">
        <label for="cost-monthly">Monthly Cost Cap ($)</label>
        <input type="number" id="cost-monthly" name="costCaps.monthly" 
               value="{{settings.costCaps.monthly}}" min="0" step="0.01" required>
      </div>
    </section>

    <section class="trust-levels">
      <h3>Repository Trust Levels</h3>
      {{#each repositories}}
      <div class="form-row">
        <label for="trust-{{name}}">{{name}}</label>
        <select id="trust-{{name}}" name="trustLevels.{{name}}">
          <option value="untrusted" {{#eq trustLevel "untrusted"}}selected{{/eq}}>Untrusted</option>
          <option value="basic" {{#eq trustLevel "basic"}}selected{{/eq}}>Basic</option>
          <option value="trusted" {{#eq trustLevel "trusted"}}selected{{/eq}}>Trusted</option>
        </select>
      </div>
      {{/each}}
    </section>

    <section class="allowlist-management">
      <h3>Repository Allowlist</h3>
      <div id="allowlist-paths">
        {{#each settings.allowlist}}
        <div class="allowlist-item">
          <input type="text" name="allowlist[]" value="{{this}}" placeholder="/path/to/repo">
          <button type="button" class="remove-path">Remove</button>
        </div>
        {{/each}}
      </div>
      <button type="button" id="add-allowlist-path">Add Repository Path</button>
    </section>

    <div class="form-actions">
      <button type="submit" class="btn-primary">Save Settings</button>
      <button type="reset" class="btn-secondary">Reset Changes</button>
    </div>
  </form>
</div>
```

**Acceptance Criteria:**
- Form fields populated with current settings values from config
- Currency inputs with proper validation (positive numbers, 2 decimal places)
- Trust level dropdowns for each discovered repository
- Dynamic allowlist management (add/remove repository paths)
- Real-time validation feedback before form submission
- Form submission triggers settings validation chain

**Lint/Test Commands:**
```bash
bun run lint:templates
bun test src/portal/templates/pages/settings.test.ts
```

### TASK-006: Server-Side Validation Chain
**Dependencies**: [TASK-001]
**Estimated Effort**: 4 hours

Implement comprehensive server-side validation for settings mutations composing PLAN-014-3 security primitives.

**Files to create:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/lib/config-validator.ts`

**Files to modify:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/lib/index.ts`

**Implementation Details:**
```typescript
export interface ConfigValidationRule {
  field: string;
  validate: (value: any, context: ValidationContext) => ValidationResult;
}

export interface ValidationContext {
  fullConfig: any;
  userHomeDir: string;
  allowedRoots: string[];
  operatorId: string;
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
        if (num > 10000) {
          return { valid: false, error: 'Daily cost cap cannot exceed $10,000' };
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
        if (num < dailyCap * 28) {
          return { 
            valid: true, 
            warnings: ['Monthly cap is less than 28x daily cap, may trigger frequently'] 
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
      field: 'trustLevels',
      validate: (levels, context) => this.validateTrustLevels(levels, context)
    },
    {
      field: 'patterns.regex',
      validate: (pattern) => this.validateRegexPattern(pattern)
    }
  ];

  async validateField(field: string, value: any, context: ValidationContext): Promise<ValidationResult>
  async validateConfiguration(config: Record<string, any>, context: ValidationContext): Promise<ValidationSummary>
  
  private validateAllowlistPaths(paths: string[], context: ValidationContext): ValidationResult
  private validateTrustLevels(levels: Record<string, string>, context: ValidationContext): ValidationResult
  private validateRegexPattern(pattern: string): ValidationResult
  private verifyGitRepository(path: string): ValidationResult
}
```

**Acceptance Criteria:**
- Cost caps validation: positive numbers, reasonable upper bounds, daily vs monthly consistency
- Allowlist path validation: canonicalization, allowed root verification, git repository check
- Trust level validation: valid enum values, admin-only restrictions for trust reduction
- Regex pattern validation: ReDoS protection, compilation timeout, input length limits
- Validation errors return human-readable messages suitable for form field display
- Validation warnings allow submission but inform operator of potential issues

**Lint/Test Commands:**
```bash
bun run lint:backend
bun test src/portal/lib/config-validator.test.ts
```

### TASK-007: Settings Mutation Endpoint Handler
**Dependencies**: [TASK-001, TASK-006]
**Estimated Effort**: 3.5 hours

Implement the `POST /settings` endpoint with validation chain integration, intake router communication, and daemon reload signaling.

**Files to create:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/routes/settings.ts`

**Files to modify:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/app.ts`

**Implementation Details:**
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
      allowedRoots: [process.env.HOME || '/Users/operator'],
      operatorId
    };

    // Validate all changes
    const validationSummary = await this.validator.validateConfiguration(changes, validationContext);
    
    if (!validationSummary.valid) {
      return { 
        success: false, 
        errors: validationSummary.errors,
        warnings: validationSummary.warnings 
      };
    }

    try {
      // Send config-set command to intake router
      const intakeResponse = await this.intakeClient.submitCommand({
        command: 'config-set',
        requestId: crypto.randomUUID(),
        source: 'portal',
        sourceUserId: operatorId,
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

      // Signal daemon reload if needed
      if (this.requiresDaemonReload(changes)) {
        await this.signalDaemonReload();
      }

      return { success: true, warnings: validationSummary.warnings };
    } catch (error) {
      return {
        success: false,
        errors: ['Internal server error updating settings']
      };
    }
  }

  private requiresDaemonReload(changes: Record<string, any>): boolean
  private signalDaemonReload(): Promise<void>
  private hashConfigValues(values: Record<string, any>): Record<string, string>
}

// Route handler
app.post('/settings', csrfProtection, async (c) => {
  const formData = await c.req.formData();
  const changes = parseFormDataToConfig(formData);
  const operatorId = getOperatorId(c);
  
  const result = await settingsHandler.updateSettings(changes, operatorId);
  
  if (!result.success) {
    return c.json({ errors: result.errors, warnings: result.warnings }, 422);
  }
  
  return c.redirect('/settings?success=1');
});
```

**Acceptance Criteria:**
- Form submission parsing handles nested config keys (e.g., "costCaps.daily")
- Validation errors return 422 status with detailed error messages
- Successful submissions trigger intake router config-set command
- Daemon reload signal sent for active-behavior changes (cost caps, trust levels)
- Configuration mutations bypass direct file writes (use intake router only)
- Audit log entries capture config change hashes for integrity verification

**Lint/Test Commands:**
```bash
bun run lint:backend
bun test src/portal/routes/settings.test.ts
```

### TASK-008: 422 Error Response UI
**Dependencies**: [TASK-005, TASK-007]
**Estimated Effort**: 2 hours

Implement client-side handling for 422 validation error responses with inline form field error display.

**Files to create:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/js/validation-ui.ts`

**Files to modify:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/js/settings-form.ts`

**Implementation Details:**
```typescript
interface ValidationError {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

class ValidationUIHandler {
  private form: HTMLFormElement;
  private errorContainer: HTMLElement;

  constructor(form: HTMLFormElement) {
    this.form = form;
    this.errorContainer = this.createErrorContainer();
  }

  displayValidationErrors(response: { errors?: string[]; warnings?: string[] }): void {
    this.clearValidationErrors();
    
    // Display field-specific errors inline
    if (response.errors) {
      response.errors.forEach(error => {
        const [field, message] = this.parseFieldError(error);
        this.showFieldError(field, message);
      });
    }
    
    // Display general warnings in notification area
    if (response.warnings) {
      response.warnings.forEach(warning => {
        this.showWarningNotification(warning);
      });
    }
  }

  private showFieldError(fieldName: string, message: string): void {
    const field = this.form.querySelector(`[name="${fieldName}"]`) as HTMLElement;
    if (!field) return;

    field.classList.add('error');
    
    const errorElement = document.createElement('div');
    errorElement.className = 'field-error';
    errorElement.textContent = message;
    
    field.parentNode?.insertBefore(errorElement, field.nextSibling);
  }

  private clearValidationErrors(): void {
    this.form.querySelectorAll('.field-error').forEach(el => el.remove());
    this.form.querySelectorAll('.error').forEach(el => el.classList.remove('error'));
  }

  private parseFieldError(errorString: string): [string, string] {
    const match = errorString.match(/^([^:]+):\s*(.+)$/);
    return match ? [match[1], match[2]] : ['_general', errorString];
  }
}

// Integration with settings form
document.getElementById('settings-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const formData = new FormData(e.target as HTMLFormElement);
  const response = await fetch('/settings', {
    method: 'POST',
    body: formData
  });

  if (response.status === 422) {
    const validation = await response.json();
    validationUI.displayValidationErrors(validation);
  } else if (response.ok) {
    window.location.href = '/settings?success=1';
  }
});
```

**Acceptance Criteria:**
- 422 responses display field-specific errors inline below affected form controls
- Error fields receive visual styling (red border, error icon)
- Form submission preventDefault when validation errors exist
- Success responses redirect to settings page with success message
- Multiple errors per field display as stacked messages
- Error clearing on subsequent form interactions

**Lint/Test Commands:**
```bash
bun run lint:frontend
bun test src/portal/js/validation-ui.test.ts
```

### TASK-009: Daemon Reload Signal Implementation
**Dependencies**: [TASK-001]
**Estimated Effort**: 2 hours

Implement daemon reload signaling for configuration changes that affect active behavior (cost caps, trust levels).

**Files to create:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/lib/daemon-signal.ts`

**Files to modify:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/lib/index.ts`

**Implementation Details:**
```typescript
interface ReloadConfig {
  triggerFields: string[];
  reloadCommand: string;
  timeout: number;
}

export class DaemonReloadHandler {
  private readonly RELOAD_TRIGGERS = [
    'costCaps.daily',
    'costCaps.monthly', 
    'trustLevels',
    'circuitBreaker.enabled',
    'killSwitch.engaged'
  ];

  constructor(private intakeClient: IntakeRouterClient) {}

  requiresReload(configChanges: Record<string, any>): boolean {
    return Object.keys(configChanges).some(key => 
      this.RELOAD_TRIGGERS.some(trigger => key.includes(trigger))
    );
  }

  async signalReload(reason: string): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.intakeClient.submitCommand({
        command: 'daemon-reload',
        requestId: crypto.randomUUID(),
        source: 'portal',
        sourceUserId: 'system',
        comment: reason
      });

      if (!response.success) {
        return {
          success: false,
          error: response.error || 'Daemon reload command failed'
        };
      }

      return { success: true };
    } catch (error) {
      console.error('Daemon reload signal failed:', error);
      return {
        success: false,
        error: 'Failed to communicate with daemon'
      };
    }
  }

  async waitForReloadCompletion(timeoutMs: number = 10000): Promise<boolean> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      const health = await this.intakeClient.healthCheck();
      if (health.healthy) {
        return true;
      }
      
      await this.delay(500);
    }
    
    return false;
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

**Acceptance Criteria:**
- Reload triggers identified correctly based on configuration change keys
- Daemon reload command sent via intake router with proper attribution
- Reload signal includes human-readable reason for audit trail
- Health check polling confirms daemon restart completion
- Timeout handling for unresponsive daemon reload operations
- Non-blocking reload (portal continues serving while daemon restarts)

**Lint/Test Commands:**
```bash
bun run lint:backend
bun test src/portal/lib/daemon-signal.test.ts
```

### TASK-010: Gate Actions Frontend Integration
**Dependencies**: [TASK-002, TASK-003, TASK-004]
**Estimated Effort**: 3 hours

Implement frontend JavaScript for gate action button handling with confirmation modal integration and success/error feedback.

**Files to create:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/js/gate-actions.ts`

**Files to modify:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/portal/templates/layouts/base.hbs`

**Implementation Details:**
```typescript
interface GateActionConfig {
  requestId: string;
  action: 'approve' | 'request-changes' | 'reject';
  requiresComment: boolean;
  requiresConfirmation: boolean;
  costAmount?: number;
  redirectTarget: string;
}

class GateActionHandler {
  private confirmationHandler: GateConfirmationHandler;
  
  constructor() {
    this.confirmationHandler = new GateConfirmationHandler();
    this.bindEventHandlers();
  }

  private bindEventHandlers(): void {
    document.addEventListener('click', async (e) => {
      const button = e.target as HTMLElement;
      
      if (!button.classList.contains('gate-btn')) return;
      
      e.preventDefault();
      await this.handleGateAction(button);
    });

    // Comment field character counting
    document.addEventListener('input', (e) => {
      const textarea = e.target as HTMLTextAreaElement;
      
      if (textarea.classList.contains('comment-input')) {
        this.updateCharacterCount(textarea);
      }
    });
  }

  private async handleGateAction(button: HTMLElement): Promise<void> {
    const panel = button.closest('.gate-action-panel') as HTMLElement;
    const config = this.parseGateActionConfig(button, panel);
    
    // Validate comment requirement
    if (config.requiresComment && !this.getComment(panel)) {
      this.showError(panel, 'Comment is required for this action');
      return;
    }

    // Handle confirmation requirement
    let confirmationToken: string | null = null;
    
    if (config.requiresConfirmation) {
      confirmationToken = await this.confirmationHandler.showConfirmationModal({
        action: config.action,
        requestId: config.requestId,
        requestTitle: panel.dataset.requestTitle || 'Unknown Request',
        costAmount: config.costAmount,
        confirmText: config.action.toUpperCase()
      });
      
      if (!confirmationToken) {
        return; // User cancelled
      }
    }

    await this.submitGateAction(config, confirmationToken);
  }

  private async submitGateAction(config: GateActionConfig, confirmationToken: string | null): Promise<void> {
    const formData = new FormData();
    formData.append('action', config.action);
    formData.append('requestId', config.requestId);
    
    const comment = this.getComment(document.querySelector(`[data-request-id="${config.requestId}"]`));
    if (comment) {
      formData.append('comment', comment);
    }
    
    if (confirmationToken) {
      formData.append('confirmationToken', confirmationToken);
    }

    try {
      const response = await fetch(`/repo/${config.repoName}/request/${config.requestId}/gate/${config.action}`, {
        method: 'POST',
        body: formData
      });

      if (response.ok) {
        window.location.href = config.redirectTarget + '?action=success';
      } else {
        const error = await response.json();
        this.showError(
          document.querySelector(`[data-request-id="${config.requestId}"]`),
          error.message || 'Gate action failed'
        );
      }
    } catch (error) {
      this.showError(
        document.querySelector(`[data-request-id="${config.requestId}"]`),
        'Network error processing gate action'
      );
    }
  }

  private parseGateActionConfig(button: HTMLElement, panel: HTMLElement): GateActionConfig
  private getComment(panel: HTMLElement | null): string
  private updateCharacterCount(textarea: HTMLTextAreaElement): void
  private showError(panel: HTMLElement | null, message: string): void
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  new GateActionHandler();
});
```

**Acceptance Criteria:**
- Gate action buttons trigger appropriate POST requests to gate endpoints
- Comment validation enforced client-side (required for request-changes)
- High-cost rejection actions trigger confirmation modal flow
- Character counting for comment textarea (0/1000 display)
- Success actions redirect to approval queue with success message
- Error handling displays inline error messages below gate panels
- CSRF token automatically included in form submissions

**Lint/Test Commands:**
```bash
bun run lint:frontend
bun test src/portal/js/gate-actions.test.ts
```

### TASK-011: End-to-End Integration Test
**Dependencies**: [TASK-004, TASK-007, TASK-010]
**Estimated Effort**: 4 hours

Create comprehensive end-to-end test for approval gate flow demonstrating state.json updates and SSE broadcast integration.

**Files to create:**
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/tests/e2e/approval-gate-flow.test.ts`
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/tests/e2e/settings-mutation-flow.test.ts`

**Test Scenarios:**

**Approval Gate Flow E2E:**
```typescript
describe('Approval Gate Flow E2E', () => {
  let testPortalServer: PortalServer;
  let mockIntakeRouter: MockIntakeRouter;
  let testStateFile: string;
  
  beforeEach(async () => {
    // Setup test environment with mock intake router
    mockIntakeRouter = new MockIntakeRouter();
    await mockIntakeRouter.start();
    
    // Create test state.json with pending request
    testStateFile = createTestStateFile({
      requests: [{
        id: 'test-req-001',
        status: 'pending-approval',
        cost: { total: 25.50 },
        created: new Date().toISOString(),
        title: 'Test PRD Implementation'
      }]
    });
    
    // Start portal server with test config
    testPortalServer = await createTestPortalServer({
      intakeRouterPort: mockIntakeRouter.port,
      stateFilePath: testStateFile
    });
  });

  it('approve flow updates state.json and broadcasts SSE', async () => {
    // 1. Load approval queue page
    const page = await testPortalServer.createPage();
    await page.goto('/approval-queue');
    
    // 2. Verify pending request is visible
    const requestCard = page.locator(`[data-request-id="test-req-001"]`);
    await expect(requestCard).toBeVisible();
    
    // 3. Click approve button
    await requestCard.locator('.gate-approve').click();
    
    // 4. Verify intake router received approve command
    const commands = mockIntakeRouter.getReceivedCommands();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      command: 'approve',
      requestId: 'test-req-001',
      source: 'portal',
      sourceUserId: expect.any(String)
    });
    
    // 5. Mock intake router updates state.json
    updateStateFile(testStateFile, {
      requests: [{
        id: 'test-req-001',
        status: 'approved',
        approvedBy: 'test-operator',
        approvedAt: new Date().toISOString()
      }]
    });
    
    // 6. Verify SSE event received and UI updated
    await page.waitForFunction(() => {
      const request = document.querySelector(`[data-request-id="test-req-001"]`);
      return request?.querySelector('.status-badge')?.textContent === 'approved';
    });
    
    // 7. Verify redirect to approval queue with success message
    await expect(page.locator('.success-message')).toContainText('Request approved successfully');
  });

  it('reject high-cost request requires confirmation', async () => {
    // Setup high-cost request ($75)
    updateStateFile(testStateFile, {
      requests: [{
        id: 'test-req-002', 
        status: 'pending-approval',
        cost: { total: 75.00 },
        title: 'High-Cost Implementation'
      }]
    });
    
    const page = await testPortalServer.createPage();
    await page.goto('/approval-queue');
    
    // Click reject button
    const requestCard = page.locator(`[data-request-id="test-req-002"]`);
    await requestCard.locator('.gate-reject').click();
    
    // Verify confirmation modal appears
    const modal = page.locator('.confirmation-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('REJECT');
    
    // Type confirmation text
    await modal.locator('input[type="text"]').fill('REJECT');
    await modal.locator('.confirm-action').click();
    
    // Verify intake router command includes confirmation token
    const commands = mockIntakeRouter.getReceivedCommands();
    expect(commands[0].confirmationToken).toBeDefined();
  });
});
```

**Settings Mutation Flow E2E:**
```typescript
describe('Settings Mutation Flow E2E', () => {
  it('cost cap change triggers daemon reload', async () => {
    const page = await testPortalServer.createPage();
    await page.goto('/settings');
    
    // Change daily cost cap
    await page.fill('input[name="costCaps.daily"]', '150.00');
    await page.click('button[type="submit"]');
    
    // Verify config-set command sent to intake router
    const commands = mockIntakeRouter.getReceivedCommands();
    expect(commands.find(c => c.command === 'config-set')).toBeTruthy();
    
    // Verify daemon-reload signal sent
    expect(commands.find(c => c.command === 'daemon-reload')).toBeTruthy();
    
    // Verify success redirect
    await expect(page).toHaveURL('/settings?success=1');
  });

  it('invalid path submission returns 422 errors', async () => {
    const page = await testPortalServer.createPage();
    await page.goto('/settings');
    
    // Add invalid allowlist path
    await page.click('#add-allowlist-path');
    await page.fill('input[name="allowlist[]"]:last-child', '/invalid/path/not/git');
    await page.click('button[type="submit"]');
    
    // Verify 422 error displayed inline
    const errorMessage = page.locator('.field-error');
    await expect(errorMessage).toContainText('is not a git repository');
    
    // Verify form stays on settings page
    await expect(page).toHaveURL('/settings');
  });
});
```

**Acceptance Criteria:**
- E2E test demonstrates complete approve flow: button click → intake router → state.json update → SSE broadcast
- High-cost rejection flow includes confirmation modal with typed-CONFIRM validation
- Settings mutations trigger appropriate daemon reload signals
- Validation errors display correctly with 422 responses and inline field errors
- All tests run in isolated environments with mock intake router
- Tests cover success paths and error scenarios for both gate actions and settings

**Lint/Test Commands:**
```bash
bun run test:e2e:portal
bun test tests/e2e/approval-gate-flow.test.ts
bun test tests/e2e/settings-mutation-flow.test.ts
```

## Task Dependencies & Execution Schedule

### Dependency Graph

```
TASK-001 (Intake Router Client)
├── TASK-004 (Gate Endpoints) 
├── TASK-006 (Validation Chain)
├── TASK-007 (Settings Endpoint)
└── TASK-009 (Daemon Reload)

TASK-002 (Gate Panel Template)
├── TASK-003 (Confirmation Modal)
└── TASK-010 (Frontend Integration)

TASK-005 (Settings Form) 
└── TASK-008 (422 Error UI)

TASK-004 + TASK-007 + TASK-010
└── TASK-011 (E2E Tests)
```

### Critical Path
TASK-001 → TASK-004 → TASK-010 → TASK-011 (13.5 hours)

### Parallel Execution Tracks

**Track A (Backend Foundation)**: TASK-001 → TASK-004 → TASK-006 → TASK-007 → TASK-009
**Track B (Frontend Components)**: TASK-002 → TASK-003 → TASK-010
**Track C (Settings UI)**: TASK-005 → TASK-008
**Track D (Integration)**: TASK-011 (requires A + B completion)

## Risk Assessment

### High Risk
- **Intake router port discovery reliability**: If `userConfig.json` format changes or is missing, client will use wrong port
  - *Mitigation*: Implement fallback discovery mechanisms (process scanning, well-known ports)
- **SSE integration timing**: Gate actions may complete before file watcher detects state.json changes
  - *Mitigation*: Add explicit SSE trigger after successful intake router responses

### Medium Risk  
- **Typed-CONFIRM modal UX complexity**: Multi-step confirmation flow may confuse operators
  - *Mitigation*: Clear visual design with progress indicators and cancellation options
- **Settings validation performance**: Path verification and regex testing may be slow
  - *Mitigation*: Implement timeouts and async validation with loading indicators

### Low Risk
- **CSRF token integration**: Dependency on PLAN-014-1 middleware implementation
  - *Mitigation*: Use standardized CSRF patterns, coordinate with security team
- **Form parsing edge cases**: Complex nested configuration keys may parse incorrectly  
  - *Mitigation*: Comprehensive unit tests for form data to config object conversion

## Definition of Done

- [ ] All 11 tasks completed with passing acceptance criteria
- [ ] Intake router HTTP client handles retry logic, timeouts, and port discovery
- [ ] Gate action endpoints validate CSRF, communicate with intake router, and log audit entries
- [ ] Gate action panels render with proper UI components and confirmation modal integration
- [ ] Settings editor form handles all configuration fields with real-time validation
- [ ] Server-side validation chain composes security primitives from PLAN-014-3
- [ ] 422 error responses display inline field-specific error messages
- [ ] Daemon reload signaling triggers for relevant configuration changes
- [ ] Frontend JavaScript handles gate actions with confirmation and error feedback
- [ ] End-to-end tests demonstrate complete approval and settings flows
- [ ] All lint and test commands pass without errors
- [ ] Code review completed with security and architecture teams
- [ ] Integration testing with PLAN-015-1 file watcher and SSE components
- [ ] Performance testing under concurrent gate action submissions
- [ ] Documentation updated with API endpoints and configuration schema