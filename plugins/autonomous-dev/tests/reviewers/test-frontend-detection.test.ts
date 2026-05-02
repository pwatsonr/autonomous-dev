/**
 * Unit tests for the frontend-change detection helper (SPEC-020-1-05).
 *
 * Covers the contract from intake/reviewers/frontend-detection.ts:
 *   - Framework detection: react, vue, svelte, angular, vanilla.
 *   - Backend-only diffs short-circuit to isFrontendChange:false.
 *   - Cache hit returns the same object reference.
 *   - clearCache(id) evicts only the named entry.
 *   - clearCache() evicts all entries.
 *   - Viewport-meta scan inspects detected file contents.
 *
 * Each fixture package-*.json under tests/reviewers/fixtures/ is copied
 * into a per-test temp directory so the helper sees a real package.json
 * at the expected location (FRAMEWORK_DEPS lookup is keyed off
 * `<repoPath>/package.json`).
 *
 * Spec note: SPEC-020-1-05 prescribed Vitest, but this plugin uses Jest
 * (jest.config.cjs at the package root); the orchestrator approved the
 * deviation. Test shape is otherwise identical to the spec example.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  __cacheForTests,
  clearCache,
  detectFrontendChanges,
} from '../../intake/reviewers/frontend-detection';

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

/**
 * Materialize a temp directory whose `package.json` is a copy of the
 * given fixture file. The returned path is the repo root that should be
 * passed as `repoPath` to detectFrontendChanges().
 */
function makeRepoFromFixture(fixtureName: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-detect-'));
  const src = path.join(FIXTURES_DIR, fixtureName);
  fs.copyFileSync(src, path.join(dir, 'package.json'));
  return dir;
}

/** Materialize a temp dir with no package.json at all. */
function makeEmptyRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-detect-empty-'));
}

const tempRoots: string[] = [];

function trackedRepo(fixtureName: string | null): string {
  const dir = fixtureName === null ? makeEmptyRepo() : makeRepoFromFixture(fixtureName);
  tempRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe('detectFrontendChanges', () => {
  beforeEach(() => clearCache());

  describe('framework detection', () => {
    it.each<[Exclude<ReturnType<typeof detectFrontendChanges>['framework'], undefined>, string, string[]]>([
      ['react', 'package-react.json', ['src/components/Button.tsx']],
      ['vue', 'package-vue.json', ['src/components/Card.vue']],
      ['svelte', 'package-svelte.json', ['src/routes/Page.svelte']],
      // Angular .component.ts files don't carry a frontend extension;
      // route them through the /components/ path pattern so the helper
      // recognises them as frontend changes.
      ['angular', 'package-angular.json', ['src/app/components/app.component.ts']],
      // The vanilla fixture has no react/vue/svelte/angular dep; the
      // module returns 'vanilla' as the explicit fallback.
      ['vanilla', 'package-vanilla.json', ['src/components/widget.tsx']],
    ])('detects %s', (expected, pkg, files) => {
      const repoPath = trackedRepo(pkg);
      const result = detectFrontendChanges(`req-${expected}`, repoPath, files);
      expect(result.isFrontendChange).toBe(true);
      expect(result.framework).toBe(expected);
      expect(result.detectedFiles).toEqual(files);
    });

    it('falls back to vanilla when package.json is missing', () => {
      const repoPath = trackedRepo(null);
      const result = detectFrontendChanges('req-no-pkg', repoPath, ['src/components/X.tsx']);
      expect(result.isFrontendChange).toBe(true);
      expect(result.framework).toBe('vanilla');
    });
  });

  describe('non-frontend changes', () => {
    it('returns isFrontendChange:false for backend-only diff', () => {
      const repoPath = trackedRepo('package-react.json');
      const result = detectFrontendChanges('req-backend', repoPath, [
        'src/services/auth.ts',
        'src/db/users.ts',
      ]);
      expect(result.isFrontendChange).toBe(false);
      expect(result.detectedFiles).toEqual([]);
      expect(result.framework).toBeUndefined();
      expect(result.hasViewportMeta).toBe(false);
    });

    it('returns isFrontendChange:false for empty file list', () => {
      const repoPath = trackedRepo('package-react.json');
      const result = detectFrontendChanges('req-empty', repoPath, []);
      expect(result.isFrontendChange).toBe(false);
      expect(result.framework).toBeUndefined();
    });
  });

  describe('cache semantics', () => {
    it('returns same object reference on cache hit', () => {
      const repoPath = trackedRepo('package-react.json');
      const a = detectFrontendChanges('req-cache-1', repoPath, ['src/Button.tsx']);
      // Even with different changed files, cache key is requestId only.
      const b = detectFrontendChanges('req-cache-1', repoPath, ['src/Other.tsx']);
      expect(a).toBe(b);
    });

    it('clearCache(id) evicts only the named entry', () => {
      const repoPath = trackedRepo('package-react.json');
      detectFrontendChanges('req-evict-a', repoPath, ['x.tsx']);
      detectFrontendChanges('req-evict-b', repoPath, ['y.tsx']);
      expect(__cacheForTests.has('req-evict-a')).toBe(true);
      expect(__cacheForTests.has('req-evict-b')).toBe(true);

      clearCache('req-evict-a');

      expect(__cacheForTests.has('req-evict-a')).toBe(false);
      expect(__cacheForTests.has('req-evict-b')).toBe(true);
    });

    it('clearCache() with no arg evicts all entries', () => {
      const repoPath = trackedRepo('package-react.json');
      detectFrontendChanges('req-clear-1', repoPath, ['x.tsx']);
      detectFrontendChanges('req-clear-2', repoPath, ['y.tsx']);
      expect(__cacheForTests.size).toBeGreaterThanOrEqual(2);

      clearCache();

      expect(__cacheForTests.size).toBe(0);
    });

    it('clearCache(unknownId) is a safe no-op', () => {
      const repoPath = trackedRepo('package-react.json');
      detectFrontendChanges('req-keep', repoPath, ['x.tsx']);
      expect(() => clearCache('never-cached')).not.toThrow();
      expect(__cacheForTests.has('req-keep')).toBe(true);
    });

    it('treats devDependencies the same as dependencies', () => {
      // Build a repo where the framework is only declared under devDependencies.
      const repoPath = trackedRepo(null);
      fs.writeFileSync(
        path.join(repoPath, 'package.json'),
        JSON.stringify({ name: 'dev-only', devDependencies: { vue: '^3.0.0' } }),
      );
      const result = detectFrontendChanges('req-devdeps', repoPath, ['src/components/X.vue']);
      expect(result.framework).toBe('vue');
    });

    it('returns vanilla on malformed package.json', () => {
      const repoPath = trackedRepo(null);
      fs.writeFileSync(path.join(repoPath, 'package.json'), '{ this is not json');
      const result = detectFrontendChanges('req-malformed', repoPath, ['src/components/X.tsx']);
      expect(result.framework).toBe('vanilla');
    });
  });

  describe('viewport meta detection', () => {
    it('detects <meta name="viewport"> in scanned files', () => {
      // Build a repo containing an HTML file at a frontend path that
      // includes the viewport meta tag.
      const repoPath = trackedRepo('package-react.json');
      const subdir = path.join(repoPath, 'src', 'pages');
      fs.mkdirSync(subdir, { recursive: true });
      const htmlSrc = fs.readFileSync(path.join(FIXTURES_DIR, 'viewport-index.html'), 'utf8');
      fs.writeFileSync(path.join(subdir, 'index.html'), htmlSrc);

      const result = detectFrontendChanges('req-viewport', repoPath, ['src/pages/index.html']);
      expect(result.isFrontendChange).toBe(true);
      expect(result.hasViewportMeta).toBe(true);
    });

    it('returns hasViewportMeta:false when no detected file contains the tag', () => {
      const repoPath = trackedRepo('package-react.json');
      const subdir = path.join(repoPath, 'src', 'components');
      fs.mkdirSync(subdir, { recursive: true });
      fs.writeFileSync(path.join(subdir, 'Button.tsx'), 'export const Button = () => null;');

      const result = detectFrontendChanges('req-no-viewport', repoPath, ['src/components/Button.tsx']);
      expect(result.isFrontendChange).toBe(true);
      expect(result.hasViewportMeta).toBe(false);
    });

    it('skips missing files (deleted in diff) without throwing', () => {
      const repoPath = trackedRepo('package-react.json');
      // src/pages/gone.html does not exist on disk.
      const result = detectFrontendChanges('req-gone', repoPath, ['src/pages/gone.html']);
      expect(result.isFrontendChange).toBe(true);
      expect(result.hasViewportMeta).toBe(false);
    });
  });
});
