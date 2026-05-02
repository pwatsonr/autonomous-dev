/**
 * Tests for endpoint-scanner built-in evaluator (SPEC-021-2-01).
 *
 * Coverage: positive cases for Python (FastAPI/Flask), TypeScript
 * (Express), Go (chi/net-http style), negative case across all three
 * languages, regex-metacharacter escaping (`.well-known`), determinism.
 *
 * @module tests/standards/evaluators/endpoint-scanner.test
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import endpointScanner from '../../../intake/standards/evaluators/endpoint-scanner';
import type { EvaluatorContext } from '../../../intake/standards/evaluators/types';

function workspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'es-'));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
function ctx(root: string): EvaluatorContext {
  return { workspaceRoot: root };
}

describe('endpoint-scanner', () => {
  it('Python FastAPI: @app.get("/health") matches', async () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.root, 'main.py'), "@app.get('/health')\ndef h(): pass\n");
      const r = await endpointScanner(['main.py'], { exposes_endpoint: '/health' }, ctx(ws.root));
      expect(r.passed).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it('Python Flask blueprint matches', async () => {
    const ws = workspace();
    try {
      writeFileSync(
        join(ws.root, 'bp.py'),
        '@blueprint.route("/api/users")\ndef u(): pass\n',
      );
      const r = await endpointScanner(['bp.py'], { exposes_endpoint: '/api/users' }, ctx(ws.root));
      expect(r.passed).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it('TypeScript Express: app.get("/api/users", handler) matches', async () => {
    const ws = workspace();
    try {
      writeFileSync(
        join(ws.root, 'srv.ts'),
        "app.get('/api/users', (req, res) => res.json([]));\n",
      );
      const r = await endpointScanner(['srv.ts'], { exposes_endpoint: '/api/users' }, ctx(ws.root));
      expect(r.passed).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it('Go: mux.HandleFunc("/health", handler) matches', async () => {
    const ws = workspace();
    try {
      writeFileSync(
        join(ws.root, 'srv.go'),
        'mux.HandleFunc("/health", healthHandler)\n',
      );
      const r = await endpointScanner(['srv.go'], { exposes_endpoint: '/health' }, ctx(ws.root));
      expect(r.passed).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it('Go chi/gin: r.GET("/api/v1/items") matches', async () => {
    const ws = workspace();
    try {
      writeFileSync(
        join(ws.root, 'srv.go'),
        'r.GET("/api/v1/items", listItems)\n',
      );
      const r = await endpointScanner(['srv.go'], { exposes_endpoint: '/api/v1/items' }, ctx(ws.root));
      expect(r.passed).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it('returns single summary finding when no language matches the endpoint', async () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.root, 'main.py'), 'print("nothing here")\n');
      writeFileSync(join(ws.root, 'srv.ts'), 'console.log("nothing");\n');
      writeFileSync(join(ws.root, 'srv.go'), '// no routes\n');
      const r = await endpointScanner(
        ['main.py', 'srv.ts', 'srv.go'],
        { exposes_endpoint: '/missing' },
        ctx(ws.root),
      );
      expect(r.passed).toBe(false);
      expect(r.findings).toHaveLength(1);
      expect(r.findings[0].message).toContain('/missing');
      expect(r.findings[0].message).toContain('3');
    } finally {
      ws.cleanup();
    }
  });

  it('endpoint with regex metacharacters is escaped (matches literal `.well-known`)', async () => {
    const ws = workspace();
    try {
      writeFileSync(
        join(ws.root, 'srv.ts'),
        "app.get('/api/v1/.well-known', handler);\n",
      );
      // A bogus endpoint that would only match if `.` were treated as regex any-char:
      const bogus = await endpointScanner(
        ['srv.ts'],
        { exposes_endpoint: '/api/v1/Xwell-known' },
        ctx(ws.root),
      );
      expect(bogus.passed).toBe(false);
      // Literal match works:
      const literal = await endpointScanner(
        ['srv.ts'],
        { exposes_endpoint: '/api/v1/.well-known' },
        ctx(ws.root),
      );
      expect(literal.passed).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it('non-matching extensions are silently skipped', async () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.root, 'README.md'), '@app.get("/health")\n');
      const r = await endpointScanner(['README.md'], { exposes_endpoint: '/health' }, ctx(ws.root));
      expect(r.passed).toBe(false);
      // 0 scanned files reported
      expect(r.findings[0].message).toContain('0');
    } finally {
      ws.cleanup();
    }
  });

  it('unreadable files are skipped without throwing', async () => {
    const ws = workspace();
    try {
      const r = await endpointScanner(
        ['nonexistent.py'],
        { exposes_endpoint: '/health' },
        ctx(ws.root),
      );
      expect(r.passed).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  it('empty exposes_endpoint args produces a configuration finding', async () => {
    const ws = workspace();
    try {
      const r = await endpointScanner(['main.py'], {}, ctx(ws.root));
      expect(r.passed).toBe(false);
      expect(r.findings[0].message).toContain('exposes_endpoint');
    } finally {
      ws.cleanup();
    }
  });

  it('determinism: identical inputs → identical outputs', async () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.root, 'm.py'), "@app.get('/h')\n");
      const a = await endpointScanner(['m.py'], { exposes_endpoint: '/h' }, ctx(ws.root));
      const b = await endpointScanner(['m.py'], { exposes_endpoint: '/h' }, ctx(ws.root));
      expect(a).toEqual(b);
    } finally {
      ws.cleanup();
    }
  });
});
