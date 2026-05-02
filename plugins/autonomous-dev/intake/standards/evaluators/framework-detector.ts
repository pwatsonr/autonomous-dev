/**
 * `framework-detector` built-in evaluator (SPEC-021-2-01, Task 1).
 *
 * Inspects the workspace's dependency manifest (in priority order:
 * `package.json` → `pyproject.toml` → `requirements.txt`) and verifies that
 * the requested framework — or any of its declared aliases / implied parent
 * frameworks — is present in the dependency list.
 *
 * Args contract: `{ framework_match: string }`. Unknown args are ignored.
 *
 * Behavior is deterministic and stateless: the same workspace + same args
 * always produce the same result. Manifest parse failures are handled
 * gracefully — never throw; always return a structured `EvaluatorResult`.
 *
 * @module intake/standards/evaluators/framework-detector
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  BuiltinEvaluator,
  EvaluatorContext,
  EvaluatorResult,
  Finding,
} from './types';
import { resolveAcceptedNames } from './aliases';

const MANIFEST_ORDER = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
] as const;
type ManifestName = (typeof MANIFEST_ORDER)[number];

interface ManifestHit {
  name: ManifestName;
  absolutePath: string;
  contents: string;
}

/** Locate the first manifest in priority order; returns undefined if none. */
function findManifest(workspaceRoot: string): ManifestHit | undefined {
  for (const name of MANIFEST_ORDER) {
    const absolutePath = join(workspaceRoot, name);
    try {
      const contents = readFileSync(absolutePath, 'utf8');
      return { name, absolutePath, contents };
    } catch {
      // Missing or unreadable — try next.
    }
  }
  return undefined;
}

/** Extract dependency names from a `package.json` (deps + devDeps merged). */
function parsePackageJson(contents: string): { names: string[] } {
  const parsed = JSON.parse(contents) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const names: string[] = [];
  if (parsed.dependencies) names.push(...Object.keys(parsed.dependencies));
  if (parsed.devDependencies)
    names.push(...Object.keys(parsed.devDependencies));
  return { names };
}

/**
 * Minimal pyproject.toml parser focused on dependency sections.
 *
 * Recognizes `[project] dependencies = [...]` (PEP 621) and
 * `[tool.poetry.dependencies]` (Poetry). The parser is intentionally strict
 * about what it understands — anything else is treated as "no deps found"
 * which surfaces as a missed match (the rule fails) rather than a parse
 * crash.
 */
function parsePyprojectToml(contents: string): { names: string[] } {
  const names: string[] = [];
  const lines = contents.split(/\r?\n/);

  // Pass 1: PEP 621 [project] dependencies = ["fastapi>=0.100", ...]
  let inProject = false;
  let collectingDeps = false;
  let depsBuffer = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      // Section header — flush any in-progress dep collection.
      if (collectingDeps) {
        names.push(...extractNamesFromArrayLiteral(depsBuffer));
        depsBuffer = '';
        collectingDeps = false;
      }
      inProject = line === '[project]';
      continue;
    }
    if (!inProject) continue;
    if (collectingDeps) {
      depsBuffer += ' ' + line;
      if (line.includes(']')) {
        names.push(...extractNamesFromArrayLiteral(depsBuffer));
        depsBuffer = '';
        collectingDeps = false;
      }
      continue;
    }
    const depsMatch = /^dependencies\s*=\s*(\[.*)$/.exec(line);
    if (depsMatch) {
      depsBuffer = depsMatch[1];
      if (depsBuffer.includes(']')) {
        names.push(...extractNamesFromArrayLiteral(depsBuffer));
        depsBuffer = '';
      } else {
        collectingDeps = true;
      }
    }
  }
  if (collectingDeps && depsBuffer) {
    names.push(...extractNamesFromArrayLiteral(depsBuffer));
  }

  // Pass 2: Poetry-style `[tool.poetry.dependencies]` / `[tool.poetry.dev-dependencies]`
  let inPoetryDeps = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inPoetryDeps =
        line === '[tool.poetry.dependencies]' ||
        line === '[tool.poetry.dev-dependencies]';
      continue;
    }
    if (!inPoetryDeps) continue;
    if (!line || line.startsWith('#')) continue;
    // `name = "version"` or `name = { version = "..." }`
    const m = /^([A-Za-z0-9_.\-]+)\s*=/.exec(line);
    if (m) names.push(m[1]);
  }

  return { names };
}

/** Strip version specifiers and quotes from `["fastapi>=0.100", "uvicorn"]`-like strings. */
function extractNamesFromArrayLiteral(literal: string): string[] {
  const out: string[] = [];
  // Match every quoted string in the literal.
  const re = /"([^"\\]+)"|'([^'\\]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(literal)) !== null) {
    const raw = (m[1] ?? m[2] ?? '').trim();
    // Strip version specifier: `fastapi>=0.100` → `fastapi`.
    const name = raw.replace(/[\s<>=!~;[\],].*$/, '').trim();
    if (name) out.push(name);
  }
  return out;
}

/** Parse `requirements.txt`-style dependency lists. */
function parseRequirementsTxt(contents: string): { names: string[] } {
  const names: string[] = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    // Strip inline comments.
    const hashIdx = line.indexOf('#');
    if (hashIdx >= 0) line = line.slice(0, hashIdx).trim();
    if (!line) continue;
    // Skip option lines (`-r ...`, `-e ...`, `--index-url ...`).
    if (line.startsWith('-')) continue;
    // Strip version specifier.
    const name = line.replace(/[\s<>=!~;[\],].*$/, '').trim();
    if (name) names.push(name);
  }
  return { names };
}

/** Convenience: all dependency names declared in a manifest. */
function extractNames(manifest: ManifestHit): string[] {
  switch (manifest.name) {
    case 'package.json':
      return parsePackageJson(manifest.contents).names;
    case 'pyproject.toml':
      return parsePyprojectToml(manifest.contents).names;
    case 'requirements.txt':
      return parseRequirementsTxt(manifest.contents).names;
  }
}

const frameworkDetector: BuiltinEvaluator = async (
  _filePaths: string[],
  args: Record<string, unknown>,
  ctx: EvaluatorContext,
): Promise<EvaluatorResult> => {
  const framework =
    typeof args.framework_match === 'string' ? args.framework_match : '';
  if (!framework) {
    const finding: Finding = {
      file: ctx.workspaceRoot,
      line: 0,
      severity: 'major',
      message:
        'framework-detector requires args.framework_match (got empty/undefined)',
    };
    return { passed: false, findings: [finding] };
  }

  const manifest = findManifest(ctx.workspaceRoot);
  if (!manifest) {
    const finding: Finding = {
      file: ctx.workspaceRoot,
      line: 0,
      severity: 'major',
      message:
        'no dependency manifest found in workspace root (looked for package.json, pyproject.toml, requirements.txt)',
    };
    return { passed: false, findings: [finding] };
  }

  let names: string[];
  try {
    names = extractNames(manifest);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const finding: Finding = {
      file: manifest.absolutePath,
      line: 1,
      severity: 'major',
      message: `failed to parse ${manifest.name}: ${message}`,
    };
    return { passed: false, findings: [finding] };
  }

  const accepted = resolveAcceptedNames(framework);
  const declared = new Set(names.map((n) => n.toLowerCase()));
  for (const a of accepted) {
    if (declared.has(a)) {
      return { passed: true, findings: [] };
    }
  }

  const finding: Finding = {
    file: manifest.absolutePath,
    line: 1,
    severity: 'major',
    message: `framework '${framework}' not declared in ${manifest.name}`,
  };
  return { passed: false, findings: [finding] };
};

export default frameworkDetector;
