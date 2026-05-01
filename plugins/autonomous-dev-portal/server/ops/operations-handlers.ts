// SPEC-015-4-01 §Operations Handler — service composing the typed-confirmation
// service (PLAN-014-2 §confirmation-tokens), the IntakeRouterClient
// (PLAN-015-2 §intake-router-client), the HMAC-chained AuditLogger
// (PLAN-014-3 §audit-logger), and the SSE event bus (PLAN-015-1 §SSEEventBus).
//
// Each mutation method follows the same recipe:
//   1. Validate confirmation phrase + token (via TypedConfirmationService).
//      The service is consume-on-success: invalid validations do NOT
//      consume the token, so transient retries are still allowed inside
//      the 60s TTL window.
//   2. Submit the command via IntakeRouterClient. On non-2xx, append an
//      audit entry with `outcome: 'failed'` and surface INTAKE_FAILED.
//   3. On 2xx, append an audit entry with `outcome: 'success'`, broadcast
//      a state-change event over SSE, and return the request id.
//
// All operator-facing strings here MUST be safe — they get rendered into
// the operator's browser via the typed-CONFIRM modal.

import { randomUUID } from "node:crypto";

import type { AuditLogger } from "../security/audit-logger";
import type {
    TypedConfirmationService,
    ValidationResult,
} from "../security/confirmation-tokens";
import type { SSEEventBus } from "../sse/SSEEventBus";
import type { IntakeRouterClient } from "../lib/intake-router-client";

/** Stable, operator-safe error codes. */
export type OperationErrorCode =
    | "INVALID_TOKEN"
    | "EXPIRED_TOKEN"
    | "ACTION_MISMATCH"
    | "PHRASE_MISMATCH"
    | "SESSION_MISMATCH"
    | "MISSING_REASON"
    | "REASON_TOO_LONG"
    | "INTAKE_FAILED"
    | "DAEMON_UNHEALTHY";

/** Result envelope for every mutation method. */
export interface OperationResult {
    success: boolean;
    error?: string;
    errorCode?: OperationErrorCode;
    intakeRequestId?: string;
}

/** Action allowlist — enumerated in code, not configuration. */
export const OPS_ACTIONS = [
    "kill-switch.engage",
    "kill-switch.reset",
    "circuit-breaker.reset",
] as const;
export type OpsAction = (typeof OPS_ACTIONS)[number];

export function isOpsAction(value: string): value is OpsAction {
    return (OPS_ACTIONS as readonly string[]).includes(value);
}

/** Maximum length of the operator-supplied reason string. */
const MAX_REASON_LENGTH = 500;

interface ConfirmationInput {
    /** Server-issued token (from TypedConfirmationService). */
    token: string;
    /** Server-issued phrase the user typed back ("CONFIRM"). */
    typedPhrase: string;
    /** Caller session — must match the issuing session. */
    sessionId: string;
}

/**
 * OperationsHandler is the SOLE entry point for portal-side daemon
 * operations. Routes call into this; this calls the intake router.
 */
export class OperationsHandler {
    constructor(
        private readonly intakeClient: IntakeRouterClient,
        private readonly confirmService: TypedConfirmationService,
        private readonly auditLogger: AuditLogger,
        private readonly eventBus: SSEEventBus,
    ) {}

    /**
     * Engage the kill-switch. `reason` is mandatory and bounded; it lands
     * in the audit entry verbatim.
     */
    async engageKillSwitch(
        reason: string,
        operatorId: string,
        confirmation: ConfirmationInput,
    ): Promise<OperationResult> {
        const reasonError = this.validateReason(reason);
        if (reasonError !== null) return reasonError;

        const v = this.confirmService.validateConfirmation(
            confirmation.token,
            confirmation.sessionId,
            confirmation.typedPhrase,
        );
        const validationError = this.mapValidation(v, "kill-switch.engage");
        if (validationError !== null) return validationError;

        return await this.dispatch({
            action: "kill-switch.engage",
            operatorId,
            reason,
            sseType: "state-change",
            sseRequestId: `kill-switch-engaged-${randomUUID()}`,
            sseNewPhase: "kill-switch-engaged",
        });
    }

    async resetKillSwitch(
        operatorId: string,
        confirmation: ConfirmationInput,
    ): Promise<OperationResult> {
        const v = this.confirmService.validateConfirmation(
            confirmation.token,
            confirmation.sessionId,
            confirmation.typedPhrase,
        );
        const validationError = this.mapValidation(v, "kill-switch.reset");
        if (validationError !== null) return validationError;

        return await this.dispatch({
            action: "kill-switch.reset",
            operatorId,
            reason: null,
            sseType: "state-change",
            sseRequestId: `kill-switch-reset-${randomUUID()}`,
            sseNewPhase: "kill-switch-reset",
        });
    }

    async resetCircuitBreaker(
        operatorId: string,
        confirmation: ConfirmationInput,
    ): Promise<OperationResult> {
        const v = this.confirmService.validateConfirmation(
            confirmation.token,
            confirmation.sessionId,
            confirmation.typedPhrase,
        );
        const validationError = this.mapValidation(
            v,
            "circuit-breaker.reset",
        );
        if (validationError !== null) return validationError;

        return await this.dispatch({
            action: "circuit-breaker.reset",
            operatorId,
            reason: null,
            sseType: "state-change",
            sseRequestId: `circuit-breaker-reset-${randomUUID()}`,
            sseNewPhase: "circuit-breaker-reset",
        });
    }

    private validateReason(reason: string): OperationResult | null {
        if (typeof reason !== "string" || reason.trim().length === 0) {
            return {
                success: false,
                error: "Reason is required for kill-switch engagement.",
                errorCode: "MISSING_REASON",
            };
        }
        if (reason.length > MAX_REASON_LENGTH) {
            return {
                success: false,
                error: `Reason must be ≤ ${String(MAX_REASON_LENGTH)} characters.`,
                errorCode: "REASON_TOO_LONG",
            };
        }
        return null;
    }

    /**
     * Map the typed-confirmation service's validation result onto an
     * operator-facing OperationResult. The service's error vocabulary
     * collapses onto our stable OperationErrorCode set.
     */
    private mapValidation(
        v: ValidationResult,
        expectedAction: string,
    ): OperationResult | null {
        if (v.valid) {
            // Token issued for a different action — refuse and surface
            // ACTION_MISMATCH so the operator gets a fresh modal flow.
            if (v.action !== expectedAction) {
                return {
                    success: false,
                    error: `Confirmation token was issued for ${String(v.action)}, not ${expectedAction}.`,
                    errorCode: "ACTION_MISMATCH",
                };
            }
            return null;
        }
        switch (v.error) {
            case "invalid-or-expired-token":
                return {
                    success: false,
                    error: "Confirmation token is invalid or expired.",
                    errorCode: "INVALID_TOKEN",
                };
            case "token-expired":
                return {
                    success: false,
                    error: "Confirmation token has expired. Please retry.",
                    errorCode: "EXPIRED_TOKEN",
                };
            case "session-mismatch":
                return {
                    success: false,
                    error: "Confirmation token belongs to a different session.",
                    errorCode: "SESSION_MISMATCH",
                };
            case "phrase-mismatch":
            case "input-too-long":
            default:
                return {
                    success: false,
                    error: "Typed confirmation phrase did not match.",
                    errorCode: "PHRASE_MISMATCH",
                };
        }
    }

    /** Common tail: submit, audit, broadcast. */
    private async dispatch(opts: {
        action: OpsAction;
        operatorId: string;
        reason: string | null;
        sseType: "state-change";
        sseRequestId: string;
        sseNewPhase: string;
    }): Promise<OperationResult> {
        const command = this.commandFor(opts.action);
        const requestId = randomUUID();
        const intake = await this.intakeClient.submitCommand({
            command,
            requestId,
            source: "portal",
            sourceUserId: opts.operatorId,
            comment: opts.reason ?? undefined,
        });

        if (!intake.success) {
            await this.audit({
                action: opts.action,
                operatorId: opts.operatorId,
                outcome: "failed",
                reason: opts.reason,
                error: intake.error ?? "intake submission failed",
            });
            return {
                success: false,
                error: intake.error ?? "Daemon command failed.",
                errorCode: "INTAKE_FAILED",
            };
        }

        await this.audit({
            action: opts.action,
            operatorId: opts.operatorId,
            outcome: "success",
            reason: opts.reason,
            intakeCommandId: intake.commandId,
        });

        await this.eventBus.broadcast({
            type: opts.sseType,
            payload: {
                request_id: opts.sseRequestId,
                old_phase: null,
                new_phase: opts.sseNewPhase,
                repository: "portal",
            },
        });

        return { success: true, intakeRequestId: intake.commandId };
    }

    private commandFor(
        action: OpsAction,
    ): "kill-switch" | "circuit-breaker-reset" {
        switch (action) {
            case "kill-switch.engage":
            case "kill-switch.reset":
                return "kill-switch";
            case "circuit-breaker.reset":
                return "circuit-breaker-reset";
        }
    }

    private async audit(opts: {
        action: OpsAction;
        operatorId: string;
        outcome: "success" | "failed";
        reason: string | null;
        intakeCommandId?: string;
        error?: string;
    }): Promise<void> {
        await this.auditLogger.log({
            action: opts.action,
            user: opts.operatorId,
            resource: "daemon",
            details: {
                outcome: opts.outcome,
                reason: opts.reason,
                intake_command_id: opts.intakeCommandId ?? null,
                error: opts.error ?? null,
            },
        });
    }
}
