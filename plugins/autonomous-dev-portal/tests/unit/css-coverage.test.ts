// #417 — portal-wide CSS coverage. Every class a template emits must have
// a rule in the served static CSS, or be explicitly allowlisted as known
// tier-2 debt. This generalizes the swimlane coverage test: 106 classes
// shipped with no styling at all (audit table, modals, empty states, the
// settings Save button…), which reads as "broken tool" to operators.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

// Tier-2 debt: request-detail subcomponents + legacy fragments awaiting
// their kit-parity pass (burned down page-by-page during the visual
// crawl; remove entries as their CSS lands). Adding NEW unstyled classes
// fails this test.
const TIER2_ALLOWLIST = new Set([
    // request-detail subcomponents
    "artifact-diff", "artifact-placeholder", "phase-artifact-modal",
    "gate-action-panel", "gate-form", "gate-button", "comment-input",
    "comment-label", "char-count", "resolution-comment", "resolution-status",
    "resolved", "request-timeline", "timeline-entry", "entry-body",
    "status-icon", "reviewer-chain-section", "rev-dims", "rev-dim",
    "rev-dim-link", "rev-dim-name", "run-history", "rd-verification-override", "applied", "decision",
    "clarifying-questions", "question-options", "question-text",
    "error-details-content", "request-header-summary",
    // legacy pre-v3 fragments
    "approval-queue", "gate-strip", "gate-id", "gate-repo", "gate-age",
    "gate-left", "gate-mid", "deploy-pipeline-section", "pipeline-section",
    "standards-drift", "heartbeat", "heartbeat-svg", "breaker-grid",
    "requests", "audit-row", "result",
    "integrity", "error-icon-svg", "error-nav-suggestions",
    "approvals-table-rows",
]);

function allServedCss(): string {
    let out = "";
    const walk = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith(".css")) out += readFileSync(p, "utf-8");
        }
    };
    walk(join(ROOT, "static"));
    return out;
}

/** Strip ${...} expressions with BALANCED braces (nested templates). */
function stripExpressions(s: string): string {
    let out = "";
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
        if (depth === 0 && s[i] === "$" && s[i + 1] === "{") {
            depth = 1; i++; out += " "; continue;
        }
        if (depth > 0) {
            if (s[i] === "{") depth++;
            else if (s[i] === "}") depth--;
            continue;
        }
        out += s[i];
    }
    return out;
}

function templateFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith(".tsx")) out.push(p);
        }
    };
    walk(join(ROOT, "server", "templates"));
    walk(join(ROOT, "server", "components"));
    return out;
}

describe("portal-wide CSS coverage (#417)", () => {
    test("every static template class has a served CSS rule (or is allowlisted tier-2 debt)", () => {
        const css = allServedCss();
        const missing = new Map<string, string[]>();
        for (const f of templateFiles()) {
            const src = readFileSync(f, "utf-8");
            for (const m of src.matchAll(/class=\{?[`"]([^`"]*)[`"]\}?/g)) {
                for (const t of stripExpressions(m[1]!).split(/\s+/)) {
                    if (!/^[a-z][a-z0-9-]{2,}$/.test(t)) continue;
                    // tokens ending in "-" are dynamic prefixes (status-${x})
                    if (t.endsWith("-")) continue;
                    if (TIER2_ALLOWLIST.has(t)) continue;
                    if (!css.includes(`.${t}`)) {
                        const file = f.split("/").pop()!;
                        if (!missing.get(t)?.includes(file)) {
                            missing.set(t, [...(missing.get(t) ?? []), file]);
                        }
                    }
                }
            }
        }
        const report = [...missing.entries()]
            .map(([c, fs]) => `.${c} (${fs.join(", ")})`)
            .sort();
        expect(report).toEqual([]);
    });

    test("the allowlist only contains classes that are still missing (no stale entries)", () => {
        const css = allServedCss();
        const stale = [...TIER2_ALLOWLIST].filter((c) => css.includes(`.${c}`));
        expect(stale).toEqual([]);
    });

    test("kit button variants are used (no orphan btn-* names)", () => {
        const offenders: string[] = [];
        for (const f of templateFiles()) {
            const src = readFileSync(f, "utf-8");
            if (/class="[^"]*btn-(primary|secondary|danger|destructive)/.test(src)) {
                offenders.push(f.split("/").pop()!);
            }
        }
        expect(offenders).toEqual([]);
    });
});
