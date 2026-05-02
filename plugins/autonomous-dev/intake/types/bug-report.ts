/**
 * BugReport interface + JSON schema re-export (SPEC-018-3-01, Task 1).
 *
 * The canonical bug-context contract used whenever a request carries
 * `request_type === 'bug'`. The TypeScript interface mirrors TDD-018 §6.1
 * verbatim; the JSON schema (loaded from `schemas/bug-report.json`)
 * mirrors TDD-018 §6.2.
 *
 * The two are hand-maintained in lockstep. AJV consumes the schema at
 * intake time; TypeScript code consumes the interface. Keeping them
 * literal duplicates is intentional: a future spec may auto-generate the
 * interface from the schema, but for now readability wins.
 *
 * @module intake/types/bug-report
 */
import schemaJson from '../../schemas/bug-report.json';

/**
 * Severity levels recognized by the schema's `severity` enum.
 * `medium` is applied as the default at the daemon layer when omitted.
 */
export type Severity = 'low' | 'medium' | 'high' | 'critical';

/**
 * Required environment block: the developer's local conditions when the
 * bug was observed. All three fields are mandatory because they drive
 * downstream reproducibility analysis.
 */
export interface BugEnvironment {
  /** Operating system + version string, e.g. `"macOS 14.4"`. */
  os: string;
  /** Runtime + version string, e.g. `"node 20.11.0"` or `"bun 1.0.30"`. */
  runtime: string;
  /** Package version where the bug was observed. */
  version: string;
}

/**
 * Structured bug-context payload validated against
 * {@link BUG_REPORT_SCHEMA_PATH}.
 *
 * Required vs optional matches the JSON schema's `required` array.
 * Field-level constraints (lengths, minItems, enum values) are enforced
 * by AJV; this type only conveys shape.
 */
export interface BugReport {
  // -- Required ---------------------------------------------------------
  /** 1-200 chars; short, human-friendly bug title. */
  title: string;
  /** 1-4000 chars; free-text description of the problem. */
  description: string;
  /** Ordered repro steps; ≥1 item, each non-empty. */
  reproduction_steps: string[];
  /** 1-2000 chars; what the user expected to happen. */
  expected_behavior: string;
  /** 1-2000 chars; what actually happened. */
  actual_behavior: string;
  /** ≥0 verbatim stack traces / log lines; may be empty. */
  error_messages: string[];
  /** Required environment block. */
  environment: BugEnvironment;

  // -- Optional ---------------------------------------------------------
  /** Module/package paths suspected to be implicated. */
  affected_components?: string[];
  /** Bug severity; defaults to `'medium'` at the daemon layer if omitted. */
  severity?: Severity;
  /** Free-form tags for triage. */
  labels?: string[];
  /** 1-1000 chars; describes user impact. */
  user_impact?: string;
}

/**
 * Repo-relative path to the schema file. Used by AJV loaders that
 * resolve `$ref` lookups by filename.
 */
export const BUG_REPORT_SCHEMA_PATH = 'schemas/bug-report.json';

/**
 * The parsed JSON schema object, re-exported for runtime validation
 * (e.g. `new Ajv({strict:true}).compile(BugReportSchema)`).
 *
 * Loaded via `resolveJsonModule` so the schema travels with the bundle
 * and stays in sync with the on-disk file.
 */
export const BugReportSchema = schemaJson as Readonly<Record<string, unknown>>;

/**
 * Lightweight runtime guard for {@link BugReport}.
 *
 * This is a SHAPE check only — string lengths, array minItems, and the
 * severity enum are NOT validated here. Use AJV against
 * {@link BugReportSchema} when full validation is required (e.g. at the
 * intake boundary). This helper exists for cheap defensive checks in
 * code paths that have already passed AJV validation but still want a
 * type narrowing without re-validating.
 */
export function isBugReportShape(value: unknown): value is BugReport {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.title !== 'string') return false;
  if (typeof v.description !== 'string') return false;
  if (!Array.isArray(v.reproduction_steps)) return false;
  if (typeof v.expected_behavior !== 'string') return false;
  if (typeof v.actual_behavior !== 'string') return false;
  if (!Array.isArray(v.error_messages)) return false;
  if (v.environment === null || typeof v.environment !== 'object') return false;
  const env = v.environment as Record<string, unknown>;
  if (typeof env.os !== 'string') return false;
  if (typeof env.runtime !== 'string') return false;
  if (typeof env.version !== 'string') return false;
  return true;
}
