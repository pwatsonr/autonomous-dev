/**
 * Audit config parsing and validation (SPEC-009-5-7, Task 19).
 *
 * Loads the `audit:` YAML section and validates all fields.
 * Invalid values fall back to documented defaults.
 */

// ---------------------------------------------------------------------------
// AuditConfig interface
// ---------------------------------------------------------------------------

export interface AuditConfig {
  log_path: string;
  integrity: {
    hash_chain_enabled: boolean;
    verification_schedule: string;
  };
  retention: {
    active_days: number;
    archive_path: string;
  };
  decision_log: {
    include_alternatives: boolean;
    include_confidence: boolean;
  };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_AUDIT_CONFIG: AuditConfig = {
  log_path: '.autonomous-dev/events.jsonl',
  integrity: {
    hash_chain_enabled: false,
    verification_schedule: '0 2 * * *',
  },
  retention: {
    active_days: 90,
    archive_path: '.autonomous-dev/archive/',
  },
  decision_log: {
    include_alternatives: true,
    include_confidence: true,
  },
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Parse and validate an audit config section (typically from YAML).
 *
 * Rules:
 *   - `active_days` must be a positive number (default 90).
 *   - `hash_chain_enabled` must be a boolean (default false).
 *   - All other fields fall back to defaults when missing or invalid.
 */
export function loadAuditConfig(
  raw: Record<string, unknown> | undefined | null,
): AuditConfig {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_AUDIT_CONFIG };
  }

  const config: AuditConfig = {
    log_path: DEFAULT_AUDIT_CONFIG.log_path,
    integrity: { ...DEFAULT_AUDIT_CONFIG.integrity },
    retention: { ...DEFAULT_AUDIT_CONFIG.retention },
    decision_log: { ...DEFAULT_AUDIT_CONFIG.decision_log },
  };

  // log_path
  if (typeof raw.log_path === 'string' && raw.log_path.length > 0) {
    config.log_path = raw.log_path;
  }

  // integrity section
  const integrity = raw.integrity as Record<string, unknown> | undefined;
  if (integrity && typeof integrity === 'object') {
    if (typeof integrity.hash_chain_enabled === 'boolean') {
      config.integrity.hash_chain_enabled = integrity.hash_chain_enabled;
    } else if (integrity.hash_chain_enabled !== undefined) {
      // Invalid type -- fall back to default (false)
      console.warn(
        `[audit-config] Invalid integrity.hash_chain_enabled: expected boolean, got ${typeof integrity.hash_chain_enabled}. Using default: false.`,
      );
    }

    if (
      typeof integrity.verification_schedule === 'string' &&
      integrity.verification_schedule.length > 0
    ) {
      config.integrity.verification_schedule = integrity.verification_schedule;
    }
  }

  // retention section
  const retention = raw.retention as Record<string, unknown> | undefined;
  if (retention && typeof retention === 'object') {
    if (typeof retention.active_days === 'number' && retention.active_days > 0) {
      config.retention.active_days = retention.active_days;
    } else if (retention.active_days !== undefined) {
      // Invalid value -- fall back to default (90)
      console.warn(
        `[audit-config] Invalid retention.active_days: must be a positive number. Got ${retention.active_days}. Using default: 90.`,
      );
    }

    if (
      typeof retention.archive_path === 'string' &&
      retention.archive_path.length > 0
    ) {
      config.retention.archive_path = retention.archive_path;
    }
  }

  // decision_log section
  const decisionLog = raw.decision_log as Record<string, unknown> | undefined;
  if (decisionLog && typeof decisionLog === 'object') {
    if (typeof decisionLog.include_alternatives === 'boolean') {
      config.decision_log.include_alternatives = decisionLog.include_alternatives;
    }
    if (typeof decisionLog.include_confidence === 'boolean') {
      config.decision_log.include_confidence = decisionLog.include_confidence;
    }
  }

  return config;
}
