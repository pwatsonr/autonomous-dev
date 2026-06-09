// FR-026-21 — Request Detail v3: multi-file diff viewer.
//
// Renders a `.card` containing one `.diff` block per changed file. Each
// diff block has:
//   - `.file-h` header row: filename, +adds / -dels counts
//   - `.body` (overflow-x: auto; min-width: 0) containing `.ln` rows:
//     - `.ln.add`     — added line (green tint)
//     - `.ln.del`     — deleted line (red tint)
//     - `.ln.context` — context line (neutral)
//     - `.hunk`       — hunk header row (@@ … @@)
//   - Two line-number columns per `.ln` row so diffs render as a side-by-side
//     "old | new" visual, matching the design's `.diff .ln` grid.
//
// CSS classes consumed from app.css:
//   .card, .card-h, .card-b, .diff, .diff .file-h, .diff .body,
//   .diff .ln, .diff .ln .n, .diff .ln .c, .diff .hunk,
//   .diff .ln.add, .diff .ln.del, .diff .ln.context
//
// Long lines are contained via `.body { overflow-x: auto }` from app.css
// combined with `.rdetail-main { min-width: 0 }` so the panel does not
// push the gate panel off-screen.
//
// Accessibility: code content is in a <pre>-equivalent structure via
// `white-space: pre` CSS; the outer element carries a visually-hidden
// aria-label describing the diff.

import type { FC } from "hono/jsx";

import { escapeHtml } from "../../lib/markdown";

export interface DiffFile {
    /** Relative file path (e.g. "server/lib/safe-path.ts"). */
    file: string;
    /** Number of added lines. */
    adds: number;
    /** Number of deleted lines. */
    dels: number;
    /** Unified-diff body — raw text including @@ headers and +/-/space lines. */
    body: string;
}

interface Props {
    /** Branch name displayed in the card header. */
    branch: string;
    /** Files in this diff. */
    files: DiffFile[];
}

interface DiffLine {
    tag: "hunk" | "add" | "del" | "context";
    old: string; // old line number or ""
    newN: string; // new line number or ""
    content: string; // the line content (prefix char stripped for add/del/context)
    /** Original prefix character (+/-/space) preserved for WCAG 1.4.1 dual-cue. */
    prefix: string;
}

/**
 * Parse a unified-diff body string into typed line records.
 * Strips the leading + / - / space character from content lines and
 * extracts line numbers from @@ headers.
 *
 * @param body - raw unified diff body
 * @returns parsed line records
 */
function parseDiff(body: string): DiffLine[] {
    const lines = body.split("\n");
    const out: DiffLine[] = [];
    let oldN = 0;
    let newN = 0;

    for (const rawLine of lines) {
        if (rawLine === "") continue;

        if (rawLine.startsWith("@@")) {
            // @@ -OLD_START,LEN +NEW_START,LEN @@
            const match = rawLine.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (match !== null && match[1] !== undefined && match[2] !== undefined) {
                oldN = parseInt(match[1], 10) - 1;
                newN = parseInt(match[2], 10) - 1;
            }
            out.push({ tag: "hunk", old: "", newN: "", content: rawLine, prefix: "" });
            continue;
        }

        if (rawLine.startsWith("+")) {
            newN++;
            out.push({
                tag: "add",
                old: "",
                newN: String(newN),
                content: rawLine.slice(1),
                prefix: "+",
            });
        } else if (rawLine.startsWith("-")) {
            oldN++;
            out.push({
                tag: "del",
                old: String(oldN),
                newN: "",
                content: rawLine.slice(1),
                prefix: "-",
            });
        } else {
            // context line (leading space)
            oldN++;
            newN++;
            out.push({
                tag: "context",
                old: String(oldN),
                newN: String(newN),
                content: rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine,
                prefix: " ",
            });
        }
    }

    return out;
}

/**
 * FR-026-21 — Multi-file diff viewer card.
 *
 * Renders the diff card inside `.rdetail-main`. Long lines are scrollable
 * inside `.body { overflow-x: auto }` so the gate panel is never displaced.
 *
 * @param props - {@link Props}
 */
export const RdV3DiffViewer: FC<Props> = ({ branch, files }) => {
    const totalAdds = files.reduce((s, f) => s + f.adds, 0);
    const totalDels = files.reduce((s, f) => s + f.dels, 0);

    return (
        <div class="card" id="rd-diff-viewer">
            <div class="card-h">
                <h3>Diff</h3>
                <span class="meta">
                    {files.length} file{files.length !== 1 ? "s" : ""} &middot;
                    branch{" "}
                    <code class="rd-branch-inline">{branch}</code>
                </span>
                <span class="spacer"></span>
                <span class="mono dim rd-diff-totals">
                    +{totalAdds} &minus;{totalDels}
                </span>
            </div>
            <div class="card-b rd-diff-files">
                {files.map((f) => {
                    const parsed = parseDiff(f.body);
                    return (
                        <div class="diff" key={f.file} aria-label={`Diff for ${f.file}`}>
                            <div class="file-h">
                                <span>{f.file}</span>
                                <span class="pm">
                                    <span class="pl">+{f.adds}</span>{" "}
                                    &middot;{" "}
                                    <span class="mn">&minus;{f.dels}</span>
                                </span>
                            </div>
                            <div class="body">
                                {parsed.map((ln, i) => {
                                    if (ln.tag === "hunk") {
                                        return (
                                            <div class="hunk" key={i}>
                                                <span class="h"></span>
                                                <span class="h">
                                                    {escapeHtml(ln.content)}
                                                </span>
                                            </div>
                                        );
                                    }
                                    const cls =
                                        ln.tag === "context"
                                            ? "ln context"
                                            : `ln ${ln.tag}`;
                                    // WCAG 1.4.1 dual-cue: colour alone must not
                                    // be the only signal for added/deleted lines.
                                    // We render a visible prefix glyph (+/-/space)
                                    // in a narrow `.pfx` column, plus a
                                    // visually-hidden screen-reader label so
                                    // assistive technology announces the change
                                    // type even in monochrome / high-contrast modes.
                                    const srLabel =
                                        ln.tag === "add"
                                            ? "added: "
                                            : ln.tag === "del"
                                              ? "removed: "
                                              : "";
                                    return (
                                        <div class={cls} key={i}>
                                            <span class="n" aria-hidden="true">
                                                {ln.old}
                                            </span>
                                            <span class="n" aria-hidden="true">
                                                {ln.newN}
                                            </span>
                                            <span class="c">
                                                {srLabel !== "" ? (
                                                    <span class="sr-only">
                                                        {srLabel}
                                                    </span>
                                                ) : null}
                                                <span
                                                    class="pfx"
                                                    aria-hidden="true"
                                                >
                                                    {ln.prefix}
                                                </span>
                                                {escapeHtml(ln.content)}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
                {files.length === 0 ? (
                    <p class="dim meta-mono rd-diff-empty">
                        No changed files in this diff.
                    </p>
                ) : null}
            </div>
        </div>
    );
};
