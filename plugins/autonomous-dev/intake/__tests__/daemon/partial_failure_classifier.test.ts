/**
 * partial_failure_classifier tests (SPEC-012-1-03 §"Partial Failure Classifier").
 *
 * @module __tests__/daemon/partial_failure_classifier.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  IN_FLIGHT_MAX_AGE_MS,
  classifyTempFile,
} from '../../daemon/partial_failure_classifier';

function mkdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-dev-classify-'));
}

function rmdir(d: string): void {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe('classifyTempFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdir();
  });

  afterEach(() => {
    rmdir(dir);
  });

  test('NEEDS_PROMOTION for *.needs_promotion suffix', async () => {
    const p = path.join(dir, 'state.json.tmp.123.abcd1234.needs_promotion');
    fs.writeFileSync(p, 'x');
    expect(await classifyTempFile(p)).toBe('NEEDS_PROMOTION');
  });

  test('CORRUPT for *.corrupt suffix', async () => {
    const p = path.join(dir, 'state.json.tmp.123.abcd1234.corrupt');
    fs.writeFileSync(p, 'x');
    expect(await classifyTempFile(p)).toBe('CORRUPT');
  });

  test('IN_FLIGHT for fresh temp from current PID', async () => {
    const p = path.join(dir, `state.json.tmp.${process.pid}.deadbeef00000000`);
    fs.writeFileSync(p, '{}');
    expect(await classifyTempFile(p)).toBe('IN_FLIGHT');
  });

  test('ORPHANED for temp from dead PID (999999)', async () => {
    const p = path.join(dir, 'state.json.tmp.999999.deadbeef00000000');
    fs.writeFileSync(p, '{}');
    expect(await classifyTempFile(p)).toBe('ORPHANED');
  });

  test('ORPHANED when mtime > 60s old, even from current PID', async () => {
    const p = path.join(dir, `state.json.tmp.${process.pid}.cafebabecafebabe`);
    fs.writeFileSync(p, '{}');
    // Force mtime to far in the past via injected nowMs (cheaper than utimes).
    expect(
      await classifyTempFile(p, { nowMs: Date.now() + IN_FLIGHT_MAX_AGE_MS + 5000 }),
    ).toBe('ORPHANED');
  });

  test('ORPHANED for non-matching filename pattern (defensive)', async () => {
    const p = path.join(dir, 'random_file');
    fs.writeFileSync(p, 'x');
    expect(await classifyTempFile(p)).toBe('ORPHANED');
  });

  test('ORPHANED when file vanishes before classification', async () => {
    const p = path.join(dir, 'state.json.tmp.123.abcd1234');
    // Don't create — stat will fail.
    expect(await classifyTempFile(p)).toBe('ORPHANED');
  });
});
