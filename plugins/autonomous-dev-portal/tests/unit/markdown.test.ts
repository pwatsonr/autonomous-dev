// SPEC-036-3-02 — markdown subset renderer unit tests.
//
// Asserts the lightweight renderer covers the spec's required subset
// (headers, paragraphs, lists, fenced code, inline code, bold/italic,
// links) AND the trust-boundary contract (script tags inside fences are
// HTML-escaped; unsafe link schemes are defanged).

import { describe, expect, test } from "bun:test";

import { escapeHtml, renderMarkdown } from "../../server/lib/markdown";

describe("escapeHtml", () => {
    test("escapes the five HTML-significant characters", () => {
        // The implementation follows the OWASP-canonical 5: `&`, `<`, `>`,
        // `"`, `'`. The forward slash (`/`) is intentionally NOT escaped:
        // it's safe inside attribute values and tag bodies once `<` and
        // `>` are already escaped, and leaving it readable improves
        // diagnostic output for the audit log preview.
        expect(escapeHtml('<script>alert("x")</script>')).toBe(
            "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
        );
    });

    test("returns empty string verbatim", () => {
        expect(escapeHtml("")).toBe("");
    });
});

describe("renderMarkdown — headers", () => {
    test("renders # h1", () => {
        expect(renderMarkdown("# Hello")).toBe("<h1>Hello</h1>");
    });

    test("renders ### h3", () => {
        expect(renderMarkdown("### Sub")).toBe("<h3>Sub</h3>");
    });
});

describe("renderMarkdown — paragraphs", () => {
    test("wraps a single line in <p>", () => {
        expect(renderMarkdown("plain text")).toBe("<p>plain text</p>");
    });

    test("collapses contiguous lines into one paragraph", () => {
        expect(renderMarkdown("line one\nline two")).toBe(
            "<p>line one line two</p>",
        );
    });
});

describe("renderMarkdown — lists", () => {
    test("renders unordered list", () => {
        const out = renderMarkdown("- one\n- two");
        expect(out).toBe("<ul><li>one</li><li>two</li></ul>");
    });

    test("renders ordered list", () => {
        const out = renderMarkdown("1. one\n2. two");
        expect(out).toBe("<ol><li>one</li><li>two</li></ol>");
    });
});

describe("renderMarkdown — fenced code blocks (trust boundary)", () => {
    test("escapes <script> inside ``` blocks", () => {
        const out = renderMarkdown(
            "```\n<script>alert(1)</script>\n```",
        );
        expect(out).toContain("&lt;script&gt;");
        expect(out).not.toMatch(/<script>alert/);
    });

    test("preserves code-block class", () => {
        const out = renderMarkdown("```\nhi\n```");
        expect(out).toContain('<pre class="md-code">');
        expect(out).toContain("<code>hi</code>");
    });
});

describe("renderMarkdown — inline", () => {
    test("inline code", () => {
        expect(renderMarkdown("a `b` c")).toBe("<p>a <code>b</code> c</p>");
    });

    test("bold and italic", () => {
        expect(renderMarkdown("**b** *i*")).toBe(
            "<p><strong>b</strong> <em>i</em></p>",
        );
    });

    test("links with safe schemes", () => {
        expect(renderMarkdown("[home](/dashboard)")).toContain(
            '<a href="/dashboard">home</a>',
        );
        expect(renderMarkdown("[ext](https://example.com)")).toContain(
            '<a href="https://example.com">ext</a>',
        );
    });

    test("defangs javascript: links", () => {
        const out = renderMarkdown("[evil](javascript:alert(1))");
        expect(out).not.toContain("<a ");
        expect(out).toContain("evil");
    });
});

describe("renderMarkdown — empty/edge", () => {
    test("empty string returns empty string", () => {
        expect(renderMarkdown("")).toBe("");
    });

    test("whitespace-only returns empty string", () => {
        expect(renderMarkdown("\n\n  \n")).toBe("");
    });
});
