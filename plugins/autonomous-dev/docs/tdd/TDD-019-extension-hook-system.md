```typescript
import Ajv, { Schema, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { promises as fs } from 'fs';
import { join } from 'path';

/**
 * Schema registry and validation pipeline for hook outputs.
 * Provides versioned schema management and high-performance validation.
 */
export class ValidationPipeline {
  private readonly ajv: Ajv;
  private readonly schemaCache = new Map<string, ValidateFunction>();
  private readonly schemaRegistry = new Map<string, JSONSchema>();
  private readonly validationStats = new Map<string, ValidationStats>();

  constructor(private readonly schemaBasePath: string) {
    this.ajv = new Ajv({
      strict: true,
      allErrors: false, // Fail fast for performance
      coerceTypes: true, // Safe type coercion
      removeAdditional: 'all', // Strip extra properties for security
      useDefaults: true,
      validateFormats: true
    });
    
    addFormats(this.ajv);
    this.registerCustomFormats();
    this.registerCustomKeywords();
  }

  /**
   * Load all schemas from filesystem into registry.
   * Called during daemon startup.
   */
  async loadSchemas(): Promise<void> {
    const hookPoints: HookPoint[] = [
      'intake-pre-validate', 'prd-pre-author', 'tdd-pre-author',
      'code-pre-write', 'code-post-write', 'review-pre-score',
      'review-post-score', 'deploy-pre', 'deploy-post', 'rule-evaluation'
    ];

    for (const hookPoint of hookPoints) {
      await this.loadSchemasForHookPoint(hookPoint);
    }
  }

  /**
   * Validate hook output against the appropriate schema.
   * Returns sanitized output with extra fields stripped.
   */
  async validateHookOutput(
    hookPoint: HookPoint,
    version: string,
    output: unknown
  ): Promise<ValidationResult> {
    const startTime = performance.now();
    
    try {
      const validator = await this.getValidator(hookPoint, 'output', version);
      
      // Create deep copy for validation (AJV mutates the object)
      const outputCopy = JSON.parse(JSON.stringify(output));
      
      const isValid = validator(outputCopy);
      const duration = performance.now() - startTime;
      
      this.recordValidationStats(hookPoint, version, isValid, duration);
      
      if (!isValid) {
        return {
          isValid: false,
          sanitizedOutput: null,
          errors: this.formatValidationErrors(validator.errors || []),
          warnings: [],
          validationTime: duration
        };
      }

      return {
        isValid: true,
        sanitizedOutput: outputCopy, // Extra fields already stripped by AJV
        errors: [],
        warnings: this.generateWarnings(output, outputCopy),
        validationTime: duration
      };
      
    } catch (error) {
      const duration = performance.now() - startTime;
      this.recordValidationStats(hookPoint, version, false, duration);
      
      return {
        isValid: false,
        sanitizedOutput: null,
        errors: [`Validation error: ${error.message}`],
        warnings: [],
        validationTime: duration
      };
    }
  }

  /**
   * Validate hook input context (used for development/debugging).
   */
  async validateHookInput(
    hookPoint: HookPoint,
    version: string,
    input: unknown
  ): Promise<ValidationResult> {
    const validator = await this.getValidator(hookPoint, 'input', version);
    const inputCopy = JSON.parse(JSON.stringify(input));
    
    const isValid = validator(inputCopy);
    
    return {
      isValid,
      sanitizedOutput: isValid ? inputCopy : null,
      errors: isValid ? [] : this.formatValidationErrors(validator.errors || []),
      warnings: [],
      validationTime: 0
    };
  }

  /**
   * Get compiled validator function for a hook point and schema type.
   */
  private async getValidator(
    hookPoint: HookPoint,
    schemaType: 'input' | 'output',
    version: string
  ): Promise<ValidateFunction> {
    const cacheKey = `${hookPoint}:${schemaType}:${version}`;
    
    let validator = this.schemaCache.get(cacheKey);
    if (validator) {
      return validator;
    }

    const schema = await this.loadSchema(hookPoint, schemaType, version);
    if (!schema) {
      throw new Error(`Schema not found: ${cacheKey}`);
    }

    validator = this.ajv.compile(schema);
    this.schemaCache.set(cacheKey, validator);
    
    return validator;
  }

  /**
   * Load schema file from filesystem.
   */
  private async loadSchema(
    hookPoint: HookPoint,
    schemaType: 'input' | 'output',
    version: string
  ): Promise<JSONSchema | null> {
    const registryKey = `${hookPoint}:${schemaType}:${version}`;
    
    if (this.schemaRegistry.has(registryKey)) {
      return this.schemaRegistry.get(registryKey)!;
    }

    try {
      const schemaPath = join(
        this.schemaBasePath,
        hookPoint,
        `${schemaType}-${version}.json`
      );
      
      const schemaContent = await fs.readFile(schemaPath, 'utf-8');
      const schema = JSON.parse(schemaContent) as JSONSchema;
      
      // Validate schema itself
      this.validateSchemaStructure(schema, hookPoint, schemaType, version);
      
      this.schemaRegistry.set(registryKey, schema);
      return schema;
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null; // Schema file not found
      }
      throw new Error(`Failed to load schema ${registryKey}: ${error.message}`);
    }
  }

  /**
   * Load all schema versions for a specific hook point.
   */
  private async loadSchemasForHookPoint(hookPoint: HookPoint): Promise<void> {
    const hookPointPath = join(this.schemaBasePath, hookPoint);
    
    try {
      const files = await fs.readdir(hookPointPath);
      const schemaFiles = files.filter(f => f.endsWith('.json'));
      
      for (const file of schemaFiles) {
        const [schemaType, version] = file.replace('.json', '').split('-');
        if (schemaType === 'input' || schemaType === 'output') {
          await this.loadSchema(hookPoint, schemaType as any, version);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`Failed to load schemas for ${hookPoint}: ${error.message}`);
      }
    }
  }

  /**
   * Validate that the schema itself is well-formed.
   */
  private validateSchemaStructure(
    schema: JSONSchema,
    hookPoint: HookPoint,
    schemaType: string,
    version: string
  ): void {
    if (!schema.$schema) {
      throw new Error(`Schema missing $schema field: ${hookPoint}:${schemaType}:${version}`);
    }

    if (!schema.type) {
      throw new Error(`Schema missing type field: ${hookPoint}:${schemaType}:${version}`);
    }

    // Validate required security constraints
    if (schemaType === 'output') {
      if (schema.additionalProperties !== false) {
        console.warn(`Output schema should set additionalProperties: false for security: ${hookPoint}:${version}`);
      }
    }
  }

  /**
   * Format AJV validation errors into readable messages.
   */
  private formatValidationErrors(errors: any[]): string[] {
    return errors.map(error => {
      const path = error.instancePath ? `at path '${error.instancePath}'` : 'at root';
      const message = error.message || 'validation failed';
      
      if (error.keyword === 'additionalProperties') {
        return `Unexpected property '${error.params?.additionalProperty}' ${path}`;
      }
      
      if (error.keyword === 'required') {
        return `Missing required property '${error.params?.missingProperty}' ${path}`;
      }
      
      if (error.keyword === 'type') {
        return `Expected type '${error.schema}' but got '${typeof error.data}' ${path}`;
      }
      
      return `${message} ${path}`;
    });
  }

  /**
   * Generate warnings for fields that were stripped during sanitization.
   */
  private generateWarnings(original: unknown, sanitized: unknown): string[] {
    const warnings: string[] = [];
    
    if (typeof original === 'object' && original !== null && 
        typeof sanitized === 'object' && sanitized !== null) {
      
      const originalKeys = Object.keys(original as any);
      const sanitizedKeys = Object.keys(sanitized as any);
      const removedKeys = originalKeys.filter(key => !sanitizedKeys.includes(key));
      
      if (removedKeys.length > 0) {
        warnings.push(`Removed ${removedKeys.length} extra properties: ${removedKeys.join(', ')}`);
      }
    }
    
    return warnings;
  }

  /**
   * Record validation performance statistics.
   */
  private recordValidationStats(
    hookPoint: HookPoint,
    version: string,
    isValid: boolean,
    duration: number
  ): void {
    const key = `${hookPoint}:${version}`;
    const stats = this.validationStats.get(key) || {
      totalValidations: 0,
      successfulValidations: 0,
      totalDuration: 0,
      maxDuration: 0,
      minDuration: Infinity
    };

    stats.totalValidations++;
    if (isValid) stats.successfulValidations++;
    stats.totalDuration += duration;
    stats.maxDuration = Math.max(stats.maxDuration, duration);
    stats.minDuration = Math.min(stats.minDuration, duration);

    this.validationStats.set(key, stats);
  }

  /**
   * Register custom formats for autonomous-dev specific data types.
   */
  private registerCustomFormats(): void {
    // Request ID format
    this.ajv.addFormat('request-id', {
      type: 'string',
      validate: (value: string) => /^REQ-[A-Z0-9]{8}-[A-Z0-9]{4}$/.test(value)
    });

    // Plugin name format
    this.ajv.addFormat('plugin-name', {
      type: 'string',
      validate: (value: string) => /^[a-z0-9-]+\.[a-z0-9-]+\.[a-z0-9-]+$/.test(value)
    });

    // Semantic version format
    this.ajv.addFormat('semver', {
      type: 'string',
      validate: (value: string) => /^\d+\.\d+\.\d+(-[a-zA-Z0-9-]+)?$/.test(value)
    });

    // File path format (for capability validation)
    this.ajv.addFormat('file-path', {
      type: 'string',
      validate: (value: string) => {
        // Basic path validation - no null bytes, reasonable length
        return !value.includes('\0') && value.length <= 4096;
      }
    });
  }

  /**
   * Register custom keywords for advanced validation.
   */
  private registerCustomKeywords(): void {
    // Custom keyword for validating hook point enum
    this.ajv.addKeyword({
      keyword: 'hookPoint',
      type: 'string',
      validate: function validate(schema: boolean, data: string) {
        if (!schema) return true;
        
        const validHookPoints = [
          'intake-pre-validate', 'prd-pre-author', 'tdd-pre-author',
          'code-pre-write', 'code-post-write', 'review-pre-score',
          'review-post-score', 'deploy-pre', 'deploy-post', 'rule-evaluation'
        ];
        
        return validHookPoints.includes(data);
      }
    });

    // Custom keyword for capability path validation
    this.ajv.addKeyword({
      keyword: 'capabilityPath',
      type: 'string',
      validate: function validate(schema: boolean, data: string) {
        if (!schema) return true;
        
        // Validate filesystem capability paths
        return data.startsWith('/') || data.startsWith('./') &&
               !data.includes('..') &&
               data.length <= 1000;
      }
    });
  }

  /**
   * Get validation statistics for monitoring and debugging.
   */
  getValidationStats(): ValidationStatsReport {
    const report: ValidationStatsReport = {
      totalSchemas: this.schemaRegistry.size,
      cachedValidators: this.schemaCache.size,
      hookPointStats: {}
    };

    for (const [key, stats] of this.validationStats.entries()) {
      const successRate = stats.totalValidations > 0 
        ? stats.successfulValidations / stats.totalValidations 
        : 0;
      
      const avgDuration = stats.totalValidations > 0 
        ? stats.totalDuration / stats.totalValidations 
        : 0;

      report.hookPointStats[key] = {
        totalValidations: stats.totalValidations,
        successRate: Math.round(successRate * 100) / 100,
        avgDurationMs: Math.round(avgDuration * 100) / 100,
        maxDurationMs: Math.round(stats.maxDuration * 100) / 100,
        minDurationMs: stats.minDuration === Infinity ? 0 : Math.round(stats.minDuration * 100) / 100
      };
    }

    return report;
  }

  /**
   * Clear validation cache (useful for testing or after schema updates).
   */
  clearCache(): void {
    this.schemaCache.clear();
    this.validationStats.clear();
  }
}

// Type definitions
interface ValidationResult {
  isValid: boolean;
  sanitizedOutput: unknown | null;
  errors: string[];
  warnings: string[];
  validationTime: number;
}

interface ValidationStats {
  totalValidations: number;
  successfulValidations: number;
  totalDuration: number;
  maxDuration: number;
  minDuration: number;
}

interface ValidationStatsReport {
  totalSchemas: number;
  cachedValidators: number;
  hookPointStats: Record<string, {
    totalValidations: number;
    successRate: number;
    avgDurationMs: number;
    maxDurationMs: number;
    minDurationMs: number;
  }>;
}
```

### 9.2 Schema Version Management

Schema evolution is managed through semantic versioning with backward compatibility guarantees. Each hook point maintains multiple schema versions to support gradual migration of plugins while preventing breaking changes from disrupting existing installations.

**Version Pinning**: Each hook registration specifies an exact output schema version in its manifest. This ensures deterministic validation behavior and prevents unexpected failures when schemas are updated.

**Compatibility Checking**: The validation pipeline can compare schema versions to detect breaking changes and provide migration guidance for plugin developers.

**Default Fallback**: When no specific version is requested, the validation pipeline uses the latest stable version for the hook point, with fallback to v1 for maximum compatibility.

---

## 10. Plugin Trust & Allowlist

The plugin trust system provides operator control over which extensions can execute within the autonomous-dev environment. This multi-layered security model ensures that only explicitly permitted and validated plugins can access system resources or influence pipeline behavior.

### 10.1 Trust Configuration Model

Plugin trust is configured through the `~/.claude/autonomous-dev.json` configuration file with hierarchical allowlists and trust policies:

```json
{
  "extensions": {
    "allowlist": [
      "com.company.security-scanner",
      "com.company.cost-analyzer", 
      "com.company.compliance-checker"
    ],
    "privileged_reviewers": [
      "com.company.security-scanner",
      "com.company.code-quality-checker"
    ],
    "trust_mode": "allowlist",
    "signature_verification": true,
    "auto_update_allowed": false,
    "max_plugins_per_hook_point": 5,
    "global_resource_limits": {
      "max_total_memory_mb": 2048,
      "max_concurrent_executions": 10,
      "max_execution_time_seconds": 300
    }
  }
}
```

**Trust Modes**:
- `allowlist`: Only explicitly listed plugins are permitted (recommended for production)
- `permissive`: All signed plugins from trusted sources are allowed (development environments)
- `strict`: Only plugins with valid signatures and organizational approval are permitted

**Signature Verification**: When enabled, all plugins must have valid cryptographic signatures from trusted signing authorities. Unsigned plugins are rejected with security warnings.

**Privileged Reviewer Allowlist**: Plugins that register reviewer slots for security-review or code-review gates require separate authorization in the `privileged_reviewers` allowlist.

### 10.2 Validation Order and Agent-Meta-Reviewer Integration

Plugin validation follows a strict order during daemon startup and dynamic reload:

1. **Manifest Syntax Validation**: Verify hooks.json conforms to schema and contains no malformed entries
2. **Trust Status Check**: Validate plugin is in the appropriate allowlist for its declared capabilities
3. **Signature Verification**: Check cryptographic signatures against trusted signing keys (if enabled)
4. **Capability Validation**: Ensure declared capabilities are within system limits and security policies
5. **Agent-Meta-Reviewer Audit**: For privileged reviewers, trigger automatic review by the agent-meta-reviewer (PRD-003 FR-32)
6. **Dependency Resolution**: Validate required dependencies are available and compatible
7. **Registration**: Add validated hooks to the in-memory registry

### 10.3 Agent-Meta-Reviewer Trigger Conditions

The agent-meta-reviewer (PRD-003 FR-32) is automatically invoked for plugins that:

- Register reviewer slots for `code-review` or `security-review` gates
- Declare capabilities that include filesystem write access outside `/tmp`
- Request network access to external hosts
- Require privileged environment variables
- Declare `allow_child_processes: true`
- Have hook failure modes set to `block` for critical hook points

The meta-reviewer analyzes the hook implementation code, capability declarations, and potential security risks before approving plugin registration. This provides an additional security layer beyond static validation.

### 10.4 Runtime Trust Enforcement

Trust validation continues during runtime execution:

**Execution-Time Validation**: Each hook execution validates that the plugin remains in good standing with current trust policies. Revoked or blacklisted plugins are immediately prevented from executing.

**Resource Budget Enforcement**: Global resource limits prevent any single plugin or collection of plugins from consuming excessive system resources.

**Audit Trail**: All trust decisions, policy violations, and plugin state changes are logged to the audit system for security monitoring and compliance purposes.

This comprehensive trust model ensures that extensions enhance the autonomous-dev system without compromising security, reliability, or operational control.

---

## 11. Reviewer-Slot Mechanics

The reviewer-slot extension mechanism allows plugins to register custom AI agents that participate in the autonomous-dev review process. These custom reviewers integrate seamlessly with the existing review gate system while maintaining security boundaries and quality guarantees.

### 11.1 Registration Shape and Requirements

Reviewer slots are declared in the plugin's `hooks.json` manifest using a specialized configuration structure:

```json
{
  "id": "security-expert-reviewer",
  "name": "Security Expert Code Reviewer",
  "hook_point": "review-pre-score",
  "entry_point": "lib/security-reviewer.execute",
  "reviewer_slot": {
    "agent_name": "security-expert",
    "review_gates": ["code-review", "security-review"],
    "expertise_domains": ["security", "cryptography", "authentication", "authorization"],
    "minimum_threshold": 80,
    "blocking_on_failure": true,
    "requires_privileged_approval": true,
    "weight": 1.0,
    "metadata": {
      "model": "claude-sonnet",
      "specialization": "security-focused code analysis",
      "training_data_cutoff": "2024-01"
    }
  }
}
```

**Agent Identity**: Each reviewer must declare a unique `agent_name` within the plugin namespace. This name becomes part of the review audit trail and is used for fingerprinting verdicts.

**Gate Authorization**: Reviewers specify which review gates they can participate in. Access to `code-review` and `security-review` requires privileged approval and separate allowlisting.

**Expertise Declaration**: Domains of expertise help the review system select appropriate reviewers for specific types of changes. Common domains include security, performance, accessibility, compliance, and domain-specific technologies.

**Threshold and Blocking Behavior**: Reviewers can set minimum approval thresholds and specify whether their failure should block pipeline progression or generate warnings.

### 11.2 Multi-Reviewer Minimum Enforcement

The review system enforces a critical security policy: **no custom reviewer can be the sole approver** for security-critical review gates. This prevents malicious plugins from automatically approving dangerous changes without oversight.

**Minimum Reviewer Requirements**:
- Code-review gates with custom reviewers must include at least one built-in reviewer
- Security-review gates always require the built-in security-reviewer plus any custom reviewers
- Deployment-review gates require built-in deployment safety checks regardless of custom reviewers
- PRD and TDD review gates may use custom reviewers as primary reviewers with built-in fallbacks

**Implementation**: The review panel assembly service validates reviewer combinations before starting reviews and rejects configurations that rely solely on extension reviewers for critical gates.

### 11.3 Fingerprinting in Verdicts

Every review verdict carries a comprehensive fingerprint that identifies the reviewer and provides audit trail information:

```typescript
interface ReviewVerdict {
  reviewer_fingerprint: {
    reviewer_type: 'built-in' | 'extension';
    reviewer_id: string;
    plugin_name?: string;
    plugin_version?: string;
    agent_name?: string;
    review_timestamp: string;
    execution_environment: {
      hook_point: string;
      execution_id: string;
      resource_usage: ResourceUsage;
    };
  };
  score: number;
  feedback: string;
  confidence_level: number;
  review_criteria_met: string[];
  concerns_raised: string[];
  recommendations: string[];
}
```

**Reviewer Identity**: Built-in reviewers are identified by their system-defined names, while extension reviewers include both plugin identity and agent name for complete traceability.

**Execution Context**: The fingerprint captures the execution environment, resource usage, and timing information to enable forensic analysis of review decisions.

**Audit Integration**: Fingerprints are automatically included in the pipeline audit log, providing a complete record of who participated in each review decision and how they contributed to the outcome.

### 11.4 Plugin Name and Version in Audit Entries

All audit log entries related to extension reviewers include detailed plugin identification:

```typescript
interface ReviewAuditEntry extends PipelineEvent {
  eventType: 'review_completed';
  details: {
    gate_name: string;
    document_id: string;
    overall_score: number;
    approval_status: 'approved' | 'rejected' | 'conditional';
    reviewer_verdicts: ReviewVerdict[];
    extension_reviewers: Array<{
      plugin_name: string;
      plugin_version: string;
      agent_name: string;
      execution_time_ms: number;
      resource_usage: ResourceUsage;
      verdict_summary: {
        score: number;
        blocking_issues: number;
        recommendations: number;
      };
    }>;
    review_duration_ms: number;
    consensus_metrics: {
      agreement_level: number;
      confidence_variance: number;
      outlier_reviewers: string[];
    };
  };
}
```

This comprehensive audit trail enables operators to:
- Track the performance and reliability of specific extension reviewers
- Identify patterns in review outcomes by plugin and version
- Correlate review quality with specific plugin implementations
- Provide accountability for review decisions in compliance environments

The reviewer-slot system thus provides powerful extensibility while maintaining the security, auditability, and reliability requirements of production autonomous-dev deployments.

---

## 12. Sequential Execution within Phases

Hook execution within pipeline phases follows a deterministic sequential model that ensures predictable behavior, enables reliable testing, and provides clear failure semantics. This design balances performance with operational simplicity while maintaining the isolation guarantees required for security.

### 12.1 Priority Ordering and Context Propagation

Hooks registered for the same hook point execute in strict priority order (1-10, lowest number first) with well-defined context propagation rules:

```typescript
/**
 * Sequential executor that orchestrates hook execution within pipeline phases.
 * Provides deterministic ordering, context propagation, and failure handling.
 */
export class SequentialExecutor {
  private readonly hookRegistry: HookRegistry;
  private readonly sandboxExecutor: SandboxExecutor;
  private readonly validationPipeline: ValidationPipeline;
  private readonly auditLogger: HookAuditLogger;
  private readonly executionMetrics = new Map<string, ExecutionMetrics>();

  constructor(
    hookRegistry: HookRegistry,
    sandboxExecutor: SandboxExecutor,
    validationPipeline: ValidationPipeline,
    auditLogger: HookAuditLogger
  ) {
    this.hookRegistry = hookRegistry;
    this.sandboxExecutor = sandboxExecutor;
    this.validationPipeline = validationPipeline;
    this.auditLogger = auditLogger;
  }

  /**
   * Execute all hooks registered for a specific hook point.
   * Maintains strict ordering and handles failures according to hook configurations.
   */
  async executeHooksForPoint(
    hookPoint: HookPoint,
    initialContext: HookContext
  ): Promise<PhaseExecutionResult> {
    const executionId = `${hookPoint}-${Date.now()}-${Math.random()}`;
    const startTime = performance.now();
    
    try {
      // Get and sort hooks by priority
      const hooks = await this.hookRegistry.getHooksForPoint(hookPoint);
      const sortedHooks = this.sortHooksByPriority(hooks);
      
      if (sortedHooks.length === 0) {
        return this.createEmptyResult(hookPoint, executionId, startTime);
      }

      // Initialize execution context
      let currentContext = this.cloneContext(initialContext);
      const hookResults: HookExecutionRecord[] = [];
      let accumulatedOutputs: Record<string, unknown> = {};
      
      // Log phase execution start
      await this.auditLogger.logPhaseExecutionStart(
        executionId,
        hookPoint,
        sortedHooks.map(h => ({ id: h.id, priority: h.priority }))
      );

      // Execute hooks sequentially
      for (const hook of sortedHooks) {
        const hookStartTime = performance.now();
        
        try {
          // Prepare hook-specific context
          const hookContext = this.prepareHookContext(
            currentContext,
            accumulatedOutputs,
            hook
          );

          // Execute hook in sandbox
          const hookResult = await this.sandboxExecutor.executeHook(
            hook.id,
            hook,
            hookContext
          );

          // Validate and sanitize hook output
          const validationResult = await this.validationPipeline.validateHookOutput(
            hookPoint,
            hook.output_schema_version,
            hookResult.payload
          );

          // Handle validation failures (always fail-hard per PRD-011 §19.2)
          if (!validationResult.isValid) {
            const validationError = new HookValidationError(
              hook.id,
              validationResult.errors,
              validationResult.warnings
            );
            return this.handleCriticalFailure(
              hookPoint,
              executionId,
              hook,
              validationError,
              hookResults,
              startTime
            );
          }

          // Process successful hook execution
          const processedResult = this.processHookResult(
            hook,
            hookResult,
            validationResult.sanitizedOutput,
            performance.now() - hookStartTime
          );

          hookResults.push(processedResult);

          // Handle hook failure modes
          if (hookResult.status === 'block') {
            return this.handleBlockingFailure(
              hookPoint,
              executionId,
              hook,
              processedResult,
              hookResults,
              startTime
            );
          }

          // Accumulate outputs for next hooks
          if (validationResult.sanitizedOutput) {
            accumulatedOutputs[hook.id] = validationResult.sanitizedOutput;
          }

          // Update context for next hook
          currentContext = this.updateContextWithHookResult(
            currentContext,
            hook,
            processedResult
          );

          // Log individual hook completion
          await this.auditLogger.logHookExecution(
            executionId,
            hook,
            processedResult,
            validationResult
          );

        } catch (error) {
          const failureRecord = this.createFailureRecord(
            hook,
            error,
            performance.now() - hookStartTime
          );
          
          hookResults.push(failureRecord);

          // Handle failure according to hook configuration
          if (hook.failure_mode === 'block' || error instanceof HookValidationError) {
            return this.handleCriticalFailure(
              hookPoint,
              executionId,
              hook,
              error,
              hookResults,
              startTime
            );
          }

          // Log warning and continue for 'warn' mode
          await this.auditLogger.logHookFailure(
            executionId,
            hook,
            error,
            'warning'
          );
        }
      }

      // Create successful phase result
      const result = this.createSuccessResult(
        hookPoint,
        executionId,
        hookResults,
        accumulatedOutputs,
        startTime
      );

      // Log phase completion
      await this.auditLogger.logPhaseExecutionComplete(
        executionId,
        result
      );

      return result;

    } catch (error) {
      // Handle unexpected phase-level errors
      return this.handlePhaseError(hookPoint, executionId, error, startTime);
    }
  }

  /**
   * Sort hooks by priority with stable ordering for equal priorities.
   */
  private sortHooksByPriority(hooks: HookRegistration[]): HookRegistration[] {
    return hooks.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      // Stable sort: use hook ID for equal priorities
      return a.id.localeCompare(b.id);
    });
  }

  /**
   * Prepare context object for individual hook execution.
   * Includes outputs from previously executed hooks in this phase.
   */
  private prepareHookContext(
    baseContext: HookContext,
    accumulatedOutputs: Record<string, unknown>,
    hook: HookRegistration
  ): HookContext {
    return {
      ...baseContext,
      previous_outputs: { ...accumulatedOutputs },
      configuration: this.loadHookConfiguration(hook),
      execution_metadata: {
        ...baseContext.execution_metadata,
        hook_execution_id: `${hook.id}-${Date.now()}`,
        hook_priority: hook.priority
      }
    };
  }

  /**
   * Process successful hook result and create execution record.
   */
  private processHookResult(
    hook: HookRegistration,
    result: HookResult,
    sanitizedOutput: unknown,
    executionTime: number
  ): HookExecutionRecord {
    return {
      hook_id: hook.id,
      hook_name: hook.name,
      plugin_name: hook.plugin.name,
      plugin_version: hook.plugin.version,
      execution_status: 'success',
      result_status: result.status,
      message: result.message,
      sanitized_output: sanitizedOutput,
      execution_time_ms: executionTime,
      resource_usage: {
        memory_mb: result.memory_usage_mb || 0,
        cpu_ms: result.execution_time_ms || 0
      },
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Update context with hook result for propagation to subsequent hooks.
   */
  private updateContextWithHookResult(
    context: HookContext,
    hook: HookRegistration,
    result: HookExecutionRecord
  ): HookContext {
    return {
      ...context,
      // Add hook result to artifacts if it produces persistent data
      artifacts: this.updateArtifactsFromHook(context.artifacts, hook, result),
      // Update execution metadata
      execution_metadata: {
        ...context.execution_metadata,
        last_successful_hook: hook.id,
        hooks_executed: (context.execution_metadata.hooks_executed || 0) + 1
      }
    };
  }

  /**
   * Handle blocking hook failures that stop phase execution.
   */
  private async handleBlockingFailure(
    hookPoint: HookPoint,
    executionId: string,
    hook: HookRegistration,
    result: HookExecutionRecord,
    previousResults: HookExecutionRecord[],
    startTime: number
  ): Promise<PhaseExecutionResult> {
    const endTime = performance.now();
    
    await this.auditLogger.logPhaseExecutionBlocked(
      executionId,
      hookPoint,
      hook.id,
      result.message || 'Hook returned blocking status'
    );

    return {
      hookPoint,
      executionId,
      status: 'blocked',
      message: `Phase blocked by hook '${hook.name}': ${result.message}`,
      hookResults: [...previousResults, result],
      accumulatedOutputs: this.extractOutputsFromResults(previousResults),
      executionTime: endTime - startTime,
      blockingHook: {
        hookId: hook.id,
        hookName: hook.name,
        reason: result.message || 'Hook returned blocking status'
      }
    };
  }

  /**
   * Handle critical failures including validation errors.
   */
  private async handleCriticalFailure(
    hookPoint: HookPoint,
    executionId: string,
    hook: HookRegistration,
    error: Error,
    previousResults: HookExecutionRecord[],
    startTime: number
  ): Promise<PhaseExecutionResult> {
    const endTime = performance.now();
    
    const failureRecord = this.createFailureRecord(
      hook,
      error,
      endTime - startTime
    );

    await this.auditLogger.logPhaseExecutionFailed(
      executionId,
      hookPoint,
      hook.id,
      error
    );

    return {
      hookPoint,
      executionId,
      status: 'failed',
      message: `Phase failed due to critical error in hook '${hook.name}': ${error.message}`,
      hookResults: [...previousResults, failureRecord],
      accumulatedOutputs: this.extractOutputsFromResults(previousResults),
      executionTime: endTime - startTime,
      criticalError: {
        hookId: hook.id,
        errorType: error.constructor.name,
        errorMessage: error.message,
        isValidationError: error instanceof HookValidationError
      }
    };
  }

  /**
   * Create failure record for hooks that throw exceptions.
   */
  private createFailureRecord(
    hook: HookRegistration,
    error: Error,
    executionTime: number
  ): HookExecutionRecord {
    return {
      hook_id: hook.id,
      hook_name: hook.name,
      plugin_name: hook.plugin.name,
      plugin_version: hook.plugin.version,
      execution_status: 'failed',
      result_status: 'block',
      message: error.message,
      sanitized_output: null,
      execution_time_ms: executionTime,
      resource_usage: { memory_mb: 0, cpu_ms: 0 },
      timestamp: new Date().toISOString(),
      error_details: {
        error_type: error.constructor.name,
        error_message: error.message,
        stack_trace: error.stack?.split('\n').slice(0, 10).join('\n')
      }
    };
  }

  /**
   * Create successful phase result.
   */
  private createSuccessResult(
    hookPoint: HookPoint,
    executionId: string,
    hookResults: HookExecutionRecord[],
    accumulatedOutputs: Record<string, unknown>,
    startTime: number
  ): PhaseExecutionResult {
    const endTime = performance.now();
    const hasWarnings = hookResults.some(r => r.result_status === 'warn');
    
    return {
      hookPoint,
      executionId,
      status: hasWarnings ? 'success-with-warnings' : 'success',
      message: `Phase completed successfully with ${hookResults.length} hooks`,
      hookResults,
      accumulatedOutputs,
      executionTime: endTime - startTime,
      summary: {
        totalHooks: hookResults.length,
        successfulHooks: hookResults.filter(r => r.execution_status === 'success').length,
        failedHooks: hookResults.filter(r => r.execution_status === 'failed').length,
        warningHooks: hookResults.filter(r => r.result_status === 'warn').length,
        totalExecutionTime: hookResults.reduce((sum, r) => sum + r.execution_time_ms, 0),
        maxExecutionTime: Math.max(...hookResults.map(r => r.execution_time_ms)),
        avgExecutionTime: hookResults.length > 0 
          ? hookResults.reduce((sum, r) => sum + r.execution_time_ms, 0) / hookResults.length 
          : 0
      }
    };
  }

  /**
   * Create empty result for hook points with no registered hooks.
   */
  private createEmptyResult(
    hookPoint: HookPoint,
    executionId: string,
    startTime: number
  ): PhaseExecutionResult {
    return {
      hookPoint,
      executionId,
      status: 'success',
      message: 'No hooks registered for this hook point',
      hookResults: [],
      accumulatedOutputs: {},
      executionTime: performance.now() - startTime
    };
  }

  /**
   * Load hook-specific configuration from plugin manifest.
   */
  private loadHookConfiguration(hook: HookRegistration): Record<string, unknown> {
    // Implementation would load configuration from plugin's hooks.json
    // and merge with any runtime configuration overrides
    return {};
  }

  /**
   * Update artifacts with hook results if applicable.
   */
  private updateArtifactsFromHook(
    artifacts: Record<string, ArtifactRef>,
    hook: HookRegistration,
    result: HookExecutionRecord
  ): Record<string, ArtifactRef> {
    // Implementation would check if hook produces artifacts
    // and add them to the artifacts collection
    return artifacts;
  }

  /**
   * Extract accumulated outputs from execution results.
   */
  private extractOutputsFromResults(
    results: HookExecutionRecord[]
  ): Record<string, unknown> {
    const outputs: Record<string, unknown> = {};
    for (const result of results) {
      if (result.sanitized_output !== null) {
        outputs[result.hook_id] = result.sanitized_output;
      }
    }
    return outputs;
  }

  /**
   * Handle unexpected phase-level errors.
   */
  private async handlePhaseError(
    hookPoint: HookPoint,
    executionId: string,
    error: Error,
    startTime: number
  ): Promise<PhaseExecutionResult> {
    await this.auditLogger.logPhaseExecutionError(
      executionId,
      hookPoint,
      error
    );

    return {
      hookPoint,
      executionId,
      status: 'error',
      message: `Phase execution failed: ${error.message}`,
      hookResults: [],
      accumulatedOutputs: {},
      executionTime: performance.now() - startTime,
      systemError: {
        errorType: error.constructor.name,
        errorMessage: error.message
      }
    };
  }

  /**
   * Deep clone context to prevent mutations between hooks.
   */
  private cloneContext(context: HookContext): HookContext {
    return JSON.parse(JSON.stringify(context));
  }
}

// Type definitions for sequential execution
interface PhaseExecutionResult {
  hookPoint: HookPoint;
  executionId: string;
  status: 'success' | 'success-with-warnings' | 'blocked' | 'failed' | 'error';
  message: string;
  hookResults: HookExecutionRecord[];
  accumulatedOutputs: Record<string, unknown>;
  executionTime: number;
  blockingHook?: {
    hookId: string;
    hookName: string;
    reason: string;
  };
  criticalError?: {
    hookId: string;
    errorType: string;
    errorMessage: string;
    isValidationError: boolean;
  };
  systemError?: {
    errorType: string;
    errorMessage: string;
  };
  summary?: {
    totalHooks: number;
    successfulHooks: number;
    failedHooks: number;
    warningHooks: number;
    totalExecutionTime: number;
    maxExecutionTime: number;
    avgExecutionTime: number;
  };
}

interface HookExecutionRecord {
  hook_id: string;
  hook_name: string;
  plugin_name: string;
  plugin_version: string;
  execution_status: 'success' | 'failed';
  result_status: 'ok' | 'warn' | 'block';
  message?: string;
  sanitized_output: unknown;
  execution_time_ms: number;
  resource_usage: {
    memory_mb: number;
    cpu_ms: number;
  };
  timestamp: string;
  error_details?: {
    error_type: string;
    error_message: string;
    stack_trace?: string;
  };
}

interface ExecutionMetrics {
  totalExecutions: number;
  averageExecutionTime: number;
  successRate: number;
  lastExecution: string;
}

/**
 * Custom error for hook validation failures.
 */
class HookValidationError extends Error {
  constructor(
    public readonly hookId: string,
    public readonly validationErrors: string[],
    public readonly validationWarnings: string[]
  ) {
    super(`Hook output validation failed: ${validationErrors.join(', ')}`);
    this.name = 'HookValidationError';
  }
}
```

This sequential execution model ensures predictable hook behavior while providing comprehensive error handling and audit capabilities. The deterministic ordering and context propagation enable reliable testing and debugging of hook interactions.

---

## 13. Discovery & Reload

The plugin discovery system provides automated detection and loading of hook manifests from the autonomous-dev plugin ecosystem. This system supports both startup-time scanning for initial registration and dynamic reload capabilities for operational flexibility without daemon restart.

### 13.1 Startup Scan Implementation

```typescript
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { EventEmitter } from 'events';

/**
 * Plugin discovery service that scans for hooks.json manifests
 * and manages the plugin registration lifecycle.
 */
export class PluginDiscovery extends EventEmitter {
  private readonly pluginBasePath: string;
  private readonly registeredPlugins = new Map<string, PluginRegistration>();
  private readonly watchedDirectories = new Set<string>();
  private isInitialized = false;

  constructor(
    private readonly hookRegistry: HookRegistry,
    private readonly trustValidator: PluginTrustValidator,
    pluginBasePath?: string
  ) {
    super();
    this.pluginBasePath = pluginBasePath || join(homedir(), '.claude', 'plugins');
    this.setupSignalHandlers();
  }

  /**
   * Perform initial scan of all plugin directories during daemon startup.
   * This is a comprehensive scan that loads and validates all available plugins.
   */
  async performStartupScan(): Promise<DiscoveryResult> {
    if (this.isInitialized) {
      throw new Error('Plugin discovery already initialized');
    }

    const startTime = performance.now();
    const result: DiscoveryResult = {
      totalPluginsScanned: 0,
      successfulRegistrations: 0,
      failedRegistrations: 0,
      pluginResults: [],
      scanDuration: 0,
      errors: []
    };

    try {
      // Ensure plugin base directory exists
      await this.ensurePluginDirectory();

      // Scan all plugin directories
      const pluginDirs = await this.discoverPluginDirectories();
      result.totalPluginsScanned = pluginDirs.length;

      // Process each plugin directory
      for (const pluginDir of pluginDirs) {
        try {
          const pluginResult = await this.processPluginDirectory(pluginDir);
          result.pluginResults.push(pluginResult);
          
          if (pluginResult.status === 'success') {
            result.successfulRegistrations++;
          } else {
            result.failedRegistrations++;
          }
        } catch (error) {
          const pluginResult: PluginRegistrationResult = {
            pluginPath: pluginDir,
            pluginName: 'unknown',
            status: 'failed',
            error: error.message,
            registeredHooks: [],
            processingTime: 0
          };
          
          result.pluginResults.push(pluginResult);
          result.failedRegistrations++;
          result.errors.push(`Failed to process ${pluginDir}: ${error.message}`);
        }
      }

      result.scanDuration = performance.now() - startTime;
      this.isInitialized = true;

      this.emit('startup-scan-complete', result);
      return result;

    } catch (error) {
      result.scanDuration = performance.now() - startTime;
      result.errors.push(`Startup scan failed: ${error.message}`);
      this.emit('startup-scan-failed', error);
      throw error;
    }
  }

  /**
   * Reload plugins in response to SIGUSR1 or manual request.
   * Performs incremental scan to detect changes since last scan.
   */
  async reloadPlugins(): Promise<ReloadResult> {
    if (!this.isInitialized) {
      throw new Error('Plugin discovery not initialized - run startup scan first');
    }

    const startTime = performance.now();
    const result: ReloadResult = {
      addedPlugins: [],
      updatedPlugins: [],
      removedPlugins: [],
      failedPlugins: [],
      reloadDuration: 0,
      errors: []
    };

    try {
      // Discover current plugin state
      const currentPluginDirs = await this.discoverPluginDirectories();
      const currentPluginSet = new Set(currentPluginDirs);
      
      // Identify changes since last scan
      const previousPluginSet = new Set(this.registeredPlugins.keys());
      
      // Find new plugins
      const newPlugins = currentPluginDirs.filter(dir => !previousPluginSet.has(dir));
      
      // Find removed plugins
      const removedPlugins = Array.from(previousPluginSet).filter(dir => !currentPluginSet.has(dir));
      
      // Find potentially updated plugins
      const existingPlugins = currentPluginDirs.filter(dir => previousPluginSet.has(dir));

      // Process removed plugins
      for (const pluginDir of removedPlugins) {
        await this.unregisterPlugin(pluginDir);
        result.removedPlugins.push(pluginDir);
      }

      // Process new plugins
      for (const pluginDir of newPlugins) {
        try {
          const pluginResult = await this.processPluginDirectory(pluginDir);
          if (pluginResult.status === 'success') {
            result.addedPlugins.push(pluginResult);
          } else {
            result.failedPlugins.push(pluginResult);
          }
        } catch (error) {
          result.errors.push(`Failed to add plugin ${pluginDir}: ${error.message}`);
        }
      }

      // Check existing plugins for updates
      for (const pluginDir of existingPlugins) {
        try {
          const updateResult = await this.checkForPluginUpdate(pluginDir);
          if (updateResult.wasUpdated) {
            result.updatedPlugins.push(updateResult.registrationResult!);
          }
        } catch (error) {
          result.errors.push(`Failed to update plugin ${pluginDir}: ${error.message}`);
        }
      }

      result.reloadDuration = performance.now() - startTime;
      this.emit('reload-complete', result);
      
      return result;

    } catch (error) {
      result.reloadDuration = performance.now() - startTime;
      result.errors.push(`Reload failed: ${error.message}`);
      this.emit('reload-failed', error);
      throw error;
    }
  }

  /**
   * Discover all plugin directories under the base path.
   */
  private async discoverPluginDirectories(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.pluginBasePath, { withFileTypes: true });
      const pluginDirs: string[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const pluginPath = join(this.pluginBasePath, entry.name);
          const manifestPath = join(pluginPath, 'hooks.json');
          
          try {
            await fs.access(manifestPath);
            pluginDirs.push(pluginPath);
          } catch {
            // No hooks.json file, skip this directory
          }
        }
      }

      return pluginDirs.sort(); // Consistent ordering
    } catch (error) {
      if (error.code === 'ENOENT') {
        return []; // Plugin directory doesn't exist
      }
      throw error;
    }
  }

  /**
   * Process a single plugin directory and register its hooks.
   */
  private async processPluginDirectory(pluginDir: string): Promise<PluginRegistrationResult> {
    const startTime = performance.now();
    const manifestPath = join(pluginDir, 'hooks.json');
    
    try {
      // Load and parse manifest
      const manifestContent = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent) as PluginManifest;

      // Validate manifest structure
      await this.validateManifest(manifest, pluginDir);

      // Check plugin trust status
      await this.trustValidator.validatePlugin(manifest);

      // Process hooks from manifest
      const registeredHooks: string[] = [];
      const registrationErrors: string[] = [];

      for (const hookDef of manifest.hooks) {
        try {
          const hookRegistration = this.createHookRegistration(hookDef, manifest);
          await this.hookRegistry.registerHook(hookRegistration);
          registeredHooks.push(hookDef.id);
        } catch (error) {
          registrationErrors.push(`Hook ${hookDef.id}: ${error.message}`);
        }
      }

      // Store plugin registration
      const pluginRegistration: PluginRegistration = {
        manifest,
        pluginDir,
        registeredHooks,
        registrationTime: new Date().toISOString(),
        lastManifestModified: await this.getManifestModificationTime(manifestPath)
      };

      this.registeredPlugins.set(pluginDir, pluginRegistration);

      // Determine result status
      const status = registrationErrors.length === 0 ? 'success' : 
                   registeredHooks.length > 0 ? 'partial' : 'failed';

      return {
        pluginPath: pluginDir,
        pluginName: manifest.plugin.name,
        status,
        registeredHooks,
        errors: registrationErrors,
        processingTime: performance.now() - startTime
      };

    } catch (error) {
      return {
        pluginPath: pluginDir,
        pluginName: 'unknown',
        status: 'failed',
        error: error.message,
        registeredHooks: [],
        processingTime: performance.now() - startTime
      };
    }
  }

  /**
   * Check if a plugin has been updated since last registration.
   */
  private async checkForPluginUpdate(pluginDir: string): Promise<UpdateCheckResult> {
    const previousRegistration = this.registeredPlugins.get(pluginDir);
    if (!previousRegistration) {
      throw new Error(`No previous registration found for ${pluginDir}`);
    }

    const manifestPath = join(pluginDir, 'hooks.json');
    const currentModificationTime = await this.getManifestModificationTime(manifestPath);

    // Check if manifest file has been modified
    if (currentModificationTime <= previousRegistration.lastManifestModified) {
      return { wasUpdated: false };
    }

    // Manifest was updated - unregister old hooks and register new ones
    await this.unregisterPlugin(pluginDir);
    const registrationResult = await this.processPluginDirectory(pluginDir);

    return {
      wasUpdated: true,
      registrationResult
    };
  }

  /**
   * Unregister all hooks from a plugin.
   */
  private async unregisterPlugin(pluginDir: string): Promise<void> {
    const registration = this.registeredPlugins.get(pluginDir);
    if (!registration) {
      return; // Plugin not registered
    }

    // Unregister all hooks
    for (const hookId of registration.registeredHooks) {
      try {
        await this.hookRegistry.unregisterHook(hookId);
      } catch (error) {
        console.warn(`Failed to unregister hook ${hookId}: ${error.message}`);
      }
    }

    this.registeredPlugins.delete(pluginDir);
    this.emit('plugin-unregistered', registration.manifest.plugin.name);
  }

  /**
   * Create hook registration object from manifest definition.
   */
  private createHookRegistration(
    hookDef: HookDefinition,
    manifest: PluginManifest
  ): HookRegistration {
    return {
      id: `${manifest.plugin.name}:${hookDef.id}`,
      name: hookDef.name,
      hook_point: hookDef.hook_point,
      entry_point: hookDef.entry_point,
      plugin: {
        name: manifest.plugin.name,
        version: manifest.plugin.version
      },
      priority: hookDef.priority || 5,
      timeout_seconds: hookDef.timeout_seconds || 30,
      failure_mode: hookDef.failure_mode || 'warn',
      capabilities: this.normalizeCapabilities(hookDef.capabilities),
      description: hookDef.description,
      config_schema: hookDef.config_schema,
      output_schema_version: hookDef.output_schema_version || 'v1'
    };
  }

  /**
   * Normalize and validate capability declarations.
   */
  private normalizeCapabilities(capabilities: any): HookCapabilities {
    return {
      fs_read: capabilities.fs_read || [],
      fs_write: capabilities.fs_write || [],
      network: capabilities.network || [],
      env_vars: capabilities.env_vars || [],
      max_memory_mb: capabilities.max_memory_mb || 256,
      max_cpu_seconds: capabilities.max_cpu_seconds || 30,
      allow_child_processes: capabilities.allow_child_processes || false,
      temp_dir_access: capabilities.temp_dir_access !== false
    };
  }

  /**
   * Validate manifest structure and content.
   */
  private async validateManifest(manifest: PluginManifest, pluginDir: string): Promise<void> {
    if (!manifest.manifest_version || manifest.manifest_version !== '1.0') {
      throw new Error('Invalid or unsupported manifest version');
    }

    if (!manifest.plugin || !manifest.plugin.name || !manifest.plugin.version) {
      throw new Error('Invalid plugin metadata');
    }

    if (!manifest.hooks || !Array.isArray(manifest.hooks) || manifest.hooks.length === 0) {
      throw new Error('No hooks defined in manifest');
    }

    // Validate hook definitions
    for (const hook of manifest.hooks) {
      if (!hook.id || !hook.name || !hook.hook_point || !hook.entry_point) {
        throw new Error(`Invalid hook definition: ${hook.id || 'unnamed'}`);
      }
    }

    // Validate entry points exist
    for (const hook of manifest.hooks) {
      const entryPath = join(pluginDir, hook.entry_point.replace(/\./g, '/') + '.js');
      try {
        await fs.access(entryPath);
      } catch {
        throw new Error(`Hook entry point not found: ${hook.entry_point}`);
      }
    }
  }

  /**
   * Get manifest file modification time.
   */
  private async getManifestModificationTime(manifestPath: string): Promise<number> {
    const stats = await fs.stat(manifestPath);
    return stats.mtime.getTime();
  }

  /**
   * Ensure plugin base directory exists.
   */
  private async ensurePluginDirectory(): Promise<void> {
    try {
      await fs.access(this.pluginBasePath);
    } catch {
      await fs.mkdir(this.pluginBasePath, { recursive: true });
    }
  }

  /**
   * Setup signal handlers for reload functionality.
   */
  private setupSignalHandlers(): void {
    process.on('SIGUSR1', async () => {
      try {
        console.log('Received SIGUSR1 - reloading plugins');
        const result = await this.reloadPlugins();
        console.log(`Plugin reload completed: ${result.addedPlugins.length} added, ${result.updatedPlugins.length} updated, ${result.removedPlugins.length} removed`);
      } catch (error) {
        console.error(`Plugin reload failed: ${error.message}`);
      }
    });
  }

  /**
   * Get current plugin registration status.
   */
  getRegistrationSummary(): RegistrationSummary {
    const registrations = Array.from(this.registeredPlugins.values());
    
    return {
      totalPlugins: registrations.length,
      totalHooks: registrations.reduce((sum, reg) => sum + reg.registeredHooks.length, 0),
      pluginsByStatus: this.groupPluginsByStatus(registrations),
      lastScanTime: this.isInitialized ? new Date().toISOString() : null
    };
  }

  /**
   * Group plugins by their current status.
   */
  private groupPluginsByStatus(registrations: PluginRegistration[]): Record<string, number> {
    return registrations.reduce((groups, reg) => {
      const status = reg.registeredHooks.length > 0 ? 'active' : 'inactive';
      groups[status] = (groups[status] || 0) + 1;
      return groups;
    }, {} as Record<string, number>);
  }
}

// Type definitions for discovery system
interface DiscoveryResult {
  totalPluginsScanned: number;
  successfulRegistrations: number;
  failedRegistrations: number;
  pluginResults: PluginRegistrationResult[];
  scanDuration: number;
  errors: string[];
}

interface ReloadResult {
  addedPlugins: PluginRegistrationResult[];
  updatedPlugins: PluginRegistrationResult[];
  removedPlugins: string[];
  failedPlugins: PluginRegistrationResult[];
  reloadDuration: number;
  errors: string[];
}

interface PluginRegistrationResult {
  pluginPath: string;
  pluginName: string;
  status: 'success' | 'partial' | 'failed';
  registeredHooks: string[];
  errors?: string[];
  error?: string;
  processingTime: number;
}

interface UpdateCheckResult {
  wasUpdated: boolean;
  registrationResult?: PluginRegistrationResult;
}

interface PluginRegistration {
  manifest: PluginManifest;
  pluginDir: string;
  registeredHooks: string[];
  registrationTime: string;
  lastManifestModified: number;
}

interface RegistrationSummary {
  totalPlugins: number;
  totalHooks: number;
  pluginsByStatus: Record<string, number>;
  lastScanTime: string | null;
}

interface PluginManifest {
  manifest_version: string;
  plugin: {
    name: string;
    version: string;
    display_name: string;
    description: string;
  };
  hooks: HookDefinition[];
  [key: string]: unknown;
}

interface HookDefinition {
  id: string;
  name: string;
  hook_point: HookPoint;
  entry_point: string;
  priority?: number;
  timeout_seconds?: number;
  failure_mode?: 'warn' | 'block';
  capabilities: any;
  description: string;
  config_schema?: any;
  output_schema_version?: string;
}
```

### 13.2 SIGUSR1 Reload Semantics

The reload mechanism provides zero-downtime plugin updates through signal-based triggering. When the daemon receives SIGUSR1, it performs an incremental scan to detect plugin changes without disrupting active request processing.

**Idempotent Re-registration**: The reload process safely handles plugins that haven't changed by comparing manifest modification times. Only updated plugins are unregistered and re-registered.

**Failure Isolation**: Plugin registration failures during reload don't affect successfully registered plugins or the daemon's operation. Failed plugins are logged and reported but don't block other plugins from loading.

**Atomic Operations**: Each plugin's registration is atomic - either all hooks from a plugin are registered successfully, or none are. This prevents partial registration states that could cause undefined behavior.

This discovery and reload system provides operational flexibility while maintaining the security and reliability guarantees required for production autonomous-dev deployments.

---

## 14. Audit Log

The Hook Audit Logger provides comprehensive observability and security monitoring for all extension activities within the autonomous-dev pipeline. This system maintains tamper-evident records of hook executions, integrates with the existing pipeline audit infrastructure, and enables forensic analysis of extension behavior.

```typescript
import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';

/**
 * Audit logger specifically for hook execution events.
 * Integrates with the main pipeline audit system and provides
 * extension-specific logging capabilities.
 */
export class HookAuditLogger {
  private readonly auditLogPath: string;
  private lastHashCache: string | null = null;
  private readonly hmacKey: Buffer | null = null;

  constructor(
    private readonly pipelineAuditLogger: AuditLogger,
    auditBasePath: string,
    hmacSecret?: string
  ) {
    this.auditLogPath = join(auditBasePath, 'hook-audit.jsonl');
    if (hmacSecret) {
      this.hmacKey = Buffer.from(hmacSecret, 'hex');
    }
  }

  /**
   * Log the start of a phase execution with hook information.
   */
  async logPhaseExecutionStart(
    executionId: string,
    hookPoint: HookPoint,
    hooksToExecute: Array<{ id: string; priority: number }>
  ): Promise<void> {
    const event: HookAuditEvent = {
      event_type: 'phase_execution_start',
      execution_id: executionId,
      hook_point: hookPoint,
      timestamp: new Date().toISOString(),
      details: {
        hooks_scheduled: hooksToExecute,
        total_hooks: hooksToExecute.length
      }
    };

    await this.appendAuditEvent(event);
    
    // Also log to main pipeline audit
    await this.pipelineAuditLogger.appendEvent(
      executionId.split('-')[0], // Extract pipeline ID
      'hook_phase_start',
      {
        hook_point: hookPoint,
        scheduled_hooks: hooksToExecute.length
      },
      'hook-system'
    );
  }

  /**
   * Log individual hook execution with detailed metrics.
   */
  async logHookExecution(
    executionId: string,
    hook: HookRegistration,
    result: HookExecutionRecord,
    validation: ValidationResult
  ): Promise<void> {
    const event: HookAuditEvent = {
      event_type: 'hook_execution',
      execution_id: executionId,
      hook_point: hook.hook_point,
      timestamp: new Date().toISOString(),
      hook_identity: {
        hook_id: hook.id,
        plugin_name: hook.plugin.name,
        plugin_version: hook.plugin.version,
        hook_name: hook.name
      },
      execution_metrics: {
        execution_time_ms: result.execution_time_ms,
        memory_usage_mb: result.resource_usage.memory_mb,
        cpu_time_ms: result.resource_usage.cpu_ms,
        result_status: result.result_status,
        execution_status: result.execution_status
      },
      validation_info: {
        validation_passed: validation.isValid,
        validation_time_ms: validation.validationTime,
        validation_errors: validation.errors,
        validation_warnings: validation.warnings,
        fields_stripped: validation.warnings.filter(w => w.includes('Removed')).length > 0
      },
      details: {
        message: result.message,
        output_fingerprint: this.createOutputFingerprint(result.sanitized_output),
        capabilities_used: this.extractUsedCapabilities(hook, result),
        failure_mode: hook.failure_mode,
        priority: hook.priority
      }
    };

    await this.appendAuditEvent(event);

    // Log to main pipeline audit with summary
    await this.pipelineAuditLogger.appendEvent(
      executionId.split('-')[0],
      'hook_executed',
      {
        hook_id: hook.id,
        plugin: `${hook.plugin.name}@${hook.plugin.version}`,
        status: result.result_status,
        execution_time: result.execution_time_ms
      },
      `plugin:${hook.plugin.name}`
    );
  }

  /**
   * Log hook execution failures with error details.
   */
  async logHookFailure(
    executionId: string,
    hook: HookRegistration,
    error: Error,
    severity: 'warning' | 'error'
  ): Promise<void> {
    const event: HookAuditEvent = {
      event_type: 'hook_failure',
      execution_id: executionId,
      hook_point: hook.hook_point,
      timestamp: new Date().toISOString(),
      hook_identity: {
        hook_id: hook.id,
        plugin_name: hook.plugin.name,
        plugin_version: hook.plugin.version,
        hook_name: hook.name
      },
      failure_info: {
        error_type: error.constructor.name,
        error_message: error.message,
        stack_trace: error.stack?.split('\n').slice(0, 10).join('\n'),
        severity,
        failure_mode: hook.failure_mode,
        is_validation_error: error instanceof HookValidationError
      },
      details: {
        timeout_seconds: hook.timeout_seconds,
        capabilities: hook.capabilities
      }
    };

    await this.appendAuditEvent(event);

    // Log to main pipeline audit
    await this.pipelineAuditLogger.appendEvent(
      executionId.split('-')[0],
      'hook_failed',
      {
        hook_id: hook.id,
        error_type: error.constructor.name,
        severity
      },
      `plugin:${hook.plugin.name}`
    );
  }

  /**
   * Log completion of phase execution.
   */
  async logPhaseExecutionComplete(
    executionId: string,
    result: PhaseExecutionResult
  ): Promise<void> {
    const event: HookAuditEvent = {
      event_type: 'phase_execution_complete',
      execution_id: executionId,
      hook_point: result.hookPoint,
      timestamp: new Date().toISOString(),
      phase_summary: {
        status: result.status,
        total_hooks: result.hookResults.length,
        successful_hooks: result.hookResults.filter(h => h.execution_status === 'success').length,
        failed_hooks: result.hookResults.filter(h => h.execution_status === 'failed').length,
        warning_hooks: result.hookResults.filter(h => h.result_status === 'warn').length,
        blocked_by_hook: result.blockingHook?.hookId,
        total_execution_time_ms: result.executionTime,
        average_hook_time_ms: result.summary?.avgExecutionTime || 0
      },
      details: {
        message: result.message,
        accumulated_outputs_count: Object.keys(result.accumulatedOutputs).length,
        hook_execution_order: result.hookResults.map(h => ({
          hook_id: h.hook_id,
          plugin: h.plugin_name,
          execution_time: h.execution_time_ms,
          status: h.result_status
        }))
      }
    };

    await this.appendAuditEvent(event);

    // Log to main pipeline audit
    await this.pipelineAuditLogger.appendEvent(
      executionId.split('-')[0],
      'hook_phase_complete',
      {
        hook_point: result.hookPoint,
        status: result.status,
        hooks_executed: result.hookResults.length,
        total_time: result.executionTime
      },
      'hook-system'
    );
  }

  /**
   * Log phase execution blocked by a hook.
   */
  async logPhaseExecutionBlocked(
    executionId: string,
    hookPoint: HookPoint,
    blockingHookId: string,
    reason: string
  ): Promise<void> {
    const event: HookAuditEvent = {
      event_type: 'phase_execution_blocked',
      execution_id: executionId,
      hook_point: hookPoint,
      timestamp: new Date().toISOString(),
      blocking_info: {
        blocking_hook_id: blockingHookId,
        reason,
        impact: 'pipeline_halted'
      },
      details: {
        message: `Phase execution blocked by hook: ${blockingHookId}`,
        reason
      }
    };

    await this.appendAuditEvent(event);

    // Log to main pipeline audit as critical event
    await this.pipelineAuditLogger.appendEvent(
      executionId.split('-')[0],
      'pipeline_blocked_by_hook',
      {
        hook_point: hookPoint,
        blocking_hook: blockingHookId,
        reason
      },
      'hook-system'
    );
  }

  /**
   * Log phase execution failure.
   */
  async logPhaseExecutionFailed(
    executionId: string,
    hookPoint: HookPoint,
    failingHookId: string,
    error: Error
  ): Promise<void> {
    const event: HookAuditEvent = {
      event_type: 'phase_execution_failed',
      execution_id: executionId,
      hook_point: hookPoint,
      timestamp: new Date().toISOString(),
      failure_info: {
        error_type: error.constructor.name,
        error_message: error.message,
        failing_hook_id: failingHookId,
        severity: 'error',
        is_validation_error: error instanceof HookValidationError
      },
      details: {
        stack_trace: error.stack?.split('\n').slice(0, 10).join('\n')
      }
    };

    await this.appendAuditEvent(event);
  }

  /**
   * Log system-level phase errors.
   */
  async logPhaseExecutionError(
    executionId: string,
    hookPoint: HookPoint,
    error: Error
  ): Promise<void> {
    const event: HookAuditEvent = {
      event_type: 'phase_execution_error',
      execution_id: executionId,
      hook_point: hookPoint,
      timestamp: new Date().toISOString(),
      system_error: {
        error_type: error.constructor.name,
        error_message: error.message,
        stack_trace: error.stack?.split('\n').slice(0, 15).join('\n')
      },
      details: {
        message: `System error during phase execution: ${error.message}`
      }
    };

    await this.appendAuditEvent(event);
  }

  /**
   * Log plugin registration/unregistration events.
   */
  async logPluginRegistration(
    pluginName: string,
    pluginVersion: string,
    action: 'registered' | 'unregistered' | 'updated',
    hookIds: string[],
    trustLevel?: string
  ): Promise<void> {
    const event: HookAuditEvent = {
      event_type: 'plugin_registration',
      execution_id: `plugin-${action}-${Date.now()}`,
      hook_point: 'system' as any,
      timestamp: new Date().toISOString(),
      plugin_info: {
        plugin_name: pluginName,
        plugin_version: pluginVersion,
        action,
        hooks_affected: hookIds,
        trust_level: trustLevel
      },
      details: {
        message: `Plugin ${pluginName}@${pluginVersion} ${action}`,
        hook_count: hookIds.length
      }
    };

    await this.appendAuditEvent(event);
  }

  /**
   * Append audit event to the hook-specific audit log with hash chain integrity.
   */
  private async appendAuditEvent(event: HookAuditEvent): Promise<void> {
    // Get previous hash for chain integrity
    if (this.lastHashCache === null) {
      this.lastHashCache = await this.getLastHash();
    }

    // Add chain integrity fields
    const chainedEvent: ChainedHookAuditEvent = {
      ...event,
      event_id: crypto.randomUUID(),
      previous_hash: this.lastHashCache,
      hmac: null // Will be calculated after serialization
    };

    // Serialize event
    const serializedEvent = JSON.stringify(chainedEvent);

    // Calculate HMAC if key is available (PRD-009 §22.3 integration)
    if (this.hmacKey) {
      const hmac = crypto.createHmac('sha256', this.hmacKey);
      hmac.update(serializedEvent);
      chainedEvent.hmac = hmac.digest('hex');
    }

    // Write to audit log
    const finalSerialized = JSON.stringify(chainedEvent);
    await fs.appendFile(this.auditLogPath, finalSerialized + '\n', 'utf-8');

    // Update hash cache
    this.lastHashCache = crypto.createHash('sha256').update(finalSerialized).digest('hex');
  }

  /**
   * Get the hash of the last audit entry for chain integrity.
   */
  private async getLastHash(): Promise<string> {
    try {
      const content = await fs.readFile(this.auditLogPath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.length > 0);
      
      if (lines.length === 0) {
        return crypto.createHash('sha256').update('').digest('hex');
      }

      const lastLine = lines[lines.length - 1];
      return crypto.createHash('sha256').update(lastLine).digest('hex');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return crypto.createHash('sha256').update('').digest('hex');
      }
      throw error;
    }
  }

  /**
   * Create fingerprint of hook output for audit purposes.
   */
  private createOutputFingerprint(output: unknown): string {
    if (output === null || output === undefined) {
      return 'null';
    }

    const serialized = JSON.stringify(output, null, 0);
    const hash = crypto.createHash('sha256').update(serialized).digest('hex');
    return `${hash.substring(0, 16)}:${serialized.length}`;
  }

  /**
   * Extract which capabilities were actually used during hook execution.
   */
  private extractUsedCapabilities(
    hook: HookRegistration, 
    result: HookExecutionRecord
  ): string[] {
    // This would be populated by the sandbox executor based on
    // actual resource access during execution
    const used: string[] = [];
    
    // Basic inference based on execution
    if (result.execution_time_ms > 100) {
      used.push('cpu_time');
    }
    
    if (result.resource_usage.memory_mb > 50) {
      used.push('memory');
    }

    // Would include actual fs_read, fs_write, network access logged by sandbox
    return used;
  }

  /**
   * Read hook audit events for analysis.
   */
  async readHookAuditEvents(
    filters?: {
      hookPoint?: HookPoint;
      pluginName?: string;
      eventType?: string;
      since?: Date;
      limit?: number;
    }
  ): Promise<HookAuditEvent[]> {
    try {
      const content = await fs.readFile(this.auditLogPath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.length > 0);
      
      let events = lines.map(line => JSON.parse(line) as ChainedHookAuditEvent);

      // Apply filters
      if (filters) {
        if (filters.hookPoint) {
          events = events.filter(e => e.hook_point === filters.hookPoint);
        }
        
        if (filters.pluginName) {
          events = events.filter(e => 
            e.hook_identity?.plugin_name === filters.pluginName ||
            e.plugin_info?.plugin_name === filters.pluginName
          );
        }
        
        if (filters.eventType) {
          events = events.filter(e => e.event_type === filters.eventType);
        }
        
        if (filters.since) {
          const sinceTime = filters.since.getTime();
          events = events.filter(e => new Date(e.timestamp).getTime() >= sinceTime);
        }
        
        if (filters.limit && filters.limit > 0) {
          events = events.slice(-filters.limit);
        }
      }

      return events;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Verify audit log chain integrity.
   */
  async verifyChainIntegrity(): Promise<ChainIntegrityResult> {
    try {
      const events = await this.readHookAuditEvents();
      const result: ChainIntegrityResult = {
        isValid: true,
        totalEvents: events.length,
        brokenChains: [],
        hmacFailures: []
      };

      let expectedPreviousHash = crypto.createHash('sha256').update('').digest('hex');

      for (let i = 0; i < events.length; i++) {
        const event = events[i] as ChainedHookAuditEvent;
        
        // Check hash chain
        if (event.previous_hash !== expectedPreviousHash) {
          result.isValid = false;
          result.brokenChains.push({
            eventIndex: i,
            eventId: event.event_id,
            expected: expectedPreviousHash,
            actual: event.previous_hash
          });
        }

        // Check HMAC if present
        if (event.hmac && this.hmacKey) {
          const eventCopy = { ...event, hmac: null };
          const serialized = JSON.stringify(eventCopy);
          const hmac = crypto.createHmac('sha256', this.hmacKey);
          hmac.update(serialized);
          const expectedHmac = hmac.digest('hex');
          
          if (event.hmac !== expectedHmac) {
            result.isValid = false;
            result.hmacFailures.push({
              eventIndex: i,
              eventId: event.event_id,
              expected: expectedHmac,
              actual: event.hmac
            });
          }
        }

        // Calculate next expected hash
        const serialized = JSON.stringify(event);
        expectedPreviousHash = crypto.createHash('sha256').update(serialized).digest('hex');
      }

      return result;
    } catch (error) {
      return {
        isValid: false,
        totalEvents: 0,
        brokenChains: [],
        hmacFailures: [],
        error: error.message
      };
    }
  }
}

// Type definitions for audit logging
interface HookAuditEvent {
  event_type: 'phase_execution_start' | 'phase_execution_complete' | 'phase_execution_blocked' | 
             'phase_execution_failed' | 'phase_execution_error' | 'hook_execution' | 
             'hook_failure' | 'plugin_registration';
  execution_id: string;
  hook_point: HookPoint | 'system';
  timestamp: string;
  hook_identity?: {
    hook_id: string;
    plugin_name: string;
    plugin_version: string;
    hook_name: string;
  };
  execution_metrics?: {
    execution_time_ms: number;
    memory_usage_mb: number;
    cpu_time_ms: number;
    result_status: string;
    execution_status: string;
  };
  validation_info?: {
    validation_passed: boolean;
    validation_time_ms: number;
    validation_errors: string[];
    validation_warnings: string[];
    fields_stripped: boolean;
  };
  failure_info?: {
    error_type: string;
    error_message: string;
    stack_trace?: string;
    severity: string;
    failure_mode?: string;
    is_validation_error?: boolean;
  };
  blocking_info?: {
    blocking_hook_id: string;
    reason: string;
    impact: string;
  };
  phase_summary?: {
    status: string;
    total_hooks: number;
    successful_hooks: number;
    failed_hooks: number;
    warning_hooks: number;
    blocked_by_hook?: string;
    total_execution_time_ms: number;
    average_hook_time_ms: number;
  };
  system_error?: {
    error_type: string;
    error_message: string;
    stack_trace: string;
  };
  plugin_info?: {
    plugin_name: string;
    plugin_version: string;
    action: string;
    hooks_affected: string[];
    trust_level?: string;
  };
  details: Record<string, unknown>;
}

interface ChainedHookAuditEvent extends HookAuditEvent {
  event_id: string;
  previous_hash: string;
  hmac: string | null;
}

interface ChainIntegrityResult {
  isValid: boolean;
  totalEvents: number;
  brokenChains: Array<{
    eventIndex: number;
    eventId: string;
    expected: string;
    actual: string;
  }>;
  hmacFailures: Array<{
    eventIndex: number;
    eventId: string;
    expected: string;
    actual: string;
  }>;
  error?: string;
}
```

This comprehensive audit system provides full traceability of hook execution while integrating seamlessly with the existing pipeline audit infrastructure and supporting HMAC chain integrity when configured.

---

## 15. Test Strategy

The Extension Hook System test strategy focuses on validating security boundaries, ensuring correct operational behavior, and preventing system compromise through comprehensive testing across multiple attack vectors and failure modes.

### 15.1 Test Categories and Approach

**Security Boundary Testing**: Validates that sandboxing effectively prevents hooks from accessing unauthorized resources or escaping their execution environment.

**Functional Correctness Testing**: Ensures hooks execute in the correct order, context propagation works properly, and failure modes behave as specified.

**Performance and Resource Testing**: Validates resource budgets are enforced and the system maintains acceptable performance under load.

**Integration Testing**: Verifies seamless integration with existing pipeline components and audit systems.

### 15.2 Sandbox Security Tests

```typescript
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { SandboxExecutor } from '../src/sandbox/sandbox-executor';
import { HookRegistration, HookCapabilities } from '../src/types';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('SandboxExecutor Security Tests', () => {
  let sandboxExecutor: SandboxExecutor;
  let tempDir: string;
  let testHookRegistration: HookRegistration;

  beforeEach(async () => {
    sandboxExecutor = new SandboxExecutor(5, 30000);
    tempDir = await fs.mkdtemp(join(tmpdir(), 'hook-test-'));
    
    // Create a test plugin with minimal capabilities
    testHookRegistration = {
      id: 'test-security-hook',
      name: 'Security Test Hook',
      hook_point: 'code-post-write',
      entry_point: 'test-hooks/security-test',
      plugin: { name: 'test-plugin', version: '1.0.0' },
      priority: 5,
      timeout_seconds: 30,
      failure_mode: 'warn',
      capabilities: {
        fs_read: [tempDir],
        fs_write: [join(tempDir, 'output')],
        network: [],
        env_vars: ['NODE_ENV'],
        max_memory_mb: 128,
        max_cpu_seconds: 10,
        allow_child_processes: false,
        temp_dir_access: true
      },
      description: 'Test hook for security validation',
      output_schema_version: 'v1'
    };
  });

  afterEach(async () => {
    await sandboxExecutor.terminateAll();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('prevents path traversal attacks through filesystem access', async () => {
    // Create malicious hook that attempts directory traversal
    const maliciousHook = {
      ...testHookRegistration,
      id: 'path-traversal-test'
    };

    // Create hook code that attempts to access /etc/passwd
    const hookCode = `
      const fs = require('fs').promises;
      
      module.exports = async function(context) {
        try {
          // Attempt directory traversal to access sensitive file
          const sensitiveData = await fs.readFile('../../../etc/passwd', 'utf-8');
          return {
            status: 'block',
            message: 'Successfully accessed sensitive file',
            payload: { sensitiveData: sensitiveData.substring(0, 100) }
          };
        } catch (error) {
          return {
            status: 'ok',
            message: 'Path traversal blocked correctly',
            payload: { error: error.message }
          };
        }
      };
    `;

    // Write hook code to temp directory
    const hookPath = join(tempDir, 'test-hooks', 'path-traversal.js');
    await fs.mkdir(join(tempDir, 'test-hooks'), { recursive: true });
    await fs.writeFile(hookPath, hookCode);

    // Update hook registration to point to the malicious code
    maliciousHook.entry_point = 'path-traversal';

    const context = createTestContext();
    const result = await sandboxExecutor.executeHook('path-traversal', maliciousHook, context);

    // Verify that path traversal was blocked
    expect(result.status).toBe('ok');
    expect(result.message).toBe('Path traversal blocked correctly');
    expect(result.payload).toHaveProperty('error');
    
    // Ensure no sensitive data was accessed
    if (result.payload && typeof result.payload === 'object') {
      expect(result.payload).not.toHaveProperty('sensitiveData');
    }
  });

  test('blocks network access to AWS metadata IP', async () => {
    const networkHook = {
      ...testHookRegistration,
      id: 'network-metadata-test',
      capabilities: {
        ...testHookRegistration.capabilities,
        network: ['allowed-api.company.com'] // Only allow specific domain
      }
    };

    const hookCode = `
      const http = require('http');
      
      module.exports = async function(context) {
        return new Promise((resolve) => {
          // Attempt to access AWS metadata service
          const req = http.get('http://169.254.169.254/latest/meta-data/', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              resolve({
                status: 'block',
                message: 'Successfully accessed AWS metadata',
                payload: { metadataPreview: data.substring(0, 100) }
              });
            });
          });

          req.on('error', (error) => {
            resolve({
              status: 'ok',
              message: 'AWS metadata access blocked correctly',
              payload: { error: error.message }
            });
          });

          req.setTimeout(5000, () => {
            req.destroy();
            resolve({
              status: 'ok',
              message: 'AWS metadata access timed out (blocked)',
              payload: { error: 'Request timeout' }
            });
          });
        });
      };
    `;

    const hookPath = join(tempDir, 'test-hooks', 'network-test.js');
    await fs.writeFile(hookPath, hookCode);
    networkHook.entry_point = 'network-test';

    const context = createTestContext();
    const result = await sandboxExecutor.executeHook('network-test', networkHook, context);

    // Verify that AWS metadata access was blocked
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/blocked|timeout/i);
    
    // Ensure no metadata was accessed
    if (result.payload && typeof result.payload === 'object') {
      expect(result.payload).not.toHaveProperty('metadataPreview');
    }
  });

  test('enforces memory limits and terminates on exhaustion', async () => {
    const memoryHook = {
      ...testHookRegistration,
      id: 'memory-exhaustion-test',
      capabilities: {
        ...testHookRegistration.capabilities,
        max_memory_mb: 64 // Very low limit for testing
      }
    };

    const hookCode = `
      module.exports = async function(context) {
        try {
          // Attempt to allocate excessive memory
          const chunks = [];
          for (let i = 0; i < 1000; i++) {
            // Allocate 1MB chunks
            chunks.push(Buffer.alloc(1024 * 1024, 'a'));
            
            // Brief yield to allow memory monitoring
            if (i % 10 === 0) {
              await new Promise(resolve => setImmediate(resolve));
            }
          }
          
          return {
            status: 'block',
            message: 'Memory exhaustion not prevented',
            payload: { allocatedChunks: chunks.length }
          };
        } catch (error) {
          return {
            status: 'ok',
            message: 'Memory limit enforced correctly',
            payload: { error: error.message }
          };
        }
      };
    `;

    const hookPath = join(tempDir, 'test-hooks', 'memory-test.js');
    await fs.writeFile(hookPath, hookCode);
    memoryHook.entry_point = 'memory-test';

    const context = createTestContext();
    
    // Should either return an error or be terminated by the sandbox
    const startTime = Date.now();
    const result = await sandboxExecutor.executeHook('memory-test', memoryHook, context);
    const duration = Date.now() - startTime;

    // Verify memory exhaustion was handled
    expect(duration).toBeLessThan(15000); // Should not take too long
    
    if (result.status === 'ok') {
      // Memory allocation was caught and handled
      expect(result.message).toBe('Memory limit enforced correctly');
    } else {
      // Worker was terminated due to memory exhaustion
      expect(result.status).toBe('warn');
      expect(result.message).toMatch(/terminated|failed|timeout/i);
    }
  });
});

describe('Output Schema Validation Tests', () => {
  let validationPipeline: ValidationPipeline;
  let tempSchemaDir: string;

  beforeEach(async () => {
    tempSchemaDir = await fs.mkdtemp(join(tmpdir(), 'schema-test-'));
    validationPipeline = new ValidationPipeline(tempSchemaDir);
    
    // Create test schema for code-post-write hook
    const schemaDir = join(tempSchemaDir, 'code-post-write');
    await fs.mkdir(schemaDir, { recursive: true });
    
    const outputSchema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        quality_analysis: {
          type: "object",
          properties: {
            overall_score: { type: "number", minimum: 0, maximum: 100 }
          },
          required: ["overall_score"]
        },
        security_findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: { enum: ["low", "medium", "high", "critical"] },
              description: { type: "string" }
            },
            required: ["severity", "description"]
          }
        }
      },
      required: ["quality_analysis"],
      additionalProperties: false
    };
    
    await fs.writeFile(
      join(schemaDir, 'output-v1.json'),
      JSON.stringify(outputSchema, null, 2)
    );
    
    await validationPipeline.loadSchemas();
  });

  afterEach(async () => {
    await fs.rm(tempSchemaDir, { recursive: true, force: true });
  });

  test('prevents output schema poisoning attacks', async () => {
    // Test malicious output that attempts to inject extra fields
    const maliciousOutput = {
      quality_analysis: {
        overall_score: 85
      },
      security_findings: [
        {
          severity: "high",
          description: "SQL injection vulnerability detected"
        }
      ],
      // Malicious extra fields that should be stripped
      __proto__: { isAdmin: true },
      constructor: { name: "AdminUser" },
      malicious_script: "<script>alert('xss')</script>",
      system_commands: ["rm -rf /", "cat /etc/passwd"],
      secret_data: {
        api_key: "secret-api-key-12345",
        database_password: "super-secret-password"
      }
    };

    const result = await validationPipeline.validateHookOutput(
      'code-post-write',
      'v1',
      maliciousOutput
    );

    // Validation should succeed (valid core structure)
    expect(result.isValid).toBe(true);
    expect(result.sanitizedOutput).toBeTruthy();

    // Malicious fields should be stripped
    const sanitized = result.sanitizedOutput as any;
    expect(sanitized).not.toHaveProperty('__proto__');
    expect(sanitized).not.toHaveProperty('constructor');
    expect(sanitized).not.toHaveProperty('malicious_script');
    expect(sanitized).not.toHaveProperty('system_commands');
    expect(sanitized).not.toHaveProperty('secret_data');

    // Valid fields should remain
    expect(sanitized).toHaveProperty('quality_analysis');
    expect(sanitized).toHaveProperty('security_findings');
    expect(sanitized.quality_analysis.overall_score).toBe(85);

    // Should have warnings about stripped fields
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/Removed.*properties/i);
  });

  test('rejects invalid output structure with detailed errors', async () => {
    const invalidOutput = {
      quality_analysis: {
        // Missing required 'overall_score' field
        complexity_score: 75
      },
      security_findings: [
        {
          // Invalid severity value
          severity: "super-critical",
          description: "Test finding"
        },
        {
          severity: "high",
          // Missing required description
        }
      ],
      // Wrong type for array
      malformed_array: "should-be-array-not-string"
    };

    const result = await validationPipeline.validateHookOutput(
      'code-post-write',
      'v1',
      invalidOutput
    );

    // Validation should fail
    expect(result.isValid).toBe(false);
    expect(result.sanitizedOutput).toBe(null);

    // Should have specific error messages
    expect(result.errors.length).toBeGreaterThan(0);
    
    const errorText = result.errors.join(' ').toLowerCase();
    expect(errorText).toMatch(/missing.*overall_score|required.*overall_score/);
    expect(errorText).toMatch(/invalid|unexpected.*severity/);
  });

  test('handles schema validation performance under load', async () => {
    // Test large valid output
    const largeOutput = {
      quality_analysis: {
        overall_score: 92
      },
      security_findings: Array.from({ length: 1000 }, (_, i) => ({
        severity: i % 2 === 0 ? "low" : "medium",
        description: `Security finding #${i + 1} - this is a test finding with some detail about the issue discovered during analysis.`
      }))
    };

    const startTime = performance.now();
    const result = await validationPipeline.validateHookOutput(
      'code-post-write',
      'v1',
      largeOutput
    );
    const duration = performance.now() - startTime;

    // Should complete quickly even with large payloads
    expect(duration).toBeLessThan(100); // Under 100ms
    expect(result.isValid).toBe(true);
    expect(result.validationTime).toBeLessThan(50);
    
    const sanitized = result.sanitizedOutput as any;
    expect(sanitized.security_findings).toHaveLength(1000);
  });
});

describe('Hook Execution Priority and Context Tests', () => {
  let sequentialExecutor: SequentialExecutor;
  let mockRegistry: jest.Mocked<HookRegistry>;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'hook-priority-test-'));
    
    mockRegistry = {
      getHooksForPoint: jest.fn(),
      registerHook: jest.fn(),
      unregisterHook: jest.fn(),
      getAllHooks: jest.fn(),
      isHookRegistered: jest.fn(),
      validateCapabilities: jest.fn(),
      getHook: jest.fn()
    } as any;

    const sandboxExecutor = new SandboxExecutor(5, 30000);
    const validationPipeline = new ValidationPipeline(join(tempDir, 'schemas'));
    const auditLogger = new HookAuditLogger({} as any, tempDir);
    
    sequentialExecutor = new SequentialExecutor(
      mockRegistry,
      sandboxExecutor,
      validationPipeline,
      auditLogger
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('executes hooks in correct priority order', async () => {
    const executionOrder: string[] = [];
    
    // Create hooks with different priorities
    const hooks: HookRegistration[] = [
      createTestHook('hook-priority-8', 8, () => {
        executionOrder.push('hook-priority-8');
        return { status: 'ok' as const, message: 'Hook 8 executed' };
      }),
      createTestHook('hook-priority-1', 1, () => {
        executionOrder.push('hook-priority-1');
        return { status: 'ok' as const, message: 'Hook 1 executed' };
      }),
      createTestHook('hook-priority-5', 5, () => {
        executionOrder.push('hook-priority-5');
        return { status: 'ok' as const, message: 'Hook 5 executed' };
      }),
      createTestHook('hook-priority-3', 3, () => {
        executionOrder.push('hook-priority-3');
        return { status: 'ok' as const, message: 'Hook 3 executed' };
      })
    ];

    mockRegistry.getHooksForPoint.mockResolvedValue(hooks);

    const context = createTestContext();
    const result = await sequentialExecutor.executeHooksForPoint(
      'code-post-write',
      context
    );

    // Verify hooks executed in priority order (1, 3, 5, 8)
    expect(executionOrder).toEqual([
      'hook-priority-1',
      'hook-priority-3', 
      'hook-priority-5',
      'hook-priority-8'
    ]);

    expect(result.status).toBe('success');
    expect(result.hookResults).toHaveLength(4);
  });

  test('propagates context correctly between hooks', async () => {
    const contextSnapshots: any[] = [];
    
    const hooks: HookRegistration[] = [
      createTestHook('context-producer', 1, (ctx) => {
        contextSnapshots.push({
          hook: 'context-producer',
          previousOutputs: Object.keys(ctx.previous_outputs)
        });
        return {
          status: 'ok' as const,
          message: 'Produced output',
          payload: { producedData: 'test-data-1' }
        };
      }),
      createTestHook('context-consumer-1', 2, (ctx) => {
        contextSnapshots.push({
          hook: 'context-consumer-1',
          previousOutputs: Object.keys(ctx.previous_outputs)
        });
        return {
          status: 'ok' as const,
          message: 'Consumed and produced',
          payload: { consumedData: ctx.previous_outputs['context-producer'], producedData: 'test-data-2' }
        };
      }),
      createTestHook('context-consumer-2', 3, (ctx) => {
        contextSnapshots.push({
          hook: 'context-consumer-2',
          previousOutputs: Object.keys(ctx.previous_outputs)
        });
        return {
          status: 'ok' as const,
          message: 'Final consumer',
          payload: { allPreviousOutputs: ctx.previous_outputs }
        };
      })
    ];

    mockRegistry.getHooksForPoint.mockResolvedValue(hooks);

    const context = createTestContext();
    await sequentialExecutor.executeHooksForPoint('code-post-write', context);

    // Verify context propagation
    expect(contextSnapshots[0].previousOutputs).toEqual([]); // First hook has no previous outputs
    expect(contextSnapshots[1].previousOutputs).toEqual(['context-producer']); // Second hook sees first
    expect(contextSnapshots[2].previousOutputs).toEqual(['context-producer', 'context-consumer-1']); // Third sees both
  });

  function createTestHook(
    id: string, 
    priority: number, 
    handler: (ctx: any) => { status: 'ok' | 'warn' | 'block', message: string, payload?: any }
  ): HookRegistration {
    return {
      id,
      name: `Test Hook ${id}`,
      hook_point: 'code-post-write',
      entry_point: `test/${id}`,
      plugin: { name: 'test-plugin', version: '1.0.0' },
      priority,
      timeout_seconds: 30,
      failure_mode: 'warn',
      capabilities: {
        fs_read: [],
        fs_write: [],
        network: [],
        env_vars: [],
        max_memory_mb: 128,
        max_cpu_seconds: 10,
        allow_child_processes: false,
        temp_dir_access: true
      },
      description: `Test hook ${id}`,
      output_schema_version: 'v1'
    };
  }
});

function createTestContext(): HookContext {
  return {
    request_id: 'REQ-TEST1234-5678',
    request_type: 'feature',
    phase: 'code-generation',
    hook_point: 'code-post-write',
    artifacts: {},
    user_context: {
      user_id: 'test-user',
      organization: 'test-org',
      permissions: ['read', 'write']
    },
    previous_outputs: {},
    configuration: {},
    execution_metadata: {
      execution_id: 'test-exec-123',
      started_at: new Date().toISOString(),
      pipeline_config: {},
      environment: 'test'
    }
  };
}
```

This comprehensive test strategy validates security boundaries, functional correctness, and operational behavior while providing concrete examples of potential attack vectors and system responses.

---

## 16. Performance

The Extension Hook System is designed to maintain sub-100ms execution overhead for typical hook operations while supporting concurrent execution and providing predictable resource usage patterns. Performance characteristics are critical for maintaining acceptable pipeline execution times as the number of installed plugins grows.

### 16.1 Performance Targets and Measurements

**Hook Execution Overhead (P95 < 100ms)**: Simple hooks that perform basic validation or data transformation should complete within 100 milliseconds at the 95th percentile, including sandbox setup, execution, and output validation time.

**Worker Spawn Cost (< 50ms amortized)**: Worker thread creation and initialization overhead should average less than 50 milliseconds when amortized across multiple hook executions through worker pooling and reuse strategies.

**Schema Validation Cost (< 10ms)**: JSON Schema validation of hook outputs should complete in under 10 milliseconds for typical payload sizes (up to 1MB), enabling fast feedback and minimal pipeline delay.

**Concurrent Execution (10 hooks)**: The system should support up to 10 concurrent hook executions within a single pipeline phase without resource contention or performance degradation.

### 16.2 Optimization Strategies

**Worker Pool Management**: Worker threads are pooled and reused across hook executions to amortize the creation cost. The pool maintains a configurable number of warm workers for each hook type, with lazy initialization for infrequently used hooks.

**Schema Compilation Caching**: JSON Schema validators are compiled once and cached in memory, avoiding the overhead of schema parsing and compilation on each validation. The cache is organized by hook point and schema version for efficient lookup.

**Context Serialization Optimization**: Hook context objects are efficiently serialized using structured cloning algorithms optimized for the specific data types used in the autonomous-dev pipeline. Immutable data structures are shared rather than deep-copied where possible.

**Resource Budget Enforcement**: Memory and CPU limits are enforced at the operating system level through worker thread resource constraints and Node.js heap limit configuration, providing deterministic performance boundaries.

### 16.3 Performance Monitoring and Alerting

**Execution Metrics Collection**: All hook executions are timed at multiple levels (total execution time, sandbox setup time, validation time, cleanup time) and recorded in the audit log for analysis and trending.

**Resource Usage Tracking**: Memory consumption, CPU utilization, and I/O patterns are monitored for each hook execution, enabling identification of resource-intensive hooks that may require optimization or capability adjustments.

**Performance Degradation Detection**: Automatic detection of hooks that exceed their historical performance baselines, with alerting to operators when performance degrades beyond configurable thresholds.

**Load Testing Integration**: Performance tests simulate realistic plugin loads with varying execution patterns, concurrent phases, and resource utilization scenarios to validate system behavior under stress.

The performance design ensures that extension capabilities do not compromise the autonomous-dev system's responsiveness while providing operators with the observability needed to maintain optimal performance as the plugin ecosystem evolves.

---

## 17. Open Questions

Several design and implementation questions require further investigation and decision-making as the Extension Hook System evolves:

### 17.1 Plugin Versioning and Compatibility

**Question**: How should the system handle plugin dependencies and version compatibility checking between plugins that interact through shared hook points?

**Context**: When multiple plugins register hooks for the same hook point, their outputs may be consumed by subsequent hooks. If Plugin A produces data that Plugin B expects to consume, version mismatches could cause runtime failures.

**Options**: 
- Implement semantic versioning compatibility checks at registration time
- Create a plugin dependency resolution system similar to npm
- Require explicit compatibility declarations in hook manifests
- Design hook interfaces to be forward/backward compatible by default

### 17.2 Cross-Plugin Communication

**Question**: Should plugins be able to communicate directly with each other, or should all inter-plugin coordination happen through the structured context passed between hooks?

**Context**: Some use cases might benefit from plugins sharing state or coordinating behavior (e.g., a security scanner that wants to suppress duplicate findings from multiple security-focused plugins).

**Options**:
- Maintain strict isolation with context-only communication (current design)
- Introduce a controlled shared state mechanism
- Allow plugins to declare explicit dependencies and communication channels
- Create plugin-to-plugin messaging system with capability controls

### 17.3 Dynamic Hook Registration

**Question**: Should hooks be able to register additional hooks dynamically during execution, or should all hook registration happen at startup/reload time?

**Context**: Advanced plugins might want to register specialized hooks based on runtime analysis (e.g., detecting that a request involves a specific technology and registering technology-specific validation hooks).

**Options**:
- Maintain static registration (current design)
- Allow limited dynamic registration with strict capability controls
- Support conditional hook activation based on request context
- Create hook factory pattern for runtime specialization

### 17.4 Plugin Marketplace and Distribution

**Question**: How should plugins be distributed, installed, and updated in enterprise environments with security requirements?

**Context**: Organizations need secure, auditable ways to distribute plugins while maintaining control over what gets installed and ensuring supply chain security.

**Options**:
- Private package registries with organizational approval workflows
- Cryptographically signed plugin packages with chain of trust
- Integration with existing enterprise software distribution systems
- Automated security scanning of plugins before installation

### 17.5 Resource Sharing and Optimization

**Question**: Should plugins be able to share expensive resources (database connections, ML models, external API clients) to improve performance and reduce overhead?

**Context**: Multiple plugins might need similar resources (e.g., connecting to the same compliance database), and creating separate connections for each hook execution could be inefficient.

**Options**:
- Maintain strict isolation with per-hook resource allocation (current design)
- Create controlled resource sharing pools with capability-based access
- Allow plugins to declare shared resource requirements
- Implement resource caching layers that multiple plugins can access

These open questions will be addressed through iterative design, prototype development, and feedback from early plugin developers and operators as the Extension Hook System matures.

---

## 18. References

This Technical Design Document references the following specifications, standards, and related documents:

### 18.1 Primary Requirements Documents

**PRD-011 §19 (Review-Driven Design Updates)**: Binding specification for sandbox implementation, output schema validation, and reviewer-slot authorization. Section 19 establishes that sandboxing is in scope, schema validation failures always fail-hard, and agent-meta-reviewer audit is required for privileged reviewer slots.

**PRD-003 (Agent Factory & Self-Improvement)**: Defines the agent-meta-reviewer system referenced in FR-32, which performs security analysis of plugin modifications including privilege escalation detection and prompt injection analysis.

### 18.2 Forward References

**TDD-018 (Pipeline State Management)**: Extension hooks integrate with pipeline state through the context propagation mechanisms and artifact management system defined in the state management TDD.

**TDD-020 (Review Gate System)**: Reviewer-slot hooks register with and participate in the review gate system, following the scoring aggregation and approval threshold mechanisms.

**TDD-021 (Audit & Observability)**: Hook audit logging integrates with the comprehensive audit system, following the hash chain integrity model and HMAC integration patterns.

**TDD-022 (Security Framework)**: Extension sandbox capabilities align with the broader security framework including capability-based access control and trust boundary management.

### 18.3 Industry Standards and Specifications

**JSON Schema Draft-07**: All hook input and output schemas follow the JSON Schema specification for validation, type checking, and documentation.

**Worker Threads API (Node.js)**: Sandbox implementation uses the Node.js Worker Threads API for isolation and resource management.

**Semantic Versioning (SemVer)**: Plugin and manifest versioning follows semantic versioning for compatibility and dependency management.

**RFC 7517 (JSON Web Key)**: Plugin signing and verification mechanisms can integrate with JWK standards for cryptographic key management.

### 18.4 Security References

**OWASP Secure Coding Practices**: Plugin capability restrictions and validation patterns follow OWASP guidelines for secure extension system design.

**Principle of Least Privilege**: Capability-based access control implements least privilege by requiring explicit declaration of all resource access needs.

**Defense in Depth**: Multi-layered security approach with sandboxing, validation, allowlisting, and audit logging provides comprehensive protection.

**Common Weakness Enumeration (CWE)**: Security test cases address common vulnerabilities including CWE-22 (Path Traversal), CWE-918 (Server-Side Request Forgery), and CWE-502 (Deserialization of Untrusted Data).

This TDD provides the comprehensive technical specification required to implement a secure, performant, and operationally manageable extension system for the autonomous-dev pipeline while maintaining compatibility with existing infrastructure and enabling future ecosystem growth.