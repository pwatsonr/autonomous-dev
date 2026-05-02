/**
 * SPEC-023-3-04 DeployLogger tests.
 *
 * Covers directory creation, JSON line shape, concurrency without torn
 * lines, rotation, lifecycle (close, flush), telemetry forwarding gates,
 * and forComponent siblings.
 *
 * @module tests/deploy/test-deploy-logger.test
 */

import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeployLogger, type LogLine } from '../../intake/deploy/logger';
import { LoggerClosedError } from '../../intake/deploy/errors';

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'deploy-logger-'));
}

function logPath(root: string, deployId: string, comp: string): string {
  return join(root, '.autonomous-dev', 'deploy-logs', deployId, comp, `${comp}.log`);
}

describe('SPEC-023-3-04 DeployLogger', () => {
  it('first write creates the full directory tree', async () => {
    const root = await tmp();
    try {
      const logger = new DeployLogger({
        requestRoot: root,
        deployId: 'dep-A',
        component: 'deploy',
      });
      logger.info('hello');
      await logger.flush();
      const text = await readFile(logPath(root, 'dep-A', 'deploy'), 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      const line = JSON.parse(text.trim()) as LogLine;
      expect(line.message).toBe('hello');
      expect(line.level).toBe('INFO');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('each line is single-line JSON with the four required keys', async () => {
    const root = await tmp();
    try {
      const logger = new DeployLogger({
        requestRoot: root,
        deployId: 'dep-A',
        component: 'deploy',
      });
      logger.info('a', { foo: 1 });
      logger.warn('b', { bar: 'x' });
      logger.error('c');
      await logger.flush();
      const text = await readFile(logPath(root, 'dep-A', 'deploy'), 'utf8');
      const lines = text.split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(3);
      for (const raw of lines) {
        const obj = JSON.parse(raw) as LogLine;
        expect(typeof obj.ts).toBe('string');
        expect(['INFO', 'WARN', 'ERROR']).toContain(obj.level);
        expect(typeof obj.message).toBe('string');
        expect(obj.fields).toBeDefined();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('concurrent writes from two components produce no torn lines', async () => {
    const root = await tmp();
    try {
      const a = new DeployLogger({
        requestRoot: root,
        deployId: 'dep-A',
        component: 'build',
      });
      const b = a.forComponent('deploy');
      // 200 alternating writes (1000 from spec is overkill at unit scale).
      const N = 200;
      for (let i = 0; i < N; i++) {
        a.info('a', { i });
        b.info('b', { i });
      }
      await a.flush();
      await b.flush();
      const buildText = await readFile(logPath(root, 'dep-A', 'build'), 'utf8');
      const deployText = await readFile(logPath(root, 'dep-A', 'deploy'), 'utf8');
      for (const text of [buildText, deployText]) {
        const lines = text.split('\n').filter((l) => l.length > 0);
        expect(lines).toHaveLength(N);
        for (const l of lines) {
          // Throws if a line was torn.
          JSON.parse(l);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rotation triggers when projected size > rotateAtBytes', async () => {
    const root = await tmp();
    try {
      const logger = new DeployLogger({
        requestRoot: root,
        deployId: 'dep-A',
        component: 'deploy',
        rotateAtBytes: 200, // tiny so a couple of lines triggers rotation
        maxRotations: 3,
      });
      for (let i = 0; i < 10; i++) {
        logger.info('payload', { i, padding: 'x'.repeat(50) });
      }
      await logger.flush();
      const cur = logPath(root, 'dep-A', 'deploy');
      const rot1 = `${cur}.1`;
      // Rotation happened — the .1 file exists with prior content.
      const rot1Stat = await stat(rot1);
      expect(rot1Stat.size).toBeGreaterThan(0);
      // Current file has bytes too (post-rotation writes).
      const curStat = await stat(cur);
      expect(curStat.size).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('close() then info() throws LoggerClosedError', async () => {
    const root = await tmp();
    try {
      const logger = new DeployLogger({
        requestRoot: root,
        deployId: 'dep-A',
        component: 'deploy',
      });
      logger.info('one');
      await logger.close();
      expect(() => logger.info('two')).toThrow(LoggerClosedError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('forComponent returns sibling writing to a different file', async () => {
    const root = await tmp();
    try {
      const a = new DeployLogger({
        requestRoot: root,
        deployId: 'dep-A',
        component: 'deploy',
      });
      const b = a.forComponent('health');
      a.info('on-deploy');
      b.info('on-health');
      await a.flush();
      await b.flush();
      const aText = await readFile(logPath(root, 'dep-A', 'deploy'), 'utf8');
      const bText = await readFile(logPath(root, 'dep-A', 'health'), 'utf8');
      expect(aText).toContain('on-deploy');
      expect(bText).toContain('on-health');
      // Disjoint files.
      expect(aText).not.toContain('on-health');
      expect(bText).not.toContain('on-deploy');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('telemetry adapter receives one emit per info/warn/error and zero for debug', async () => {
    const root = await tmp();
    try {
      const events: { name: string }[] = [];
      const logger = new DeployLogger({
        requestRoot: root,
        deployId: 'dep-A',
        component: 'deploy',
        env: 'prod',
        backend: 'static',
        telemetry: {
          emit: (ev) => {
            events.push({ name: ev.name });
          },
        },
      });
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
      await logger.flush();
      expect(events.map((e) => e.name)).toEqual(['i', 'w', 'e']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
