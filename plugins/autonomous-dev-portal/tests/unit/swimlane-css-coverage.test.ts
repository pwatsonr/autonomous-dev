// Kit-parity CSS coverage — every class the swimlanes fragment emits must
// have a rule in the SERVED static CSS. The lanes shipped unstyled because
// the base pipeline block was assumed to live in app.css but was never
// vendored (PORTAL-REDESIGN-HANDOFF cause-class; PORTAL-V3-DESIGN-GAP
// carried the design targets). This test makes markup/CSS drift loud.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

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

function classesIn(file: string): string[] {
    const src = readFileSync(join(ROOT, file), "utf-8");
    const classes = new Set<string>();
    for (const m of src.matchAll(/class=\{?[`"]([^`"}]+)[`"]/g)) {
        for (const token of m[1]!.split(/[\s${}]+/)) {
            if (/^[a-z][a-z0-9-]+$/.test(token)) classes.add(token);
        }
    }
    return [...classes].sort();
}

describe("swimlane CSS coverage (kit parity)", () => {
    test("every fragment class has a rule in served static CSS", () => {
        const css = allServedCss();
        const missing = classesIn(
            "server/templates/fragments/dashboard-swimlanes.tsx",
        ).filter((c) => !css.includes(`.${c}`));
        expect(missing).toEqual([]);
    });

    test("the kit base selectors exist with layout rules", () => {
        const css = readFileSync(
            join(ROOT, "static", "v3", "dashboard.css"), "utf-8",
        );
        expect(css).toMatch(/\.pipeline-header\s*\{[^}]*grid-template-columns:\s*repeat\(8/);
        expect(css).toMatch(/\.pipeline-body\s*\{[^}]*min-height:\s*480px/);
        expect(css).toMatch(/\.pcard\s*\{[^}]*border-left:\s*3px solid/);
        expect(css).toMatch(/\.ph-count\s*\{[^}]*border-radius:\s*999px/);
    });
});
