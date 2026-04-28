# TDD-021: Standards DSL & Auto-Detection

| Field        | Value                                              |
|--------------|----------------------------------------------------|
| **Title**    | Standards DSL & Auto-Detection                      |
| **TDD ID**   | TDD-021                                            |
| **Version**  | 1.0                                                |
| **Date**     | 2026-04-28                                         |
| **Status**   | Draft                                              |
| **Author**   | Patrick Watson                                     |
| **Parent PRD** | PRD-013: Engineering Standards & Plugin Chaining |
| **Plugin**   | autonomous-dev                                     |

---

## 1. Summary

This TDD specifies the engineering-standards artifact (`standards.yaml`), its declarative DSL, the auto-detection scanner, the inheritance resolver, custom-evaluator subprocess sandbox, and the standards-meta-reviewer governance agent. It honors PRD-013 §19 binding updates: ReDoS sandbox via worker threads, custom-evaluator subprocess sandbox, namespaced rule IDs.

Plugin chaining (PRD-013 §5.4) is owned by sibling TDD-022 — this TDD focuses on the standards artifact and its evaluation.

## 2. Goals & Non-Goals

| ID   | Goal                                                                          |
|------|-------------------------------------------------------------------------------|
| G-01 | Versioned standards artifact at `<repo>/.autonomous-dev/standards.yaml`.      |
| G-02 | Declarative DSL with predicates and assertions for engineering rules.         |
| G-03 | Auto-detection from repo signals (eslint/prettier/jest/tsconfig/imports).     |
| G-04 | Hierarchical inheritance: per-request → repo → org → defaults.                |
| G-05 | Standards-aware author agents (prd/tdd/code) read rules at task start.        |
| G-06 | Custom evaluator subprocess sandbox (execFile, ro-fs, no-net, 30s/256MB).     |
| G-07 | ReDoS defense via worker-thread regex sandbox (100ms timeout).                |
| G-08 | Namespaced rule IDs (`<plugin>:<id>`) prevent shadowing collisions.            |

| ID    | Non-Goal                                                                |
|-------|--------------------------------------------------------------------------|
| NG-01 | Plugin chaining (`produces`/`consumes`) — TDD-022 scope.                |
| NG-02 | Reviewer agents that consume standards — TDD-020 scope.                 |
| NG-03 | Replacing existing linters (eslint, prettier, etc.).                    |
| NG-04 | Real-time standards evaluation during typing.                           |

## 3. Background

Engineering teams accumulate implicit rules: "use FastAPI for Python services", "every backend exposes /health", "no string-concatenated SQL", "tests live in `tests/`". These live in tribal knowledge. autonomous-dev produces code that violates them silently. PRD-013 introduces a versionable standards artifact to make these explicit and enforceable.

## 4. Architecture

```
.autonomous-dev/standards.yaml (repo)
    │
~/.claude/autonomous-dev/standards.yaml (org, optional)
    │
    ▼
┌────────────────────┐
│ InheritanceResolver│ ── per-request → repo → org → defaults
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│ ResolvedStandards  │ ── cached for request lifetime
│ (in-memory)        │
└─────┬───────┬──────┘
      │       │
      ▼       ▼
[Author     [rule-set-enforcement-reviewer
 agents]     (TDD-020) — invokes evaluators]
      │       │
      └───┬───┘
          ▼
┌────────────────────┐
│ Evaluator Registry │ — built-in + custom (allowlisted)
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│ Subprocess Sandbox │ ── execFile, ro-fs, no-net, 30s, 256MB
└────────────────────┘
```

## 5. Standards Artifact Schema

JSON Schema at `plugins/autonomous-dev/schemas/standards-v1.json`:

```json
{
  "$id": "https://autonomous-dev/schemas/standards-v1.json",
  "type": "object",
  "required": ["version", "rules"],
  "properties": {
    "version": {"const": "1.0"},
    "metadata": {
      "type": "object",
      "properties": {
        "name": {"type": "string"},
        "description": {"type": "string"},
        "owner": {"type": "string"},
        "last_updated": {"type": "string", "format": "date"}
      }
    },
    "rules": {
      "type": "array",
      "items": {"$ref": "#/$defs/rule"}
    }
  },
  "$defs": {
    "rule": {
      "type": "object",
      "required": ["id", "severity", "description", "applies_to", "requires", "evaluator"],
      "properties": {
        "id": {"type": "string", "pattern": "^[a-z0-9-]+:[a-z0-9-]+$"},
        "severity": {"enum": ["advisory", "warn", "blocking"]},
        "immutable": {"type": "boolean", "default": false},
        "description": {"type": "string"},
        "applies_to": {"$ref": "#/$defs/predicate"},
        "requires": {"$ref": "#/$defs/assertion"},
        "evaluator": {"type": "string"}
      }
    },
    "predicate": {
      "type": "object",
      "properties": {
        "language": {"type": ["string", "array"]},
        "service_type": {"enum": ["backend", "frontend", "library", "cli"]},
        "framework": {"type": ["string", "array"]},
        "implements": {"type": "string"},
        "path_pattern": {"type": "string"}
      }
    },
    "assertion": {
      "type": "object",
      "properties": {
        "framework_match": {"type": "string"},
        "exposes_endpoint": {"type": "string"},
        "uses_pattern": {"type": "string"},
        "excludes_pattern": {"type": "string"},
        "dependency_present": {"type": "string"},
        "custom_evaluator_args": {"type": "object"}
      }
    }
  }
}
```

### Example standards.yaml

```yaml
version: "1.0"
metadata:
  name: my-org engineering standards
  owner: platform-team
  last_updated: 2026-04-28
rules:
  - id: "org:python-fastapi-only"
    severity: blocking
    description: Python services must use FastAPI
    applies_to:
      language: python
      service_type: backend
    requires:
      framework_match: fastapi
    evaluator: framework-detector

  - id: "org:health-endpoint-required"
    severity: warn
    description: All backend services expose GET /health
    applies_to:
      service_type: backend
    requires:
      exposes_endpoint: /health
    evaluator: endpoint-scanner

  - id: "org:parameterized-sql"
    severity: blocking
    immutable: true
    description: Database queries use parameterized statements
    applies_to:
      implements: database_client
    requires:
      excludes_pattern: ".*\\\.format\\(.*query.*"
    evaluator: sql-injection-detector
```

## 6. Built-in Evaluator Catalog

| Evaluator              | Purpose                                                       |
|------------------------|----------------------------------------------------------------|
| framework-detector     | Inspects package.json, requirements.txt for framework imports |
| endpoint-scanner       | Greps for HTTP route declarations matching given path         |
| sql-injection-detector | Pattern match for unsafe string-format SQL                    |
| dependency-checker     | Verifies package.json/requirements.txt entry exists           |
| pattern-grep           | Generic regex match (uses_pattern/excludes_pattern)           |

Each is implemented as a TS module in `intake/standards/evaluators/`.

## 7. Custom Evaluator Subprocess Sandbox

Custom evaluators run as separate processes via `execFile` with strict resource limits.

```typescript
import { execFile } from "child_process";
import { promisify } from "util";

interface CustomEvaluatorResult {
  passed: boolean;
  findings: Array<{file: string; line: number; severity: string; message: string}>;
}

async function runCustomEvaluator(
  evaluatorPath: string,
  filePaths: string[],
  args: Record<string, unknown>
): Promise<CustomEvaluatorResult> {
  // Verify evaluator is in allowlist
  if (!config.extensions.evaluators_allowlist.includes(evaluatorPath)) {
    throw new SecurityError(`Evaluator not allowlisted: ${evaluatorPath}`);
  }

  const argv = [...filePaths, "--args", JSON.stringify(args)];
  const result = await promisify(execFile)(evaluatorPath, argv, {
    timeout: 30_000,           // 30s wall clock
    maxBuffer: 10 * 1024 * 1024,  // 10MB stdout
    env: {},                    // empty env — no inherited secrets
    cwd: "/tmp/eval-sandbox",   // ro-mounted scratch dir on Linux
  });

  // Parse JSON stdout per the contract
  return JSON.parse(result.stdout);
}
```

Linux: additional isolation via `unshare --net --mount` and `prlimit --as=268435456` (256MB).
macOS: `sandbox-exec` profile denying network and limiting filesystem.

Custom evaluator contract (callable script):

```bash
#!/bin/bash
# Input: file paths as argv, optional --args '{"key":"val"}'
# Output: JSON to stdout matching CustomEvaluatorResult schema
# Exit codes: 0 ok, 1 violations found, 2 evaluation error
```

## 8. Inheritance Resolver

```typescript
interface ResolvedStandards {
  rules: Map<string, Rule>;     // keyed by rule.id
  source: Map<string, "default" | "org" | "repo" | "request">;
}

function resolveStandards(
  defaultRules: Rule[],
  orgRules: Rule[],
  repoRules: Rule[],
  requestOverrides: Rule[]
): ResolvedStandards {
  const resolved = new Map<string, Rule>();
  const source = new Map<string, "default" | "org" | "repo" | "request">();

  for (const rule of defaultRules) { resolved.set(rule.id, rule); source.set(rule.id, "default"); }
  for (const rule of orgRules) { resolved.set(rule.id, rule); source.set(rule.id, "org"); }

  // Repo rules override unless org rule is immutable
  for (const rule of repoRules) {
    const existing = resolved.get(rule.id);
    if (existing?.immutable && source.get(rule.id) === "org") {
      throw new ValidationError(`Cannot override immutable org rule: ${rule.id}`);
    }
    resolved.set(rule.id, rule); source.set(rule.id, "repo");
  }

  // Per-request overrides require admin authorization
  for (const rule of requestOverrides) {
    if (!isAdminRequest()) throw new AuthorizationError();
    resolved.set(rule.id, rule); source.set(rule.id, "request");
  }

  return { rules: resolved, source };
}
```

## 9. Auto-Detection Scanner

Runs once per repo at first install. Outputs `<repo>/.autonomous-dev/standards.inferred.yaml` with confidence scores.

```typescript
interface DetectedRule extends Rule {
  confidence: number;      // 0-1
  evidence: string[];      // file paths supporting the inference
}

async function detectStandards(repoPath: string): Promise<DetectedRule[]> {
  const detected: DetectedRule[] = [];

  // Framework detection
  const pkg = await loadJsonOptional(join(repoPath, "package.json"));
  if (pkg?.dependencies?.fastapi) {
    detected.push({
      id: "auto:python-fastapi",
      severity: "advisory",
      description: "Repo uses FastAPI; codify as standard",
      applies_to: { language: "python", service_type: "backend" },
      requires: { framework_match: "fastapi" },
      evaluator: "framework-detector",
      confidence: 0.9,
      evidence: ["package.json"]
    });
  }

  // ESLint config detection
  // Prettier config detection
  // tsconfig strict mode
  // Jest test file patterns
  // ... etc

  return detected;
}
```

Detection signals & confidence rubric:

| Signal                              | Confidence |
|-------------------------------------|------------|
| Explicit dep in package.json        | 0.9        |
| Used in 80%+ of files               | 0.8        |
| Mentioned in README                 | 0.6        |
| Single example file                 | 0.4        |

Operator promotes inferred rules to `standards.yaml` after review.

## 10. ReDoS Defense (Per §19.3)

All `uses_pattern`/`excludes_pattern` regexes evaluated in worker-thread sandbox:

```typescript
import { Worker } from "worker_threads";

async function evaluateRegex(pattern: string, input: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (input.length > 10_000) reject(new Error("Input exceeds 10KB cap"));

    const worker = new Worker("./regex-worker.js", {
      workerData: { pattern, input },
      resourceLimits: { maxOldGenerationSizeMb: 64 }
    });

    const timer = setTimeout(() => {
      worker.terminate();
      reject(new ReDoSError(`Regex execution exceeded 100ms: ${pattern}`));
    }, 100);

    worker.on("message", (matched: boolean) => {
      clearTimeout(timer);
      resolve(matched);
    });
    worker.on("error", reject);
  });
}
```

Test-compile of regex at standards-load time using `re2` (linear-time engine) when available; falls back to worker-thread sandbox.

## 11. Standards-Aware Author Agents

prd-author, tdd-author, code-executor receive a structured prompt section:

```
## Engineering Standards (auto-applied)

The following rules apply to this work:

[blocking] org:python-fastapi-only — Python services must use FastAPI
  ↳ When you generate Python backend code, import from `fastapi` not `flask`.

[warn] org:health-endpoint-required — All backend services expose GET /health
  ↳ Include a `/health` route returning 200 in any backend service you scaffold.

[blocking] org:parameterized-sql — Database queries use parameterized statements
  ↳ Use `cursor.execute(sql, params)`. Never f-strings or .format() in SQL.

If any rule is unworkable for this task, document the deviation in the artifact's "Known Limitations" section. Do NOT silently violate.
```

## 12. Standards Governance

`standards-meta-reviewer` agent (`agents/standards-meta-reviewer.md`):

```markdown
---
name: standards-meta-reviewer
description: Audits proposed changes to standards.yaml for consistency, workability, and conflict with existing rules.
model: claude-sonnet-4-6
tools: Read, Glob, Grep
---

You are the standards meta-reviewer. When standards.yaml is modified:

1. Detect rule conflicts (two rules requiring opposite things)
2. Detect unworkability (rule requires X but X is unattainable on this stack)
3. Detect impact: scan recent commits — would this rule fail on existing code?
4. Detect overly broad predicates (catches unintended files)

Output verdict and findings JSON. Major changes (immutable rules, framework requirements) escalate to two-person approval.
```

## 13. Fix-Recipe Schema (For TDD-022 Plugin Chains)

When rule-set-enforcement-reviewer (TDD-020) flags a violation, it emits a structured fix-recipe:

```json
{
  "violation_id": "VIO-2026-04-28-0042",
  "rule_id": "org:parameterized-sql",
  "file": "src/db/users.py",
  "line": 42,
  "fix_type": "code-replacement",
  "before": "f\"SELECT * FROM users WHERE id = {user_id}\"",
  "after_template": "\"SELECT * FROM users WHERE id = %s\", (user_id,)",
  "confidence": 0.85
}
```

Code-fixer plugins (chained per TDD-022) consume these.

## 14. Test Strategy

- Schema validation tests: 50+ standards.yaml fixtures (valid + invalid)
- Built-in evaluator tests per evaluator (framework-detector, endpoint-scanner, etc.)
- ReDoS adversarial: catastrophic-backtracking patterns must time out cleanly within 100ms
- Inheritance precedence tests: 8+ scenarios covering immutability + override authorization
- Custom evaluator sandbox tests: try to escape (network connect, write outside cwd, exceed memory) — all must be blocked
- Auto-detection tests: 20 known repos with ground-truth expected detections; precision ≥80% per signal type

## 15. Performance

- Standards resolution: <5s for 100-rule org+repo merge
- Rule evaluation: <30s p95 for 500 files × 50 applicable rules
- File-hash cache invalidation: <100ms cache hit; miss triggers re-evaluation only for changed files
- Custom evaluator subprocess: 30s hard timeout; <2s typical

## 16. Migration & Rollout

- Phase 1 (Weeks 1-3): Schema + auto-detection + advisory-only rules
- Phase 2 (Weeks 4-6): Standards-aware author agents read and respect rules
- Phase 3 (Weeks 7-9): rule-set-enforcement-reviewer enforces blocking rules
- Phase 4 (Weeks 10-12): Custom evaluators + governance workflow

Rollback: rules can be downgraded from blocking to warn at any time without redeployment.

## 17. Security

- Evaluator allowlist: `extensions.evaluators_allowlist` in config; runtime addition requires admin
- ReDoS sandbox enforced for all user-supplied regex
- Custom evaluator subprocess: no env vars, ro filesystem, no network, 30s/256MB caps
- Rule IDs namespaced to prevent shadowing
- Immutable rules at org level cannot be overridden at repo without admin

## 18. Open Questions

1. Should standards rules support semver evolution (rule v1 grandfathered for old code)?
2. Cross-language rules (parameterized SQL applies to Python AND Node)?
3. Performance at scale (100+ repos × 200+ rules)?
4. Custom evaluator distribution: bundled with plugin or separate?

## 19. References

- PRD-013 (whole + §19)
- TDD-019 (rule-evaluation hook)
- TDD-020 (rule-set-enforcement-reviewer consumes standards)
- TDD-022 (plugin chaining for fix-recipe → code-fixer)
