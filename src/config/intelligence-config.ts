import * as fs from 'fs/promises';
import yaml from 'js-yaml';
import {
  IntelligenceConfigSchema,
  type IntelligenceConfig,
  type ThresholdConfig,
} from './intelligence-config.schema';

/**
 * Converts an interval string (e.g. "4h", "30m") to a cron expression.
 *
 * Conversion rules:
 *   - "Nh" -> "0 * /N * * *"  (hours)
 *   - "Nm" -> "* /N * * * *"  (minutes)
 *
 * @throws Error if the interval string does not match expected format
 */
export function intervalToCron(interval: string): string {
  const match = interval.match(/^(\d+)(h|m)$/);
  if (!match) {
    throw new Error(
      `Invalid interval format "${interval}". Expected a value like "4h" or "30m".`,
    );
  }

  const value = match[1];
  const unit = match[2];

  if (unit === 'h') {
    return `0 */${value} * * *`;
  }
  // unit === 'm'
  return `*/${value} * * * *`;
}

/**
 * Loads and validates the intelligence.yaml configuration file.
 *
 * Steps:
 *   1. Read YAML file from disk
 *   2. Parse with js-yaml
 *   3. Validate against Zod schema -- throw on invalid
 *   4. Convert interval schedule to cron if schedule.type === "interval"
 *   5. Return typed config
 *
 * @param configPath Absolute path to intelligence.yaml
 * @returns Validated IntelligenceConfig
 * @throws ZodError for schema violations
 * @throws Error for file read or YAML parse failures
 */
export async function loadConfig(configPath: string): Promise<IntelligenceConfig> {
  const raw = await fs.readFile(configPath, 'utf-8');
  const parsed = yaml.load(raw) as Record<string, unknown>;
  const config = IntelligenceConfigSchema.parse(parsed);

  // Convert interval to cron if needed
  if (config.schedule.type === 'interval') {
    config.schedule.expression = intervalToCron(config.schedule.expression);
    config.schedule.type = 'cron';
  }

  return config;
}

/**
 * Returns the effective thresholds for a specific service by deep-merging
 * the default thresholds with any per-service overrides.
 *
 * Only fields explicitly specified in per_service_overrides replace the
 * defaults; unspecified fields are inherited from default_thresholds.
 *
 * @param config The loaded IntelligenceConfig
 * @param serviceName The service name to look up overrides for
 * @returns Merged ThresholdConfig
 */
export function getServiceThresholds(
  config: IntelligenceConfig,
  serviceName: string,
): ThresholdConfig {
  const overrides = config.per_service_overrides[serviceName] ?? {};
  return { ...config.default_thresholds, ...overrides };
}
