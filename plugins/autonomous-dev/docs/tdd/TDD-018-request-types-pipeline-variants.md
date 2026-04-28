# TDD-018: Request Types & Pipeline Variants

| Field        | Value                                              |
|--------------|----------------------------------------------------|
| **Title**    | Request Types & Pipeline Variants                  |
| **TDD ID**   | TDD-018                                            |
| **Version**  | 1.0                                                |
| **Date**     | 2026-04-28                                         |
| **Status**   | Draft                                              |
| **Author**   | Patrick Watson                                     |
| **Parent PRD** | PRD-011: Pipeline Variants & Extension Hooks    |
| **Plugin**   | autonomous-dev                                     |

---

## 1. Summary

This Technical Design Document specifies the implementation of request type taxonomy and pipeline variants for the autonomous-dev system. The design introduces five distinct request types (`feature`, `bug`, `infra`, `refactor`, `hotfix`) with customized pipeline phase configurations, comprehensive bug report intake schema, and enhanced daemon request selection logic that honors per-type phase overrides.

The core innovation is the **Phase Override Matrix**: a configuration system that maps each request type to specific pipeline requirements while maintaining backward compatibility with existing feature-type requests. Bug-typed requests bypass PRD generation entirely, starting directly from TDD with structured bug context input. Infrastructure requests include additional security and cost gates. Refactor and hotfix types optimize for speed with streamlined review cycles.

**Key Deliverables:**
- `RequestType` enum and `PhaseOverrideMatrix` data structures extending state.json schema to v1.1
- Enhanced daemon `select_request()` logic implementing type-aware phase progression
- Comprehensive bug report intake schema with JSON validation and CLI integration
- TDD-author agent prompt extensions for processing bug-typed requests without PRD dependency
- CLI surface integration with TDD-011's request submission dispatcher
- Complete backward compatibility ensuring existing v1.0 state files operate unchanged
- Validation framework preventing invalid type strings and enforcing immutability post-submission

## 2. Goals & Non-Goals

### 2.1 Goals

| ID   | Goal |
|------|------|
| G-01 | Implement `RequestType` enum (`feature` \| `bug` \| `infra` \| `refactor` \| `hotfix`) as optional field in state.json schema v1.1 |
| G-02 | Design `PhaseOverrideMatrix` data structure mapping request types to customized phase sequences |
| G-03 | Extend daemon `select_request()` function to honor per-type phase overrides when determining next actionable state |
| G-04 | Implement comprehensive bug report intake schema with required fields: reproduction_steps, expected_behavior, actual_behavior, error_messages, environment |
| G-05 | Extend TDD-author agent to process bug-typed requests using structured bug context instead of PRD input |
| G-06 | Integrate request type selection with TDD-011's CLI dispatcher via `--type` parameter |
| G-07 | Maintain complete backward compatibility: existing requests without explicit type default to `feature` |
| G-08 | Implement validation preventing invalid type strings and enforcing immutability after submission |

### 2.2 Non-Goals

| ID    | Non-Goal |
|-------|----------|
| NG-01 | Extension hooks, plugin manifests, or sandbox mechanics (deferred to TDD-019) |
| NG-02 | Reviewer slot assignment or advanced gate mechanics beyond phase skipping |
| NG-03 | Multi-tenant request typing or organization-wide type policies |
| NG-04 | Dynamic type conversion after request submission (requires cancel + resubmit) |
| NG-05 | Complex workflow orchestration beyond linear phase progression |

## 3. Background

### 3.1 Current Single-Shape Pipeline

The autonomous-dev system currently implements a single, uniform pipeline for all requests:

```
intake → prd → prd_review → tdd → tdd_review → plan → plan_review → 
spec → spec_review → code → code_review → integration → deploy → monitor
```

This design serves feature development well but creates inefficiencies for other work types:

- **Bug fixes** spend unnecessary cycles generating PRDs when the problem is already defined
- **Infrastructure changes** lack specialized security and cost validation gates
- **Refactoring** work gets bogged down in product requirement analysis
- **Hotfixes** cannot expedite through review cycles when time-critical

### 3.2 Request Type Optimization Targets

Each request type optimizes for different outcomes:

| Type | Primary Goal | Key Optimizations |
|------|-------------|-------------------|
| `feature` | Product capability delivery | Full pipeline with comprehensive review gates |
| `bug` | Incident resolution | Skip PRD, structured bug context, regression testing focus |
| `infra` | System reliability | Enhanced security gates, cost analysis, rollback planning |
| `refactor` | Code quality improvement | Skip PRD, focused TDD on quality metrics |
| `hotfix` | Critical issue mitigation | Expedited review cycles, minimal documentation |

### 3.3 Integration Points

The request typing system integrates with three existing subsystems:

1. **State Machine** (TDD-002): `state.json` schema extension for type persistence
2. **Daemon Engine** (TDD-001): `select_request()` enhancement for type-aware progression
3. **CLI Dispatcher** (TDD-011): `--type` parameter integration for submission

## 4. Architecture

### 4.1 Component Diagram

```
┌══════════════════════════════════════════════════════════════════════┐
│                       Request Submission Layer                       │
├─────────────────┬─────────────────┬─────────────────┬─────────────────┤
│ CLI Dispatcher  │ Claude App      │ Discord Bot     │ Slack App       │
│ --type feature  │ type=bug        │ /submit-bug     │ /hotfix         │
│ --type bug      │ type=infra      │ /submit-infra   │ /refactor       │
└─────────┬───────┴─────────┬───────┴─────────┬───────┴─────────┬───────┘
          │                 │                 │                 │
          │ RequestType     │ RequestType     │ RequestType     │ RequestType
          │ validation      │ validation      │ validation      │ validation
          ▼                 ▼                 ▼                 ▼
┌══════════════════════════════════════════════════════════════════════┐
│                      Enhanced State Machine                          │
│                          (TDD-002 + v1.1)                           │
├──────────────────────────────────────────────────────────────────────┤
│  state.json Schema v1.1:                                            │
│  + request_type: RequestType (optional, defaults to "feature")      │
│  + bug_context?: BugReport (populated when type="bug")              │
│  + phase_overrides: string[] (computed from PhaseOverrideMatrix)    │
└─────────┬────────────────────────────────────────────────────┬───────┘
          │                                                    │
          ▼                                                    ▼
┌─────────────────────┐                            ┌─────────────────────┐
│ PhaseOverrideMatrix │                            │     Bug Context     │
│ (type → phases)     │                            │    Validation       │
│                     │                            │                     │
│ feature: [all]      │                            │ - reproduction_steps│
│ bug: [skip prd]     │                            │ - expected_behavior │
│ infra: [+ security] │                            │ - actual_behavior   │
│ refactor: [skip prd]│                            │ - error_messages    │
│ hotfix: [expedited] │                            │ - environment       │
└─────────┬───────────┘                            └─────────┬───────────┘
          │                                                    │
          ▼                                                    ▼
┌══════════════════════════════════════════════════════════════════════┐
│                       Enhanced Daemon Engine                         │
│                          (TDD-001 + types)                          │
├──────────────────────────────────────────────────────────────────────┤
│  select_request() enhancements:                                     │
│  1. Read request_type from state.json                               │
│  2. Resolve phase_overrides from PhaseOverrideMatrix               │
│  3. Apply type-specific state progression logic                     │
│  4. Skip phases marked as overridden                               │
└─────────┬────────────────────────────────────────────────────┬───────┘
          │                                                    │
          ▼                                                    ▼
┌─────────────────────┐                            ┌─────────────────────┐
│  TDD Author Agent   │                            │   Phase Execution   │
│     Extensions      │                            │      Engine         │
│                     │                            │                     │
│ Bug Context Input:  │                            │ Type-aware routing: │
│ - Skip PRD prompts  │                            │ feature → standard  │
│ - Focus on root     │                            │ bug → skip prd      │
│   cause analysis    │                            │ infra → + gates     │
│ - Regression tests  │                            │ refactor → skip prd │
│ - Fix approach      │                            │ hotfix → expedited  │
└─────────────────────┘                            └─────────────────────┘
```

### 4.2 Data Flow: Type-Aware Request Processing

```
1. SUBMISSION
   ┌─────────────────┐    type validation    ┌─────────────────┐
   │ CLI: --type bug │ ────────────────────► │ RequestType     │
   │ + bug fields    │                        │ enum check      │
   └─────────────────┘                        └─────────┬───────┘
                                                        │
2. SCHEMA EXTENSION                                     ▼
   ┌─────────────────┐    state.json v1.1    ┌─────────────────┐
   │ State Migration │ ◄─────────────────── │ Type Assignment │
   │ v1.0 → v1.1     │                        │ + bug_context   │
   └─────────────────┘                        └─────────┬───────┘
                                                        │
3. PHASE RESOLUTION                                     ▼
   ┌─────────────────┐   PhaseOverrideMatrix  ┌─────────────────┐
   │ daemon          │ ◄─────────────────── │ Type → Phases   │
   │ select_request()│                        │ bug: skip prd   │
   └─────────┬───────┘                        └─────────────────┘
             │
4. EXECUTION   ▼
   ┌─────────────────┐    bug context       ┌─────────────────┐
   │ TDD Agent       │ ◄─────────────────── │ Direct TDD      │
   │ (bug prompts)   │                        │ Generation      │
   └─────────────────┘                        └─────────────────┘
```

## 5. Request Type Catalog

### 5.1 RequestType Enum Definition

```typescript
/**
 * Supported request types with distinct pipeline optimizations
 */
export enum RequestType {
  /** Standard product feature development (default) */
  FEATURE = 'feature',
  
  /** Bug fix with structured problem context */
  BUG = 'bug',
  
  /** Infrastructure changes with enhanced gates */
  INFRA = 'infra',
  
  /** Code quality improvements */
  REFACTOR = 'refactor',
  
  /** Critical issue hotfix with expedited processing */
  HOTFIX = 'hotfix'
}

/**
 * Type guard for RequestType validation
 */
export function isValidRequestType(value: string): value is RequestType {
  return Object.values(RequestType).includes(value as RequestType);
}

/**
 * Default request type for backward compatibility
 */
export const DEFAULT_REQUEST_TYPE = RequestType.FEATURE;
```

### 5.2 Phase Override Matrix

```typescript
/**
 * Maps request types to customized pipeline phase configurations
 */
export interface PhaseOverrideConfig {
  /** Phases to skip entirely */
  skippedPhases: PipelinePhase[];
  
  /** Phases with enhanced validation gates */
  enhancedPhases: PipelinePhase[];
  
  /** Whether to expedite review cycles */
  expeditedReviews: boolean;
  
  /** Additional security or cost gates */
  additionalGates: string[];
  
  /** Maximum retry attempts per phase */
  maxRetries: number;
  
  /** Timeout overrides in minutes */
  phaseTimeouts: Record<string, number>;
}

/**
 * Complete phase override matrix
 */
export const PHASE_OVERRIDE_MATRIX: Record<RequestType, PhaseOverrideConfig> = {
  [RequestType.FEATURE]: {
    skippedPhases: [],
    enhancedPhases: [],
    expeditedReviews: false,
    additionalGates: [],
    maxRetries: 3,
    phaseTimeouts: {}
  },
  
  [RequestType.BUG]: {
    skippedPhases: ['prd', 'prd_review'],
    enhancedPhases: ['code', 'code_review'],
    expeditedReviews: true,
    additionalGates: ['regression_test_validation'],
    maxRetries: 5, // Bugs may need more attempts
    phaseTimeouts: {
      'tdd': 30,     // Faster TDD for bug fixes
      'code': 60     // More time for careful bug fixing
    }
  },
  
  [RequestType.INFRA]: {
    skippedPhases: [],
    enhancedPhases: ['tdd', 'tdd_review', 'plan', 'plan_review'],
    expeditedReviews: false,
    additionalGates: ['security_review', 'cost_analysis', 'rollback_plan'],
    maxRetries: 2, // Infrastructure changes should be well-planned
    phaseTimeouts: {
      'tdd': 120,    // Thorough infrastructure design
      'plan': 90     // Detailed deployment planning
    }
  },
  
  [RequestType.REFACTOR]: {
    skippedPhases: ['prd', 'prd_review'],
    enhancedPhases: ['code', 'code_review'],
    expeditedReviews: true,
    additionalGates: ['code_quality_metrics', 'performance_benchmarks'],
    maxRetries: 3,
    phaseTimeouts: {
      'code': 90     // Careful refactoring takes time
    }
  },
  
  [RequestType.HOTFIX]: {
    skippedPhases: ['prd', 'prd_review', 'plan_review'],
    enhancedPhases: ['tdd', 'code'],
    expeditedReviews: true,
    additionalGates: ['incident_correlation', 'rollback_validation'],
    maxRetries: 5, // Hotfixes may need rapid iteration
    phaseTimeouts: {
      'tdd': 15,     // Rapid problem analysis
      'code': 30,    // Quick but careful fix
      'deploy': 10   // Fast deployment
    }
  }
};

/**
 * Resolves the ordered phase list for a given request type
 */
export function getPhaseSequence(requestType: RequestType): PipelinePhase[] {
  const config = PHASE_OVERRIDE_MATRIX[requestType];
  const allPhases: PipelinePhase[] = [
    'intake', 'prd', 'prd_review', 'tdd', 'tdd_review',
    'plan', 'plan_review', 'spec', 'spec_review',
    'code', 'code_review', 'integration', 'deploy', 'monitor'
  ];
  
  return allPhases.filter(phase => !config.skippedPhases.includes(phase));
}

/**
 * Checks if a phase should be enhanced for the given request type
 */
export function isEnhancedPhase(requestType: RequestType, phase: PipelinePhase): boolean {
  return PHASE_OVERRIDE_MATRIX[requestType].enhancedPhases.includes(phase);
}

/**
 * Gets additional gates required for a request type
 */
export function getAdditionalGates(requestType: RequestType): string[] {
  return PHASE_OVERRIDE_MATRIX[requestType].additionalGates;
}
```

### 5.3 Phase Configuration Summary Table

| Request Type | Skipped Phases | Enhanced Phases | Expedited Reviews | Additional Gates |
|--------------|----------------|-----------------|-------------------|------------------|
| `feature` | None | None | No | None |
| `bug` | prd, prd_review | code, code_review | Yes | regression_test_validation |
| `infra` | None | tdd, tdd_review, plan, plan_review | No | security_review, cost_analysis, rollback_plan |
| `refactor` | prd, prd_review | code, code_review | Yes | code_quality_metrics, performance_benchmarks |
| `hotfix` | prd, prd_review, plan_review | tdd, code | Yes | incident_correlation, rollback_validation |

## 6. Bug Intake Schema

### 6.1 TypeScript Interface Definition

```typescript
/**
 * Comprehensive bug report schema with required fields for effective debugging
 */
export interface BugReport {
  /** Brief summary of the bug */
  title: string;
  
  /** Detailed description of the issue */
  description: string;
  
  /** Step-by-step instructions to reproduce the bug */
  reproduction_steps: string[];
  
  /** What should have happened */
  expected_behavior: string;
  
  /** What actually happened */
  actual_behavior: string;
  
  /** Error messages, stack traces, or failure outputs */
  error_messages: string[];
  
  /** Environment details for reproduction */
  environment: BugEnvironment;
  
  /** Components or modules affected (optional) */
  affected_components?: string[];
  
  /** Bug severity assessment (optional, defaults to 'medium') */
  severity?: BugSeverity;
  
  /** Labels for categorization (optional) */
  labels?: string[];
  
  /** Screenshots or logs as file attachments (optional) */
  attachments?: BugAttachment[];
  
  /** Related issue IDs or tickets (optional) */
  related_issues?: string[];
  
  /** User impact assessment (optional) */
  user_impact?: string;
  
  /** Workaround if known (optional) */
  workaround?: string;
}

/**
 * Environment context for bug reproduction
 */
export interface BugEnvironment {
  /** Software version or git commit hash */
  version: string;
  
  /** Operating system and version */
  platform: string;
  
  /** Runtime environment (browser, Node.js version, etc.) */
  runtime: string;
  
  /** Configuration details relevant to the bug */
  config?: Record<string, string>;
  
  /** Feature flags or experimental settings */
  feature_flags?: string[];
}

/**
 * Bug severity levels
 */
export enum BugSeverity {
  CRITICAL = 'critical', // System down, data loss
  HIGH = 'high',         // Major functionality broken
  MEDIUM = 'medium',     // Minor functionality affected
  LOW = 'low'            // Cosmetic or edge case issues
}

/**
 * File attachment metadata
 */
export interface BugAttachment {
  /** File name */
  filename: string;
  
  /** File MIME type */
  content_type: string;
  
  /** File size in bytes */
  size: number;
  
  /** Base64 encoded file content or file path */
  content: string;
  
  /** Description of what the attachment shows */
  description?: string;
}

/**
 * Validation rules for bug reports
 */
export const BUG_REPORT_VALIDATION = {
  title: {
    required: true,
    minLength: 10,
    maxLength: 200
  },
  description: {
    required: true,
    minLength: 20,
    maxLength: 5000
  },
  reproduction_steps: {
    required: true,
    minItems: 1,
    maxItems: 20
  },
  expected_behavior: {
    required: true,
    minLength: 10,
    maxLength: 1000
  },
  actual_behavior: {
    required: true,
    minLength: 10,
    maxLength: 1000
  },
  error_messages: {
    required: true,
    minItems: 0, // Can be empty if no error messages
    maxItems: 10
  },
  environment: {
    required: true,
    fields: {
      version: { required: true, pattern: /^[a-zA-Z0-9.-]+$/ },
      platform: { required: true, minLength: 3 },
      runtime: { required: true, minLength: 3 }
    }
  }
};
```

### 6.2 JSON Schema Document

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://autonomous-dev.plugin/schemas/bug-report.json",
  "title": "Bug Report Schema",
  "description": "Structured bug report format for autonomous-dev request submission",
  "type": "object",
  "required": [
    "title",
    "description", 
    "reproduction_steps",
    "expected_behavior",
    "actual_behavior",
    "error_messages",
    "environment"
  ],
  "additionalProperties": false,
  "properties": {
    "title": {
      "type": "string",
      "description": "Brief summary of the bug",
      "minLength": 10,
      "maxLength": 200
    },
    "description": {
      "type": "string", 
      "description": "Detailed description of the issue",
      "minLength": 20,
      "maxLength": 5000
    },
    "reproduction_steps": {
      "type": "array",
      "description": "Step-by-step instructions to reproduce the bug",
      "minItems": 1,
      "maxItems": 20,
      "items": {
        "type": "string",
        "minLength": 5,
        "maxLength": 500
      }
    },
    "expected_behavior": {
      "type": "string",
      "description": "What should have happened",
      "minLength": 10,
      "maxLength": 1000
    },
    "actual_behavior": {
      "type": "string", 
      "description": "What actually happened",
      "minLength": 10,
      "maxLength": 1000
    },
    "error_messages": {
      "type": "array",
      "description": "Error messages, stack traces, or failure outputs",
      "maxItems": 10,
      "items": {
        "type": "string",
        "maxLength": 10000
      }
    },
    "environment": {
      "type": "object",
      "description": "Environment details for reproduction",
      "required": ["version", "platform", "runtime"],
      "additionalProperties": false,
      "properties": {
        "version": {
          "type": "string",
          "description": "Software version or git commit hash",
          "pattern": "^[a-zA-Z0-9.-]+$"
        },
        "platform": {
          "type": "string",
          "description": "Operating system and version",
          "minLength": 3,
          "maxLength": 100
        },
        "runtime": {
          "type": "string",
          "description": "Runtime environment (browser, Node.js version, etc.)",
          "minLength": 3,
          "maxLength": 100
        },
        "config": {
          "type": "object",
          "description": "Configuration details relevant to the bug",
          "additionalProperties": {
            "type": "string"
          }
        },
        "feature_flags": {
          "type": "array",
          "description": "Feature flags or experimental settings",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "affected_components": {
      "type": "array",
      "description": "Components or modules affected",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 100
      }
    },
    "severity": {
      "type": "string",
      "description": "Bug severity assessment",
      "enum": ["critical", "high", "medium", "low"],
      "default": "medium"
    },
    "labels": {
      "type": "array",
      "description": "Labels for categorization", 
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 50
      }
    },
    "attachments": {
      "type": "array",
      "description": "Screenshots or logs as file attachments",
      "maxItems": 5,
      "items": {
        "type": "object",
        "required": ["filename", "content_type", "size", "content"],
        "properties": {
          "filename": {
            "type": "string",
            "minLength": 1,
            "maxLength": 255
          },
          "content_type": {
            "type": "string",
            "pattern": "^[a-zA-Z]+/[a-zA-Z0-9.-]+$"
          },
          "size": {
            "type": "integer",
            "minimum": 0,
            "maximum": 10485760
          },
          "content": {
            "type": "string",
            "description": "Base64 encoded file content or file path"
          },
          "description": {
            "type": "string",
            "maxLength": 500
          }
        }
      }
    },
    "related_issues": {
      "type": "array",
      "description": "Related issue IDs or tickets",
      "items": {
        "type": "string",
        "pattern": "^[A-Z]+-[0-9]+$"
      }
    },
    "user_impact": {
      "type": "string",
      "description": "User impact assessment", 
      "maxLength": 1000
    },
    "workaround": {
      "type": "string",
      "description": "Workaround if known",
      "maxLength": 1000  
    }
  }
}
```

### 6.3 CLI Integration Examples

```bash
# Basic bug submission with required fields
autonomous-dev request submit --type bug \
  --title "Login fails with 500 error on password reset" \
  --description "Users cannot reset passwords, getting 500 internal server error" \
  --steps "1. Go to login page" "2. Click 'Forgot Password'" "3. Enter email" "4. Click submit" \
  --expected "Should receive password reset email" \
  --actual "Gets 500 internal server error page" \
  --errors "Internal server error: Cannot read property 'id' of undefined at /auth/reset:42" \
  --version "v2.1.3" \
  --platform "macOS 13.4" \
  --runtime "Node.js 18.16.1"

# Bug submission with optional fields
autonomous-dev request submit --type bug \
  --title "Dashboard charts render incorrectly" \
  --description "Revenue charts show negative values as positive bars" \
  --steps "1. Login as admin" "2. Navigate to dashboard" "3. View revenue chart" \
  --expected "Negative revenue shows below x-axis" \
  --actual "Negative revenue shows above x-axis as positive bars" \
  --errors "" \
  --version "commit-a3f2e1b" \
  --platform "Chrome 114 on Windows 11" \
  --runtime "React 18.2.0" \
  --components "Dashboard" "ChartRenderer" \
  --severity "medium" \
  --labels "ui" "charts" \
  --impact "Finance team cannot assess losses correctly"

# Bug submission via interactive prompt
autonomous-dev request submit --type bug --interactive
# Prompts user for each field with validation

# Bug submission from file
autonomous-dev request submit --type bug --from-file bug-report.json
```

## 7. State.json Schema Additions

### 7.1 Schema Version 1.1 Extensions

```typescript
/**
 * Extended state schema supporting request types and bug context
 */
export interface RequestStateV1_1 extends RequestStateV1_0 {
  /** Schema version identifier */
  schema_version: 1.1;
  
  /** Request type classification (optional, defaults to 'feature') */
  request_type?: RequestType;
  
  /** Structured bug context (only present when request_type === 'bug') */
  bug_context?: BugReport;
  
  /** Computed phase sequence based on request type */
  phase_overrides: string[];
  
  /** Type-specific configuration applied */
  type_config: PhaseOverrideConfig;
}

/**
 * State migration function from v1.0 to v1.1
 */
export function migrateStateV1_0ToV1_1(state: RequestStateV1_0): RequestStateV1_1 {
  const requestType = DEFAULT_REQUEST_TYPE; // Default to 'feature'
  
  return {
    ...state,
    schema_version: 1.1,
    request_type: requestType,
    bug_context: undefined, // No bug context for migrated requests
    phase_overrides: getPhaseSequence(requestType),
    type_config: PHASE_OVERRIDE_MATRIX[requestType]
  };
}

/**
 * Backward compatibility check
 */
export function isLegacyState(state: any): state is RequestStateV1_0 {
  return state.schema_version === 1.0 && !state.hasOwnProperty('request_type');
}
```

### 7.2 Complete Schema Example

```json
{
  "schema_version": 1.1,
  "id": "REQ-20260428-b7f3",
  "status": "tdd",
  "request_type": "bug",
  "priority": 1,
  "title": "Login authentication bypass vulnerability",
  "description": "Bug report submitted via CLI with structured context",
  "repository": "/Users/pwatson/codebase/auth-service",
  "branch": "autonomous/REQ-20260428-b7f3",
  "worktree_path": "/Users/pwatson/.autonomous-dev/worktrees/REQ-20260428-b7f3",
  "created_at": "2026-04-28T14:22:00Z",
  "updated_at": "2026-04-28T14:25:30Z",
  "cost_accrued_usd": 1.25,
  "turn_count": 12,
  "escalation_count": 0,
  "blocked_by": [],
  "phase_overrides": [
    "intake", "tdd", "tdd_review", "plan", "plan_review", 
    "spec", "spec_review", "code", "code_review", 
    "integration", "deploy", "monitor"
  ],
  "type_config": {
    "skippedPhases": ["prd", "prd_review"],
    "enhancedPhases": ["code", "code_review"],
    "expeditedReviews": true,
    "additionalGates": ["regression_test_validation"],
    "maxRetries": 5,
    "phaseTimeouts": {
      "tdd": 30,
      "code": 60
    }
  },
  "bug_context": {
    "title": "Login authentication bypass vulnerability",
    "description": "Users can bypass login by manipulating JWT tokens in localStorage",
    "reproduction_steps": [
      "1. Login with valid credentials",
      "2. Open browser DevTools", 
      "3. Modify JWT token exp claim to future date",
      "4. Refresh page - still authenticated without re-login"
    ],
    "expected_behavior": "Modified JWT should be rejected and user logged out",
    "actual_behavior": "Modified JWT is accepted and user remains authenticated",
    "error_messages": [
      "JWT verification failed: Token signature invalid",
      "Auth middleware: Fallback to localStorage token"
    ],
    "environment": {
      "version": "v3.2.1",
      "platform": "Chrome 114 on macOS 13.4",
      "runtime": "Node.js 18.16.1",
      "config": {
        "jwt_secret": "[REDACTED]",
        "session_timeout": "3600"
      }
    },
    "affected_components": ["AuthService", "JWTMiddleware"],
    "severity": "critical",
    "labels": ["security", "authentication"],
    "user_impact": "Complete authentication bypass allows unauthorized access"
  },
  "phase_history": [
    {
      "state": "intake",
      "entered_at": "2026-04-28T14:22:00Z",
      "exited_at": "2026-04-28T14:22:45Z",
      "session_id": "sess_bug_001",
      "turns_used": 2,
      "cost_usd": 0.15,
      "retry_count": 0,
      "exit_reason": "completed"
    },
    {
      "state": "tdd",
      "entered_at": "2026-04-28T14:22:45Z",
      "exited_at": null,
      "session_id": "sess_bug_002", 
      "turns_used": 10,
      "cost_usd": 1.10,
      "retry_count": 0,
      "exit_reason": null
    }
  ],
  "current_phase_metadata": {
    "bug_analysis_approach": "root_cause_security_review",
    "regression_test_plan": "JWT token manipulation test suite",
    "fix_complexity": "medium"
  },
  "error": null,
  "last_checkpoint": "2026-04-28T14:22:45Z"
}
```

### 7.3 Migration Strategy

```bash
#!/bin/bash
# migrate_state_files.sh - Migrates existing v1.0 state files to v1.1

migrate_state_file() {
    local state_file="$1"
    
    # Check if already v1.1
    local version=$(jq -r '.schema_version' "$state_file")
    if [[ "$version" == "1.1" ]]; then
        echo "Already v1.1: $state_file"
        return 0
    fi
    
    # Create backup
    cp "$state_file" "${state_file}.v1.0.backup"
    
    # Migrate to v1.1
    jq '. + {
        "schema_version": 1.1,
        "request_type": "feature",
        "phase_overrides": [
            "intake", "prd", "prd_review", "tdd", "tdd_review",
            "plan", "plan_review", "spec", "spec_review", 
            "code", "code_review", "integration", "deploy", "monitor"
        ],
        "type_config": {
            "skippedPhases": [],
            "enhancedPhases": [],
            "expeditedReviews": false,
            "additionalGates": [],
            "maxRetries": 3,
            "phaseTimeouts": {}
        }
    }' "$state_file" > "${state_file}.tmp"
    
    mv "${state_file}.tmp" "$state_file"
    echo "Migrated: $state_file"
}

# Find and migrate all v1.0 state files
find ~/.autonomous-dev -name "state.json" -type f | while read -r state_file; do
    migrate_state_file "$state_file"
done
```

## 8. Daemon select_request Changes

### 8.1 Enhanced Request Selection Logic

```bash
# Enhanced select_request() function in supervisor-loop.sh
select_request() {
    # Scans all configured repository .autonomous-dev/requests/ directories.
    # Returns the highest-priority request in an actionable state.
    # Now considers request_type and phase_overrides for next state determination.
    
    local best_id="" best_project="" best_priority=999999 best_created=""

    local repos
    repos=$(jq -r '.repositories.allowlist[]' "${EFFECTIVE_CONFIG}" 2>/dev/null)

    while IFS= read -r repo; do
        [[ -z "$repo" ]] && continue
        [[ ! -d "$repo/.autonomous-dev/requests" ]] && continue

        find "$repo/.autonomous-dev/requests" -name "state.json" -type f | while read -r state_file; do
            local state_content
            state_content=$(cat "$state_file" 2>/dev/null)
            [[ -z "$state_content" ]] && continue

            # Parse state with migration support
            local state_version
            state_version=$(echo "$state_content" | jq -r '.schema_version // 1.0')
            
            # Migrate v1.0 to v1.1 if needed
            if [[ "$state_version" == "1.0" ]]; then
                state_content=$(migrate_state_inline "$state_content")
                echo "$state_content" > "${state_file}.tmp"
                mv "${state_file}.tmp" "$state_file"
            fi

            # Extract state fields with type awareness
            local request_id status priority created_at request_type
            request_id=$(echo "$state_content" | jq -r '.id')
            status=$(echo "$state_content" | jq -r '.status')
            priority=$(echo "$state_content" | jq -r '.priority')
            created_at=$(echo "$state_content" | jq -r '.created_at')
            request_type=$(echo "$state_content" | jq -r '.request_type // "feature"')

            # Skip non-actionable states
            case "$status" in
                "paused"|"failed"|"cancelled"|"monitor")
                    continue
                    ;;
            esac

            # Apply type-specific actionability check
            if ! is_actionable_for_type "$status" "$request_type" "$state_content"; then
                continue
            fi

            # Priority comparison (lower number = higher priority)
            if [[ $priority -lt $best_priority ]] || \
               [[ $priority -eq $best_priority && "$created_at" < "$best_created" ]]; then
                best_id="$request_id"
                best_project="$repo"
                best_priority=$priority
                best_created="$created_at"
            fi
        done
    done <<< "$repos"

    if [[ -n "$best_id" ]]; then
        echo "${best_id}|${best_project}"
    fi
}

# Type-aware actionability check
is_actionable_for_type() {
    local current_status="$1"
    local request_type="$2"
    local state_content="$3"
    
    # Get phase overrides for the request type
    local phase_overrides
    phase_overrides=$(echo "$state_content" | jq -r '.phase_overrides[]' | tr '\n' ' ')
    
    # Check if current status is in the allowed phase sequence
    if [[ "$phase_overrides" != *"$current_status"* ]]; then
        # Current status is overridden for this type
        return 1
    fi
    
    # Type-specific blocking conditions
    case "$request_type" in
        "bug")
            # Bug requests cannot be actionable if missing bug context
            local has_bug_context
            has_bug_context=$(echo "$state_content" | jq -r 'has("bug_context")')
            [[ "$has_bug_context" == "true" ]]
            ;;
        "infra")
            # Infrastructure requests require additional gate validation
            if [[ "$current_status" == "deploy" ]]; then
                local security_approved
                security_approved=$(echo "$state_content" | jq -r '.current_phase_metadata.security_approved // false')
                [[ "$security_approved" == "true" ]]
            else
                return 0
            fi
            ;;
        "hotfix")
            # Hotfixes bypass normal blocking conditions
            return 0
            ;;
        *)
            # Standard actionability for feature/refactor
            return 0
            ;;
    esac
}

# Inline state migration for v1.0 → v1.1
migrate_state_inline() {
    local state_content="$1"
    
    echo "$state_content" | jq '. + {
        "schema_version": 1.1,
        "request_type": "feature",
        "phase_overrides": [
            "intake", "prd", "prd_review", "tdd", "tdd_review",
            "plan", "plan_review", "spec", "spec_review", 
            "code", "code_review", "integration", "deploy", "monitor"
        ],
        "type_config": {
            "skippedPhases": [],
            "enhancedPhases": [],
            "expeditedReviews": false,
            "additionalGates": [],
            "maxRetries": 3,
            "phaseTimeouts": {}
        }
    }'
}

# Next phase determination with type awareness
get_next_phase() {
    local current_status="$1"
    local request_type="$2"
    
    case "$request_type" in
        "bug"|"refactor")
            case "$current_status" in
                "intake") echo "tdd" ;;      # Skip PRD phases
                "tdd") echo "tdd_review" ;;
                "tdd_review") echo "plan" ;;
                "plan") echo "plan_review" ;;
                "plan_review") echo "spec" ;;
                "spec") echo "spec_review" ;;
                "spec_review") echo "code" ;;
                "code") echo "code_review" ;;
                "code_review") echo "integration" ;;
                "integration") echo "deploy" ;;
                "deploy") echo "monitor" ;;
                *) echo "completed" ;;
            esac
            ;;
        "hotfix")
            case "$current_status" in
                "intake") echo "tdd" ;;      # Skip PRD phases
                "tdd") echo "tdd_review" ;;
                "tdd_review") echo "plan" ;;
                "plan") echo "spec" ;;       # Skip plan_review
                "spec") echo "spec_review" ;;
                "spec_review") echo "code" ;;
                "code") echo "code_review" ;;
                "code_review") echo "integration" ;;
                "integration") echo "deploy" ;;
                "deploy") echo "monitor" ;;
                *) echo "completed" ;;
            esac
            ;;
        *)  # feature, infra (standard progression)
            case "$current_status" in
                "intake") echo "prd" ;;
                "prd") echo "prd_review" ;;
                "prd_review") echo "tdd" ;;
                "tdd") echo "tdd_review" ;;
                "tdd_review") echo "plan" ;;
                "plan") echo "plan_review" ;;
                "plan_review") echo "spec" ;;
                "spec") echo "spec_review" ;;
                "spec_review") echo "code" ;;
                "code") echo "code_review" ;;
                "code_review") echo "integration" ;;
                "integration") echo "deploy" ;;
                "deploy") echo "monitor" ;;
                *) echo "completed" ;;
            esac
            ;;
    esac
}
```

### 8.2 Type-Aware Session Spawning

```bash
# Enhanced spawn_session function with type-specific prompts
spawn_session() {
    local request_id="$1"
    local project="$2"
    
    local state_file="${project}/.autonomous-dev/requests/${request_id}/state.json"
    [[ ! -f "$state_file" ]] && return 1
    
    # Load state with type information
    local state_content request_type current_status
    state_content=$(cat "$state_file")
    request_type=$(echo "$state_content" | jq -r '.request_type // "feature"')
    current_status=$(echo "$state_content" | jq -r '.status')
    
    # Select appropriate agent prompt based on type and phase
    local agent_prompt_file
    case "$current_status" in
        "tdd")
            case "$request_type" in
                "bug")
                    agent_prompt_file="prompts/tdd-author-bug.md"
                    ;;
                "infra")
                    agent_prompt_file="prompts/tdd-author-infra.md"
                    ;;
                "refactor")
                    agent_prompt_file="prompts/tdd-author-refactor.md"
                    ;;
                "hotfix")
                    agent_prompt_file="prompts/tdd-author-hotfix.md"
                    ;;
                *)
                    agent_prompt_file="prompts/tdd-author-feature.md"
                    ;;
            esac
            ;;
        "code")
            case "$request_type" in
                "bug")
                    agent_prompt_file="prompts/code-executor-bug.md"
                    ;;
                *)
                    agent_prompt_file="prompts/code-executor.md"
                    ;;
            esac
            ;;
        *)
            agent_prompt_file="prompts/${current_status}-agent.md"
            ;;
    esac
    
    # Build Claude Code command with type-specific context
    local claude_cmd=(
        "claude"
        "--max-turns" "50"
        "--print"
        "--output-format" "json"
        "--system-prompt" "$agent_prompt_file"
    )
    
    # Add type-specific context variables
    case "$request_type" in
        "bug")
            claude_cmd+=("--var" "REQUEST_TYPE=bug")
            claude_cmd+=("--var" "BUG_CONTEXT=$(echo "$state_content" | jq -c '.bug_context')")
            ;;
        "infra")
            claude_cmd+=("--var" "REQUEST_TYPE=infra")
            claude_cmd+=("--var" "SECURITY_GATES=enabled")
            ;;
        "hotfix")
            claude_cmd+=("--var" "REQUEST_TYPE=hotfix")
            claude_cmd+=("--var" "EXPEDITED_MODE=true")
            ;;
    esac
    
    claude_cmd+=("$project")
    
    # Execute session and capture output
    local session_output session_exit_code
    session_output=$("${claude_cmd[@]}" 2>&1)
    session_exit_code=$?
    
    # Log session details
    log_event "$request_id" "session_spawned" \
        "{\"agent_prompt\": \"$agent_prompt_file\", \"request_type\": \"$request_type\", \"exit_code\": $session_exit_code}"
    
    return $session_exit_code
}
```

## 9. TDD-Author Agent Extension for Bug-Typed Requests

### 9.1 Bug-Specific Agent Prompt

The TDD-author agent receives specialized prompts when processing bug-typed requests, focusing on root cause analysis rather than product requirement interpretation.

```markdown
# TDD Author Agent - Bug Analysis Mode

You are a Technical Design Document author specializing in bug fix implementation. Your task is to analyze the provided bug report and create a comprehensive TDD that guides the resolution process.

## Input Context

You will receive:
- **Bug Report** (structured format): reproduction steps, expected vs actual behavior, error messages, environment details
- **Request Type**: `bug` (this determines your analysis approach)
- **Codebase Context**: existing code structure, recent changes, related components

## Analysis Framework

### 1. Root Cause Investigation
- Map error messages to specific code locations
- Trace execution flow leading to the failure
- Identify contributing factors (race conditions, edge cases, configuration issues)
- Assess whether this is a regression or existing defect

### 2. Impact Assessment
- Determine blast radius of the bug
- Identify all affected user workflows
- Assess data integrity implications
- Evaluate security considerations

### 3. Fix Strategy Design
- Design minimal viable fix vs comprehensive solution
- Plan for regression prevention
- Consider backward compatibility requirements
- Design rollback strategy

### 4. Testing Strategy
- Create reproduction test cases
- Design regression test suite
- Plan integration testing approach
- Define acceptance criteria

## Output Requirements

Your TDD must include:

1. **Bug Summary**: Concise problem statement with technical root cause
2. **Reproduction Analysis**: Technical explanation of why the bug occurs
3. **Fix Approach**: Detailed implementation strategy with code changes
4. **Regression Prevention**: Testing and monitoring to prevent recurrence
5. **Rollback Plan**: Safe deployment and rollback procedures

## Bug Context Variables

Access the structured bug report via these variables:
- `${BUG_CONTEXT.reproduction_steps}` - Steps to reproduce
- `${BUG_CONTEXT.expected_behavior}` - What should happen
- `${BUG_CONTEXT.actual_behavior}` - What actually happens  
- `${BUG_CONTEXT.error_messages}` - Error messages and stack traces
- `${BUG_CONTEXT.environment}` - Runtime environment details
- `${BUG_CONTEXT.affected_components}` - Components involved
- `${BUG_CONTEXT.severity}` - Bug severity level

## Analysis Process

1. **Load Bug Context**: Parse the structured bug report and understand the failure mode
2. **Codebase Exploration**: Examine the affected components and trace execution paths
3. **Root Cause Identification**: Pinpoint the exact cause of the unexpected behavior
4. **Fix Design**: Create a targeted solution addressing the root cause
5. **Test Strategy**: Design comprehensive testing to verify the fix and prevent regression

Focus on technical accuracy, minimal risk, and comprehensive testing. Do not spend time on product requirements analysis since the problem is already defined in the bug report.
```

### 9.2 Bug Context Processing Logic

```typescript
/**
 * Processes bug context for TDD agent consumption
 */
export class BugContextProcessor {
  /**
   * Transforms bug report into agent-consumable format
   */
  static processBugContext(bugReport: BugReport): AgentBugContext {
    return {
      problem_statement: this.generateProblemStatement(bugReport),
      technical_details: this.extractTechnicalDetails(bugReport),
      reproduction_guide: this.formatReproductionSteps(bugReport),
      environment_context: this.summarizeEnvironment(bugReport),
      analysis_hints: this.generateAnalysisHints(bugReport)
    };
  }

  private static generateProblemStatement(bug: BugReport): string {
    return `
PROBLEM: ${bug.title}

DESCRIPTION: ${bug.description}

EXPECTED: ${bug.expected_behavior}

ACTUAL: ${bug.actual_behavior}

SEVERITY: ${bug.severity || 'medium'}
    `.trim();
  }

  private static extractTechnicalDetails(bug: BugReport): TechnicalDetails {
    return {
      error_messages: bug.error_messages,
      stack_traces: this.extractStackTraces(bug.error_messages),
      affected_components: bug.affected_components || [],
      related_issues: bug.related_issues || [],
      environment: bug.environment
    };
  }

  private static formatReproductionSteps(bug: BugReport): ReproductionGuide {
    return {
      steps: bug.reproduction_steps,
      environment_setup: this.extractEnvironmentSetup(bug.environment),
      preconditions: this.inferPreconditions(bug),
      expected_outcome: bug.expected_behavior,
      actual_outcome: bug.actual_behavior
    };
  }

  private static generateAnalysisHints(bug: BugReport): AnalysisHints {
    const hints: string[] = [];
    
    // Error message analysis hints
    if (bug.error_messages.some(msg => msg.includes('undefined'))) {
      hints.push('HINT: Null/undefined access - check object initialization and property access');
    }
    
    if (bug.error_messages.some(msg => msg.includes('timeout'))) {
      hints.push('HINT: Timeout issue - examine async operations and race conditions');
    }
    
    if (bug.error_messages.some(msg => msg.includes('permission'))) {
      hints.push('HINT: Authorization issue - check user permissions and access controls');
    }
    
    // Severity-based hints
    if (bug.severity === BugSeverity.CRITICAL) {
      hints.push('HINT: Critical severity - prioritize minimal risk fix with comprehensive rollback plan');
    }
    
    // Component-based hints
    if (bug.affected_components?.includes('Database')) {
      hints.push('HINT: Database involvement - check data integrity and transaction handling');
    }
    
    return { analysis_hints: hints };
  }
}

/**
 * Agent context interfaces
 */
interface AgentBugContext {
  problem_statement: string;
  technical_details: TechnicalDetails;
  reproduction_guide: ReproductionGuide;
  environment_context: EnvironmentSummary;
  analysis_hints: AnalysisHints;
}

interface TechnicalDetails {
  error_messages: string[];
  stack_traces: string[];
  affected_components: string[];
  related_issues: string[];
  environment: BugEnvironment;
}

interface ReproductionGuide {
  steps: string[];
  environment_setup: string;
  preconditions: string[];
  expected_outcome: string;
  actual_outcome: string;
}

interface AnalysisHints {
  analysis_hints: string[];
}
```

### 9.3 TDD Template for Bug Fixes

```markdown
# TDD-{ID}: Bug Fix - {Bug Title}

| Field | Value |
|-------|-------|
| **Title** | Bug Fix - {Bug Title} |
| **TDD ID** | TDD-{ID} |
| **Version** | 1.0 |
| **Date** | {ISO Date} |
| **Status** | Draft |
| **Author** | TDD Author Agent (Bug Analysis Mode) |
| **Request Type** | Bug Fix |
| **Bug Report ID** | {Request ID} |
| **Severity** | {Bug Severity} |

## 1. Bug Analysis Summary

### 1.1 Problem Statement
{Concise description of the bug and its impact}

### 1.2 Root Cause
{Technical explanation of why the bug occurs}

### 1.3 Affected Systems
{List of components, modules, or services impacted}

## 2. Reproduction Analysis

### 2.1 Failure Scenario
{Step-by-step technical breakdown of the failure path}

### 2.2 Conditions Required
{Specific conditions that trigger the bug}

### 2.3 Error Analysis
{Detailed analysis of error messages and stack traces}

## 3. Technical Investigation

### 3.1 Code Path Analysis
{Trace through the code execution path leading to failure}

### 3.2 Data Flow Examination
{How data moves through the system and where it breaks}

### 3.3 Contributing Factors
{Environmental factors, race conditions, edge cases}

## 4. Fix Design

### 4.1 Solution Approach
{High-level strategy for resolving the bug}

### 4.2 Code Changes Required
{Specific files, functions, and modifications needed}

### 4.3 Configuration Changes
{Any configuration or environment changes required}

### 4.4 Database Changes
{Schema modifications or data migrations if needed}

## 5. Risk Assessment

### 5.1 Change Impact
{Analysis of what might be affected by the fix}

### 5.2 Regression Risks
{Potential for introducing new bugs}

### 5.3 Mitigation Strategies
{How to minimize risk during implementation}

## 6. Testing Strategy

### 6.1 Reproduction Tests
{Tests that reproduce the original bug}

### 6.2 Fix Validation Tests
{Tests that verify the fix works correctly}

### 6.3 Regression Test Suite
{Comprehensive tests to prevent future regressions}

### 6.4 Integration Testing
{Tests for system-wide impact of the fix}

## 7. Deployment Plan

### 7.1 Deployment Strategy
{How to safely deploy the fix to production}

### 7.2 Rollback Plan
{How to quickly revert if the fix causes issues}

### 7.3 Monitoring Plan
{What to monitor to ensure the fix is successful}

## 8. Prevention Measures

### 8.1 Process Improvements
{Changes to prevent similar bugs in the future}

### 8.2 Additional Monitoring
{New alerts or monitoring to catch similar issues}

### 8.3 Documentation Updates
{Updates to development guidelines or best practices}
```

## 10. Validation & Error Handling

### 10.1 Request Type Validation

```typescript
/**
 * Comprehensive request type validation
 */
export class RequestTypeValidator {
  /**
   * Validates request type string at submission time
   */
  static validateRequestType(typeString: string): ValidationResult {
    if (!typeString) {
      return {
        valid: false,
        error: 'Request type is required',
        suggestions: Object.values(RequestType)
      };
    }

    if (!isValidRequestType(typeString)) {
      return {
        valid: false,
        error: `Invalid request type: ${typeString}`,
        suggestions: Object.values(RequestType).filter(type => 
          type.includes(typeString) || typeString.includes(type)
        )
      };
    }

    return { valid: true };
  }

  /**
   * Validates bug context when type is 'bug'
   */
  static validateBugContext(bugReport: any): ValidationResult {
    const validator = new BugReportValidator();
    return validator.validate(bugReport);
  }

  /**
   * Enforces type immutability after submission
   */
  static validateTypeImmutability(
    currentType: RequestType, 
    requestedType: RequestType,
    requestStatus: string
  ): ValidationResult {
    if (requestStatus === 'intake') {
      // Allow type changes only in intake phase
      return { valid: true };
    }

    if (currentType !== requestedType) {
      return {
        valid: false,
        error: `Cannot change request type from '${currentType}' to '${requestedType}' after submission. Cancel and resubmit to change type.`,
        suggestions: ['cancel', 'resubmit']
      };
    }

    return { valid: true };
  }
}

/**
 * Bug report validation using JSON schema
 */
export class BugReportValidator {
  private schema: JSONSchema;

  constructor() {
    this.schema = JSON.parse(fs.readFileSync('schemas/bug-report.json', 'utf-8'));
  }

  validate(bugReport: any): ValidationResult {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(this.schema);
    
    if (validate(bugReport)) {
      return { valid: true };
    }

    const errors = validate.errors?.map(err => ({
      field: err.instancePath,
      message: err.message,
      value: err.data
    })) || [];

    return {
      valid: false,
      error: 'Bug report validation failed',
      details: errors
    };
  }
}

interface ValidationResult {
  valid: boolean;
  error?: string;
  details?: any[];
  suggestions?: string[];
}
```

### 10.2 CLI Error UX

```bash
# Enhanced CLI error handling for request types

validate_request_type() {
    local type="$1"
    
    case "$type" in
        "feature"|"bug"|"infra"|"refactor"|"hotfix")
            return 0
            ;;
        "")
            echo "ERROR: Request type is required. Use --type flag."
            echo "Valid types: feature, bug, infra, refactor, hotfix"
            echo "Example: autonomous-dev request submit --type bug ..."
            return 1
            ;;
        *)
            echo "ERROR: Invalid request type: '$type'"
            echo "Valid types: feature, bug, infra, refactor, hotfix"
            
            # Suggest similar types
            case "$type" in
                "fix"|"bugfix"|"bug-fix")
                    echo "Did you mean: bug"
                    ;;
                "infrastructure"|"deployment"|"ops")
                    echo "Did you mean: infra"
                    ;;
                "emergency"|"urgent"|"critical")
                    echo "Did you mean: hotfix"
                    ;;
                "cleanup"|"tech-debt"|"technical-debt")
                    echo "Did you mean: refactor"
                    ;;
            esac
            
            return 1
            ;;
    esac
}

validate_bug_fields() {
    local title="$1" description="$2" steps="$3" expected="$4" actual="$5"
    
    # Title validation
    if [[ ${#title} -lt 10 ]]; then
        echo "ERROR: Bug title must be at least 10 characters"
        return 1
    fi
    
    if [[ ${#title} -gt 200 ]]; then
        echo "ERROR: Bug title must be less than 200 characters"
        return 1
    fi
    
    # Description validation
    if [[ ${#description} -lt 20 ]]; then
        echo "ERROR: Bug description must be at least 20 characters"
        return 1
    fi
    
    # Steps validation
    if [[ -z "$steps" ]]; then
        echo "ERROR: Reproduction steps are required for bug reports"
        echo "Use: --steps \"step 1\" \"step 2\" ..."
        return 1
    fi
    
    # Expected behavior validation
    if [[ ${#expected} -lt 10 ]]; then
        echo "ERROR: Expected behavior description must be at least 10 characters"
        return 1
    fi
    
    # Actual behavior validation
    if [[ ${#actual} -lt 10 ]]; then
        echo "ERROR: Actual behavior description must be at least 10 characters"
        return 1
    fi
    
    return 0
}

# Enhanced request submission with validation
submit_request() {
    local type="$1"
    shift
    
    # Validate request type
    if ! validate_request_type "$type"; then
        exit 1
    fi
    
    # Type-specific validation
    case "$type" in
        "bug")
            # Extract bug-specific arguments
            local title="" description="" steps=() expected="" actual=""
            local errors=() version="" platform="" runtime=""
            
            while [[ $# -gt 0 ]]; do
                case "$1" in
                    --title) title="$2"; shift 2 ;;
                    --description) description="$2"; shift 2 ;;
                    --steps) 
                        shift
                        while [[ $# -gt 0 && "$1" != --* ]]; do
                            steps+=("$1")
                            shift
                        done
                        ;;
                    --expected) expected="$2"; shift 2 ;;
                    --actual) actual="$2"; shift 2 ;;
                    --errors)
                        shift
                        while [[ $# -gt 0 && "$1" != --* ]]; do
                            errors+=("$1")
                            shift
                        done
                        ;;
                    --version) version="$2"; shift 2 ;;
                    --platform) platform="$2"; shift 2 ;;
                    --runtime) runtime="$2"; shift 2 ;;
                    *) 
                        echo "ERROR: Unknown bug report option: $1"
                        exit 1
                        ;;
                esac
            done
            
            # Validate required bug fields
            if ! validate_bug_fields "$title" "$description" "${steps[*]}" "$expected" "$actual"; then
                exit 1
            fi
            
            # Validate environment fields
            if [[ -z "$version" ]]; then
                echo "ERROR: Software version is required for bug reports (--version)"
                exit 1
            fi
            
            if [[ -z "$platform" ]]; then
                echo "ERROR: Platform is required for bug reports (--platform)"
                exit 1
            fi
            
            if [[ -z "$runtime" ]]; then
                echo "ERROR: Runtime is required for bug reports (--runtime)"
                exit 1
            fi
            
            # Build bug context JSON
            local bug_context
            bug_context=$(jq -n \
                --arg title "$title" \
                --arg description "$description" \
                --argjson steps "$(printf '%s\n' "${steps[@]}" | jq -R . | jq -s .)" \
                --arg expected "$expected" \
                --arg actual "$actual" \
                --argjson errors "$(printf '%s\n' "${errors[@]}" | jq -R . | jq -s .)" \
                --arg version "$version" \
                --arg platform "$platform" \
                --arg runtime "$runtime" \
                '{
                    title: $title,
                    description: $description,
                    reproduction_steps: $steps,
                    expected_behavior: $expected,
                    actual_behavior: $actual,
                    error_messages: $errors,
                    environment: {
                        version: $version,
                        platform: $platform,
                        runtime: $runtime
                    }
                }'
            )
            
            # Submit bug request
            submit_typed_request "$type" "$bug_context"
            ;;
            
        "feature"|"infra"|"refactor"|"hotfix")
            # Standard request submission
            submit_typed_request "$type" "{}"
            ;;
    esac
}
```

## 11. Backward Compatibility

### 11.1 Migration Testing Strategy

```typescript
/**
 * Comprehensive backward compatibility test suite
 */
describe('Request Type Backward Compatibility', () => {
  describe('Schema Migration v1.0 → v1.1', () => {
    test('migrates existing feature request without data loss', () => {
      const v1_0_state = {
        schema_version: 1.0,
        id: 'REQ-20260401-test',
        status: 'prd_review',
        priority: 5,
        title: 'Legacy feature request',
        // ... other v1.0 fields
      };
      
      const migrated = migrateStateV1_0ToV1_1(v1_0_state);
      
      expect(migrated.schema_version).toBe(1.1);
      expect(migrated.request_type).toBe('feature');
      expect(migrated.phase_overrides).toEqual([
        'intake', 'prd', 'prd_review', 'tdd', 'tdd_review',
        'plan', 'plan_review', 'spec', 'spec_review', 
        'code', 'code_review', 'integration', 'deploy', 'monitor'
      ]);
      expect(migrated.bug_context).toBeUndefined();
      
      // Verify all original fields preserved
      expect(migrated.id).toBe(v1_0_state.id);
      expect(migrated.title).toBe(v1_0_state.title);
      expect(migrated.status).toBe(v1_0_state.status);
    });
    
    test('daemon selects migrated requests correctly', () => {
      const stateFileContent = JSON.stringify({
        schema_version: 1.0,
        id: 'REQ-20260401-legacy',
        status: 'tdd',
        priority: 3
      });
      
      // Mock filesystem
      mockFs({
        '/test/repo/.autonomous-dev/requests/REQ-20260401-legacy/state.json': stateFileContent
      });
      
      const selected = selectRequestWithType();
      
      expect(selected).toBe('REQ-20260401-legacy|/test/repo');
      
      // Verify file was migrated
      const updatedContent = fs.readFileSync(
        '/test/repo/.autonomous-dev/requests/REQ-20260401-legacy/state.json', 
        'utf-8'
      );
      const updatedState = JSON.parse(updatedContent);
      expect(updatedState.schema_version).toBe(1.1);
      expect(updatedState.request_type).toBe('feature');
    });
  });
  
  describe('CLI Backward Compatibility', () => {
    test('submission without --type defaults to feature', async () => {
      const result = await cli.execute([
        'request', 'submit', 
        'Legacy feature request without type specified'
      ]);
      
      expect(result.success).toBe(true);
      expect(result.requestType).toBe('feature');
    });
    
    test('existing commands work unchanged', async () => {
      const commands = [
        ['request', 'status', 'REQ-20260401-test'],
        ['request', 'list'],
        ['request', 'pause', 'REQ-20260401-test'],
        ['request', 'resume', 'REQ-20260401-test'],
        ['daemon', 'start'],
        ['daemon', 'status']
      ];
      
      for (const cmd of commands) {
        const result = await cli.execute(cmd);
        expect(result.success).toBe(true);
      }
    });
  });
  
  describe('Agent Compatibility', () => {
    test('TDD agent works with migrated feature requests', async () => {
      const migratedState = migrateStateV1_0ToV1_1(legacyFeatureState);
      
      const agent = new TDDAuthorAgent();
      const result = await agent.processRequest(migratedState);
      
      expect(result.success).toBe(true);
      expect(result.usedBugPrompts).toBe(false);
    });
    
    test('daemon spawns correct agent for migrated requests', () => {
      const state = {
        schema_version: 1.1,
        request_type: 'feature', // Migrated from v1.0
        status: 'tdd'
      };
      
      const agentPrompt = selectAgentPrompt(state);
      expect(agentPrompt).toBe('prompts/tdd-author-feature.md');
    });
  });
});
```

### 11.2 Rollback Strategy

```bash
#!/bin/bash
# rollback_request_types.sh - Emergency rollback to v1.0 behavior

rollback_to_v1_0() {
    echo "Rolling back request type system to v1.0 behavior..."
    
    # 1. Disable request type CLI options
    sed -i.backup 's/--type/--disabled-type/g' bin/autonomous-dev.sh
    
    # 2. Force all requests to use feature pipeline
    find ~/.autonomous-dev -name "state.json" -type f | while read -r state_file; do
        jq '. + {
            "schema_version": 1.0,
            "request_type": null,
            "bug_context": null,
            "phase_overrides": null,
            "type_config": null
        } | del(.request_type, .bug_context, .phase_overrides, .type_config)' \
        "$state_file" > "${state_file}.tmp"
        
        mv "${state_file}.tmp" "$state_file"
    done
    
    # 3. Restart daemon to pick up changes
    autonomous-dev daemon stop
    autonomous-dev daemon start
    
    echo "Rollback complete. All requests now use standard feature pipeline."
}

# Verify rollback success
verify_rollback() {
    local failed=0
    
    find ~/.autonomous-dev -name "state.json" -type f | while read -r state_file; do
        local version
        version=$(jq -r '.schema_version' "$state_file")
        
        if [[ "$version" != "1.0" ]]; then
            echo "ERROR: $state_file still has version $version"
            failed=$((failed + 1))
        fi
        
        local has_type
        has_type=$(jq 'has("request_type")' "$state_file")
        
        if [[ "$has_type" == "true" ]]; then
            echo "ERROR: $state_file still has request_type field"
            failed=$((failed + 1))
        fi
    done
    
    if [[ $failed -eq 0 ]]; then
        echo "Rollback verification successful"
        return 0
    else
        echo "Rollback verification failed: $failed issues found"
        return 1
    fi
}
```

## 12. Test Strategy

### 12.1 Unit Tests

```typescript
describe('Request Type System Unit Tests', () => {
  describe('RequestType Enum', () => {
    test('validates known types', () => {
      expect(isValidRequestType('feature')).toBe(true);
      expect(isValidRequestType('bug')).toBe(true);
      expect(isValidRequestType('infra')).toBe(true);
      expect(isValidRequestType('refactor')).toBe(true);
      expect(isValidRequestType('hotfix')).toBe(true);
    });
    
    test('rejects invalid types', () => {
      expect(isValidRequestType('invalid')).toBe(false);
      expect(isValidRequestType('')).toBe(false);
      expect(isValidRequestType(null as any)).toBe(false);
    });
  });
  
  describe('PhaseOverrideMatrix', () => {
    test('bug requests skip PRD phases', () => {
      const phases = getPhaseSequence(RequestType.BUG);
      expect(phases).not.toContain('prd');
      expect(phases).not.toContain('prd_review');
      expect(phases).toContain('tdd');
    });
    
    test('feature requests include all phases', () => {
      const phases = getPhaseSequence(RequestType.FEATURE);
      expect(phases).toContain('prd');
      expect(phases).toContain('prd_review');
      expect(phases).toContain('tdd');
    });
    
    test('hotfix requests skip plan review', () => {
      const phases = getPhaseSequence(RequestType.HOTFIX);
      expect(phases).not.toContain('prd_review');
      expect(phases).not.toContain('plan_review');
      expect(phases).toContain('plan');
    });
    
    test('enhanced phases are identified correctly', () => {
      expect(isEnhancedPhase(RequestType.BUG, 'code')).toBe(true);
      expect(isEnhancedPhase(RequestType.FEATURE, 'code')).toBe(false);
      expect(isEnhancedPhase(RequestType.INFRA, 'tdd')).toBe(true);
    });
  });
  
  describe('Bug Report Validation', () => {
    test('validates complete bug report', () => {
      const validBug: BugReport = {
        title: 'Authentication fails with timeout',
        description: 'Users cannot login when server load is high',
        reproduction_steps: [
          'Login during peak hours',
          'Enter valid credentials',
          'Click login button'
        ],
        expected_behavior: 'Successful login',
        actual_behavior: 'Timeout error after 30 seconds',
        error_messages: ['Request timeout: 30000ms exceeded'],
        environment: {
          version: 'v2.1.0',
          platform: 'Chrome 114 on macOS',
          runtime: 'Node.js 18.16.1'
        }
      };
      
      const validator = new BugReportValidator();
      const result = validator.validate(validBug);
      expect(result.valid).toBe(true);
    });
    
    test('rejects incomplete bug report', () => {
      const invalidBug = {
        title: 'Bug', // Too short
        description: 'Broken', // Too short
        // Missing required fields
      };
      
      const validator = new BugReportValidator();
      const result = validator.validate(invalidBug);
      expect(result.valid).toBe(false);
      expect(result.details).toHaveLength(5); // Missing 5 required fields
    });
  });
  
  describe('State Migration', () => {
    test('migrates v1.0 state to v1.1', () => {
      const v1_0: RequestStateV1_0 = {
        schema_version: 1.0,
        id: 'REQ-20260428-test',
        status: 'tdd',
        priority: 5,
        title: 'Test request',
        // ... other required fields
      };
      
      const migrated = migrateStateV1_0ToV1_1(v1_0);
      
      expect(migrated.schema_version).toBe(1.1);
      expect(migrated.request_type).toBe('feature');
      expect(migrated.phase_overrides).toBeDefined();
      expect(migrated.type_config).toBeDefined();
    });
    
    test('preserves all original data during migration', () => {
      const original: RequestStateV1_0 = createTestStateV1_0();
      const migrated = migrateStateV1_0ToV1_1(original);
      
      // Check all v1.0 fields preserved
      expect(migrated.id).toBe(original.id);
      expect(migrated.status).toBe(original.status);
      expect(migrated.title).toBe(original.title);
      expect(migrated.priority).toBe(original.priority);
    });
  });
});
```

### 12.2 Integration Tests

```typescript
describe('Request Type Integration Tests', () => {
  let testRepo: string;
  let daemon: TestDaemon;
  
  beforeEach(async () => {
    testRepo = await createTestRepository();
    daemon = new TestDaemon(testRepo);
    await daemon.start();
  });
  
  afterEach(async () => {
    await daemon.stop();
    await cleanup(testRepo);
  });
  
  test('complete bug request pipeline', async () => {
    // Submit bug request
    const bugReport: BugReport = createTestBugReport();
    const submitResult = await cli.execute([
      'request', 'submit', '--type', 'bug',
      '--bug-context', JSON.stringify(bugReport)
    ]);
    
    expect(submitResult.success).toBe(true);
    const requestId = submitResult.requestId;
    
    // Verify state.json created with bug type
    const statePath = path.join(testRepo, '.autonomous-dev', 'requests', requestId, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    
    expect(state.schema_version).toBe(1.1);
    expect(state.request_type).toBe('bug');
    expect(state.bug_context).toEqual(bugReport);
    expect(state.phase_overrides).not.toContain('prd');
    
    // Wait for daemon to pick up request
    await waitForDaemonPickup(requestId);
    
    // Verify daemon skipped PRD phase
    await waitForPhase(requestId, 'tdd');
    const updatedState = getRequestState(requestId);
    expect(updatedState.status).toBe('tdd');
    
    // Verify TDD agent received bug context
    const tddOutput = await getTDDOutput(requestId);
    expect(tddOutput).toContain('Bug Analysis');
    expect(tddOutput).toContain(bugReport.title);
  });
  
  test('infra request includes security gates', async () => {
    const submitResult = await cli.execute([
      'request', 'submit', '--type', 'infra',
      'Add Redis caching layer for session storage'
    ]);
    
    const requestId = submitResult.requestId;
    
    // Progress to deploy phase
    await progressToPhase(requestId, 'deploy');
    
    // Verify security gate is enforced
    const state = getRequestState(requestId);
    const additionalGates = state.type_config.additionalGates;
    
    expect(additionalGates).toContain('security_review');
    expect(additionalGates).toContain('cost_analysis');
    expect(additionalGates).toContain('rollback_plan');
  });
  
  test('hotfix request expedites through pipeline', async () => {
    const startTime = Date.now();
    
    const submitResult = await cli.execute([
      'request', 'submit', '--type', 'hotfix',
      'Fix critical authentication bypass'
    ]);
    
    const requestId = submitResult.requestId;
    
    // Progress through pipeline
    await waitForPhase(requestId, 'deploy');
    
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    // Hotfix should complete faster due to skipped phases
    expect(duration).toBeLessThan(60000); // Under 1 minute for test
    
    // Verify phases were skipped
    const state = getRequestState(requestId);
    const phaseHistory = state.phase_history.map(p => p.state);
    
    expect(phaseHistory).not.toContain('prd');
    expect(phaseHistory).not.toContain('prd_review');
    expect(phaseHistory).not.toContain('plan_review');
  });
  
  test('mixed request types processed correctly', async () => {
    // Submit multiple request types
    const requests = await Promise.all([
      cli.execute(['request', 'submit', '--type', 'feature', 'Add user dashboard']),
      cli.execute(['request', 'submit', '--type', 'bug', '--bug-context', JSON.stringify(createTestBugReport())]),
      cli.execute(['request', 'submit', '--type', 'hotfix', 'Fix security vulnerability']),
    ]);
    
    const [featureId, bugId, hotfixId] = requests.map(r => r.requestId);
    
    // Wait for daemon processing
    await waitForProcessing();
    
    // Verify each type follows correct pipeline
    const featureState = getRequestState(featureId);
    const bugState = getRequestState(bugId);
    const hotfixState = getRequestState(hotfixId);
    
    // Feature should go through PRD
    expect(featureState.phase_overrides).toContain('prd');
    
    // Bug should skip PRD
    expect(bugState.phase_overrides).not.toContain('prd');
    expect(bugState.bug_context).toBeDefined();
    
    // Hotfix should be expedited
    expect(hotfixState.type_config.expeditedReviews).toBe(true);
  });
});
```

### 12.3 Backward Compatibility Tests

```typescript
describe('Backward Compatibility Tests', () => {
  test('v1.0 state files migrate seamlessly', () => {
    const v1_0_states = [
      createLegacyFeatureState(),
      createLegacyPendingRequest(),
      createLegacyCompletedRequest()
    ];
    
    v1_0_states.forEach(state => {
      const migrated = migrateStateV1_0ToV1_1(state);
      
      expect(migrated.schema_version).toBe(1.1);
      expect(migrated.request_type).toBe('feature');
      expect(migrated.id).toBe(state.id);
      expect(migrated.status).toBe(state.status);
    });
  });
  
  test('daemon handles mixed v1.0 and v1.1 state files', async () => {
    // Create mixed environment
    await createV1_0StateFile('REQ-old-001');
    await createV1_1StateFile('REQ-new-001', 'bug');
    
    const daemon = new TestDaemon();
    await daemon.start();
    
    // Both should be discoverable
    const availableRequests = await daemon.getAvailableRequests();
    expect(availableRequests).toContain('REQ-old-001');
    expect(availableRequests).toContain('REQ-new-001');
    
    // v1.0 file should be migrated automatically
    const oldState = await getRequestState('REQ-old-001');
    expect(oldState.schema_version).toBe(1.1);
  });
  
  test('CLI commands work with legacy requests', async () => {
    const legacyRequestId = await createLegacyRequest();
    
    // All commands should work
    const statusResult = await cli.execute(['request', 'status', legacyRequestId]);
    expect(statusResult.success).toBe(true);
    
    const pauseResult = await cli.execute(['request', 'pause', legacyRequestId]);
    expect(pauseResult.success).toBe(true);
    
    const resumeResult = await cli.execute(['request', 'resume', legacyRequestId]);
    expect(resumeResult.success).toBe(true);
  });
});
```

## 13. Performance Considerations

### 13.1 Phase Resolution Overhead

The phase override resolution must complete within 100ms per request to meet NFR-1102. The implementation optimizes for:

```typescript
/**
 * Performance-optimized phase resolution
 */
export class PhaseResolver {
  private static readonly PHASE_CACHE = new Map<RequestType, string[]>();
  
  /**
   * Resolves phase sequence with caching for performance
   */
  static resolvePhases(requestType: RequestType): string[] {
    // Use cached result if available
    if (this.PHASE_CACHE.has(requestType)) {
      return this.PHASE_CACHE.get(requestType)!;
    }
    
    // Compute and cache
    const phases = getPhaseSequence(requestType);
    this.PHASE_CACHE.set(requestType, phases);
    
    return phases;
  }
  
  /**
   * Batch phase resolution for multiple requests
   */
  static resolvePhasesForRequests(requests: RequestTypeMapping[]): PhaseResolutionResult[] {
    return requests.map(req => ({
      requestId: req.id,
      phases: this.resolvePhases(req.type),
      timestamp: Date.now()
    }));
  }
}
```

### 13.2 State File Performance Impact

```bash
# Performance monitoring for state file operations
monitor_state_performance() {
    local operation="$1"
    local start_time end_time duration
    
    start_time=$(date +%s%N)
    
    case "$operation" in
        "read")
            # Monitor state file reads
            for state_file in ~/.autonomous-dev/requests/*/state.json; do
                jq -r '.request_type // "feature"' "$state_file" >/dev/null
            done
            ;;
        "migrate")
            # Monitor migration operations
            migrate_state_inline "$test_state_content" >/dev/null
            ;;
        "validate")
            # Monitor type validation
            validate_request_type "bug" >/dev/null
            ;;
    esac
    
    end_time=$(date +%s%N)
    duration=$(( (end_time - start_time) / 1000000 )) # Convert to milliseconds
    
    if [[ $duration -gt 100 ]]; then
        echo "WARNING: $operation took ${duration}ms (exceeds 100ms target)"
    fi
    
    echo "$operation: ${duration}ms"
}

# Benchmark phase resolution
benchmark_phase_resolution() {
    local iterations=1000
    local total_time=0
    
    for ((i=1; i<=iterations; i++)); do
        local start_time end_time duration
        start_time=$(date +%s%N)
        
        get_next_phase "tdd" "bug" >/dev/null
        
        end_time=$(date +%s%N)
        duration=$(( (end_time - start_time) / 1000000 ))
        total_time=$((total_time + duration))
    done
    
    local average=$((total_time / iterations))
    echo "Phase resolution average: ${average}ms over $iterations iterations"
    
    if [[ $average -gt 1 ]]; then
        echo "WARNING: Phase resolution slower than 1ms target"
    fi
}
```

### 13.3 Memory Usage Optimization

The phase override matrix is designed to minimize memory footprint:

- Pre-computed phase sequences cached at startup
- Immutable configuration prevents runtime modifications  
- Lightweight enum types reduce memory usage
- No dynamic phase sequence generation per request

## 14. Migration & Rollout Plan

### 14.1 Phase 1: Core Infrastructure (Week 1)

**Deliverables:**
- `RequestType` enum and validation functions
- `PhaseOverrideMatrix` data structure
- State schema v1.1 definition
- Migration functions for v1.0 → v1.1

**Acceptance Criteria:**
- All unit tests pass for type system
- Schema migration preserves existing data
- Performance benchmarks meet <100ms target

**Risk Mitigation:**
- Feature flag for enabling type system
- Automatic fallback to v1.0 behavior on errors

### 14.2 Phase 2: Daemon Integration (Week 2)  

**Deliverables:**
- Enhanced `select_request()` with type awareness
- Type-aware session spawning logic
- Backward compatibility for mixed version environments

**Acceptance Criteria:**
- Daemon correctly processes both v1.0 and v1.1 requests
- Type-specific phase progression working
- Zero downtime migration of existing requests

**Validation:**
- Integration tests with mixed request types
- Load testing with 100+ concurrent requests
- Chaos testing with daemon restarts during migration

### 14.3 Phase 3: Bug Intake & CLI (Week 3)

**Deliverables:**
- Bug report schema and validation
- CLI `--type` parameter integration
- TDD-author agent bug-specific prompts

**Acceptance Criteria:**
- Bug requests bypass PRD generation
- CLI validation prevents invalid submissions  
- Agent produces bug-focused TDD documents

**User Testing:**
- Submit 10 realistic bug reports via CLI
- Verify end-to-end bug fix pipeline
- Validate TDD quality for bug analysis

### 14.4 Phase 4: Full Type Support (Week 4)

**Deliverables:**
- Complete type catalog implementation
- Enhanced gates for infra/hotfix types
- Comprehensive test coverage

**Acceptance Criteria:**
- All 5 request types fully operational
- Type-specific optimizations working
- Documentation complete

**Production Readiness:**
- Performance benchmarks under load
- Security review of type validation
- Operator training on new features

### 14.5 Rollback Strategy

```bash
# Emergency rollback procedures
rollback_request_types() {
    echo "EMERGENCY ROLLBACK: Disabling request types"
    
    # 1. Stop daemon
    autonomous-dev daemon stop
    
    # 2. Disable type CLI options  
    sed -i 's/--type/--disabled-type/g' bin/autonomous-dev.sh
    
    # 3. Force all requests to feature type
    find ~/.autonomous-dev -name "state.json" -exec \
        jq '.request_type = "feature"' {} \; > /tmp/migration.log
    
    # 4. Restart with v1.0 behavior
    export AUTONOMOUS_DEV_FORCE_V1_0=true
    autonomous-dev daemon start
    
    echo "Rollback complete. All requests using feature pipeline."
}
```

## 15. Open Questions

| ID | Question | Impact | Recommendation | Status |
|----|----------|--------|----------------|--------|
| OQ-01 | Should bug context be editable after submission, or immutable like request type? | User experience vs data integrity | Make bug context editable during intake phase only, immutable after TDD generation starts | Proposed |
| OQ-02 | How should the system handle requests that could fit multiple types (e.g., security bug vs hotfix)? | Classification accuracy | Require user to choose primary type, add secondary classification via labels field | Proposed |
| OQ-03 | Should infra requests require approval gates before TDD generation, or only before deployment? | Security vs velocity | Security gates only before deployment to avoid blocking TDD analysis | Proposed |
| OQ-04 | How should the CLI handle bug report submission when some optional fields are missing? | User experience | Prompt for required fields only, make optional fields discoverable via --help | Proposed |
| OQ-05 | Should hotfix requests support automatic rollback triggers if deployment fails? | Risk management | Yes, integrate with deployment monitoring to trigger automatic rollback on failure | Open |
| OQ-06 | How should the phase override matrix handle custom request types added by extensions? | Extensibility | Provide plugin API to register custom types with phase configurations | Deferred to TDD-019 |
| OQ-07 | Should bug severity automatically influence request priority, or remain independent? | Request prioritization | Keep independent - severity is technical impact, priority is business importance | Proposed |
| OQ-08 | How should the system handle migration of in-flight requests during rollout? | Migration safety | Complete current phase before applying type-specific logic to minimize disruption | Proposed |

## 16. References

### 16.1 Design Documents

- **PRD-011**: Pipeline Variants & Extension Hooks - Core requirements and type taxonomy
- **TDD-001**: Daemon Engine - State machine and request selection logic foundation
- **TDD-002**: State Machine & Request Lifecycle - Schema definitions and lifecycle management
- **TDD-011**: Multi-Channel Intake Adapters - CLI integration and request submission

### 16.2 Implementation Files

Referenced implementation will modify these key files:

- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/tdd/TDD-002-state-machine.md` - State schema extension
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/tdd/TDD-001-daemon-engine.md` - Request selection logic
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/bin/autonomous-dev.sh` - CLI type parameter
- `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/src/pipeline/flow/pipeline-state.ts` - TypeScript type definitions

### 16.3 Standards & Specifications

- **JSON Schema Draft 2020-12**: Bug report validation schema format
- **ISO 8601**: Timestamp formats in state files and bug reports  
- **RFC 5424**: Structured logging for type-specific events
- **Semantic Versioning 2.0**: State schema versioning strategy

---

**Implementation Priority**: High - Foundational system enabling all pipeline optimization features
**Estimated Effort**: 4 weeks (1 senior engineer)  
**Dependencies**: TDD-001, TDD-002, TDD-011 completion
**Successor**: TDD-019 (Extension Hooks & Plugin Manifests)