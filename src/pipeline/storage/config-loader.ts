import * as fs from 'fs/promises';
import yaml from 'js-yaml';
import { PipelineConfig, DEFAULT_PIPELINE_CONFIG } from '../types/config';

export class ConfigValidationError extends Error {
  constructor(
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`Invalid config: ${field} -- ${reason}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Deep-merges a partial config onto the defaults.
 * Only leaf values from the partial override the defaults.
 * Unknown keys are ignored (not passed through).
 */
function deepMerge(defaults: PipelineConfig, partial: Record<string, unknown>): PipelineConfig {
  const result = structuredClone(defaults) as Record<string, unknown>;

  for (const key of Object.keys(defaults) as (keyof PipelineConfig)[]) {
    if (!(key in partial)) continue;
    const defaultVal = (defaults as Record<string, unknown>)[key];
    const partialVal = partial[key];

    if (
      defaultVal !== null &&
      typeof defaultVal === 'object' &&
      !Array.isArray(defaultVal) &&
      partialVal !== null &&
      typeof partialVal === 'object' &&
      !Array.isArray(partialVal)
    ) {
      result[key] = mergeObject(
        defaultVal as Record<string, unknown>,
        partialVal as Record<string, unknown>,
      );
    } else {
      result[key] = partialVal;
    }
  }

  return result as unknown as PipelineConfig;
}

/**
 * Recursively merges two plain objects. Only keys present in `defaults`
 * are carried forward; unknown keys in `partial` are ignored.
 */
function mergeObject(
  defaults: Record<string, unknown>,
  partial: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...defaults };

  for (const key of Object.keys(defaults)) {
    if (!(key in partial)) continue;
    const defaultVal = defaults[key];
    const partialVal = partial[key];

    if (
      defaultVal !== null &&
      typeof defaultVal === 'object' &&
      !Array.isArray(defaultVal) &&
      partialVal !== null &&
      typeof partialVal === 'object' &&
      !Array.isArray(partialVal)
    ) {
      result[key] = mergeObject(
        defaultVal as Record<string, unknown>,
        partialVal as Record<string, unknown>,
      );
    } else {
      result[key] = partialVal;
    }
  }

  return result;
}

/**
 * Validates merged config values:
 *   - pipeline.maxDepth must be 4 (hardcoded, reject override)
 *   - storage.maxDocumentsPerPipeline must be 1-1000
 *   - storage.maxVersionsPerDocument must be 1-100
 *   - storage.maxTotalSizeBytes must be > 0
 *   - storage.maxDocumentSizeBytes must be > 0
 *   - reviewGates.defaults.approvalThreshold must be 0-100
 *   - reviewGates.defaults.regressionMargin must be 0-100
 *   - reviewGates.defaults.panelSize must be >= 1
 *   - reviewGates.defaults.maxIterations must be >= 1
 *   - decomposition.maxChildrenPerDecomposition must be 1-50
 *   - decomposition.maxTotalNodes must be 1-500
 *   - decomposition.explosionThresholdPercent must be 1-100
 *   - backwardCascade.maxDepth must be 1-10
 *
 * @throws ConfigValidationError for invalid values
 */
function validateConfig(config: PipelineConfig): void {
  if (config.pipeline.maxDepth !== 4) {
    throw new ConfigValidationError(
      'pipeline.maxDepth',
      'must be 4 (hardcoded, cannot be overridden)',
    );
  }

  if (config.storage.maxDocumentsPerPipeline < 1 || config.storage.maxDocumentsPerPipeline > 1000) {
    throw new ConfigValidationError(
      'storage.maxDocumentsPerPipeline',
      'must be between 1 and 1000',
    );
  }

  if (config.storage.maxVersionsPerDocument < 1 || config.storage.maxVersionsPerDocument > 100) {
    throw new ConfigValidationError(
      'storage.maxVersionsPerDocument',
      'must be between 1 and 100',
    );
  }

  if (config.storage.maxTotalSizeBytes <= 0) {
    throw new ConfigValidationError(
      'storage.maxTotalSizeBytes',
      'must be greater than 0',
    );
  }

  if (config.storage.maxDocumentSizeBytes <= 0) {
    throw new ConfigValidationError(
      'storage.maxDocumentSizeBytes',
      'must be greater than 0',
    );
  }

  if (
    config.reviewGates.defaults.approvalThreshold < 0 ||
    config.reviewGates.defaults.approvalThreshold > 100
  ) {
    throw new ConfigValidationError(
      'reviewGates.defaults.approvalThreshold',
      'must be between 0 and 100',
    );
  }

  if (
    config.reviewGates.defaults.regressionMargin < 0 ||
    config.reviewGates.defaults.regressionMargin > 100
  ) {
    throw new ConfigValidationError(
      'reviewGates.defaults.regressionMargin',
      'must be between 0 and 100',
    );
  }

  if (config.reviewGates.defaults.panelSize < 1) {
    throw new ConfigValidationError(
      'reviewGates.defaults.panelSize',
      'must be at least 1',
    );
  }

  if (config.reviewGates.defaults.maxIterations < 1) {
    throw new ConfigValidationError(
      'reviewGates.defaults.maxIterations',
      'must be at least 1',
    );
  }

  if (
    config.decomposition.maxChildrenPerDecomposition < 1 ||
    config.decomposition.maxChildrenPerDecomposition > 50
  ) {
    throw new ConfigValidationError(
      'decomposition.maxChildrenPerDecomposition',
      'must be between 1 and 50',
    );
  }

  if (
    config.decomposition.maxTotalNodes < 1 ||
    config.decomposition.maxTotalNodes > 500
  ) {
    throw new ConfigValidationError(
      'decomposition.maxTotalNodes',
      'must be between 1 and 500',
    );
  }

  if (
    config.decomposition.explosionThresholdPercent < 1 ||
    config.decomposition.explosionThresholdPercent > 100
  ) {
    throw new ConfigValidationError(
      'decomposition.explosionThresholdPercent',
      'must be between 1 and 100',
    );
  }

  if (config.backwardCascade.maxDepth < 1 || config.backwardCascade.maxDepth > 10) {
    throw new ConfigValidationError(
      'backwardCascade.maxDepth',
      'must be between 1 and 10',
    );
  }
}

/**
 * Loads configuration from config.yaml, merges with defaults,
 * and validates.
 *
 * @param configPath Absolute path to config.yaml (may not exist)
 * @returns Merged and validated PipelineConfig
 */
export async function loadConfig(configPath: string): Promise<PipelineConfig> {
  let partial: Record<string, unknown> = {};

  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    partial = yaml.load(raw) as Record<string, unknown>;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err; // re-throw non-ENOENT errors (e.g. malformed YAML)
    }
    // File not found: use all defaults (this is fine)
  }

  const merged = deepMerge(DEFAULT_PIPELINE_CONFIG, partial);
  validateConfig(merged);
  return merged;
}
