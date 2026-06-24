/**
 * Per-repo memory extractors (ONBOARD Phase 1 — #587).
 *
 * Each extractor reads a `RepoSource` (read-only) and produces one memory doc.
 * Best-effort + independent: a returning-undefined or throwing extractor only
 * affects its own topic (the orchestrator records the error and continues).
 * These operate over the read-only `RepoSource` interface so they work for both
 * the shallow-clone and the GitHub-API adapters. (Richer stack/standards
 * detection via AutoDetectionScanner is wired for the clone adapter in P1.2b.)
 */

import type { Extractor } from './types';

const CAP = 8000; // cap per-doc content to keep memory files bounded

/** Dependencies — from common manifests. */
export const depsExtractor: Extractor = {
  topic: 'dependencies',
  extract(repo) {
    const manifests = [
      'package.json',
      'pom.xml',
      'requirements.txt',
      'pyproject.toml',
      'go.mod',
      'Cargo.toml',
      'build.gradle',
      'Gemfile',
    ];
    const blocks: string[] = [];
    for (const m of manifests) {
      const c = repo.readFile(m);
      if (c !== undefined) blocks.push(`### ${m}\n\n\`\`\`\n${c.slice(0, 4000)}\n\`\`\``);
    }
    if (blocks.length === 0) return undefined;
    return { topic: 'dependencies', content: `# Dependencies — ${repo.meta.id}\n\n${blocks.join('\n\n')}` };
  },
};

/** Ownership — CODEOWNERS. */
export const codeownersExtractor: Extractor = {
  topic: 'ownership',
  extract(repo) {
    const c =
      repo.readFile('CODEOWNERS') ??
      repo.readFile('.github/CODEOWNERS') ??
      repo.readFile('docs/CODEOWNERS');
    if (c === undefined) return undefined;
    return { topic: 'ownership', content: `# Ownership — ${repo.meta.id}\n\n\`\`\`\n${c.slice(0, CAP)}\n\`\`\`` };
  },
};

/** Overview / domain glossary — from the README. */
export const overviewExtractor: Extractor = {
  topic: 'overview',
  extract(repo) {
    const c = repo.readFile('README.md') ?? repo.readFile('readme.md') ?? repo.readFile('README');
    if (c === undefined) return undefined;
    return { topic: 'overview', content: `# Overview — ${repo.meta.id}\n\n${c.slice(0, CAP)}` };
  },
};

/** Build/deploy targets — CI workflows + container/deploy files (names + snippets). */
export const buildDeployExtractor: Extractor = {
  topic: 'build-deploy',
  extract(repo) {
    const candidates = [
      'Dockerfile',
      'docker-compose.yml',
      '.github/workflows',
      'Makefile',
      'k8s',
      'helm',
    ];
    const present = candidates.filter((p) => repo.readFile(p) !== undefined || repo.listFiles(p).length > 0);
    if (present.length === 0) return undefined;
    return {
      topic: 'build-deploy',
      content: `# Build / Deploy — ${repo.meta.id}\n\nDetected: ${present.join(', ')}`,
    };
  },
};

/** Test conventions — presence of common test dirs/configs. */
export const testConventionsExtractor: Extractor = {
  topic: 'test-conventions',
  extract(repo) {
    const markers = ['jest.config.js', 'jest.config.cjs', 'pytest.ini', 'tests', 'test', '__tests__', 'spec'];
    const present = markers.filter((p) => repo.readFile(p) !== undefined || repo.listFiles(p).length > 0);
    if (present.length === 0) return undefined;
    return {
      topic: 'test-conventions',
      content: `# Test conventions — ${repo.meta.id}\n\nDetected: ${present.join(', ')}`,
    };
  },
};

export const defaultExtractors: Extractor[] = [
  overviewExtractor,
  depsExtractor,
  codeownersExtractor,
  buildDeployExtractor,
  testConventionsExtractor,
];
