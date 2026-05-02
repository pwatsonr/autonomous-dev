/**
 * Tests for sql-injection-detector built-in evaluator (SPEC-021-2-02).
 *
 * Coverage:
 *   - 5+ Python unsafe patterns (f-string, format, percent, concat)
 *   - 3+ JS/TS unsafe patterns (template, concat, replace)
 *   - 3+ JVM unsafe patterns (String.format, concat, MessageFormat)
 *   - safe parameterized + ORM examples (must NOT match)
 *   - 10KB random alphanumerics completes in <100ms (ReDoS regression)
 *
 * @module tests/standards/evaluators/sql-injection-detector.test
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sqlInjectionDetector from '../../../intake/standards/evaluators/sql-injection-detector';
import type { EvaluatorContext } from '../../../intake/standards/evaluators/types';

function workspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'sqli-'));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
function ctx(root: string): EvaluatorContext {
  return { workspaceRoot: root };
}

async function runOn(
  files: Array<{ name: string; contents: string }>,
): Promise<{ passed: boolean; findings: ReturnType<typeof Object> }> {
  const ws = workspace();
  try {
    const names = files.map((f) => {
      writeFileSync(join(ws.root, f.name), f.contents);
      return f.name;
    });
    const r = await sqlInjectionDetector(names, {}, ctx(ws.root));
    return { passed: r.passed, findings: r.findings };
  } finally {
    ws.cleanup();
  }
}

describe('sql-injection-detector — unsafe patterns flagged', () => {
  it('PY-FSTRING-1: f-string with SELECT and interpolation', async () => {
    const r = await runOn([
      { name: 'a.py', contents: 'q = f"SELECT * FROM users WHERE id = {user_id}"\n' },
    ]);
    expect(r.passed).toBe(false);
    expect((r.findings as any[])[0].severity).toBe('critical');
  });

  it('PY-FSTRING-2: f-string with WHERE only', async () => {
    const r = await runOn([
      { name: 'a.py', contents: 'q = f"... WHERE name = {name}"\n' },
    ]);
    expect(r.passed).toBe(false);
  });

  it('PY-FORMAT: ".format()" with SELECT', async () => {
    const r = await runOn([
      { name: 'a.py', contents: 'q = "SELECT * FROM t WHERE id = {}".format(uid)\n' },
    ]);
    expect(r.passed).toBe(false);
  });

  it('PY-PERCENT: % formatting with SELECT', async () => {
    const r = await runOn([
      { name: 'a.py', contents: 'q = "SELECT * FROM t WHERE id = %s" % uid\n' },
    ]);
    expect(r.passed).toBe(false);
  });

  it('PY-CONCAT: concatenation', async () => {
    const r = await runOn([
      { name: 'a.py', contents: 'q = "SELECT * FROM t WHERE id = " + uid\n' },
    ]);
    expect(r.passed).toBe(false);
  });

  it('JS-TEMPLATE: template literal with interpolation', async () => {
    const r = await runOn([
      { name: 'a.ts', contents: 'const q = `SELECT * FROM t WHERE id = ${uid}`;\n' },
    ]);
    expect(r.passed).toBe(false);
  });

  it('JS-CONCAT: string concat with SELECT', async () => {
    const r = await runOn([
      { name: 'a.js', contents: 'const q = "SELECT * FROM t WHERE id = " + uid;\n' },
    ]);
    expect(r.passed).toBe(false);
  });

  it('JS-REPLACE: string.replace on SELECT literal', async () => {
    const r = await runOn([
      { name: 'a.ts', contents: 'const q = "SELECT * FROM t WHERE id = X".replace("X", uid);\n' },
    ]);
    expect(r.passed).toBe(false);
  });

  it('JAVA-FORMAT: String.format with SELECT', async () => {
    const r = await runOn([
      { name: 'a.java', contents: 'String sql = String.format("SELECT * FROM t WHERE id = %s", id);\n' },
    ]);
    expect(r.passed).toBe(false);
  });

  it('JAVA-CONCAT: concatenation', async () => {
    const r = await runOn([
      { name: 'a.java', contents: 'String sql = "SELECT * FROM t WHERE id = " + id;\n' },
    ]);
    expect(r.passed).toBe(false);
  });

  it('JAVA-MSGFMT: MessageFormat.format with SELECT', async () => {
    const r = await runOn([
      { name: 'a.java', contents: 'String sql = MessageFormat.format("SELECT * FROM t WHERE id = {0}", id);\n' },
    ]);
    expect(r.passed).toBe(false);
  });
});

describe('sql-injection-detector — safe patterns NOT flagged', () => {
  it('Python parameterized cursor.execute', async () => {
    const r = await runOn([
      { name: 'a.py', contents: 'cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))\n' },
    ]);
    expect(r.passed).toBe(true);
  });

  it('Python ORM call', async () => {
    const r = await runOn([
      { name: 'a.py', contents: 'User.query.filter_by(id=user_id).first()\n' },
    ]);
    expect(r.passed).toBe(true);
  });

  it('TS template literal of pure constants', async () => {
    const r = await runOn([
      { name: 'a.ts', contents: 'const q = `SELECT * FROM users WHERE deleted = false`;\n' },
    ]);
    expect(r.passed).toBe(true);
  });

  it('Java PreparedStatement', async () => {
    const r = await runOn([
      { name: 'a.java', contents: 'PreparedStatement ps = c.prepareStatement("SELECT * FROM t WHERE id = ?");\nps.setString(1, userId);\n' },
    ]);
    expect(r.passed).toBe(true);
  });

  it('JS Prisma findOne', async () => {
    const r = await runOn([
      { name: 'a.ts', contents: 'const u = await db.users.findOne({where: {id}});\n' },
    ]);
    expect(r.passed).toBe(true);
  });
});

describe('sql-injection-detector — performance', () => {
  it('10KB of random alphanumerics completes in <100ms (ReDoS regression)', async () => {
    let body = '';
    while (body.length < 10 * 1024) body += 'abc123XYZ ';
    const start = Date.now();
    const r = await runOn([{ name: 'big.py', contents: body }]);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(r.passed).toBe(true);
  });
});
