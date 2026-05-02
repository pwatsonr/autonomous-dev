/**
 * SPEC-023-3-04: CostCapEnforcer threshold tests.
 *
 * Boundary table-driven test against fixtures at 79/80/99/100/109/110% of
 * a $100 cap, plus sticky-warning idempotency, override consumption, and
 * expiry handling.
 *
 * @module tests/deploy/test-cost-cap-enforcer.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';

import { CostCapEnforcer } from '../../intake/deploy/cost-cap-enforcer';
import {
  AdminOverrideRequiredError,
  DailyCostCapExceededError,
} from '../../intake/deploy/errors';
import type { EscalationMessage } from '../../intake/deploy/monitor-types';
import {
  TEST_HMAC_KEY,
  buildLedgerAt,
  writeOverrides,
} from './fixtures/cost-ledger-fixtures';

const FIXED_NOW = new Date('2026-05-02T12:00:00.000Z');
const CAP = 100;

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cost-cap-enforcer-'));
}

interface Harness {
  dir: string;
  enforcer: CostCapEnforcer;
  escalations: EscalationMessage[];
}

async function buildHarness(percent: number): Promise<Harness> {
  const dir = await tmp();
  const { ledger } = await buildLedgerAt({
    dir,
    percent,
    capUsd: CAP,
    now: () => FIXED_NOW,
  });
  const escalations: EscalationMessage[] = [];
  const enforcer = new CostCapEnforcer({
    ledger,
    config: () => ({ cost_cap_usd_per_day: CAP }),
    escalate: (msg) => {
      escalations.push(msg);
    },
    stateDir: dir,
    clock: () => FIXED_NOW,
  });
  return { dir, enforcer, escalations };
}

describe('SPEC-023-3-04 CostCapEnforcer thresholds', () => {
  beforeAll(() => {
    process.env.DEPLOY_COST_HMAC_KEY = TEST_HMAC_KEY;
  });

  it('79% spend + tiny estimate stays below 80% — silent allow', async () => {
    const h = await buildHarness(79);
    try {
      await expect(
        h.enforcer.check({
          actor: 'op@example',
          deployId: 'new-1',
          estimated_cost_usd: 0.5,
          env: 'prod',
          backend: 'static',
        }),
      ).resolves.toBeUndefined();
      expect(h.escalations).toHaveLength(0);
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  it('80% boundary — allowed with one warn escalation', async () => {
    const h = await buildHarness(79);
    try {
      // Estimate pushes total to 80%.
      await h.enforcer.check({
        actor: 'op@example',
        deployId: 'new-1',
        estimated_cost_usd: 1.0,
        env: 'prod',
        backend: 'static',
      });
      expect(h.escalations).toHaveLength(1);
      expect(h.escalations[0].severity).toBe('warn');
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  it('99% — allowed with no second escalation when sticky', async () => {
    const h = await buildHarness(80); // already at 80%
    try {
      // First check at 80% emits one warn.
      await h.enforcer.check({
        actor: 'op@example',
        deployId: 'd-1',
        estimated_cost_usd: 0.0001,
        env: 'prod',
        backend: 'static',
      });
      expect(h.escalations).toHaveLength(1);
      // Second check still in 80-100 band, same actor + same UTC day —
      // no second warn.
      await h.enforcer.check({
        actor: 'op@example',
        deployId: 'd-2',
        estimated_cost_usd: 1.0,
        env: 'prod',
        backend: 'static',
      });
      expect(h.escalations).toHaveLength(1);
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  it('100% — rejected with DailyCostCapExceededError', async () => {
    const h = await buildHarness(99);
    try {
      await expect(
        h.enforcer.check({
          actor: 'op@example',
          deployId: 'new-1',
          estimated_cost_usd: 1.5, // pushes to 100.5% -> >=100
          env: 'prod',
          backend: 'static',
        }),
      ).rejects.toBeInstanceOf(DailyCostCapExceededError);
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  it('109% — rejected with DailyCostCapExceededError (still below admin threshold)', async () => {
    const h = await buildHarness(108);
    try {
      await expect(
        h.enforcer.check({
          actor: 'op@example',
          deployId: 'new-1',
          estimated_cost_usd: 0.5, // pushes to 108.5% -> still <110
          env: 'prod',
          backend: 'static',
        }),
      ).rejects.toBeInstanceOf(DailyCostCapExceededError);
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  it('110% — rejected with AdminOverrideRequiredError (no token)', async () => {
    const h = await buildHarness(109);
    try {
      await expect(
        h.enforcer.check({
          actor: 'op@example',
          deployId: 'new-1',
          estimated_cost_usd: 1.0, // pushes to 110%
          env: 'prod',
          backend: 'static',
        }),
      ).rejects.toBeInstanceOf(AdminOverrideRequiredError);
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  it('110% with valid override — admitted; token is consumed exactly once', async () => {
    const h = await buildHarness(109);
    try {
      await writeOverrides(h.dir, [
        {
          actor: 'admin@example',
          deployId: 'new-1',
          expires_at: new Date(FIXED_NOW.getTime() + 60_000).toISOString(),
        },
      ]);
      // First check consumes.
      await h.enforcer.check({
        actor: 'op@example',
        deployId: 'new-1',
        estimated_cost_usd: 1.0,
        env: 'prod',
        backend: 'static',
      });
      // Override consumed -> file should now have an empty list.
      const txt = await fs.readFile(
        join(h.dir, 'deploy-cap-overrides.json'),
        'utf8',
      );
      const parsed = JSON.parse(txt) as { overrides: unknown[] };
      expect(parsed.overrides).toHaveLength(0);
      // Second deploy with same id → rejected.
      await expect(
        h.enforcer.check({
          actor: 'op@example',
          deployId: 'new-1',
          estimated_cost_usd: 1.0,
          env: 'prod',
          backend: 'static',
        }),
      ).rejects.toBeInstanceOf(AdminOverrideRequiredError);
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  it('expired override is treated as if no override existed', async () => {
    const h = await buildHarness(109);
    try {
      await writeOverrides(h.dir, [
        {
          actor: 'admin@example',
          deployId: 'new-1',
          expires_at: new Date(FIXED_NOW.getTime() - 60_000).toISOString(),
        },
      ]);
      await expect(
        h.enforcer.check({
          actor: 'op@example',
          deployId: 'new-1',
          estimated_cost_usd: 1.0,
          env: 'prod',
          backend: 'static',
        }),
      ).rejects.toBeInstanceOf(AdminOverrideRequiredError);
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  it('sticky warning persists across enforcer instances (same dir, same day)', async () => {
    const dir = await tmp();
    try {
      const { ledger } = await buildLedgerAt({
        dir,
        percent: 80,
        capUsd: CAP,
        now: () => FIXED_NOW,
      });
      const escalations1: EscalationMessage[] = [];
      const e1 = new CostCapEnforcer({
        ledger,
        config: () => ({ cost_cap_usd_per_day: CAP }),
        escalate: (msg) => {
          escalations1.push(msg);
        },
        stateDir: dir,
        clock: () => FIXED_NOW,
      });
      await e1.check({
        actor: 'op@example',
        deployId: 'd-1',
        estimated_cost_usd: 0.0001,
        env: 'prod',
        backend: 'static',
      });
      expect(escalations1).toHaveLength(1);

      // Restart simulation: build a fresh enforcer pointing at the same
      // state dir. It must see the persisted warning record and not re-emit.
      const escalations2: EscalationMessage[] = [];
      const e2 = new CostCapEnforcer({
        ledger,
        config: () => ({ cost_cap_usd_per_day: CAP }),
        escalate: (msg) => {
          escalations2.push(msg);
        },
        stateDir: dir,
        clock: () => FIXED_NOW,
      });
      await e2.check({
        actor: 'op@example',
        deployId: 'd-2',
        estimated_cost_usd: 0.0001,
        env: 'prod',
        backend: 'static',
      });
      expect(escalations2).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
