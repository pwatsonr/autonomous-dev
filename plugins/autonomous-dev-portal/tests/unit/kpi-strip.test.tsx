// SPEC-036-1-02 §KpiStrip — unit tests.
//
// Asserts the prop signature (4 tiles + sub-line + custom id) and
// the format constraints PRD-018 R-22 enforces (MTD value matches
// `/^\$\d+\.\d{2}$/`).

import { describe, expect, test } from "bun:test";

import { KpiStrip } from "../../server/templates/fragments/kpi-strip";

async function render(node: unknown): Promise<string> {
    const v = await Promise.resolve(node);
    return typeof v === "string" ? v : String(v);
}

describe("KpiStrip — SPEC-036-1-02", () => {
    const items = [
        { label: "Active requests", value: 5, sub: "across 2 repos" },
        { label: "Awaiting approval", value: 3, sub: "1 reviewer / 0 standards / 0 cost" },
        { label: "MTD spend", value: "$12.34", sub: "cap $400.00" },
        { label: "Standards rules", value: 3, sub: "2 blocking hits MTD" },
    ];

    test("AC #2: renders <div id=\"kpi-strip\" class=\"kpi-strip\">", async () => {
        const html = await render(<KpiStrip items={items} />);
        expect(html).toContain('<div id="kpi-strip" class="kpi-strip">');
    });

    test("AC #1/#3: 4 tiles render in input order", async () => {
        const html = await render(<KpiStrip items={items} />);
        const labels = [...html.matchAll(/<div class="kpi-label">([^<]+)<\/div>/g)].map(
            (m) => m[1],
        );
        expect(labels).toEqual([
            "Active requests",
            "Awaiting approval",
            "MTD spend",
            "Standards rules",
        ]);
    });

    test("AC #2: each tile carries kpi-label, kpi-value, kpi-sub", async () => {
        const html = await render(<KpiStrip items={items} />);
        // 4 tiles -> 4 labels, 4 values, 4 subs
        const labelCount = (html.match(/class="kpi-label"/g) ?? []).length;
        const valueCount = (html.match(/class="kpi-value"/g) ?? []).length;
        const subCount = (html.match(/class="kpi-sub"/g) ?? []).length;
        expect(labelCount).toBe(4);
        expect(valueCount).toBe(4);
        expect(subCount).toBe(4);
    });

    test("AC #2: sub-line omitted when undefined", async () => {
        const html = await render(
            <KpiStrip items={[{ label: "A", value: 1 }]} />,
        );
        expect(html).not.toContain("kpi-sub");
    });

    test("AC #4: zero-value renders without crashing", async () => {
        const html = await render(
            <KpiStrip items={[{ label: "Active", value: 0 }]} />,
        );
        expect(html).toContain('<div class="kpi-value">0</div>');
    });

    test("AC #4: '$0.00' renders verbatim (PRD-018 R-22)", async () => {
        const html = await render(
            <KpiStrip items={[{ label: "MTD", value: "$0.00" }]} />,
        );
        expect(html).toContain("$0.00");
    });

    test("AC #5: custom id overrides default", async () => {
        const html = await render(
            <KpiStrip items={[]} id="dashboard-kpis-x" />,
        );
        expect(html).toContain('id="dashboard-kpis-x"');
        expect(html).not.toContain('id="kpi-strip"');
    });

    test("AC #6: MTD value matches /^\\$\\d+\\.\\d{2}$/", async () => {
        const html = await render(<KpiStrip items={items} />);
        const match = html.match(
            /<div class="kpi-value">(\$\d+\.\d{2})<\/div>/,
        );
        expect(match).not.toBeNull();
        expect(match![1]).toMatch(/^\$\d+\.\d{2}$/);
    });
});
