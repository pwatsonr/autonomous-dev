/**
 * `dependency-checker` built-in evaluator (SPEC-021-2-02, Task 4).
 *
 * Verifies a literally-named dependency is present in the workspace's
 * dependency manifest. Unlike framework-detector, this evaluator does NOT
 * apply alias resolution — rule authors specify the exact dep name.
 *
 * Args contract: `{ dependency_present: string, dev?: boolean }`. When
 * `dev: true`, both runtime and dev sections are checked; default `false`
 * means runtime only.
 *
 * Manifest discovery and parsing mirrors framework-detector: package.json
 * → pyproject.toml → requirements.txt. Parse failures degrade to a
 * structured finding rather than throwing.
 *
 * @module intake/standards/evaluators/dependency-checker
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  BuiltinEvaluator,
  EvaluatorContext,
  EvaluatorResult,
  Finding,
} from './types';

const MANIFEST_ORDER = ['package.json', 'pyproject.toml', 'requirements.txt'] as const;
type ManifestName = (typeof MANIFEST_ORDER)[number];

interface ManifestHit {
  name: ManifestName;
  absolutePath: string;
  contents: string;
}

function findManifest(workspaceRoot: string): ManifestHit | undefined {
  for (const name of MANIFEST_ORDER) {
    const absolutePath = join(workspaceRoot, name);
    try {
      const contents = readFileSync(absolutePath, 'utf8');
      return { name, absolutePath, contents };
    } catch {
      // try next
    }
  }
  return undefined;
}

interface DepBuckets {
  runtime: string[];
  dev: string[];
}

function parsePackageJson(contents: string): DepBuckets {
  const parsed = JSON.parse(contents) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return {
    runtime: parsed.dependencies ? Object.keys(parsed.dependencies) : [],
    dev: parsed.devDependencies ? Object.keys(parsed.devDependencies) : [],
  };
}

function extractNamesFromArrayLiteral(literal: string): string[] {
  const out: string[] = [];
  const re = /"([^"\\]+)"|'([^'\\]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(literal)) !== null) {
    const raw = (m[1] ?? m[2] ?? '').trim();
    const name = raw.replace(/[\s<>=!~;[\],].*$/, '').trim();
    if (name) out.push(name);
  }
  return out;
}

function parsePyprojectToml(contents: string): DepBuckets {
  const buckets: DepBuckets = { runtime: [], dev: [] };
  const lines = contents.split(/\r?\n/);

  let section: 'project' | 'project-optional-dev' | 'poetry-deps' | 'poetry-dev' | 'other' =
    'other';
  let collectingProjectArray = false;
  let projectArrayBuffer = '';

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      if (collectingProjectArray) {
        buckets.runtime.push(...extractNamesFromArrayLiteral(projectArrayBuffer));
        projectArrayBuffer = '';
        collectingProjectArray = false;
      }
      if (line === '[project]') section = 'project';
      else if (line === '[project.optional-dependencies]') section = 'project-optional-dev';
      else if (line === '[tool.poetry.dependencies]') section = 'poetry-deps';
      else if (line === '[tool.poetry.dev-dependencies]') section = 'poetry-dev';
      else section = 'other';
      continue;
    }

    if (section === 'project') {
      if (collectingProjectArray) {
        projectArrayBuffer += ' ' + line;
        if (line.includes(']')) {
          buckets.runtime.push(...extractNamesFromArrayLiteral(projectArrayBuffer));
          projectArrayBuffer = '';
          collectingProjectArray = false;
        }
        continue;
      }
      const m = /^dependencies\s*=\s*(\[.*)$/.exec(line);
      if (m) {
        if (m[1].includes(']')) {
          buckets.runtime.push(...extractNamesFromArrayLiteral(m[1]));
        } else {
          projectArrayBuffer = m[1];
          collectingProjectArray = true;
        }
      }
    } else if (section === 'project-optional-dev') {
      // PEP 621 optional-dependencies has nested groups. Treat anything
      // here as dev-grade.
      const m = /=\s*(\[.*\])/.exec(line);
      if (m) buckets.dev.push(...extractNamesFromArrayLiteral(m[1]));
    } else if (section === 'poetry-deps' || section === 'poetry-dev') {
      if (!line || line.startsWith('#')) continue;
      const m = /^([A-Za-z0-9_.\-]+)\s*=/.exec(line);
      if (!m) continue;
      if (section === 'poetry-deps') buckets.runtime.push(m[1]);
      else buckets.dev.push(m[1]);
    }
  }
  if (collectingProjectArray && projectArrayBuffer) {
    buckets.runtime.push(...extractNamesFromArrayLiteral(projectArrayBuffer));
  }
  return buckets;
}

function parseRequirementsTxt(contents: string): DepBuckets {
  const runtime: string[] = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    const hashIdx = line.indexOf('#');
    if (hashIdx >= 0) line = line.slice(0, hashIdx).trim();
    if (!line) continue;
    if (line.startsWith('-')) continue;
    const name = line.replace(/[\s<>=!~;[\],].*$/, '').trim();
    if (name) runtime.push(name);
  }
  return { runtime, dev: [] };
}

function parseDeps(manifest: ManifestHit): DepBuckets {
  switch (manifest.name) {
    case 'package.json':
      return parsePackageJson(manifest.contents);
    case 'pyproject.toml':
      return parsePyprojectToml(manifest.contents);
    case 'requirements.txt':
      return parseRequirementsTxt(manifest.contents);
  }
}

const dependencyChecker: BuiltinEvaluator = async (
  _filePaths: string[],
  args: Record<string, unknown>,
  ctx: EvaluatorContext,
): Promise<EvaluatorResult> => {
  const dep =
    typeof args.dependency_present === 'string' ? args.dependency_present : '';
  const checkDev = args.dev === true;
  if (!dep) {
    return {
      passed: false,
      findings: [
        {
          file: ctx.workspaceRoot,
          line: 0,
          severity: 'major',
          message:
            'dependency-checker requires args.dependency_present (got empty/undefined)',
        },
      ],
    };
  }

  const manifest = findManifest(ctx.workspaceRoot);
  if (!manifest) {
    return {
      passed: false,
      findings: [
        {
          file: ctx.workspaceRoot,
          line: 0,
          severity: 'major',
          message: 'no dependency manifest found',
        },
      ],
    };
  }

  let buckets: DepBuckets;
  try {
    buckets = parseDeps(manifest);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      passed: false,
      findings: [
        {
          file: manifest.absolutePath,
          line: 1,
          severity: 'major',
          message: `failed to parse ${manifest.name}: ${message}`,
        },
      ],
    };
  }

  const haystack = new Set<string>(buckets.runtime.map((n) => n.toLowerCase()));
  if (checkDev) {
    for (const n of buckets.dev) haystack.add(n.toLowerCase());
  }
  if (haystack.has(dep.toLowerCase())) {
    return { passed: true, findings: [] };
  }
  const finding: Finding = {
    file: manifest.absolutePath,
    line: 1,
    severity: 'major',
    message: `dependency "${dep}" not declared in ${manifest.name} (${
      checkDev ? 'dev+runtime' : 'runtime'
    })`,
  };
  return { passed: false, findings: [finding] };
};

export default dependencyChecker;
