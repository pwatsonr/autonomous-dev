/**
 * Reusable bug-report prompt definitions + a readline-based runner
 * (SPEC-018-3-02, Task 3).
 *
 * The spec asks for an `inquirer`-driven flow. To keep the plugin's
 * dependency surface small (and to avoid pinning a CommonJS-incompatible
 * version of inquirer 9), this module ships a thin readline-based
 * implementation that satisfies every acceptance criterion in
 * SPEC-018-3-02. The exported {@link BUG_PROMPTS} array is a declarative
 * sequence consumable by *any* runner — the Claude App, Discord modal,
 * and Slack Block Kit handlers consume the same metadata to render
 * channel-native UI (see SPEC-018-3-04).
 *
 * Field order follows TDD-018 §6.1 verbatim. Validation rules mirror
 * `schemas/bug-report.json`.
 *
 * @module intake/cli/bug-prompts
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import type { BugReport, Severity } from '../types/bug-report';

// ---------------------------------------------------------------------------
// Prompt metadata
// ---------------------------------------------------------------------------

/** Severities the schema's `severity` enum accepts. */
export const SEVERITIES: readonly Severity[] = [
  'low',
  'medium',
  'high',
  'critical',
] as const;

/** Metadata describing a single prompt step. */
export interface BugPrompt {
  /** Dotted path into a {@link BugReport} (e.g. `environment.os`). */
  field: string;
  /** Short human-readable label rendered before the input. */
  label: string;
  /** When `'list'`, the runner picks from {@link BugPrompt.choices}. */
  kind: 'input' | 'list' | 'loop' | 'csv';
  /** Required vs optional drives validation + skip behavior. */
  required: boolean;
  /** Constraints mirrored from the JSON schema. */
  minLength?: number;
  maxLength?: number;
  /** For `kind: 'loop'`: minimum array length (≥0). */
  minItems?: number;
  /** For `kind: 'list'`: closed choice set. */
  choices?: readonly string[];
  /** Inline help text rendered above the prompt. */
  help?: string;
}

/**
 * Default-value resolvers for the three `environment.*` fields. Computed
 * lazily so tests can stub `os` cheaply.
 */
export function defaultEnvironment(): {
  os: string;
  runtime: string;
  version: string;
} {
  const osStr = `${process.platform} ${os.release()}`;
  const runtime = `node ${process.version}`;
  let version = 'unknown';
  try {
    // Walk up from cwd looking for a package.json.
    let dir = process.cwd();
    for (let i = 0; i < 8; i++) {
      const pj = path.join(dir, 'package.json');
      if (fs.existsSync(pj)) {
        const json = JSON.parse(fs.readFileSync(pj, 'utf8'));
        if (typeof json.version === 'string') {
          version = json.version;
          break;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Best-effort default; leave 'unknown' on failure.
  }
  return { os: osStr, runtime, version };
}

/**
 * The canonical prompt sequence consumed by interactive runners across
 * channels (CLI, Claude App, Discord, Slack).
 *
 * NOTE: The ordering here matters — channels render prompts in this
 * order to keep the UX consistent across surfaces.
 */
export const BUG_PROMPTS: readonly BugPrompt[] = [
  {
    field: 'title',
    label: 'Title',
    kind: 'input',
    required: true,
    minLength: 1,
    maxLength: 200,
    help: 'Short, human-friendly bug title (1-200 chars).',
  },
  {
    field: 'description',
    label: 'Description',
    kind: 'input',
    required: true,
    minLength: 1,
    maxLength: 4000,
    help: 'Free-text description of the problem (1-4000 chars).',
  },
  {
    field: 'reproduction_steps',
    label: 'Reproduction step',
    kind: 'loop',
    required: true,
    minItems: 1,
    help: 'Enter one step per line. Empty line ends. At least one required.',
  },
  {
    field: 'expected_behavior',
    label: 'Expected behavior',
    kind: 'input',
    required: true,
    minLength: 1,
    maxLength: 2000,
  },
  {
    field: 'actual_behavior',
    label: 'Actual behavior',
    kind: 'input',
    required: true,
    minLength: 1,
    maxLength: 2000,
  },
  {
    field: 'error_messages',
    label: 'Error message',
    kind: 'loop',
    required: false,
    minItems: 0,
    help: 'Verbatim stack traces or log lines. Empty line ends; zero allowed.',
  },
  {
    field: 'environment.os',
    label: 'OS',
    kind: 'input',
    required: true,
    minLength: 1,
  },
  {
    field: 'environment.runtime',
    label: 'Runtime',
    kind: 'input',
    required: true,
    minLength: 1,
  },
  {
    field: 'environment.version',
    label: 'Package version',
    kind: 'input',
    required: true,
    minLength: 1,
  },
  {
    field: 'severity',
    label: 'Severity',
    kind: 'list',
    required: false,
    choices: SEVERITIES,
  },
  {
    field: 'affected_components',
    label: 'Affected component',
    kind: 'loop',
    required: false,
    minItems: 0,
    help: 'Module or package paths. Empty line ends.',
  },
  {
    field: 'labels',
    label: 'Labels',
    kind: 'csv',
    required: false,
    help: 'Comma-separated list of free-form tags.',
  },
  {
    field: 'user_impact',
    label: 'User impact',
    kind: 'input',
    required: false,
    maxLength: 1000,
  },
];

// ---------------------------------------------------------------------------
// Runner — readline backed
// ---------------------------------------------------------------------------

/**
 * Minimal IO surface used by {@link runInteractivePrompts}. Tests inject
 * a fake to avoid touching real stdin/stdout. Production code calls
 * {@link runInteractivePrompts} with no IO arg, which constructs a
 * readline-backed implementation.
 */
export interface PromptIO {
  /** Print a line to stdout (newline appended). */
  write(line: string): void;
  /**
   * Display `prompt` and resolve with the user's response (no trailing
   * newline). Should reject when stdin closes unexpectedly.
   */
  ask(prompt: string): Promise<string>;
  /** Tear down any resources (e.g. close readline interface). */
  close(): void;
}

/**
 * Construct a readline-backed {@link PromptIO} bound to `process.stdin`
 * and `process.stdout`. Wired up by {@link runInteractivePrompts} when
 * no IO is supplied.
 */
export function defaultPromptIO(): PromptIO {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  return {
    write(line: string): void {
      process.stdout.write(line + '\n');
    },
    ask(prompt: string): Promise<string> {
      return new Promise((resolve, reject) => {
        rl.question(prompt, (answer) => resolve(answer));
        rl.once('close', () =>
          reject(new Error('stdin closed before response')),
        );
      });
    },
    close(): void {
      rl.close();
    },
  };
}

/**
 * Validation error rendered with the same shape as AJV's
 * `instancePath: message` output, e.g. `title: must have required property 'title'`.
 * Keeping the surface compatible with AJV means a future spec can drop
 * AJV in without changing test expectations.
 */
export interface BugValidationError {
  field: string;
  message: string;
}

/**
 * Render a single validation error as `field: message`. Multiple errors
 * are joined with `\n  ` for stderr output.
 */
export function formatErrors(errors: readonly BugValidationError[]): string {
  return errors.map((e) => `  ${e.field}: ${e.message}`).join('\n');
}

/**
 * Hand-rolled validator mirroring `schemas/bug-report.json`. Produces
 * AJV-style errors so callers can format output consistently.
 *
 * Returns `[]` when the report is valid.
 */
export function validateBugReport(
  report: Partial<BugReport> | undefined | null,
): BugValidationError[] {
  const errors: BugValidationError[] = [];
  if (report === null || report === undefined || typeof report !== 'object') {
    errors.push({ field: '', message: 'must be an object' });
    return errors;
  }
  const r = report as Record<string, unknown>;

  const requiredStrings: Array<{
    name: keyof BugReport;
    min: number;
    max: number;
  }> = [
    { name: 'title', min: 1, max: 200 },
    { name: 'description', min: 1, max: 4000 },
    { name: 'expected_behavior', min: 1, max: 2000 },
    { name: 'actual_behavior', min: 1, max: 2000 },
  ];
  for (const { name, min, max } of requiredStrings) {
    const v = r[name as string];
    if (v === undefined) {
      errors.push({
        field: String(name),
        message: `must have required property '${String(name)}'`,
      });
      continue;
    }
    if (typeof v !== 'string') {
      errors.push({ field: String(name), message: 'must be string' });
      continue;
    }
    if (v.length < min) {
      errors.push({
        field: String(name),
        message: `must NOT have fewer than ${min} characters`,
      });
    }
    if (v.length > max) {
      errors.push({
        field: String(name),
        message: `must NOT have more than ${max} characters`,
      });
    }
  }

  // reproduction_steps
  if (r.reproduction_steps === undefined) {
    errors.push({
      field: 'reproduction_steps',
      message: "must have required property 'reproduction_steps'",
    });
  } else if (!Array.isArray(r.reproduction_steps)) {
    errors.push({ field: 'reproduction_steps', message: 'must be array' });
  } else if (r.reproduction_steps.length < 1) {
    errors.push({
      field: 'reproduction_steps',
      message: 'must NOT have fewer than 1 items',
    });
  } else if (r.reproduction_steps.some((s) => typeof s !== 'string' || s.length < 1)) {
    errors.push({
      field: 'reproduction_steps',
      message: 'each step must be a non-empty string',
    });
  }

  // error_messages
  if (r.error_messages === undefined) {
    errors.push({
      field: 'error_messages',
      message: "must have required property 'error_messages'",
    });
  } else if (!Array.isArray(r.error_messages)) {
    errors.push({ field: 'error_messages', message: 'must be array' });
  } else if (r.error_messages.some((s) => typeof s !== 'string')) {
    errors.push({ field: 'error_messages', message: 'each entry must be a string' });
  }

  // environment
  if (r.environment === undefined) {
    errors.push({
      field: 'environment',
      message: "must have required property 'environment'",
    });
  } else if (
    r.environment === null ||
    typeof r.environment !== 'object' ||
    Array.isArray(r.environment)
  ) {
    errors.push({ field: 'environment', message: 'must be object' });
  } else {
    const env = r.environment as Record<string, unknown>;
    for (const k of ['os', 'runtime', 'version'] as const) {
      const v = env[k];
      if (v === undefined) {
        errors.push({
          field: `environment.${k}`,
          message: `must have required property '${k}'`,
        });
      } else if (typeof v !== 'string' || v.length < 1) {
        errors.push({
          field: `environment.${k}`,
          message: 'must be a non-empty string',
        });
      }
    }
  }

  // severity
  if (r.severity !== undefined) {
    if (typeof r.severity !== 'string' || !SEVERITIES.includes(r.severity as Severity)) {
      errors.push({
        field: 'severity',
        message: `must be equal to one of the allowed values: ${SEVERITIES.join(', ')}`,
      });
    }
  }

  // affected_components, labels (optional arrays of non-empty strings)
  for (const k of ['affected_components', 'labels'] as const) {
    const v = r[k];
    if (v !== undefined) {
      if (!Array.isArray(v)) {
        errors.push({ field: k, message: 'must be array' });
      } else if (v.some((s) => typeof s !== 'string' || s.length < 1)) {
        errors.push({ field: k, message: 'each entry must be a non-empty string' });
      }
    }
  }

  // user_impact
  if (r.user_impact !== undefined) {
    if (typeof r.user_impact !== 'string') {
      errors.push({ field: 'user_impact', message: 'must be string' });
    } else if (r.user_impact.length < 1 || r.user_impact.length > 1000) {
      errors.push({
        field: 'user_impact',
        message: 'must be 1-1000 characters',
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Interactive runner
// ---------------------------------------------------------------------------

/**
 * Set a dotted-path field on a nested object, creating intermediate
 * objects as needed. Used to assign `environment.os` (etc.) from the
 * flat prompt sequence.
 */
function setField(
  target: Record<string, unknown>,
  dotted: string,
  value: unknown,
): void {
  const parts = dotted.split('.');
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (
      cursor[k] === undefined ||
      cursor[k] === null ||
      typeof cursor[k] !== 'object'
    ) {
      cursor[k] = {};
    }
    cursor = cursor[k] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

/**
 * Drive the interactive prompt sequence, returning a populated
 * {@link BugReport}. Re-prompts on per-field validation failure.
 *
 * Caller is responsible for catching SIGINT and printing the
 * cancellation message; this function only handles the happy path and
 * inline validation.
 */
export async function runInteractivePrompts(
  io: PromptIO = defaultPromptIO(),
): Promise<BugReport> {
  const out: Record<string, unknown> = {};
  const env = defaultEnvironment();
  const defaults: Record<string, string> = {
    'environment.os': env.os,
    'environment.runtime': env.runtime,
    'environment.version': env.version,
    severity: 'medium',
  };

  try {
    for (const p of BUG_PROMPTS) {
      if (p.help) io.write(`# ${p.help}`);
      const def = defaults[p.field];

      if (p.kind === 'input') {
        // Required strings re-prompt on empty/too-short/too-long.
        // Optional strings allow empty (skip).
        for (;;) {
          const promptText = def
            ? `${p.label} [${def}]: `
            : `${p.label}${p.required ? '' : ' (optional)'}: `;
          const raw = (await io.ask(promptText)).trim();
          const value = raw === '' && def !== undefined ? def : raw;
          if (value === '') {
            if (!p.required) break; // skip optional empty
            io.write(`! ${p.label} is required.`);
            continue;
          }
          if (p.minLength !== undefined && value.length < p.minLength) {
            io.write(`! ${p.label} must be at least ${p.minLength} characters.`);
            continue;
          }
          if (p.maxLength !== undefined && value.length > p.maxLength) {
            io.write(`! ${p.label} must be at most ${p.maxLength} characters.`);
            continue;
          }
          setField(out, p.field, value);
          break;
        }
      } else if (p.kind === 'list') {
        const choices = p.choices ?? [];
        for (;;) {
          const promptText = `${p.label} [${choices.join('/')}]${def ? ` (default: ${def})` : ''}: `;
          const raw = (await io.ask(promptText)).trim();
          const value = raw === '' ? def ?? '' : raw;
          if (value === '' && !p.required) break;
          if (!choices.includes(value)) {
            io.write(
              `! ${p.label} must be one of: ${choices.join(', ')}.`,
            );
            continue;
          }
          setField(out, p.field, value);
          break;
        }
      } else if (p.kind === 'loop') {
        const items: string[] = [];
        for (;;) {
          const idx = items.length + 1;
          const raw = (await io.ask(`${p.label} #${idx} (empty to finish): `)).trim();
          if (raw === '') {
            if ((p.minItems ?? 0) > items.length) {
              if (p.field === 'reproduction_steps') {
                io.write('! At least one reproduction step is required');
              } else {
                io.write(`! At least ${p.minItems} ${p.label} required.`);
              }
              continue;
            }
            break;
          }
          items.push(raw);
        }
        setField(out, p.field, items);
      } else if (p.kind === 'csv') {
        const raw = (await io.ask(`${p.label} (comma-separated, optional): `)).trim();
        if (raw !== '') {
          const items = raw
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          if (items.length > 0) setField(out, p.field, items);
        }
      }
    }
  } finally {
    io.close();
  }

  return out as BugReport;
}
