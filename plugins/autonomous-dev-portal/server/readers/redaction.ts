// SPEC-015-1-04 — Redaction pipeline for log lines.
//
// Pure, deterministic, side-effect-safe. Applied to every log line that
// leaves the portal process — both via direct LogReader.readRecent and
// via SSE log-line broadcasts. Mirrors the daemon's audit-log
// redaction (SPEC-014-3-03) so portal-rendered logs and daemon-stored
// logs are byte-identical for the redacted spans.
//
// Rule order is contractual: later rules MUST NOT match against
// `[REDACTED]` placeholders introduced by earlier rules. The placeholder
// string contains no characters that match any pattern below — verified
// by the redaction test suite.

import type { LogLine } from "./types";

interface Rule {
    name: string;
    pattern: RegExp;
    replacer: (match: string, ...groups: string[]) => string;
}

const RULES: ReadonlyArray<Rule> = [
    // 1. OpenAI / Anthropic style API keys
    {
        name: "api_key_sk",
        pattern: /\b(sk-[A-Za-z0-9]{20,})/g,
        replacer: () => "sk-[REDACTED]",
    },
    // 2. GitHub fine-grained PATs (legacy ghp_)
    {
        name: "github_ghp",
        pattern: /\b(ghp_[A-Za-z0-9]{36})/g,
        replacer: () => "ghp_[REDACTED]",
    },
    // 3. GitHub fine-grained PAT (newer github_pat_ format)
    {
        name: "github_pat",
        pattern: /\b(github_pat_[A-Za-z0-9_]{82})/g,
        replacer: () => "github_pat_[REDACTED]",
    },
    // 4. Slack tokens
    {
        name: "slack_token",
        pattern: /\b(xox[baprs]-[A-Za-z0-9-]{10,})/g,
        replacer: () => "xoxx-[REDACTED]",
    },
    // 5. URL credentials (https://user:pass@host/...)
    {
        name: "url_credentials",
        pattern: /\b([A-Za-z0-9]+):\/\/([^@\s/]+)@([^\s]+)/g,
        replacer: (_m, scheme, _userInfo, hostAndPath) =>
            `${String(scheme)}://[REDACTED]@${String(hostAndPath)}`,
    },
    // 6. JWT (3-segment)
    {
        name: "jwt",
        pattern:
            /\b(eyJ[A-Za-z0-9_-]{20,})\.([A-Za-z0-9_-]{20,})\.([A-Za-z0-9_-]{20,})/g,
        replacer: () => "eyJ.[REDACTED].[REDACTED]",
    },
    // 7. Bearer tokens in Authorization headers
    {
        name: "bearer",
        pattern: /\bAuthorization:\s*Bearer\s+([A-Za-z0-9._-]{16,})/gi,
        replacer: () => "Authorization: Bearer [REDACTED]",
    },
    // 8. macOS home directories
    {
        name: "macos_home",
        pattern: /(\/Users\/[^/\s]+)\//g,
        replacer: () => "/Users/[REDACTED]/",
    },
    // 9. Linux home directories
    {
        name: "linux_home",
        pattern: /(\/home\/[^/\s]+)\//g,
        replacer: () => "/home/[REDACTED]/",
    },
    // 10. Email addresses (preserves domain for triage)
    {
        name: "email",
        pattern: /\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
        replacer: (_m, _local, domain) => `[REDACTED]@${String(domain)}`,
    },
];

let counts: Record<string, number> = Object.fromEntries(
    RULES.map((r) => [r.name, 0]),
);

/** Reset counters (test helper). */
export function resetRedactionCounts(): void {
    counts = Object.fromEntries(RULES.map((r) => [r.name, 0]));
}

/** Snapshot of how many times each rule has fired in this process. */
export function getRedactionCounts(): Record<string, number> {
    return { ...counts };
}

/** Apply the rule pipeline to a string. Returns the input unchanged
 * when empty. */
export function redactString(input: string): string {
    if (typeof input !== "string" || input.length === 0) return input;
    let out = input;
    for (const rule of RULES) {
        // Reset lastIndex on every call — global regexes are stateful
        // and would skip matches when reused across inputs.
        rule.pattern.lastIndex = 0;
        out = out.replace(rule.pattern, (...args: unknown[]) => {
            counts[rule.name] = (counts[rule.name] ?? 0) + 1;
            const m = args[0] as string;
            // Drop the match position + full input + groups arg from
            // replace's signature so the rule replacer only sees the
            // match + capture groups it cares about.
            const groups: string[] = [];
            for (let i = 1; i < args.length - 2; i += 1) {
                const g = args[i];
                groups.push(typeof g === "string" ? g : "");
            }
            return rule.replacer(m, ...groups);
        });
    }
    return out;
}

/**
 * Recursively redact a LogLine: message, raw, and all string-valued
 * leaves of context. Returns a new object — input is not mutated.
 */
export function redactLogLine(line: LogLine): LogLine {
    const out: LogLine = {
        ts: line.ts,
        level: line.level,
        message: redactString(line.message),
        source: line.source,
    };
    if (line.request_id !== undefined) out.request_id = line.request_id;
    if (line.raw !== undefined) out.raw = redactString(line.raw);
    if (line.context !== undefined) {
        out.context = redactValue(line.context) as Record<string, unknown>;
    }
    return out;
}

function redactValue(value: unknown): unknown {
    if (typeof value === "string") return redactString(value);
    if (Array.isArray(value)) return value.map((v) => redactValue(v));
    if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = redactValue(v);
        }
        return out;
    }
    return value;
}

/** Exposed for tests. */
export const REDACTION_RULE_NAMES: ReadonlyArray<string> = RULES.map((r) => r.name);
