// SPEC-036-1-03 §RepoCard — unit tests.
//
// Asserts the 6-region structure, Card primitive consumption (left
// bar / warn-line treatment), Chip primitive consumption (phase /
// variant / backend / stack), and PRD-018 R-22 cost format.

import { describe, expect, test } from "bun:test";

import {
    RepoCard,
    RepoCardGrid,
} from "../../server/templates/fragments/repo-card";
import type { RepoSummary } from "../../server/types/render";

async function render(node: unknown): Promise<string> {
    const v = await Promise.resolve(node);
    return typeof v === "string" ? v : String(v);
}

const baseRepo: RepoSummary = {
    repo: "acme",
    activeRequests: 2,
    lastActivity: "14",
    monthlyCostUsd: 12.34,
    attentionCount: 0,
    trust: "L1",
    phase: "code",
    variant: "fast-track",
    variantLabel: "Fast track",
    backend: "node",
    stack: "hono",
    gateCount: 0,
    attn: false,
};

describe("RepoCard — SPEC-036-1-03 (updated by SPEC-037-6-01)", () => {
    test("SPEC-037-6-01 AC: outer element is <button class=\"repo-card\"> (no <Card> wrapper)", async () => {
        const html = await render(<RepoCard {...baseRepo} />);
        // Single-element outer wrapper: <button> carries the class.
        expect(html).toMatch(/^<button [^>]*class="repo-card/);
        // No double-wrapper: the legacy <div class="card"> ... <div class="repo-card"> shape is gone.
        expect(html).not.toContain('class="card"');
    });

    test("AC #1: renders the 6 regions in kit class names in DOM order", async () => {
        const html = await render(<RepoCard {...baseRepo} />);
        // repo-top first, then repo-path, then two repo-meta-row, then repo-foot
        const idxTop = html.indexOf("repo-top");
        const idxPath = html.indexOf("repo-path");
        const idxMeta1 = html.indexOf("repo-meta-row");
        const idxMeta2 = html.indexOf("repo-meta-row", idxMeta1 + 1);
        const idxFoot = html.indexOf("repo-foot");
        expect(idxTop).toBeGreaterThan(-1);
        expect(idxTop).toBeLessThan(idxPath);
        expect(idxPath).toBeLessThan(idxMeta1);
        expect(idxMeta1).toBeLessThan(idxMeta2);
        expect(idxMeta2).toBeLessThan(idxFoot);
    });

    test("AC #1.1: top row carries repo name and trust under kit class names", async () => {
        const html = await render(<RepoCard {...baseRepo} />);
        expect(html).toContain('<span class="repo-id">acme</span>');
        expect(html).toContain('<span class="repo-trust meta-mono">L1</span>');
    });

    test("AC #6: trust badge omitted when undefined", async () => {
        const html = await render(
            <RepoCard {...baseRepo} trust={undefined} />,
        );
        expect(html).not.toContain("repo-trust");
    });

    test("AC #1.2: path row uses ~/projects/{repo}", async () => {
        const html = await render(<RepoCard {...baseRepo} />);
        expect(html).toContain("~/projects/acme");
    });

    test("AC #3: phase chip uppercase via Chip variant=\"phase\"", async () => {
        const html = await render(<RepoCard {...baseRepo} phase="code" />);
        expect(html).toContain('<span class="chip-phase code">CODE</span>');
    });

    test("AC #1.6: phase left bar emitted inline on the <button class=\"repo-card\">", async () => {
        const html = await render(<RepoCard {...baseRepo} phase="code" />);
        expect(html).toContain("border-left: 4px solid var(--phase-code)");
    });

    test("AC #2: attn=true suppresses phase left bar and adds .attn class", async () => {
        const html = await render(
            <RepoCard {...baseRepo} attn={true} phase="code" />,
        );
        expect(html).toContain('class="repo-card attn"');
        expect(html).not.toContain("border-left: 4px solid var(--phase-");
    });

    test("AC #1.5: gateCount > 0 renders 'need approval' warn chip", async () => {
        const html = await render(
            <RepoCard {...baseRepo} gateCount={2} />,
        );
        expect(html).toMatch(/chip warn[^>]*>2 need approval/);
    });

    test("AC #1.5: gateCount === 0 renders last-activity span", async () => {
        const html = await render(
            <RepoCard {...baseRepo} gateCount={0} lastActivity="7" />,
        );
        expect(html).toContain("last 7m ago");
        expect(html).not.toContain("need approval");
    });

    test("AC #7: cost format matches /^\\$\\d+\\.\\d{2} MTD$/", async () => {
        const html = await render(<RepoCard {...baseRepo} />);
        const match = html.match(/(\$\d+\.\d{2} MTD)/);
        expect(match).not.toBeNull();
        expect(match![1]).toMatch(/^\$\d+\.\d{2} MTD$/);
    });

    test("AC #3: variant rendered via Chip with variantLabel (sentence case)", async () => {
        const html = await render(
            <RepoCard {...baseRepo} variantLabel="Fast track" />,
        );
        expect(html).toContain("Fast track");
    });

    test("AC #3: backend chip uses info tone, stack chip uses muted tone", async () => {
        const html = await render(<RepoCard {...baseRepo} />);
        expect(html).toMatch(/chip info[^>]*>node/);
        expect(html).toMatch(/chip muted[^>]*>hono/);
    });
});

describe("RepoCardGrid — SPEC-036-1-03", () => {
    test("AC #4: grid container has id=\"repo-grid\" class=\"repo-grid\"", async () => {
        const html = await render(<RepoCardGrid repos={[baseRepo]} />);
        expect(html).toContain('<div id="repo-grid" class="repo-grid">');
    });

    test("AC #5: empty repos -> empty grid container (parent supplies EmptyState)", async () => {
        const html = await render(<RepoCardGrid repos={[]} />);
        expect(html).toContain('id="repo-grid"');
        expect(html).not.toContain("repo-card");
    });
});
