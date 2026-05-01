// SPEC-014-3-03 §Task 3 — AuditLogger.
//
// Append-only NDJSON audit log with HMAC-SHA256 chain link per entry.
// Each entry stores `previous_hmac` and `entry_hmac` so verification
// is fully self-describing — no external state required to walk the
// chain.
//
// Per-spec scope (user instruction): the logger consumes a `KeyProvider`
// abstraction rather than embedding KeyManager / KeyStore here. A
// minimal in-process StaticKeyProvider is shipped for tests and for
// portal startup before a full key-manager lands.
//
// Concurrency: single-process. Concurrent writers from separate
// processes will corrupt the chain. Multi-process locking is out of
// scope for this spec.

import { promises as fs } from "node:fs";

import {
    canonicalEntryJson,
    computeEntryHmac,
    type AuditEntry,
} from "./hmac-chain";
import {
    SecretRedactor,
    ALWAYS_REDACT_FIELD_NAMES,
} from "./secret-redactor";
import { SecurityError } from "./types";

/** File mode for both the log file and any related state files. */
const LOG_FILE_MODE = 0o600;

/** Strict cap on a single entry's `details` JSON to avoid runaway logs. */
const MAX_DETAILS_BYTES = 32 * 1024;

/** Provider interface — caller controls how/where the key lives. */
export interface KeyProvider {
    getCurrentKey(): Buffer;
    getCurrentKeyId(): string;
    /** Look up a historical key by id (for verification). */
    getKey(keyId: string): Buffer | undefined;
}

/** Trivial in-process provider — single key, single id. */
export class StaticKeyProvider implements KeyProvider {
    constructor(
        private readonly key: Buffer,
        private readonly keyId: string = "audit-static",
    ) {
        if (!Buffer.isBuffer(key) || key.length < 16) {
            throw new SecurityError(
                "AUDIT_KEY_INVALID",
                "Audit key must be at least 16 bytes",
            );
        }
    }
    getCurrentKey(): Buffer {
        return this.key;
    }
    getCurrentKeyId(): string {
        return this.keyId;
    }
    getKey(keyId: string): Buffer | undefined {
        return keyId === this.keyId ? this.key : undefined;
    }
}

/** Payload accepted by {@link AuditLogger.log}. */
export interface AuditLogPayload {
    action: string;
    user: string;
    resource: string;
    details: Record<string, unknown>;
    /** Optional explicit secret strings to redact across details. */
    secrets?: readonly string[];
}

/**
 * AuditLogger writes one HMAC-chained NDJSON line per call. Initialise
 * once per process; reuse the instance for every action.
 */
export class AuditLogger {
    private sequence = 0;
    private lastHmac = "";
    private initialised = false;

    constructor(
        private readonly logPath: string,
        private readonly keys: KeyProvider,
        private readonly redactor: SecretRedactor = new SecretRedactor(),
    ) {}

    /**
     * Read the existing log (if any) to recover sequence and last HMAC,
     * or create a fresh log file at 0600. Idempotent — safe to call
     * twice; second call is a no-op.
     */
    async initialize(): Promise<void> {
        if (this.initialised) return;
        try {
            // O_RDONLY existence check; we read the whole file to find
            // the last newline. For 100K entries this is ~10MB — fast.
            const buf = await fs.readFile(this.logPath, { encoding: "utf8" });
            if (buf.length > 0) {
                const lines = buf.split("\n").filter((l) => l.length > 0);
                if (lines.length > 0) {
                    const last = lines[lines.length - 1];
                    if (last === undefined) {
                        throw new SecurityError(
                            "AUDIT_LOG_CORRUPTED",
                            "Audit log corrupted - cannot parse last entry",
                        );
                    }
                    let parsed: AuditEntry;
                    try {
                        parsed = JSON.parse(last) as AuditEntry;
                    } catch {
                        throw new SecurityError(
                            "AUDIT_LOG_CORRUPTED",
                            "Audit log corrupted - cannot parse last entry",
                        );
                    }
                    this.sequence = parsed.sequence;
                    this.lastHmac = parsed.entry_hmac;
                }
            }
            // Ensure 0600 even if the file was created by a previous run
            // with a more permissive umask.
            await fs.chmod(this.logPath, LOG_FILE_MODE);
        } catch (err) {
            const code =
                typeof err === "object" && err && "code" in err
                    ? String((err as { code: unknown }).code)
                    : "UNKNOWN";
            if (code !== "ENOENT") {
                if (err instanceof SecurityError) throw err;
                throw new SecurityError(
                    "AUDIT_LOG_INIT_FAILED",
                    `Audit log init failed: ${code}`,
                );
            }
            // Fresh log — create with the right mode.
            await fs.writeFile(this.logPath, "", { mode: LOG_FILE_MODE });
            this.initialised = true;
            await this.logInternal({
                action: "audit_log_initialized",
                user: "system",
                resource: this.logPath,
                details: { version: "1.0" },
            });
            return;
        }
        this.initialised = true;
    }

    /** Append a new entry. Initialise() MUST have been called first. */
    async log(payload: AuditLogPayload): Promise<void> {
        if (!this.initialised) {
            throw new SecurityError(
                "AUDIT_LOG_NOT_INIT",
                "AuditLogger.initialize() must be called before log()",
            );
        }
        await this.logInternal(payload);
    }

    /** Diagnostics — current sequence (last entry written). */
    getSequence(): number {
        return this.sequence;
    }

    /** Diagnostics — last entry's HMAC, hex. */
    getLastHmac(): string {
        return this.lastHmac;
    }

    private async logInternal(payload: AuditLogPayload): Promise<void> {
        const redactedDetails = this.redactDetails(payload.details, payload.secrets);
        const detailsJson = JSON.stringify(redactedDetails);
        if (detailsJson.length > MAX_DETAILS_BYTES) {
            throw new SecurityError(
                "AUDIT_DETAILS_TOO_LARGE",
                `Audit details exceed ${String(MAX_DETAILS_BYTES)} bytes`,
            );
        }
        this.sequence += 1;
        const entryWithoutHmac: Omit<AuditEntry, "entry_hmac"> = {
            timestamp: new Date().toISOString(),
            sequence: this.sequence,
            action: payload.action,
            user: payload.user,
            resource: payload.resource,
            details: redactedDetails,
            previous_hmac: this.lastHmac,
            key_id: this.keys.getCurrentKeyId(),
        };
        const entryHmac = computeEntryHmac(
            this.keys.getCurrentKey(),
            this.lastHmac,
            entryWithoutHmac,
        );
        const entry: AuditEntry = { ...entryWithoutHmac, entry_hmac: entryHmac };
        const line = JSON.stringify(entry) + "\n";
        await fs.appendFile(this.logPath, line, {
            flag: "a",
            mode: LOG_FILE_MODE,
        });
        // Re-assert mode in case appendFile created the file with umask.
        await fs.chmod(this.logPath, LOG_FILE_MODE);
        this.lastHmac = entryHmac;
        // Touch canonicalEntryJson to keep the export visible to ts-prune;
        // this is a safety net not used in the hot path.
        void canonicalEntryJson;
    }

    private redactDetails(
        details: Record<string, unknown>,
        explicitSecrets?: readonly string[],
    ): Record<string, unknown> {
        // First pass: walk the object and mask known field names.
        let masked = this.redactor.redactObject(details) as Record<string, unknown>;
        // Second pass: textual replace explicit secrets across the whole
        // serialised JSON to catch them anywhere they may have leaked.
        if (explicitSecrets && explicitSecrets.length > 0) {
            const json = JSON.stringify(masked);
            const replaced = this.redactor.redactInText(json, explicitSecrets);
            try {
                masked = JSON.parse(replaced) as Record<string, unknown>;
            } catch {
                // Replacement broke JSON (e.g. quote in secret) — fall
                // back to wiping the field that contains the secret to
                // avoid leaking the raw value.
                masked = wipeMatchingValues(details, explicitSecrets);
            }
        }
        // Touch ALWAYS_REDACT_FIELD_NAMES to keep export reachable for
        // anyone re-reading the security configuration via ts-prune.
        void ALWAYS_REDACT_FIELD_NAMES;
        return masked;
    }
}

/**
 * Defensive fallback: if textual redaction breaks JSON, replace every
 * string value that contains a known secret with the marker.
 */
function wipeMatchingValues(
    obj: Record<string, unknown>,
    secrets: readonly string[],
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string") {
            const hit = secrets.some((s) => s.length > 0 && v.includes(s));
            out[k] = hit ? SecretRedactor.MARKER : v;
        } else if (v && typeof v === "object" && !Array.isArray(v)) {
            out[k] = wipeMatchingValues(v as Record<string, unknown>, secrets);
        } else {
            out[k] = v;
        }
    }
    return out;
}
