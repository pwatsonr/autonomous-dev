/**
 * T001 — Config unit tests (readSelfImproveConfig).
 */
import { readSelfImproveConfig } from '../config';

describe('readSelfImproveConfig', () => {
  it('T001-01: empty env returns all defaults, enabled=false, no warnings', () => {
    const cfg = readSelfImproveConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.maxAttemptsPerIssue).toBe(3);
    expect(cfg.maxConcurrentGlobal).toBe(2);
    expect(cfg.maxConcurrentPerRepo).toBe(1);
    expect(cfg.maxCostUsdPerDay).toBe(5.0);
    expect(cfg.maxCostUsdPerWeek).toBe(25.0);
    expect(cfg.backoffBaseMinutes).toBe(60);
    expect(cfg.fnRegistryPath).toBeNull();
    expect(cfg.maxIssuesPerTick).toBe(5);
    expect(cfg.evidenceTimeoutMs).toBe(500);
    expect(cfg.botLogin).toBe('');
    expect(cfg.bodyTruncateBytes).toBe(32768);
    expect(cfg.addInProgressLabel).toBe(false);
    expect(cfg.configWarnings).toHaveLength(0);
  });

  it('T001-02: AUTONOMOUS_DEV_SELF_IMPROVE=1 → enabled=true', () => {
    const cfg = readSelfImproveConfig({ AUTONOMOUS_DEV_SELF_IMPROVE: '1' });
    expect(cfg.enabled).toBe(true);
    expect(cfg.configWarnings).toHaveLength(0);
  });

  it('T001-03: AUTONOMOUS_DEV_SELF_IMPROVE=true → enabled=false + warning', () => {
    const cfg = readSelfImproveConfig({ AUTONOMOUS_DEV_SELF_IMPROVE: 'true' });
    expect(cfg.enabled).toBe(false);
    expect(cfg.configWarnings.some((w) => w.envVar === 'AUTONOMOUS_DEV_SELF_IMPROVE')).toBe(true);
  });

  it('T001-04: invalid max attempts → fallback + warning', () => {
    const cfg = readSelfImproveConfig({ AUTONOMOUS_DEV_SELF_IMPROVE_MAX_ATTEMPTS: 'abc' });
    expect(cfg.maxAttemptsPerIssue).toBe(3);
    expect(
      cfg.configWarnings.find(
        (w) =>
          w.envVar === 'AUTONOMOUS_DEV_SELF_IMPROVE_MAX_ATTEMPTS' &&
          w.raw === 'abc' &&
          w.fallback === '3',
      ),
    ).toBeDefined();
  });

  it('T001-05: negative max attempts → fallback + warning', () => {
    const cfg = readSelfImproveConfig({ AUTONOMOUS_DEV_SELF_IMPROVE_MAX_ATTEMPTS: '-1' });
    expect(cfg.maxAttemptsPerIssue).toBe(3);
    expect(cfg.configWarnings).toHaveLength(1);
  });

  it('T001-06: maxCostUsdPerDay=0 → allowed (0 is ≥ 0)', () => {
    const cfg = readSelfImproveConfig({
      AUTONOMOUS_DEV_SELF_IMPROVE_MAX_COST_USD_PER_DAY: '0',
    });
    expect(cfg.maxCostUsdPerDay).toBe(0);
    expect(cfg.configWarnings).toHaveLength(0);
  });

  it('T001-07: AUTONOMOUS_DEV_BOT_LOGIN set → botLogin populated', () => {
    const cfg = readSelfImproveConfig({ AUTONOMOUS_DEV_BOT_LOGIN: 'octobot' });
    expect(cfg.botLogin).toBe('octobot');
  });

  it('T001-08: full valid env → all fields non-default, zero warnings', () => {
    const env = {
      AUTONOMOUS_DEV_SELF_IMPROVE: '1',
      AUTONOMOUS_DEV_SELF_IMPROVE_MAX_ATTEMPTS: '5',
      AUTONOMOUS_DEV_SELF_IMPROVE_MAX_CONCURRENT: '4',
      AUTONOMOUS_DEV_SELF_IMPROVE_MAX_CONCURRENT_PER_REPO: '2',
      AUTONOMOUS_DEV_SELF_IMPROVE_MAX_COST_USD_PER_DAY: '10',
      AUTONOMOUS_DEV_SELF_IMPROVE_MAX_COST_USD_PER_WEEK: '50',
      AUTONOMOUS_DEV_SELF_IMPROVE_BACKOFF_BASE_MINUTES: '30',
      AUTONOMOUS_DEV_SELF_IMPROVE_FN_REGISTRY_PATH: '/tmp/fn.json',
      AUTONOMOUS_DEV_SELF_IMPROVE_MAX_ISSUES_PER_TICK: '10',
      AUTONOMOUS_DEV_SELF_IMPROVE_EVIDENCE_TIMEOUT_MS: '1000',
      AUTONOMOUS_DEV_SELF_IMPROVE_BODY_TRUNCATE_BYTES: '65536',
      AUTONOMOUS_DEV_SELF_IMPROVE_ADD_INPROGRESS_LABEL: '1',
      AUTONOMOUS_DEV_BOT_LOGIN: 'mybot',
    };
    const cfg = readSelfImproveConfig(env);
    expect(cfg.enabled).toBe(true);
    expect(cfg.maxAttemptsPerIssue).toBe(5);
    expect(cfg.maxConcurrentGlobal).toBe(4);
    expect(cfg.maxConcurrentPerRepo).toBe(2);
    expect(cfg.maxCostUsdPerDay).toBe(10);
    expect(cfg.maxCostUsdPerWeek).toBe(50);
    expect(cfg.backoffBaseMinutes).toBe(30);
    expect(cfg.fnRegistryPath).toBe('/tmp/fn.json');
    expect(cfg.maxIssuesPerTick).toBe(10);
    expect(cfg.evidenceTimeoutMs).toBe(1000);
    expect(cfg.bodyTruncateBytes).toBe(65536);
    expect(cfg.addInProgressLabel).toBe(true);
    expect(cfg.botLogin).toBe('mybot');
    expect(cfg.configWarnings).toHaveLength(0);
  });

  it('T001-09: bodyTruncateBytes=0 → fallback to 32768 + warning', () => {
    const cfg = readSelfImproveConfig({
      AUTONOMOUS_DEV_SELF_IMPROVE_BODY_TRUNCATE_BYTES: '0',
    });
    expect(cfg.bodyTruncateBytes).toBe(32768);
    expect(cfg.configWarnings).toHaveLength(1);
  });
});
