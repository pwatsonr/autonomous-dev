// SPEC-014-1-02 §Files — Logging wrapper around enforceBinding.
//
// Pure routing of the call so we can emit a structured `binding_enforced`
// or `binding_refused` log line without polluting the gate's pure
// validation contract. server.ts uses this wrapper so operators see one
// canonical line per startup attempt.

import type { PortalConfig } from "../../lib/config";
import { defaultAuthLogger } from "../base-auth";
import type { AuthLogger } from "../base-auth";
import { enforceBinding } from "../network-binding";
import { SecurityError } from "../types";

export function enforceBindingWithLogging(
    config: PortalConfig,
    logger: AuthLogger = defaultAuthLogger(),
): void {
    try {
        enforceBinding(config);
        logger.info("binding_enforced", {
            auth_mode: config.auth_mode,
            bind_host: config.bind_host,
        });
    } catch (err) {
        if (err instanceof SecurityError) {
            logger.error("binding_refused", {
                auth_mode: config.auth_mode,
                bind_host: config.bind_host,
                code: err.code,
                message: err.message,
            });
        }
        throw err;
    }
}
