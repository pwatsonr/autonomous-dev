/**
 * Agent Factory configuration loader (SPEC-005-1-4, Task 11).
 *
 * Loads configuration from `config/agent-factory.yaml` (or a provided path),
 * merges with defaults, and validates constraints (e.g., relative paths).
 *
 * If the config file is missing, returns all defaults without error.
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Configuration interface
// ---------------------------------------------------------------------------

export interface AgentFactoryConfig {
  registry: { agentsDir: string; maxAgents: number };
  observation: { defaultThreshold: number; perAgentOverrides: Record<string, number> };
  domainMatching: { similarityThreshold: number; maxResults: number };
  rateLimits: { modificationsPerAgentPerWeek: number; agentCreationsPerWeek: number };
  anomalyThresholds: {
    approvalRateDrop: number;
    qualityDeclinePoints: number;
    qualityDeclineWindow: number;
    escalationRate: number;
    tokenBudgetMultiplier: number;
  };
  autonomousPromotion?: {
    /** Whether autonomous patch-level promotion is enabled. Default false. */
    enabled: boolean;
    /** Hours the operator override window stays open after auto-promotion. Default 24. */
    overrideHours: number;
    /** Hours of post-promotion quality monitoring before monitoring ends. Default 48. */
    autoRollbackHours: number;
    /** Days the cooldown lasts after an auto-rollback triggers. Default 30. */
    cooldownDays: number;
    /** Minimum post-promotion invocations required before evaluating decline. Default 3. */
    minInvocationsForDecline: number;
    /** Approval rate drop threshold (absolute) to trigger rollback. Default 0.1. */
    approvalRateDropThreshold: number;
    /** Quality score drop threshold (absolute) to trigger rollback. Default 0.5. */
    qualityScoreDropThreshold: number;
  };
  modelRegistry: string[];
  paths: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: AgentFactoryConfig = {
  registry: {
    agentsDir: 'agents/',
    maxAgents: 50,
  },
  observation: {
    defaultThreshold: 10,
    perAgentOverrides: {},
  },
  domainMatching: {
    similarityThreshold: 0.6,
    maxResults: 5,
  },
  rateLimits: {
    modificationsPerAgentPerWeek: 1,
    agentCreationsPerWeek: 1,
  },
  anomalyThresholds: {
    approvalRateDrop: 0.70,
    qualityDeclinePoints: 0.5,
    qualityDeclineWindow: 10,
    escalationRate: 0.30,
    tokenBudgetMultiplier: 2.0,
  },
  modelRegistry: [
    'claude-sonnet-4-20250514',
    'claude-opus-4-20250514',
  ],
  paths: {
    'audit-log': 'data/agent-audit.log',
    'metrics-jsonl': 'data/metrics/agent-invocations.jsonl',
    'metrics-db': 'data/agent-metrics.db',
    'weakness-reports': 'data/weakness-reports.jsonl',
    'proposals': 'data/proposals.jsonl',
    'domain-gaps': 'data/domain-gaps.jsonl',
    'evaluations-dir': 'data/evaluations/',
    'proposed-agents-dir': 'data/proposed-agents/',
    'canary-state': 'data/canary-state.json',
    'compatibility': 'data/agent-compatibility.json',
  },
};

// ---------------------------------------------------------------------------
// Lightweight YAML parser (subset needed for config)
// ---------------------------------------------------------------------------

/**
 * Parse the agent-factory.yaml into a raw key-value structure.
 *
 * Handles:
 *   - Top-level sections (key:)
 *   - Nested key: value pairs (2-space indent)
 *   - Block-style arrays (  - item)
 *   - Inline flow objects ({})
 *   - Comments (#)
 *
 * This is intentionally minimal -- it covers exactly the config schema.
 */
function parseConfigYaml(yamlStr: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yamlStr.split('\n');

  let i = 0;
  let currentSection: string | null = null;
  let currentSectionObj: Record<string, unknown> = {};

  while (i < lines.length) {
    const line = lines[i].replace(/\r$/, '');

    // Skip blank lines and comments
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i++;
      continue;
    }

    const indent = line.length - line.trimStart().length;

    // Top-level key (no indent)
    if (indent === 0) {
      // Save previous section
      if (currentSection !== null) {
        result[currentSection] = currentSectionObj;
      }

      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) {
        i++;
        continue;
      }

      const key = line.substring(0, colonIdx).trim();
      const value = line.substring(colonIdx + 1).trim();

      // Check if this is a section (value is empty) or a top-level scalar
      if (value === '') {
        // Check if next line starts a block array
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1].replace(/\r$/, '').trimStart();
          if (nextLine.startsWith('- ')) {
            // Block array at top level
            const items: unknown[] = [];
            i++;
            while (i < lines.length) {
              const arrLine = lines[i].replace(/\r$/, '');
              if (arrLine.trim() === '' || arrLine.trim().startsWith('#')) {
                i++;
                continue;
              }
              const arrIndent = arrLine.length - arrLine.trimStart().length;
              if (arrIndent === 0) break;
              const dashMatch = arrLine.trimStart().match(/^-\s+(.*)/);
              if (dashMatch) {
                items.push(parseConfigScalar(dashMatch[1].trim()));
              } else {
                break;
              }
              i++;
            }
            // Save previous section before setting top-level array
            if (currentSection !== null) {
              result[currentSection] = currentSectionObj;
            }
            result[key] = items;
            currentSection = null;
            currentSectionObj = {};
            continue;
          }
        }
        currentSection = key;
        currentSectionObj = {};
      } else {
        // Save previous section
        if (currentSection !== null) {
          result[currentSection] = currentSectionObj;
          currentSection = null;
          currentSectionObj = {};
        }
        result[key] = parseConfigScalar(value);
      }
      i++;
    } else {
      // Indented line: belongs to current section
      const trimmed = line.trimStart();
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) {
        i++;
        continue;
      }

      const key = trimmed.substring(0, colonIdx).trim();
      const value = trimmed.substring(colonIdx + 1).trim();

      if (value === '{}') {
        currentSectionObj[key] = {};
      } else {
        currentSectionObj[key] = parseConfigScalar(value);
      }
      i++;
    }
  }

  // Save last section
  if (currentSection !== null) {
    result[currentSection] = currentSectionObj;
  }

  return result;
}

/**
 * Parse a scalar YAML value.
 */
function parseConfigScalar(raw: string): unknown {
  if (raw === '' || raw === 'null' || raw === '~') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  // Quoted string
  if ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }

  // Integer
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);

  // Float
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);

  return raw;
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

export interface ConfigValidationWarning {
  field: string;
  message: string;
}

/**
 * Validate that all path values are relative (not absolute).
 */
function validatePaths(paths: Record<string, string>): ConfigValidationWarning[] {
  const warnings: ConfigValidationWarning[] = [];
  for (const [key, value] of Object.entries(paths)) {
    if (path.isAbsolute(value)) {
      warnings.push({
        field: `paths.${key}`,
        message: `Path '${value}' is absolute; paths must be relative`,
      });
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load Agent Factory configuration from a YAML file.
 *
 * Behavior:
 *   - If `configPath` is provided, loads from that path.
 *   - If not provided, loads from `config/agent-factory.yaml` relative to
 *     the plugin root (derived from this file's location).
 *   - If the config file does not exist, returns all defaults without error.
 *   - Merges file values over defaults (partial configs are supported).
 *   - Validates that paths are relative.
 *
 * @param configPath  Optional absolute or relative path to the YAML file.
 * @returns           The merged configuration and any validation warnings.
 */
export function loadConfig(configPath?: string): AgentFactoryConfig {
  const resolvedPath = configPath
    ? path.resolve(configPath)
    : path.resolve(__dirname, '../../config/agent-factory.yaml');

  // If file does not exist, return defaults
  if (!fs.existsSync(resolvedPath)) {
    return deepClone(DEFAULT_CONFIG);
  }

  let yamlContent: string;
  try {
    yamlContent = fs.readFileSync(resolvedPath, 'utf-8');
  } catch {
    return deepClone(DEFAULT_CONFIG);
  }

  const raw = parseConfigYaml(yamlContent);

  // Merge raw values over defaults
  const config = deepClone(DEFAULT_CONFIG);

  // Registry section
  const rawRegistry = raw['registry'] as Record<string, unknown> | undefined;
  if (rawRegistry) {
    if (rawRegistry['agents-dir'] !== undefined && rawRegistry['agents-dir'] !== null) {
      config.registry.agentsDir = String(rawRegistry['agents-dir']);
    }
    if (rawRegistry['max-agents'] !== undefined && rawRegistry['max-agents'] !== null) {
      config.registry.maxAgents = Number(rawRegistry['max-agents']);
    }
  }

  // Observation section
  const rawObs = raw['observation'] as Record<string, unknown> | undefined;
  if (rawObs) {
    if (rawObs['default-threshold'] !== undefined && rawObs['default-threshold'] !== null) {
      config.observation.defaultThreshold = Number(rawObs['default-threshold']);
    }
    if (rawObs['per-agent-overrides'] !== undefined && rawObs['per-agent-overrides'] !== null) {
      if (typeof rawObs['per-agent-overrides'] === 'object' && rawObs['per-agent-overrides'] !== null) {
        const overrides = rawObs['per-agent-overrides'] as Record<string, unknown>;
        config.observation.perAgentOverrides = {};
        for (const [k, v] of Object.entries(overrides)) {
          config.observation.perAgentOverrides[k] = Number(v);
        }
      }
    }
  }

  // Domain matching section
  const rawDM = raw['domain-matching'] as Record<string, unknown> | undefined;
  if (rawDM) {
    if (rawDM['similarity-threshold'] !== undefined && rawDM['similarity-threshold'] !== null) {
      config.domainMatching.similarityThreshold = Number(rawDM['similarity-threshold']);
    }
    if (rawDM['max-results'] !== undefined && rawDM['max-results'] !== null) {
      config.domainMatching.maxResults = Number(rawDM['max-results']);
    }
  }

  // Rate limits section
  const rawRL = raw['rate-limits'] as Record<string, unknown> | undefined;
  if (rawRL) {
    if (rawRL['modifications-per-agent-per-week'] !== undefined && rawRL['modifications-per-agent-per-week'] !== null) {
      config.rateLimits.modificationsPerAgentPerWeek = Number(rawRL['modifications-per-agent-per-week']);
    }
    if (rawRL['agent-creations-per-week'] !== undefined && rawRL['agent-creations-per-week'] !== null) {
      config.rateLimits.agentCreationsPerWeek = Number(rawRL['agent-creations-per-week']);
    }
  }

  // Anomaly thresholds section
  const rawAT = raw['anomaly-thresholds'] as Record<string, unknown> | undefined;
  if (rawAT) {
    if (rawAT['approval-rate-drop'] !== undefined && rawAT['approval-rate-drop'] !== null) {
      config.anomalyThresholds.approvalRateDrop = Number(rawAT['approval-rate-drop']);
    }
    if (rawAT['quality-decline-points'] !== undefined && rawAT['quality-decline-points'] !== null) {
      config.anomalyThresholds.qualityDeclinePoints = Number(rawAT['quality-decline-points']);
    }
    if (rawAT['quality-decline-window'] !== undefined && rawAT['quality-decline-window'] !== null) {
      config.anomalyThresholds.qualityDeclineWindow = Number(rawAT['quality-decline-window']);
    }
    if (rawAT['escalation-rate'] !== undefined && rawAT['escalation-rate'] !== null) {
      config.anomalyThresholds.escalationRate = Number(rawAT['escalation-rate']);
    }
    if (rawAT['token-budget-multiplier'] !== undefined && rawAT['token-budget-multiplier'] !== null) {
      config.anomalyThresholds.tokenBudgetMultiplier = Number(rawAT['token-budget-multiplier']);
    }
  }

  // Model registry (top-level array)
  const rawModels = raw['model-registry'];
  if (Array.isArray(rawModels) && rawModels.length > 0) {
    config.modelRegistry = rawModels.map(String);
  }

  // Paths section
  const rawPaths = raw['paths'] as Record<string, unknown> | undefined;
  if (rawPaths) {
    for (const [key, value] of Object.entries(rawPaths)) {
      if (value !== undefined && value !== null) {
        config.paths[key] = String(value);
      }
    }
  }

  return config;
}

/**
 * Load config with validation warnings.
 *
 * Same as `loadConfig` but also returns path validation warnings.
 */
export function loadConfigWithValidation(configPath?: string): {
  config: AgentFactoryConfig;
  warnings: ConfigValidationWarning[];
} {
  const config = loadConfig(configPath);
  const warnings = validatePaths(config.paths);
  return { config, warnings };
}

/**
 * Get the default configuration (useful for testing).
 */
export function getDefaultConfig(): AgentFactoryConfig {
  return deepClone(DEFAULT_CONFIG);
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}
