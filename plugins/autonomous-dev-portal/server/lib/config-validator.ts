// SPEC-015-2-02 §Validation Chain
//
// ConfigurationValidator: rule registry + parallel evaluation. Rules return
// `{valid, error?, warnings?}`; the summary aggregates `fieldErrors` and
// `warnings` across rules. Empty `fieldErrors` ⇒ `valid: true`.
//
// Filesystem-aware rules (allowlist) are guarded behind a small `FsProbe`
// interface so unit tests can inject a stub. The default probe uses
// `node:fs/promises.stat` against `<path>` and `<path>/.git`.
//
// ReDoS protection on operator-supplied regex patterns reuses the
// PLAN-014-3 sandbox (`testCompileRegex`) — not exercised in this scope
// because we have no regex pattern fields, but the integration point is
// kept open so adding one only touches the rule registry.

import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface ValidationContext {
    /** The full proposed config so cross-field rules (monthly>=daily*28)
     *  can read peer values. */
    fullConfig: Record<string, unknown>;
    userHomeDir: string;
    /** Already-canonicalised allow-list from PortalConfig. */
    allowedRoots: string[];
    /** Operator who submitted the form (for audit; unused by validators). */
    operatorId: string;
}

export interface ValidationResult {
    valid: boolean;
    error?: string;
    warnings?: string[];
}

export interface ValidationSummary {
    valid: boolean;
    /** key = dotted field path, value = human-readable message. */
    fieldErrors: Record<string, string>;
    warnings: string[];
}

export interface FsProbe {
    /** Returns 'dir' / 'file' / 'missing' for a path. Errors collapse to
     *  'missing' so the validator can surface a unified message. */
    probe(p: string): Promise<"dir" | "file" | "missing">;
}

const defaultFsProbe: FsProbe = {
    async probe(p: string): Promise<"dir" | "file" | "missing"> {
        try {
            const s = await fs.stat(p);
            if (s.isDirectory()) return "dir";
            if (s.isFile()) return "file";
            return "missing";
        } catch {
            return "missing";
        }
    },
};

const SLACK_WEBHOOK_RE =
    /^https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+$/;
// RFC-5322-lite: pragmatic email check; mirrors the existing helper in
// the daemon's auth code without pulling it in transitively.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Pure helper kept exported so unit tests can exercise individual rules
 * without instantiating the validator class.
 */
export function getDeep(obj: unknown, dotted: string): unknown {
    const parts = dotted.split(".");
    let cursor: unknown = obj;
    for (const seg of parts) {
        if (
            cursor === null ||
            cursor === undefined ||
            typeof cursor !== "object"
        ) {
            return undefined;
        }
        cursor = (cursor as Record<string, unknown>)[seg];
    }
    return cursor;
}

const TRUST_LEVELS: ReadonlySet<string> = new Set([
    "untrusted",
    "basic",
    "trusted",
]);

interface FieldRuleContext {
    config: Record<string, unknown>;
    ctx: ValidationContext;
    probe: FsProbe;
}

interface RuleOutput {
    fieldErrors: Record<string, string>;
    warnings: string[];
}

async function ruleCostCaps(rc: FieldRuleContext): Promise<RuleOutput> {
    const errs: Record<string, string> = {};
    const warns: string[] = [];
    const daily = getDeep(rc.config, "costCaps.daily");
    const monthly = getDeep(rc.config, "costCaps.monthly");

    if (daily !== undefined) {
        const ok =
            typeof daily === "number" &&
            Number.isFinite(daily) &&
            daily > 0 &&
            daily <= 10_000;
        if (!ok) {
            errs["costCaps.daily"] =
                "Daily cost cap must be a positive number between 0 and 10000";
        }
    }
    if (monthly !== undefined) {
        const ok =
            typeof monthly === "number" &&
            Number.isFinite(monthly) &&
            monthly > 0 &&
            monthly <= 100_000;
        if (!ok) {
            errs["costCaps.monthly"] =
                "Monthly cost cap must be a positive number between 0 and 100000";
        }
    }
    // Cross-field warning (only when both passed type-validation).
    if (
        typeof daily === "number" &&
        typeof monthly === "number" &&
        Number.isFinite(daily) &&
        Number.isFinite(monthly) &&
        daily > 0 &&
        monthly > 0 &&
        monthly < daily * 28
    ) {
        warns.push(
            `Monthly cap ($${monthly}) is less than 28x the daily cap ($${daily * 28}); the cap may trigger frequently`,
        );
    }
    return { fieldErrors: errs, warnings: warns };
}

function isInAllowedRoot(p: string, roots: string[]): boolean {
    const normalised = path.resolve(p);
    return roots.some((r) => {
        const root = path.resolve(r);
        return normalised === root || normalised.startsWith(root + path.sep);
    });
}

async function ruleAllowlist(rc: FieldRuleContext): Promise<RuleOutput> {
    const errs: Record<string, string> = {};
    const list = rc.config["allowlist"];
    if (!Array.isArray(list)) return { fieldErrors: errs, warnings: [] };
    for (let i = 0; i < list.length; i++) {
        const raw = list[i];
        const fieldKey = `allowlist[${i}]`;
        if (typeof raw !== "string" || raw.trim() === "") {
            errs[fieldKey] = "Allowlist entry must be a non-empty path";
            continue;
        }
        if (!isInAllowedRoot(raw, rc.ctx.allowedRoots)) {
            errs[fieldKey] = `Path is not in an allowed root: ${raw}`;
            continue;
        }
        const probed = await rc.probe.probe(raw);
        if (probed !== "dir") {
            errs[fieldKey] = `Path does not exist or is not a directory: ${raw}`;
            continue;
        }
        const gitDir = await rc.probe.probe(path.join(raw, ".git"));
        if (gitDir === "missing") {
            errs[fieldKey] = `Path is not a git repository: ${raw}`;
        }
    }
    return { fieldErrors: errs, warnings: [] };
}

async function ruleTrustLevels(rc: FieldRuleContext): Promise<RuleOutput> {
    const errs: Record<string, string> = {};
    const tl = rc.config["trustLevels"];
    if (tl === undefined || tl === null || typeof tl !== "object") {
        return { fieldErrors: errs, warnings: [] };
    }
    for (const [repo, value] of Object.entries(
        tl as Record<string, unknown>,
    )) {
        if (typeof value !== "string" || !TRUST_LEVELS.has(value)) {
            errs[`trustLevels.${repo}`] =
                `Invalid trust level: ${String(value)} (must be untrusted | basic | trusted)`;
        }
    }
    return { fieldErrors: errs, warnings: [] };
}

async function ruleNotifications(rc: FieldRuleContext): Promise<RuleOutput> {
    const errs: Record<string, string> = {};
    const slack = getDeep(rc.config, "notifications.slack.webhook");
    if (typeof slack === "string" && slack.trim() !== "") {
        if (!SLACK_WEBHOOK_RE.test(slack)) {
            errs["notifications.slack.webhook"] =
                "Slack webhook URL is not in the expected format";
        }
    }
    const email = getDeep(rc.config, "notifications.email.to");
    if (typeof email === "string" && email.trim() !== "") {
        if (!EMAIL_RE.test(email)) {
            errs["notifications.email.to"] =
                "Notification email address is not valid";
        }
    }
    return { fieldErrors: errs, warnings: [] };
}

export class ConfigurationValidator {
    private readonly probe: FsProbe;

    constructor(opts: { fsProbe?: FsProbe } = {}) {
        this.probe = opts.fsProbe ?? defaultFsProbe;
    }

    async validateConfiguration(
        config: Record<string, unknown>,
        ctx: ValidationContext,
    ): Promise<ValidationSummary> {
        const rc: FieldRuleContext = { config, ctx, probe: this.probe };
        const results = await Promise.all([
            ruleCostCaps(rc),
            ruleAllowlist(rc),
            ruleTrustLevels(rc),
            ruleNotifications(rc),
        ]);
        const fieldErrors: Record<string, string> = {};
        const warnings: string[] = [];
        for (const r of results) {
            Object.assign(fieldErrors, r.fieldErrors);
            warnings.push(...r.warnings);
        }
        return {
            valid: Object.keys(fieldErrors).length === 0,
            fieldErrors,
            warnings,
        };
    }
}
