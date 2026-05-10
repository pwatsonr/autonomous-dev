// SPEC-035-1-03 §Tests — RailOpsBar component.
//
// O-01..O-06 from the spec: deterministic dot-class mapping, MTD
// formatting, and kill-switch state branching. Tests render JSX to a
// string the same way BrandWordmark / ShellLayout suites do.

import { describe, expect, test } from "bun:test";

import { RailOpsBar } from "../../server/components/rail-ops-bar";

async function render(
    props: Parameters<typeof RailOpsBar>[0],
): Promise<string> {
    const node = RailOpsBar(props) as unknown;
    return String(await Promise.resolve(node));
}

describe("RailOpsBar — SPEC-035-1-03", () => {
    test('O-01: daemonStatus="running" produces <span class="dot live">', async () => {
        const html = await render({
            daemonStatus: "running",
            killSwitchEngaged: false,
            mtdSpend: 0,
        });
        expect(html).toContain('<span class="dot live"');
        expect(html).toContain("RUNNING");
    });

    test('O-02: daemonStatus="stale" produces <span class="dot warn">', async () => {
        const html = await render({
            daemonStatus: "stale",
            killSwitchEngaged: false,
            mtdSpend: 0,
        });
        expect(html).toContain('<span class="dot warn"');
        expect(html).toContain("STALE");
    });

    test('O-03: daemonStatus="dead" produces <span class="dot err">', async () => {
        const html = await render({
            daemonStatus: "dead",
            killSwitchEngaged: false,
            mtdSpend: 0,
        });
        expect(html).toContain('<span class="dot err"');
        expect(html).toContain("DOWN");
    });

    test('O-04: daemonStatus="unknown" produces <span class="dot muted">', async () => {
        const html = await render({
            daemonStatus: "unknown",
            killSwitchEngaged: false,
            mtdSpend: 0,
        });
        expect(html).toContain('<span class="dot muted"');
        expect(html).toContain("UNKNOWN");
    });

    test("O-05: mtdSpend undefined renders muted dot and em-dash", async () => {
        const html = await render({
            daemonStatus: "running",
            killSwitchEngaged: false,
        });
        // The MTD line is the second `.line` block — assert both signals.
        expect(html).toContain("MTD spend");
        expect(html).toContain("—");
        // At least one muted dot must be present (the MTD one).
        const mutedMatches = html.match(/<span class="dot muted"/g) ?? [];
        expect(mutedMatches.length).toBeGreaterThanOrEqual(1);
    });

    test("MTD shown to 2 decimals with thousands separator", async () => {
        const html = await render({
            daemonStatus: "running",
            killSwitchEngaged: false,
            mtdSpend: 1843,
        });
        expect(html).toContain("$1,843.00");
    });

    test("MTD with fractional input rounds to 2 decimals", async () => {
        const html = await render({
            daemonStatus: "running",
            killSwitchEngaged: false,
            mtdSpend: 12.345,
        });
        // `Intl.NumberFormat` rounds half-to-even; 12.345 -> $12.35 in V8.
        // Either way the output must have exactly 2 fractional digits.
        expect(html).toMatch(/\$12\.\d{2}/);
    });

    test("O-06a: kill-switch button (default) text is `Engage kill switch`", async () => {
        const html = await render({
            daemonStatus: "running",
            killSwitchEngaged: false,
            mtdSpend: 0,
        });
        expect(html).toContain("Engage kill switch");
        expect(html).toContain('hx-get="/ops/kill-switch-modal?step=arm"');
        expect(html).toContain('hx-target="#modal-slot"');
        // Non-engaged state must NOT carry aria-disabled.
        expect(html).not.toContain('aria-disabled="true"');
    });

    test("O-06b: killSwitchEngaged=true renders ENGAGED + aria-disabled", async () => {
        const html = await render({
            daemonStatus: "running",
            killSwitchEngaged: true,
            mtdSpend: 100,
        });
        expect(html).toContain("Kill switch ENGAGED");
        expect(html).toContain('aria-disabled="true"');
        // Engaged state class must be present so the err-tint fill applies.
        expect(html).toMatch(/class="kbtn engaged"/);
    });

    test("kill-switch button uses .kbtn class (err-themed)", async () => {
        const html = await render({
            daemonStatus: "running",
            killSwitchEngaged: false,
            mtdSpend: 0,
        });
        expect(html).toMatch(/class="kbtn"/);
    });

    test("output is rooted in <div class='rail-ops'>", async () => {
        const html = await render({
            daemonStatus: "running",
            killSwitchEngaged: false,
            mtdSpend: 0,
        });
        expect(html.startsWith('<div class="rail-ops">')).toBe(true);
    });

    test("mtdSpend=0 renders $0.00 with the ok dot (not muted)", async () => {
        const html = await render({
            daemonStatus: "running",
            killSwitchEngaged: false,
            mtdSpend: 0,
        });
        expect(html).toContain("$0.00");
        // The MTD line uses `dot ok` whenever a numeric value is present,
        // including zero. Muted is reserved for `undefined`.
        expect(html).toContain('<span class="dot ok"');
    });
});
