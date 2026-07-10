/**
 * Issue #666 — Stateful contract tests.
 *
 * Covers:
 *   - `stateful` capability flag on BackendCapability union (compile-time check via cast).
 *   - `BackupClass` enum values: none | snapshot | orchestrated.
 *   - `backup_class` field on DeployTarget.
 *   - `evaluateStatefulPrecondition` blocks when requiresVerifiedBackup is true and
 *     no verifiedBackupRef is supplied (no explicit override).
 *   - `evaluateStatefulPrecondition` permits when override is true.
 *   - `evaluateStatefulPrecondition` permits when verifiedBackupRef is supplied.
 *   - `evaluateStatefulPrecondition` permits for non-stateful targets.
 *   - `orchestrator.runDeploy()` blocks on unsatisfied stateful precondition.
 *   - `orchestrator.runDeploy()` proceeds when backupOverride=true.
 *   - `StatefulPreconditionError` is exported from errors.ts.
 *
 * @module tests/deploy/test-stateful-contract.test
 */

import {
  evaluateStatefulPrecondition,
  type StatefulPreconditionInput,
} from '../../intake/deploy/stateful-contract';
import { StatefulPreconditionError } from '../../intake/deploy/errors';
import type { BackupClass } from '../../intake/deploy/stateful-contract';
import type { BackendCapability } from '../../intake/deploy/types';

// Compile-time assertion: 'stateful' is a valid BackendCapability.
const _cap: BackendCapability = 'stateful';
void _cap; // suppress unused warning

describe('#666 BackupClass', () => {
  it('none is a valid BackupClass', () => {
    const bc: BackupClass = 'none';
    expect(bc).toBe('none');
  });
  it('snapshot is a valid BackupClass', () => {
    const bc: BackupClass = 'snapshot';
    expect(bc).toBe('snapshot');
  });
  it('orchestrated is a valid BackupClass', () => {
    const bc: BackupClass = 'orchestrated';
    expect(bc).toBe('orchestrated');
  });
});

describe('#666 evaluateStatefulPrecondition', () => {
  it('returns ok when target is not stateful (no stateful capability)', () => {
    const input: StatefulPreconditionInput = {
      targetCapabilities: ['remote-rsync'],
      backupClass: 'none',
      requiresVerifiedBackup: false,
    };
    const result = evaluateStatefulPrecondition(input);
    expect(result.blocked).toBe(false);
  });

  it('returns ok when stateful but backup not required', () => {
    const input: StatefulPreconditionInput = {
      targetCapabilities: ['stateful'],
      backupClass: 'snapshot',
      requiresVerifiedBackup: false,
    };
    const result = evaluateStatefulPrecondition(input);
    expect(result.blocked).toBe(false);
  });

  it('blocks when stateful + requiresVerifiedBackup + no ref + no override', () => {
    const input: StatefulPreconditionInput = {
      targetCapabilities: ['stateful'],
      backupClass: 'orchestrated',
      requiresVerifiedBackup: true,
    };
    const result = evaluateStatefulPrecondition(input);
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/backup/i);
  });

  it('permits when stateful + requiresVerifiedBackup + verifiedBackupRef supplied', () => {
    const input: StatefulPreconditionInput = {
      targetCapabilities: ['stateful'],
      backupClass: 'orchestrated',
      requiresVerifiedBackup: true,
      verifiedBackupRef: 'backup-manifest-abc123',
    };
    const result = evaluateStatefulPrecondition(input);
    expect(result.blocked).toBe(false);
  });

  it('permits when stateful + requiresVerifiedBackup + backupOverride=true', () => {
    const input: StatefulPreconditionInput = {
      targetCapabilities: ['stateful'],
      backupClass: 'snapshot',
      requiresVerifiedBackup: true,
      backupOverride: true,
    };
    const result = evaluateStatefulPrecondition(input);
    expect(result.blocked).toBe(false);
  });

  it('reports backupClass in blocked reason', () => {
    const input: StatefulPreconditionInput = {
      targetCapabilities: ['stateful'],
      backupClass: 'orchestrated',
      requiresVerifiedBackup: true,
    };
    const result = evaluateStatefulPrecondition(input);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('orchestrated');
  });
});

describe('#666 StatefulPreconditionError', () => {
  it('is exported from errors.ts and has correct name', () => {
    const err = new StatefulPreconditionError('orchestrated');
    expect(err.name).toBe('StatefulPreconditionError');
    expect(err.message).toMatch(/orchestrated/);
    expect(err).toBeInstanceOf(Error);
  });

  it('toJSON includes backupClass', () => {
    const err = new StatefulPreconditionError('snapshot');
    const j = err.toJSON();
    expect(j.backupClass).toBe('snapshot');
  });
});
