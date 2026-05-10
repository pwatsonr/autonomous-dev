// SPEC-036-1-06 §EmptyState — unit tests.
//
// Renders <EmptyState> via Hono's JSX runtime and asserts the
// canonical "No {noun}" markup plus the optional hint line.

import { describe, expect, test } from "bun:test";

import { EmptyState } from "../../server/templates/fragments/empty-state";

async function render(node: unknown): Promise<string> {
    const v = await Promise.resolve(node);
    return typeof v === "string" ? v : String(v);
}

describe("EmptyState — SPEC-036-1-06", () => {
    test("AC #2: renders <p class=\"muted empty-state\">No {noun}</p>", async () => {
        const html = await render(<EmptyState noun="active requests" />);
        expect(html).toContain(
            '<p class="muted empty-state">No active requests</p>',
        );
    });

    test("AC #2: omits hint <p> when hint is undefined", async () => {
        const html = await render(<EmptyState noun="x" />);
        expect(html).not.toContain("empty-state-hint");
    });

    test("AC #2: renders hint as second <p class=\"muted dim empty-state-hint\">", async () => {
        const html = await render(
            <EmptyState noun="repositories" hint="add one in Settings" />,
        );
        expect(html).toContain(
            '<p class="muted dim empty-state-hint">add one in Settings</p>',
        );
    });

    test("AC #3: each canonical noun renders 'No {noun}' verbatim", async () => {
        for (const noun of [
            "repositories allowlisted",
            "active requests",
            "blocking hits",
        ]) {
            const html = await render(<EmptyState noun={noun} />);
            expect(html).toContain(`No ${noun}`);
        }
    });
});
