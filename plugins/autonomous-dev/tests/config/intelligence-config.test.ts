import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import yaml from 'js-yaml';
import {
  loadConfig,
  getServiceThresholds,
  intervalToCron,
} from '../../src/config/intelligence-config';
import type { IntelligenceConfig } from '../../src/config/intelligence-config.schema';

/**
 * Builds a minimal valid intelligence.yaml content object.
 * Individual tests override specific fields to test edge cases.
 */
function buildValidConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    schedule: { type: 'cron', expression: '0 */4 * * *' },
    services: [
      {
        name: 'api-gateway',
        repo: 'org/api-gateway',
        prometheus_job: 'api-gateway',
        grafana_dashboard_uid: 'abc123',
        opensearch_index: 'logs-api-gateway-*',
        sentry_project: 'api-gateway',
        criticality: 'critical',
      },
    ],
    default_thresholds: {
      error_rate_percent: 5.0,
      sustained_duration_minutes: 10,
      p99_latency_ms: 5000,
      availability_percent: 99.0,
    },
    per_service_overrides: {},
    query_budgets: {
      prometheus: { max_queries_per_service: 20, timeout_seconds: 30 },
      grafana: { max_queries_per_service: 10, timeout_seconds: 30 },
      opensearch: { max_queries_per_service: 15, timeout_seconds: 60 },
      sentry: { max_queries_per_service: 10, timeout_seconds: 30 },
    },
    anomaly_detection: {
      method: 'zscore',
      sensitivity: 2.5,
      consecutive_runs_required: 2,
    },
    trend_analysis: {
      windows: ['7d', '14d', '30d'],
      min_slope_threshold: 5.0,
    },
    false_positive_filters: {
      maintenance_windows: [],
      excluded_error_patterns: [],
      load_test_markers: [],
    },
    governance: {
      cooldown_days: 7,
      oscillation_window_days: 30,
      oscillation_threshold: 3,
      effectiveness_comparison_days: 7,
      effectiveness_improvement_threshold: 10.0,
    },
    retention: {
      observation_days: 90,
      archive_days: 365,
    },
    custom_pii_patterns: [],
    custom_secret_patterns: [],
    auto_promote: {
      enabled: false,
      override_hours: 2,
    },
    notifications: {
      enabled: false,
      webhook_url: null,
      severity_filter: ['P0', 'P1'],
    },
  };

  return { ...base, ...overrides };
}

describe('intelligence-config', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'intel-config-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Helper: write a config object as YAML and return its path */
  async function writeConfig(config: Record<string, unknown>): Promise<string> {
    const configPath = path.join(tmpDir, 'intelligence.yaml');
    await fs.writeFile(configPath, yaml.dump(config), 'utf-8');
    return configPath;
  }

  // --- TC-1-1-01: Valid config loads successfully ---
  describe('TC-1-1-01: valid config loads successfully', () => {
    it('returns a typed IntelligenceConfig with no errors', async () => {
      const configPath = await writeConfig(buildValidConfig());
      const config = await loadConfig(configPath);

      expect(config.schedule.type).toBe('cron');
      expect(config.schedule.expression).toBe('0 */4 * * *');
      expect(config.services).toHaveLength(1);
      expect(config.services[0].name).toBe('api-gateway');
      expect(config.default_thresholds.error_rate_percent).toBe(5.0);
      expect(config.query_budgets.prometheus.max_queries_per_service).toBe(20);
      expect(config.anomaly_detection.method).toBe('zscore');
      expect(config.trend_analysis.windows).toEqual(['7d', '14d', '30d']);
      expect(config.governance.cooldown_days).toBe(7);
      expect(config.retention.observation_days).toBe(90);
      expect(config.auto_promote.enabled).toBe(false);
      expect(config.notifications.enabled).toBe(false);
    });
  });

  // --- TC-1-1-02: Missing required field rejected ---
  describe('TC-1-1-02: missing required field rejected', () => {
    it('throws ZodError when schedule block is missing', async () => {
      const raw = buildValidConfig();
      delete raw.schedule;
      const configPath = await writeConfig(raw);

      await expect(loadConfig(configPath)).rejects.toThrow();
    });

    it('throws ZodError when services block is missing', async () => {
      const raw = buildValidConfig();
      delete raw.services;
      const configPath = await writeConfig(raw);

      await expect(loadConfig(configPath)).rejects.toThrow();
    });

    it('throws ZodError when default_thresholds block is missing', async () => {
      const raw = buildValidConfig();
      delete raw.default_thresholds;
      const configPath = await writeConfig(raw);

      await expect(loadConfig(configPath)).rejects.toThrow();
    });
  });

  // --- TC-1-1-03: Invalid enum value rejected ---
  describe('TC-1-1-03: invalid enum value rejected', () => {
    it('rejects invalid criticality enum', async () => {
      const raw = buildValidConfig({
        services: [
          {
            name: 'api-gateway',
            repo: 'org/api-gateway',
            prometheus_job: 'api-gateway',
            grafana_dashboard_uid: 'abc123',
            opensearch_index: 'logs-api-gateway-*',
            criticality: 'extreme',
          },
        ],
      });
      const configPath = await writeConfig(raw);

      await expect(loadConfig(configPath)).rejects.toThrow(/Invalid enum value/);
    });

    it('rejects invalid anomaly detection method', async () => {
      const raw = buildValidConfig({
        anomaly_detection: {
          method: 'random',
          sensitivity: 2.5,
          consecutive_runs_required: 2,
        },
      });
      const configPath = await writeConfig(raw);

      await expect(loadConfig(configPath)).rejects.toThrow(/Invalid enum value/);
    });

    it('rejects invalid schedule type', async () => {
      const raw = buildValidConfig({
        schedule: { type: 'manual', expression: '0 */4 * * *' },
      });
      const configPath = await writeConfig(raw);

      await expect(loadConfig(configPath)).rejects.toThrow(/Invalid enum value/);
    });
  });

  // --- TC-1-1-04: Interval conversion: hours ---
  describe('TC-1-1-04: interval conversion: hours', () => {
    it('converts "4h" interval to cron "0 */4 * * *"', async () => {
      const raw = buildValidConfig({
        schedule: { type: 'interval', expression: '4h' },
      });
      const configPath = await writeConfig(raw);
      const config = await loadConfig(configPath);

      expect(config.schedule.type).toBe('cron');
      expect(config.schedule.expression).toBe('0 */4 * * *');
    });

    it('converts "1h" interval to cron "0 */1 * * *"', async () => {
      const raw = buildValidConfig({
        schedule: { type: 'interval', expression: '1h' },
      });
      const configPath = await writeConfig(raw);
      const config = await loadConfig(configPath);

      expect(config.schedule.expression).toBe('0 */1 * * *');
    });

    it('converts "6h" interval to cron "0 */6 * * *"', async () => {
      const raw = buildValidConfig({
        schedule: { type: 'interval', expression: '6h' },
      });
      const configPath = await writeConfig(raw);
      const config = await loadConfig(configPath);

      expect(config.schedule.expression).toBe('0 */6 * * *');
    });
  });

  // --- TC-1-1-05: Interval conversion: minutes ---
  describe('TC-1-1-05: interval conversion: minutes', () => {
    it('converts "30m" interval to cron "*/30 * * * *"', async () => {
      const raw = buildValidConfig({
        schedule: { type: 'interval', expression: '30m' },
      });
      const configPath = await writeConfig(raw);
      const config = await loadConfig(configPath);

      expect(config.schedule.type).toBe('cron');
      expect(config.schedule.expression).toBe('*/30 * * * *');
    });
  });

  // --- TC-1-1-06: Deep-merge overrides ---
  describe('TC-1-1-06: deep-merge overrides', () => {
    it('overrides specified fields and inherits unspecified from defaults', async () => {
      const raw = buildValidConfig({
        per_service_overrides: {
          'api-gateway': {
            error_rate_percent: 3.0,
            sustained_duration_minutes: 5,
          },
        },
      });
      const configPath = await writeConfig(raw);
      const config = await loadConfig(configPath);

      const thresholds = getServiceThresholds(config, 'api-gateway');

      // Overridden fields
      expect(thresholds.error_rate_percent).toBe(3.0);
      expect(thresholds.sustained_duration_minutes).toBe(5);

      // Inherited from defaults
      expect(thresholds.p99_latency_ms).toBe(5000);
      expect(thresholds.availability_percent).toBe(99.0);
    });
  });

  // --- TC-1-1-07: Deep-merge no override ---
  describe('TC-1-1-07: deep-merge no override', () => {
    it('returns all defaults when no override exists for the service', async () => {
      const raw = buildValidConfig();
      const configPath = await writeConfig(raw);
      const config = await loadConfig(configPath);

      const thresholds = getServiceThresholds(config, 'user-service');

      expect(thresholds.error_rate_percent).toBe(5.0);
      expect(thresholds.sustained_duration_minutes).toBe(10);
      expect(thresholds.p99_latency_ms).toBe(5000);
      expect(thresholds.availability_percent).toBe(99.0);
    });
  });

  // --- TC-1-1-12: Custom patterns appended ---
  describe('TC-1-1-12: custom patterns', () => {
    it('loads custom PII patterns from config', async () => {
      const raw = buildValidConfig({
        custom_pii_patterns: ['SSN-\\d{3}-\\d{2}-\\d{4}', 'DL-[A-Z]{2}\\d+'],
      });
      const configPath = await writeConfig(raw);
      const config = await loadConfig(configPath);

      expect(config.custom_pii_patterns).toHaveLength(2);
      expect(config.custom_pii_patterns).toContain('SSN-\\d{3}-\\d{2}-\\d{4}');
      expect(config.custom_pii_patterns).toContain('DL-[A-Z]{2}\\d+');
    });

    it('loads custom secret patterns from config', async () => {
      const raw = buildValidConfig({
        custom_secret_patterns: ['my-custom-secret-\\w+'],
      });
      const configPath = await writeConfig(raw);
      const config = await loadConfig(configPath);

      expect(config.custom_secret_patterns).toHaveLength(1);
    });
  });

  // --- Query budget defaults match TDD section 3.1.4 ---
  describe('query budget defaults', () => {
    it('matches TDD section 3.1.4 defaults', async () => {
      const raw = buildValidConfig();
      const configPath = await writeConfig(raw);
      const config = await loadConfig(configPath);

      expect(config.query_budgets.prometheus.max_queries_per_service).toBe(20);
      expect(config.query_budgets.prometheus.timeout_seconds).toBe(30);
      expect(config.query_budgets.grafana.max_queries_per_service).toBe(10);
      expect(config.query_budgets.grafana.timeout_seconds).toBe(30);
      expect(config.query_budgets.opensearch.max_queries_per_service).toBe(15);
      expect(config.query_budgets.opensearch.timeout_seconds).toBe(60);
      expect(config.query_budgets.sentry.max_queries_per_service).toBe(10);
      expect(config.query_budgets.sentry.timeout_seconds).toBe(30);
    });
  });

  // --- intervalToCron unit tests ---
  describe('intervalToCron', () => {
    it('converts hour intervals correctly', () => {
      expect(intervalToCron('4h')).toBe('0 */4 * * *');
      expect(intervalToCron('1h')).toBe('0 */1 * * *');
      expect(intervalToCron('6h')).toBe('0 */6 * * *');
      expect(intervalToCron('12h')).toBe('0 */12 * * *');
    });

    it('converts minute intervals correctly', () => {
      expect(intervalToCron('30m')).toBe('*/30 * * * *');
      expect(intervalToCron('15m')).toBe('*/15 * * * *');
      expect(intervalToCron('5m')).toBe('*/5 * * * *');
    });

    it('throws on invalid format', () => {
      expect(() => intervalToCron('4d')).toThrow('Invalid interval format');
      expect(() => intervalToCron('abc')).toThrow('Invalid interval format');
      expect(() => intervalToCron('')).toThrow('Invalid interval format');
    });
  });

  // --- File not found ---
  describe('error handling', () => {
    it('throws when config file does not exist', async () => {
      const missingPath = path.join(tmpDir, 'nonexistent.yaml');
      await expect(loadConfig(missingPath)).rejects.toThrow();
    });

    it('throws on malformed YAML', async () => {
      const configPath = path.join(tmpDir, 'bad.yaml');
      await fs.writeFile(configPath, '{{{{not yaml', 'utf-8');
      await expect(loadConfig(configPath)).rejects.toThrow();
    });

    it('throws when services array is empty', async () => {
      const raw = buildValidConfig({ services: [] });
      const configPath = await writeConfig(raw);
      await expect(loadConfig(configPath)).rejects.toThrow();
    });
  });
});
