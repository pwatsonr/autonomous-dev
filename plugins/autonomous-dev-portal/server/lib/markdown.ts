// SPEC-036-3-02 §Artifact pane — lightweight server-side markdown renderer.
//
// TRUST BOUNDARY:
//   The artifact pane consumes daemon-authored prose (PRD, TDD, plan, spec
//   markdown). The trust boundary is the daemon's write to disk: artifact
//   content is treated as semi-trusted operator-facing text, NOT raw user
//   input. As a result:
//     - Code blocks ALWAYS HTML-escape their inner content (defense in
//       depth: even daemon-authored snippets shouldn't execute as HTML).
//     - Prose-level inline HTML passes through by design — the daemon may
//       intentionally embed small inline markup (e.g. <abbr>, <kbd>).
//     - Untrusted user input MUST NOT flow into this renderer; route it
//       through DOMPurify or use the `text` artifact format instead.
//
// Subset supported (per acceptance criteria):
//   - ATX headers (# ## ### up to ######)
//   - Paragraphs (double-newline separated)
//   - Fenced code blocks (```; inner content HTML-escaped)
//   - Unordered lists (-, *) and ordered lists (1.)
//   - Inline `code`, **bold**, *italic*, [text](url) links
//
// Intentionally NOT supported (out of scope for the artifact reading pane):
//   - Tables, blockquotes, images, HTML passthrough wrappers (<div>, etc.)
//   - Reference-style links, footnotes, definition lists, task lists
//
// Implementation: zero external deps — a small recursive descent over the
// line stream. The `marked` package is shipped in package.json for other
// surfaces but is intentionally not used here so the trust boundary is
// auditable in <100 LoC.

/**
 * HTML-escape a string for safe insertion into element text or attribute
 * contexts. Mirrors the escape table used by Hono's JSX runtime.
 */
export function escapeHtml(input: string): string {
    return input
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/** Inline markdown — `code`, **bold**, *italic*, [text](url). */
function renderInline(text: string): string {
    // Step 1: escape the raw text to defang any inline HTML before we
    // selectively re-inject our own tag wrappers below.
    let out = escapeHtml(text);

    // Inline code — single backtick spans. Inner content is already escaped
    // since we ran escapeHtml first.
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold (`**…**`) before italic so `**foo**` doesn't get eaten by italic.
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");

    // Links: [text](url). The url is already HTML-escaped by escapeHtml,
    // but we additionally enforce a safe scheme prefix. Anything not
    // matching http(s):/, mailto:, or a relative path is rendered as plain
    // text (no <a>) to defang `javascript:` payloads.
    out = out.replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        (_match, label: string, url: string) => {
            const safe =
                /^https?:&#x2F;&#x2F;|^https?:\/\//i.test(url) ||
                /^mailto:/i.test(url) ||
                /^\//.test(url) ||
                /^\.\.?\//.test(url);
            if (!safe) return `${label} (${url})`;
            return `<a href="${url}">${label}</a>`;
        },
    );

    return out;
}

interface Block {
    kind: "h" | "p" | "ul" | "ol" | "code";
    level?: number;
    items?: string[];
    text?: string;
    /** Raw (un-escaped) code content for `code` blocks. */
    raw?: string;
}

function tokenize(input: string): Block[] {
    const lines = input.split(/\r?\n/);
    const blocks: Block[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i] ?? "";

        // Skip blank lines between blocks.
        if (/^\s*$/.test(line)) {
            i += 1;
            continue;
        }

        // Fenced code block.
        if (/^```/.test(line)) {
            i += 1;
            const buf: string[] = [];
            while (i < lines.length && !/^```/.test(lines[i] ?? "")) {
                buf.push(lines[i] ?? "");
                i += 1;
            }
            // Skip the closing fence (or EOF).
            if (i < lines.length) i += 1;
            blocks.push({ kind: "code", raw: buf.join("\n") });
            continue;
        }

        // ATX header.
        const h = /^(#{1,6})\s+(.*)$/.exec(line);
        if (h !== null) {
            blocks.push({
                kind: "h",
                level: (h[1] ?? "#").length,
                text: h[2] ?? "",
            });
            i += 1;
            continue;
        }

        // Unordered list (consecutive `- ` or `* ` lines).
        if (/^[-*]\s+/.test(line)) {
            const items: string[] = [];
            while (i < lines.length && /^[-*]\s+/.test(lines[i] ?? "")) {
                items.push((lines[i] ?? "").replace(/^[-*]\s+/, ""));
                i += 1;
            }
            blocks.push({ kind: "ul", items });
            continue;
        }

        // Ordered list.
        if (/^\d+\.\s+/.test(line)) {
            const items: string[] = [];
            while (i < lines.length && /^\d+\.\s+/.test(lines[i] ?? "")) {
                items.push((lines[i] ?? "").replace(/^\d+\.\s+/, ""));
                i += 1;
            }
            blocks.push({ kind: "ol", items });
            continue;
        }

        // Paragraph: gather contiguous non-blank, non-block-prefix lines.
        const para: string[] = [];
        while (i < lines.length) {
            const l = lines[i] ?? "";
            if (/^\s*$/.test(l)) break;
            if (/^```/.test(l)) break;
            if (/^#{1,6}\s+/.test(l)) break;
            if (/^[-*]\s+/.test(l)) break;
            if (/^\d+\.\s+/.test(l)) break;
            para.push(l);
            i += 1;
        }
        blocks.push({ kind: "p", text: para.join(" ") });
    }

    return blocks;
}

/**
 * Render a markdown subset into HTML. See module header for trust boundary
 * and supported syntax.
 */
export function renderMarkdown(input: string): string {
    if (typeof input !== "string" || input.length === 0) return "";
    const blocks = tokenize(input);
    const out: string[] = [];

    for (const block of blocks) {
        if (block.kind === "h") {
            const lvl = block.level ?? 1;
            out.push(`<h${lvl}>${renderInline(block.text ?? "")}</h${lvl}>`);
        } else if (block.kind === "p") {
            out.push(`<p>${renderInline(block.text ?? "")}</p>`);
        } else if (block.kind === "ul") {
            const items = (block.items ?? [])
                .map((t) => `<li>${renderInline(t)}</li>`)
                .join("");
            out.push(`<ul>${items}</ul>`);
        } else if (block.kind === "ol") {
            const items = (block.items ?? [])
                .map((t) => `<li>${renderInline(t)}</li>`)
                .join("");
            out.push(`<ol>${items}</ol>`);
        } else if (block.kind === "code") {
            // CRITICAL: inner content is HTML-escaped so `<script>…</script>`
            // injected inside ``` blocks renders as text, not executable HTML.
            out.push(
                `<pre class="md-code"><code>${escapeHtml(block.raw ?? "")}</code></pre>`,
            );
        }
    }

    return out.join("");
}
