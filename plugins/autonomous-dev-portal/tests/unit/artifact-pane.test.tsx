// SPEC-036-3-02 — Artifact pane unit tests.
//
// Snapshots one example per format, asserts the empty-case copy, asserts
// diff lines carry the correct per-line classes, and verifies the XSS
// trust boundary (script tags inside fenced/diff content render escaped).

import { describe, expect, test } from "bun:test";

import { ArtifactPane } from "../../server/templates/fragments/artifact-pane";
import type { RequestArtifact } from "../../server/types/render";

async function render(node: unknown): Promise<string> {
    const v = await Promise.resolve(node);
    return typeof v === "string" ? v : String(v);
}

describe("ArtifactPane — section head", () => {
    test("uppercases the phase in the head", async () => {
        const html = await render(
            <ArtifactPane phase="prd" targetId="t" artifact={undefined} />,
        );
        expect(html).toContain("Artifact · PRD");
    });

    test("renders artifactId in meta-mono dim when provided", async () => {
        const a: RequestArtifact = {
            phase: "code",
            format: "diff",
            content: "@@",
            artifactId: "PR-1418",
        };
        const html = await render(
            <ArtifactPane phase="code" targetId="t" artifact={a} />,
        );
        expect(html).toContain('class="meta-mono dim"');
        expect(html).toContain("PR-1418");
    });
});

describe("ArtifactPane — empty state", () => {
    test("renders no-artifact copy when artifact is undefined", async () => {
        const html = await render(
            <ArtifactPane phase="spec" targetId="t" artifact={undefined} />,
        );
        expect(html).toContain("No artifact available for this phase");
    });
});

describe("ArtifactPane — diff format", () => {
    test("classifies + / - / @@ lines correctly", async () => {
        const a: RequestArtifact = {
            phase: "code",
            format: "diff",
            content: "@@ -1 +1 @@\n-foo\n+bar\n unchanged",
        };
        const html = await render(
            <ArtifactPane phase="code" targetId="t" artifact={a} />,
        );
        expect(html).toContain('class="diff-hunk"');
        expect(html).toContain('class="diff-add"');
        expect(html).toContain('class="diff-del"');
        // unchanged line should NOT carry a class.
        expect(html).toMatch(/<span> unchanged<\/span>/);
    });

    test("escapes <script> in diff content (XSS)", async () => {
        const a: RequestArtifact = {
            phase: "code",
            format: "diff",
            content: "+<script>alert(1)</script>",
        };
        const html = await render(
            <ArtifactPane phase="code" targetId="t" artifact={a} />,
        );
        expect(html).toContain("&lt;script&gt;");
        expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
    });
});

describe("ArtifactPane — markdown format", () => {
    test("renders markdown into prose container", async () => {
        const a: RequestArtifact = {
            phase: "prd",
            format: "markdown",
            content: "# Title\n\nbody",
        };
        const html = await render(
            <ArtifactPane phase="prd" targetId="t" artifact={a} />,
        );
        expect(html).toContain('class="artifact-prose"');
        expect(html).toContain("<h1>Title</h1>");
        expect(html).toContain("<p>body</p>");
    });

    test("escapes <script> inside fenced code (trust boundary)", async () => {
        const a: RequestArtifact = {
            phase: "prd",
            format: "markdown",
            content: "```\n<script>alert(1)</script>\n```",
        };
        const html = await render(
            <ArtifactPane phase="prd" targetId="t" artifact={a} />,
        );
        expect(html).toContain("&lt;script&gt;");
    });
});

describe("ArtifactPane — text format", () => {
    test("renders plain pre with content", async () => {
        const a: RequestArtifact = {
            phase: "observe",
            format: "text",
            content: "raw <stuff>",
        };
        const html = await render(
            <ArtifactPane phase="observe" targetId="t" artifact={a} />,
        );
        expect(html).toContain('<pre class="artifact-pre">');
        // Hono's JSX runtime escapes text children, so <stuff> appears safe.
        expect(html).toContain("&lt;stuff&gt;");
    });
});
