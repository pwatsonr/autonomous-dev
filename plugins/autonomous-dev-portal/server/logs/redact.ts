// SPEC-015-3-03 — Secret redaction at the egress seam.
//
// Patterns are applied in order to message + recursively to every
// string value inside context. Returns a new LogEntry — original is
// never mutated so the same entry can fan out to multiple SSE clients.

import type { LogEntry } from "./types";

export interface RedactionPattern {
    name: string;
    regex: RegExp;
    replace: string;
}

export const REDACTION_PATTERNS: ReadonlyArray<RedactionPattern> = [
    {
        name: "anthropic_api_key",
        regex: /sk-ant-[A-Za-z0-9_-]{40,}/g,
        replace: "sk-ant-***REDACTED***",
    },
    {
        name: "github_token",
        regex: /gh[pousr]_[A-Za-z0-9]{36,}/g,
        replace: "***GITHUB-TOKEN-REDACTED***",
    },
    {
        name: "aws_access_key",
        regex: /AKIA[0-9A-Z]{16}/g,
        replace: "***AWS-KEY-REDACTED***",
    },
    {
        name: "jwt_bearer",
        regex:
            /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
        replace: "***JWT-REDACTED***",
    },
    {
        name: "generic_secret_field",
        regex: /("(api_key|secret|password|token)"\s*:\s*)"[^"]+"/gi,
        replace: '$1"***REDACTED***"',
    },
    {
        name: "email",
        regex: /[\w.-]+@[\w.-]+\.[A-Za-z]{2,}/g,
        replace: "***EMAIL-REDACTED***",
    },
];

function redactString(value: string): string {
    let out = value;
    for (const p of REDACTION_PATTERNS) {
        // Each regex carries the `g` flag so a fresh exec is safe.
        out = out.replace(p.regex, p.replace);
    }
    return out;
}

function redactValue(v: unknown): unknown {
    if (typeof v === "string") return redactString(v);
    if (Array.isArray(v)) return v.map((item) => redactValue(item));
    if (v && typeof v === "object") {
        const src = v as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [k, value] of Object.entries(src)) {
            out[k] = redactValue(value);
        }
        return out;
    }
    return v;
}

export function redactSecrets(entry: LogEntry): LogEntry {
    const out: LogEntry = {
        timestamp: entry.timestamp,
        level: entry.level,
        pid: entry.pid,
        message: redactString(entry.message),
    };
    if (entry.iteration !== undefined) out.iteration = entry.iteration;
    if (entry.request_id !== undefined) out.request_id = entry.request_id;
    if (entry.context !== undefined) {
        out.context = redactValue(entry.context) as Record<string, unknown>;
    }
    return out;
}
