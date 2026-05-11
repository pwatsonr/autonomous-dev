// PLAN-037-2 — adapter shims that translate the portal's heavyweight
// AuditLogger / structured logger into the lightweight surfaces the
// action-route modules consume (see routes/_action-deps.ts).
//
// The action-route modules deliberately depend on a minimal
// `{ append(entry) }` audit interface so they can be unit-tested without
// HMAC-key boot. Production wires the real AuditLogger via the adapter
// below.

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

import {
    AuditLogger,
    StaticKeyProvider,
} from "../security/audit-logger";
import type { ActionLogger, AuditAppender } from "../routes/_action-deps";

import { portalAuditPath } from "./state-paths";

/** Structured JSON log writer. One line per call, stdout. */
export function structuredLogger(): ActionLogger {
    function emit(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
        // eslint-disable-next-line no-console
        console.log(
            JSON.stringify({
                ts: new Date().toISOString(),
                level,
                event,
                ...fields,
            }),
        );
    }
    return {
        info: (event, fields) => emit("info", event, fields ?? {}),
        warn: (event, fields) => emit("warn", event, fields ?? {}),
        error: (event, fields) => emit("error", event, fields ?? {}),
    };
}

/**
 * Adapt an AuditLogger into the `AuditAppender` surface. The route
 * supplies `{event, actor?, ...rest}` — we project that onto the
 * AuditLogger's richer `{action, user, resource, details}` schema.
 *
 * The route handlers fire-and-forget via `await deps.audit.append(...)`
 * before flushing the HTTP response. To prevent a transient audit-log
 * failure from breaking the action surface, we swallow logger errors
 * here and re-route them to the structured-stderr sink.
 */
export function auditAdapter(
    logger: AuditLogger,
    structured: ActionLogger,
): AuditAppender {
    return {
        async append(entry) {
            const { event, actor, ...rest } = entry;
            try {
                await logger.log({
                    action: event,
                    user: typeof actor === "string" ? actor : "unknown",
                    resource: typeof rest["resource"] === "string"
                        ? (rest["resource"] as string)
                        : "portal-action",
                    details: rest as Record<string, unknown>,
                });
            } catch (err) {
                structured.error("portal_audit_append_failed", {
                    event,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        },
    };
}

/**
 * Create and initialize the portal's AuditLogger. We use a process-local
 * StaticKeyProvider with a per-boot random key. The chain is rebuilt every
 * portal restart; cross-boot continuity requires a persistent KeyProvider
 * (out of scope for PLAN-037-2 — escalated in the PR body).
 */
export async function buildPortalAuditLogger(): Promise<AuditLogger> {
    const key = await loadOrMintPortalAuditKey();
    const provider = new StaticKeyProvider(key, "portal-audit");
    const logger = new AuditLogger(portalAuditPath(), provider);
    await logger.initialize();
    return logger;
}

const KEY_BYTES = 32;

/**
 * Load the persisted audit-chain key, or mint one on first boot. The key
 * file lives next to the audit log itself (mode 0600). This preserves the
 * HMAC chain across portal restarts.
 */
async function loadOrMintPortalAuditKey(): Promise<Buffer> {
    const keyPath = `${portalAuditPath()}.key`;
    try {
        const buf = await fs.readFile(keyPath);
        if (buf.length >= 16) return buf;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const fresh = randomBytes(KEY_BYTES);
    await fs.mkdir(dirname(keyPath), { recursive: true, mode: 0o700 }).catch(() => undefined);
    await fs.writeFile(keyPath, fresh, { mode: 0o600 });
    return fresh;
}
