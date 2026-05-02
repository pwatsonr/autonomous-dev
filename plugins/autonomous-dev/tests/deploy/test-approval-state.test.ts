/**
 * SPEC-023-2-03 approval state machine tests.
 *
 * @module tests/deploy/test-approval-state.test
 */

import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  __setApprovalClockForTest,
  approvalPathFor,
  checkApprovalStatus,
  loadApprovalState,
  recordApproval,
  recordRejection,
  requestApproval,
} from '../../intake/deploy/approval';
import {
  AdminRequiredError,
  ApprovalChainError,
  DeployError,
  DuplicateApproverError,
} from '../../intake/deploy/errors';

const KEY = randomBytes(32);

let tickCounter = 0;
function tickIso(): string {
  tickCounter += 1;
  // Stable, monotonically increasing ISO timestamps for determinism.
  const base = new Date('2026-05-02T00:00:00Z').getTime();
  return new Date(base + tickCounter * 1000).toISOString();
}

beforeEach(() => {
  tickCounter = 0;
  __setApprovalClockForTest(tickIso);
});
afterEach(() => {
  __setApprovalClockForTest(null);
});

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'approval-'));
}

describe('SPEC-023-2-03 requestApproval', () => {
  it('with requirement "none" derives approved with no entries', async () => {
    const dir = await tmp();
    try {
      const s = await requestApproval({
        deployId: 'd1',
        envName: 'dev',
        requirement: 'none',
        requestDir: dir,
        hmacKey: KEY,
      });
      expect(s.decision).toBe('approved');
      expect(s.entries).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('with requirement "single" returns pending', async () => {
    const dir = await tmp();
    try {
      const s = await requestApproval({
        deployId: 'd2',
        envName: 'staging',
        requirement: 'single',
        requestDir: dir,
        hmacKey: KEY,
      });
      expect(s.decision).toBe('pending');
      expect(s.entries).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes state file with mode 0600', async () => {
    const dir = await tmp();
    try {
      await requestApproval({
        deployId: 'd3',
        envName: 'staging',
        requirement: 'single',
        requestDir: dir,
        hmacKey: KEY,
      });
      const stat = await fs.stat(approvalPathFor(dir, 'd3'));
      // Mask off non-perm bits, compare to 0600.
      expect(stat.mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('SPEC-023-2-03 recordApproval thresholds', () => {
  it('single: one approver advances to approved', async () => {
    const dir = await tmp();
    try {
      await requestApproval({
        deployId: 'd4',
        envName: 'staging',
        requirement: 'single',
        requestDir: dir,
        hmacKey: KEY,
      });
      const s = await recordApproval({
        deployId: 'd4',
        approver: 'alice@example.com',
        role: 'operator',
        requestDir: dir,
        hmacKey: KEY,
      });
      expect(s.decision).toBe('approved');
      expect(s.resolvedAt).not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('two-person: requires two distinct approvers', async () => {
    const dir = await tmp();
    try {
      await requestApproval({
        deployId: 'd5',
        envName: 'prod',
        requirement: 'two-person',
        requestDir: dir,
        hmacKey: KEY,
      });
      const s1 = await recordApproval({
        deployId: 'd5',
        approver: 'alice@example.com',
        role: 'operator',
        requestDir: dir,
        hmacKey: KEY,
      });
      expect(s1.decision).toBe('pending');
      const s2 = await recordApproval({
        deployId: 'd5',
        approver: 'bob@example.com',
        role: 'operator',
        requestDir: dir,
        hmacKey: KEY,
      });
      expect(s2.decision).toBe('approved');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('two-person: same approver twice -> DuplicateApproverError', async () => {
    const dir = await tmp();
    try {
      await requestApproval({
        deployId: 'd6',
        envName: 'prod',
        requirement: 'two-person',
        requestDir: dir,
        hmacKey: KEY,
      });
      await recordApproval({
        deployId: 'd6',
        approver: 'alice@example.com',
        role: 'operator',
        requestDir: dir,
        hmacKey: KEY,
      });
      await expect(
        recordApproval({
          deployId: 'd6',
          approver: 'alice@example.com',
          role: 'operator',
          requestDir: dir,
          hmacKey: KEY,
        }),
      ).rejects.toBeInstanceOf(DuplicateApproverError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('admin: operator role rejected', async () => {
    const dir = await tmp();
    try {
      await requestApproval({
        deployId: 'd7',
        envName: 'prod',
        requirement: 'admin',
        requestDir: dir,
        hmacKey: KEY,
      });
      await expect(
        recordApproval({
          deployId: 'd7',
          approver: 'alice@example.com',
          role: 'operator',
          requestDir: dir,
          hmacKey: KEY,
        }),
      ).rejects.toBeInstanceOf(AdminRequiredError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('admin: admin role accepted', async () => {
    const dir = await tmp();
    try {
      await requestApproval({
        deployId: 'd8',
        envName: 'prod',
        requirement: 'admin',
        requestDir: dir,
        hmacKey: KEY,
      });
      const s = await recordApproval({
        deployId: 'd8',
        approver: 'admin@example.com',
        role: 'admin',
        requestDir: dir,
        hmacKey: KEY,
      });
      expect(s.decision).toBe('approved');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('SPEC-023-2-03 recordRejection', () => {
  it('rejects regardless of requirement', async () => {
    const dir = await tmp();
    try {
      await requestApproval({
        deployId: 'd9',
        envName: 'prod',
        requirement: 'two-person',
        requestDir: dir,
        hmacKey: KEY,
      });
      const s = await recordRejection({
        deployId: 'd9',
        approver: 'alice@example.com',
        role: 'operator',
        reason: 'infra freeze',
        requestDir: dir,
        hmacKey: KEY,
      });
      expect(s.decision).toBe('rejected');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('empty reason -> DeployError', async () => {
    const dir = await tmp();
    try {
      await requestApproval({
        deployId: 'dA',
        envName: 'staging',
        requirement: 'single',
        requestDir: dir,
        hmacKey: KEY,
      });
      await expect(
        recordRejection({
          deployId: 'dA',
          approver: 'alice@example.com',
          role: 'operator',
          reason: '',
          requestDir: dir,
          hmacKey: KEY,
        }),
      ).rejects.toBeInstanceOf(DeployError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('SPEC-023-2-03 HMAC chain tampering', () => {
  it('mutating recordedAt on disk causes ApprovalChainError', async () => {
    const dir = await tmp();
    try {
      await requestApproval({
        deployId: 'dB',
        envName: 'prod',
        requirement: 'two-person',
        requestDir: dir,
        hmacKey: KEY,
      });
      await recordApproval({
        deployId: 'dB',
        approver: 'alice@example.com',
        role: 'operator',
        requestDir: dir,
        hmacKey: KEY,
      });
      await recordApproval({
        deployId: 'dB',
        approver: 'bob@example.com',
        role: 'operator',
        requestDir: dir,
        hmacKey: KEY,
      });

      const path = approvalPathFor(dir, 'dB');
      const text = await fs.readFile(path, 'utf8');
      const parsed = JSON.parse(text);
      parsed.entries[0].recordedAt = '2099-01-01T00:00:00.000Z';
      await fs.writeFile(path, JSON.stringify(parsed));

      let err: unknown;
      try {
        await loadApprovalState('dB', dir, { hmacKey: KEY });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ApprovalChainError);
      expect((err as ApprovalChainError).entryIndex).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('mutating second entry approver causes ApprovalChainError on entry 1', async () => {
    const dir = await tmp();
    try {
      await requestApproval({
        deployId: 'dC',
        envName: 'prod',
        requirement: 'two-person',
        requestDir: dir,
        hmacKey: KEY,
      });
      await recordApproval({
        deployId: 'dC',
        approver: 'alice@example.com',
        role: 'operator',
        requestDir: dir,
        hmacKey: KEY,
      });
      await recordApproval({
        deployId: 'dC',
        approver: 'bob@example.com',
        role: 'operator',
        requestDir: dir,
        hmacKey: KEY,
      });

      const path = approvalPathFor(dir, 'dC');
      const parsed = JSON.parse(await fs.readFile(path, 'utf8'));
      parsed.entries[1].approver = 'eve@example.com';
      await fs.writeFile(path, JSON.stringify(parsed));

      let err: unknown;
      try {
        await loadApprovalState('dC', dir, { hmacKey: KEY });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ApprovalChainError);
      expect((err as ApprovalChainError).entryIndex).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('SPEC-023-2-03 persistence', () => {
  it('checkApprovalStatus reads back identical state', async () => {
    const dir = await tmp();
    try {
      const written = await requestApproval({
        deployId: 'dD',
        envName: 'staging',
        requirement: 'single',
        requestDir: dir,
        hmacKey: KEY,
      });
      const read = await checkApprovalStatus('dD', dir, { hmacKey: KEY });
      expect(read).toEqual(written);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
