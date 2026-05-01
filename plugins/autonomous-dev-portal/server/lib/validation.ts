// SPEC-013-2-03 §Task 5 — Type and range validators for PortalConfig.
//
// Pure synchronous validation; throws PortalError('INVALID_CONFIG', ...)
// on the first failure. Called by loadPortalConfig after the merge step.

import { PortalError } from "../middleware/error-handler";
import type { PortalConfig } from "./config";

const AUTH_MODES = ["localhost", "tailscale", "oauth"] as const;
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export function validateConfig(c: PortalConfig): void {
    if (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535) {
        throw new PortalError(
            "INVALID_CONFIG",
            `port must be integer in [1024, 65535], got ${String(c.port)}`,
            500,
        );
    }
    if (!(AUTH_MODES as readonly string[]).includes(c.auth_mode)) {
        throw new PortalError(
            "INVALID_CONFIG",
            "auth_mode must be one of localhost|tailscale|oauth",
            500,
        );
    }
    if (!(LOG_LEVELS as readonly string[]).includes(c.logging.level)) {
        throw new PortalError(
            "INVALID_CONFIG",
            "logging.level invalid",
            500,
        );
    }
    if (
        !Array.isArray(c.allowed_origins) ||
        c.allowed_origins.some((o) => typeof o !== "string")
    ) {
        throw new PortalError(
            "INVALID_CONFIG",
            "allowed_origins must be string[]",
            500,
        );
    }
    if (
        c.shutdown.grace_period_ms <= 0 ||
        c.shutdown.force_timeout_ms <= c.shutdown.grace_period_ms
    ) {
        throw new PortalError(
            "INVALID_CONFIG",
            "shutdown.force_timeout_ms must exceed grace_period_ms",
            500,
        );
    }
}
