// SPEC-035-3-01 §6 — KillSwitch primitive unit tests.
//
// Renders the FC to a string the same way other component tests do
// (await Promise.resolve(node)) and asserts on the rendered HTML
// substring. KS-U-01..KS-U-06 from SPEC-035-3-01 §6.

import { describe, expect, test } from "bun:test";

import { KillSwitch } from "../../server/components/kill-switch";

async function render(props: Parameters<typeof KillSwitch>[0]): Promise<string> {
    const node = KillSwitch(props) as unknown;
    return String(await Promise.resolve(node));
}

describe("KillSwitch — idle render (KS-U-01 / AC-1)", () => {
    test("renders DISENGAGED chip + engage button + HTMX attrs; no form/input/script", async () => {
        const html = await render({
            engaged: false,
            onConfirm: "/ops/kill-switch",
        });
        expect(html).toContain('<div class="ks-panel">');
        expect(html).not.toContain('<div class="ks-panel armed">');
        expect(html).toContain('<span class="chip ok">DISENGAGED</span>');
        expect(html).toContain('hx-get="/ops/kill-switch?step=arm"');
        expect(html).toContain('hx-target="closest .ks-panel"');
        expect(html).toContain('hx-swap="outerHTML"');
        expect(html).toContain("Engage kill switch");
        expect(html).not.toContain("<form");
        expect(html).not.toContain('name="confirmation"');
        expect(html).not.toContain("<script");
    });
});

describe("KillSwitch — engaged render (KS-U-02 / AC-3)", () => {
    test("renders ENGAGED chip + reset form; no engage button", async () => {
        const html = await render({
            engaged: true,
            onConfirm: "/ops/kill-switch",
            csrfToken: "tok-456",
        });
        expect(html).toContain('<span class="chip err">ENGAGED</span>');
        expect(html).toContain(
            '<form method="POST" action="/ops/kill-switch/reset">',
        );
        expect(html).toContain('<input type="hidden" name="_csrf" value="tok-456"');
        expect(html).toContain("Reset kill switch");
        // FR-10: no path to double-engage.
        expect(html).not.toContain("Engage kill switch");
        expect(html).not.toContain("hx-get=");
    });
});

describe("KillSwitch — armed render (KS-U-03/04)", () => {
    test("contains armed_at, confirmation input with pattern, and CSRF token", async () => {
        const html = await render({
            engaged: false,
            armed: true,
            armedAt: "2026-05-09T20:00:00.000Z",
            csrfToken: "tok-123",
            onConfirm: "/ops/kill-switch",
        });
        expect(html).toContain('<div class="ks-panel armed">');
        expect(html).toContain('<form method="POST" action="/ops/kill-switch">');
        expect(html).toContain('<input type="hidden" name="_csrf" value="tok-123"');
        expect(html).toContain(
            '<input type="hidden" name="armed_at" value="2026-05-09T20:00:00.000Z"',
        );
        expect(html).toContain('name="confirmation"');
        expect(html).toContain('pattern="CONFIRM"');
        expect(html).toContain('class="input mono"');
        expect(html).toContain('autocomplete="off"');
        expect(html).toContain("required");
        expect(html).toContain("Confirm engage");
        // A11y: label associated with input id.
        expect(html).toContain('for="ks-confirm-input"');
        expect(html).toContain('id="ks-confirm-input"');
    });
});

describe("KillSwitch — failure-path safety (KS-U-05 / AC-4)", () => {
    test("undefined csrfToken/armedAt → empty-value hidden inputs (form structurally complete)", async () => {
        const html = await render({
            engaged: false,
            armed: true,
            onConfirm: "/ops/kill-switch",
        });
        expect(html).toContain('<input type="hidden" name="_csrf" value=""');
        expect(html).toContain('<input type="hidden" name="armed_at" value=""');
    });
});

describe("KillSwitch — stateless purity (KS-U-06 / AC-5)", () => {
    test("identical props produce byte-identical output", async () => {
        const props = {
            engaged: false,
            armed: true,
            armedAt: "2026-05-09T20:00:00.000Z",
            csrfToken: "tok-1",
            onConfirm: "/ops/kill-switch",
        } as const;
        const a = await render(props);
        const b = await render(props);
        expect(a).toBe(b);
    });

    test("no <script>, no on*= attributes in any of the three states", async () => {
        const states = [
            { engaged: false, onConfirm: "/ops/kill-switch" },
            {
                engaged: false,
                armed: true,
                armedAt: "2026-05-09T20:00:00.000Z",
                csrfToken: "t",
                onConfirm: "/ops/kill-switch",
            },
            { engaged: true, csrfToken: "t", onConfirm: "/ops/kill-switch" },
        ];
        for (const props of states) {
            const html = await render(props);
            expect(html).not.toContain("<script");
            // No on*= attributes (onclick, onchange, onload, etc.)
            expect(/\son[a-z]+=/.test(html)).toBe(false);
        }
    });
});
