// SPEC-037-6-02 §LiveLog — unit tests.
//
// Asserts the kit-canonical per-line markup shape:
//   <div class="log-line">
//     <span class="l-time">...</span>
//     <span class="l-info|l-warn|l-err">LEVEL</span>
//     <span class="l-mark"?>message</span>
//   </div>
//
// The row-level `marker` modifier is gone; marker treatment is now an
// inline `<span class="l-mark">` on matching lines.

import { describe, expect, test } from "bun:test";

import { LiveLog } from "../../server/templates/fragments/live-log";
import type { LogEntry } from "../../server/types/render";

async function render(node: unknown): Promise<string> {
    const v = await Promise.resolve(node);
    return typeof v === "string" ? v : String(v);
}

const entry = (
    level: string,
    message: string,
    ts = "14:32:04Z",
): LogEntry => ({ ts, level, message });

describe("LiveLog — SPEC-037-6-02", () => {
    test("INFO/WARN/ERROR each render exactly one l-(info|warn|err) span", async () => {
        const html = await render(
            <LiveLog
                entries={[
                    entry("INFO", "boot complete"),
                    entry("WARN", "rate limit nearing"),
                    entry("ERROR", "daemon failed"),
                ]}
            />,
        );
        expect((html.match(/class="l-info"/g) ?? []).length).toBe(1);
        expect((html.match(/class="l-warn"/g) ?? []).length).toBe(1);
        expect((html.match(/class="l-err"/g) ?? []).length).toBe(1);
    });

    test("emits .l-time on the timestamp span (no .ts)", async () => {
        const html = await render(
            <LiveLog entries={[entry("INFO", "boot complete")]} />,
        );
        expect(html).toContain('<span class="l-time">14:32:04Z</span>');
        expect(html).not.toContain('class="ts"');
    });

    test("marker-matching line wraps message in <span class=\"l-mark\">", async () => {
        const html = await render(
            <LiveLog
                entries={[
                    entry("INFO", "phase prd dispatched"),
                ]}
            />,
        );
        expect(html).toContain('<span class="l-mark">phase prd dispatched</span>');
        // Row-level `marker` modifier MUST be gone.
        expect(html).not.toContain('class="log-line marker"');
    });

    test("non-marker line renders message in a class-less <span>", async () => {
        const html = await render(
            <LiveLog entries={[entry("INFO", "ordinary status update")]} />,
        );
        expect(html).toContain("<span>ordinary status update</span>");
        expect(html).not.toContain("l-mark");
    });

    test("offline=true emits a single line with l-time slot and 'Daemon offline'", async () => {
        const html = await render(<LiveLog entries={[]} offline />);
        expect(html).toContain('class="l-time"');
        expect(html).toContain("Daemon offline");
        expect(html).not.toContain('class="ts"');
        expect(html).not.toContain('class="msg"');
    });

    test("empty entries emit the 'No log entries yet' placeholder in kit shape", async () => {
        const html = await render(<LiveLog entries={[]} />);
        expect(html).toContain('class="l-time"');
        expect(html).toContain("No log entries yet");
        expect(html).not.toContain('class="lvl"');
        expect(html).not.toContain('class="msg"');
    });

    test("DEBUG/TRACE are filtered out before render (FR-4 preserved)", async () => {
        const html = await render(
            <LiveLog
                entries={[
                    entry("DEBUG", "noisy debug"),
                    entry("TRACE", "tracy trace"),
                    entry("INFO", "user-visible"),
                ]}
            />,
        );
        expect(html).not.toContain("noisy debug");
        expect(html).not.toContain("tracy trace");
        expect(html).toContain("user-visible");
    });
});
