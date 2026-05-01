// SPEC-014-2-03 §Acceptance Criteria — XSS sanitization pipeline smoke suite.
//
// The full payload corpus and OWASP-style attack matrix lives in
// tests/security/xss-payload-tests.spec.ts (SPEC-014-2-05). These cases
// pin the unit-level acceptance criteria so regressions surface early.

import { describe, expect, test } from "bun:test";

import {
    escapeAttr,
    escapeHtml,
    escapeJsString,
    escapeUrl,
} from "../../server/security/escape-helpers";
import {
    MarkdownSanitizationPipeline,
    getRefusalMessage,
    sanitizeMarkdown,
} from "../../server/security/sanitization-pipeline";
import {
    ALLOWED_CLASS_PATTERN,
    DEFAULT_SANITIZATION_CONFIG,
    flattenAllowedAttrs,
} from "../../server/security/sanitization-config";

describe("escapeHtml / escapeAttr", () => {
    test("escapes the five HTML metacharacters", () => {
        expect(escapeHtml("<>&\"'")).toBe("&lt;&gt;&amp;&quot;&#039;");
    });
    test("escapeAttr also escapes backtick and equals", () => {
        expect(escapeAttr("a`=b")).toBe("a&#096;&#061;b");
    });
});

describe("escapeJsString", () => {
    test("hex-encodes anything outside safe ASCII", () => {
        const out = escapeJsString("alert('x')");
        expect(out).not.toContain("'");
        expect(out).not.toContain("(");
    });
    test("preserves alphanumerics and basic punctuation", () => {
        expect(escapeJsString("abc123,._")).toBe("abc123,._");
    });
});

describe("escapeUrl", () => {
    test("accepts http / https / mailto", () => {
        expect(escapeUrl("https://example.com")).toBe("https://example.com");
        expect(escapeUrl("mailto:x@y.z")).toBe("mailto:x@y.z");
    });
    test("rejects javascript: vbscript: data:text/html file:", () => {
        expect(escapeUrl("javascript:alert(1)")).toBeNull();
        expect(escapeUrl("vbscript:msgbox")).toBeNull();
        expect(escapeUrl("file:///etc/passwd")).toBeNull();
    });
    test("rejects empty / whitespace", () => {
        expect(escapeUrl("")).toBeNull();
        expect(escapeUrl("   ")).toBeNull();
    });
    test("accepts relative paths", () => {
        expect(escapeUrl("/foo/bar?x=1")).toBe("/foo/bar?x=1");
    });
});

describe("sanitization-config", () => {
    test("class allowlist accepts documented patterns", () => {
        for (const cls of [
            "language-typescript",
            "tok-keyword",
            "tok-diff-add",
            "code-block",
            "inline-code",
            "blocked-link",
            "diff-block",
            "diff-line",
            "diff-truncated",
        ]) {
            expect(ALLOWED_CLASS_PATTERN.test(cls)).toBe(true);
        }
    });
    test("class allowlist rejects arbitrary classes", () => {
        for (const cls of ["random", "btn-danger", "x", "language-../oops"]) {
            expect(ALLOWED_CLASS_PATTERN.test(cls)).toBe(false);
        }
    });
    test("flattenAllowedAttrs unions per-tag entries", () => {
        const flat = flattenAllowedAttrs(
            DEFAULT_SANITIZATION_CONFIG.allowedAttributes,
        );
        expect(flat).toContain("href");
        expect(flat).toContain("src");
        expect(flat).toContain("class");
    });
});

describe("MarkdownSanitizationPipeline — happy path", () => {
    test("renders simple markdown to safe HTML", () => {
        const r = sanitizeMarkdown("# Hello\n\nThis is **bold** text.");
        expect(r.safe).toBe(true);
        expect(r.sanitized).toContain("<h1");
        expect(r.sanitized).toContain("<strong>bold</strong>");
    });

    test("renders code blocks with entity-escaped content", () => {
        const r = sanitizeMarkdown(
            "```typescript\nconst x = '<script>';\n```",
        );
        expect(r.safe).toBe(true);
        expect(r.sanitized).toContain("language-typescript");
        expect(r.sanitized).toContain("&lt;script&gt;");
        expect(r.sanitized).not.toMatch(/<script\b/i);
    });

    test("renders well-formed external links with rel/target", () => {
        const r = sanitizeMarkdown("[home](https://example.com)");
        expect(r.sanitized).toContain('href="https://example.com"');
        expect(r.sanitized).toContain('rel="noopener noreferrer"');
        expect(r.sanitized).toContain('target="_blank"');
    });
});

describe("MarkdownSanitizationPipeline — XSS payloads", () => {
    test("blocks <script> tag", () => {
        const r = sanitizeMarkdown("<script>alert(1)</script>");
        expect(r.sanitized).not.toMatch(/<script\b/i);
        expect(r.sanitized).not.toContain("alert(");
    });

    test("blocks javascript: link", () => {
        const r = sanitizeMarkdown("[click](javascript:alert(1))");
        expect(r.sanitized).not.toContain("javascript:");
        expect(r.sanitized).toContain("blocked-link");
    });

    test("blocks vbscript: image", () => {
        const r = sanitizeMarkdown("![x](vbscript:msgbox)");
        expect(r.sanitized).not.toContain("vbscript:");
    });

    test("blocks data:text/html image", () => {
        const r = sanitizeMarkdown("![x](data:text/html,<script>alert(1)</script>)");
        expect(r.sanitized).not.toContain("data:text/html");
        expect(r.sanitized).toContain("blocked-image");
    });

    test("blocks event handlers in raw HTML markdown", () => {
        const r = sanitizeMarkdown("<img src=x onerror=alert(1)>");
        expect(r.sanitized).not.toMatch(/onerror=/i);
    });

    test("blocks <iframe> embed", () => {
        const r = sanitizeMarkdown("<iframe src=https://evil></iframe>");
        expect(r.sanitized).not.toMatch(/<iframe\b/i);
    });

    test("strips dangerous classes", () => {
        const r = sanitizeMarkdown('<span class="evil-class tok-keyword">x</span>');
        expect(r.sanitized).not.toContain("evil-class");
        expect(r.sanitized).toContain("tok-keyword");
    });

    test("rejects oversized input with entire-content blocked", () => {
        const huge = "x".repeat(150_000);
        const r = sanitizeMarkdown(huge);
        expect(r.safe).toBe(false);
        expect(r.blocked).toContain("entire-content");
        expect(r.warnings).toContain("content-exceeds-max-length");
    });
});

describe("MarkdownSanitizationPipeline — false-positive prevention", () => {
    test("preserves prose mentioning 'javascript' as a word", () => {
        const r = sanitizeMarkdown("JavaScript is a programming language.");
        expect(r.safe).toBe(true);
        expect(r.sanitized).toContain("JavaScript");
    });

    test("preserves a code fence with the literal word script", () => {
        const r = sanitizeMarkdown("```\nrun the script\n```");
        expect(r.safe).toBe(true);
        expect(r.sanitized).toContain("run the script");
    });

    test("preserves a markdown table with normal content", () => {
        const r = sanitizeMarkdown(
            "| a | b |\n|---|---|\n| 1 | 2 |\n",
        );
        expect(r.sanitized).toContain("<table>");
        expect(r.sanitized).toContain("<td>1</td>");
    });

    test("preserves an https link without modifying the body", () => {
        const r = sanitizeMarkdown("[home](https://example.com/path)");
        expect(r.sanitized).toContain("https://example.com/path");
    });
});

describe("MarkdownSanitizationPipeline — caching", () => {
    test("caches by content hash", () => {
        const p = new MarkdownSanitizationPipeline({
            enableCaching: true,
            cacheMaxEntries: 10,
        });
        p.sanitizeMarkdown("# A");
        const before = p.cacheSize;
        p.sanitizeMarkdown("# A");
        expect(p.cacheSize).toBe(before);
    });

    test("LRU evicts beyond cacheMaxEntries", () => {
        const p = new MarkdownSanitizationPipeline({
            enableCaching: true,
            cacheMaxEntries: 3,
        });
        for (let i = 0; i < 5; i += 1) {
            p.sanitizeMarkdown(`# heading ${String(i)}`);
        }
        expect(p.cacheSize).toBeLessThanOrEqual(3);
    });
});

describe("getRefusalMessage", () => {
    test("includes warning text when warnings present", () => {
        expect(
            getRefusalMessage({
                sanitized: "",
                warnings: ["foo"],
                blocked: [],
                safe: false,
            }),
        ).toContain("foo");
    });
    test("includes blocked tags when no warnings", () => {
        expect(
            getRefusalMessage({
                sanitized: "x",
                warnings: [],
                blocked: ["script"],
                safe: false,
            }),
        ).toContain("script");
    });
    test("falls back to generic message", () => {
        expect(
            getRefusalMessage({
                sanitized: "x",
                warnings: [],
                blocked: [],
                safe: true,
            }),
        ).toContain("security");
    });
});
