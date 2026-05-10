// SPEC-036-4-03 + SPEC-036-4-05 — Snapshot tests for the
// trust-overrides + allowlist tables.

import { describe, expect, test } from "bun:test";

import { AllowlistTable } from "../../server/templates/fragments/allowlist-table";
import { TrustOverridesTable } from "../../server/templates/fragments/trust-overrides-table";
import type {
    AllowlistEntry,
    TrustOverride,
} from "../../server/types/render";

async function render(node: unknown): Promise<string> {
    return await Promise.resolve(node).then(String);
}

describe("TrustOverridesTable", () => {
    test("0 overrides renders empty state", async () => {
        const html = await render(TrustOverridesTable({ overrides: [] }));
        expect(html).toContain('data-empty="trust-overrides"');
        expect(html).toContain("No overrides set");
    });

    test("1 override renders one row", async () => {
        const overrides: TrustOverride[] = [
            {
                repo: "acme/widgets",
                level: "L1",
                source: "global",
            },
        ];
        const html = await render(TrustOverridesTable({ overrides }));
        expect(html).toContain('data-repo="acme/widgets"');
        expect(html).toContain("trust-override-acme-widgets");
    });

    test("immutable row renders disabled select + reset btn", async () => {
        const overrides: TrustOverride[] = [
            {
                repo: "system/core",
                level: "L3",
                source: "policy",
                immutable: true,
            },
        ];
        const html = await render(TrustOverridesTable({ overrides }));
        // Both the select and the Btn carry `disabled`.
        expect(html.match(/disabled/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    });
});

describe("AllowlistTable", () => {
    test("0 entries renders empty state with primary CTA", async () => {
        const html = await render(AllowlistTable({ entries: [] }));
        expect(html).toContain("No repos allowlisted");
        expect(html).toContain('data-allowlist=""');
        expect(html).toContain("Add your first repo");
    });

    test("3 entries with mixed statuses render correct chip tones", async () => {
        const entries: AllowlistEntry[] = [
            {
                id: "1",
                path: "/a",
                status: "ok",
                addedAt: "2026-01-01T00:00:00Z",
            },
            {
                id: "2",
                path: "/b",
                status: "missing",
                addedAt: "2026-01-02T00:00:00Z",
            },
            {
                id: "3",
                path: "/c",
                status: "not-a-repo",
                addedAt: "2026-01-03T00:00:00Z",
            },
        ];
        const html = await render(AllowlistTable({ entries }));
        // chip ok / warn / err must each appear.
        expect(html).toContain('class="chip ok"');
        expect(html).toContain('class="chip warn"');
        expect(html).toContain('class="chip err"');
        // data-allowlist mirrors the paths.
        expect(html).toContain('data-allowlist="/a\n/b\n/c"');
    });

    test("Remove btn carries data-confirm with the path interpolated", async () => {
        const entries: AllowlistEntry[] = [
            {
                id: "1",
                path: "/Users/op/repos/foo",
                status: "ok",
                addedAt: "2026-01-01T00:00:00Z",
            },
        ];
        const html = await render(AllowlistTable({ entries }));
        expect(html).toContain(
            "Remove /Users/op/repos/foo from allowlist?",
        );
    });
});
