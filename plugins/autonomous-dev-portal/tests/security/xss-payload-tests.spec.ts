// SPEC-014-2-05 §XSS payload corpus.
//
// Loads the externalised JSON corpus (xss-payloads.json) and runs every
// payload through the production sanitization paths. The contract: NO
// payload from any category may produce sanitized output containing
// executable patterns (raw `<script`, `javascript:` URLs, `on*=` event
// handlers, or `expression(` CSS sinks).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { escapeAttr, escapeHtml } from "../../server/security/escape-helpers";
import { sanitizeMarkdown } from "../../server/security/sanitization-pipeline";

const CORPUS_PATH = join(__dirname, "xss-payloads.json");

interface Corpus {
    version: string;
    scriptTagAttacks: string[];
    eventHandlerAttacks: string[];
    javascriptUrlAttacks: string[];
    svgAttacks: string[];
    cssAttacks: string[];
    encodingBypassAttacks: string[];
    dataUriAttacks: string[];
    owaspFilterEvasion: string[];
    markdownSpecific: string[];
    mutationXss: string[];
    legitimateContent: string[];
}

const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as Corpus;

const FORBIDDEN_PATTERNS: Array<{ name: string; check: (s: string) => boolean }> = [
    { name: "no <script tag", check: (s) => /<\s*script\b/i.test(s) },
    {
        name: "no <iframe / <object / <embed",
        check: (s) => /<\s*(iframe|object|embed)\b/i.test(s),
    },
    { name: "no on*= event handlers", check: (s) => /\son[a-z]+\s*=/i.test(s) },
    {
        name: "no javascript: URL",
        check: (s) =>
            /(href|src|action|formaction)\s*=\s*["']?\s*javascript:/i.test(s),
    },
    {
        name: "no vbscript: URL",
        check: (s) => /(href|src|action)\s*=\s*["']?\s*vbscript:/i.test(s),
    },
    {
        name: "no data:text/html URL",
        check: (s) => /(href|src)\s*=\s*["']?\s*data:text\/html/i.test(s),
    },
    { name: "no CSS expression()", check: (s) => /expression\s*\(/i.test(s) },
];

function assertNoForbiddenPatterns(payload: string, output: string): void {
    for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.check(output)) {
            throw new Error(
                `Sanitized output violated "${pattern.name}".\n` +
                    `  Input:  ${payload}\n` +
                    `  Output: ${output}`,
            );
        }
    }
}

const ATTACK_CATEGORIES: Array<{ name: string; payloads: string[] }> = [
    { name: "script tag attacks", payloads: corpus.scriptTagAttacks },
    { name: "event handler attacks", payloads: corpus.eventHandlerAttacks },
    { name: "javascript: URL attacks", payloads: corpus.javascriptUrlAttacks },
    { name: "SVG attacks", payloads: corpus.svgAttacks },
    { name: "CSS attacks", payloads: corpus.cssAttacks },
    { name: "encoding bypass attacks", payloads: corpus.encodingBypassAttacks },
    { name: "data: URI attacks", payloads: corpus.dataUriAttacks },
    { name: "OWASP filter evasion", payloads: corpus.owaspFilterEvasion },
    { name: "markdown-specific attacks", payloads: corpus.markdownSpecific },
    { name: "mutation XSS attacks", payloads: corpus.mutationXss },
];

for (const category of ATTACK_CATEGORIES) {
    describe(`sanitizeMarkdown — ${category.name}`, () => {
        const payloads = category.payloads ?? [];
        for (let i = 0; i < payloads.length; i++) {
            const payload = payloads[i] as string;
            test(`payload[${i}] is neutralised: ${payload.slice(0, 60)}`, () => {
                const result = sanitizeMarkdown(payload);
                assertNoForbiddenPatterns(payload, result.sanitized);
            });
        }
    });
}

for (const category of ATTACK_CATEGORIES) {
    describe(`escapeHtml — ${category.name}`, () => {
        const payloads = category.payloads ?? [];
        for (let i = 0; i < payloads.length; i++) {
            const payload = payloads[i] as string;
            test(`payload[${i}] escapes safely: ${payload.slice(0, 60)}`, () => {
                const escaped = escapeHtml(payload);
                assertNoForbiddenPatterns(payload, escaped);
            });
        }
    });
}

describe("escapeAttr — quote-context safety", () => {
    test("attribute escaping prevents quote-break injection", () => {
        const escaped = escapeAttr('" onmouseover="alert(1)"');
        assertNoForbiddenPatterns('" onmouseover="alert(1)"', escaped);
    });
});

describe("legitimate content survives sanitization", () => {
    const legit = corpus.legitimateContent ?? [];
    for (let i = 0; i < legit.length; i++) {
        const payload = legit[i] as string;
        test(`payload[${i}] preserves at least one visible word`, () => {
            const result = sanitizeMarkdown(payload);
            const visibleSanitized = result.sanitized
                .replace(/<[^>]*>/g, "")
                .replace(/&amp;/g, "&")
                .replace(/&lt;/g, "<")
                .replace(/&gt;/g, ">")
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/\s+/g, " ")
                .trim();
            const inputWords = payload
                .replace(/[*_`#>[\]()!-]/g, "")
                .split(/\s+/)
                .filter((w) => w.length > 2);
            const survived = inputWords.some((w) => visibleSanitized.includes(w));
            expect(survived).toBe(true);
        });
    }
});
