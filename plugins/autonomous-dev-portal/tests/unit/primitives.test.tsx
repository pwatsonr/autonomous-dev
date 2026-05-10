// PLAN-035-2 — Primitive components unit tests.
//
// Covers:
//   - SPEC-035-2-02 §Btn       (kind/size/disabled + HTMX pass-through)
//   - SPEC-035-2-03 §Chip/Dot  (status/phase variants, live state)
//   - SPEC-035-2-04 §Score/CostRing (threshold colors, arc math)
//   - SPEC-035-2-05 §Card      (leftBar, padding, no-shadow)
//
// Each test renders the component via Hono's JSX runtime and asserts the
// HTML string against the spec's documented examples.

import { describe, expect, test } from "bun:test";

import {
    Btn,
    Card,
    Chip,
    CostRing,
    Dot,
    Score,
} from "../../server/components/primitives";

/** Resolve a Hono JSX node to a plain HTML string. */
async function render(node: unknown): Promise<string> {
    const v = await Promise.resolve(node);
    return typeof v === "string" ? v : String(v);
}

// ---------------------------------------------------------------------------
// Btn — SPEC-035-2-02
// ---------------------------------------------------------------------------

describe("Btn — SPEC-035-2-02", () => {
    test("default renders class=\"btn\" with no kind suffix", async () => {
        const html = await render(<Btn />);
        expect(html).toMatch(/<button[^>]*\sclass=["']btn["']/);
    });

    test("kind=\"primary\" appends primary to class", async () => {
        const html = await render(<Btn kind="primary">Approve</Btn>);
        expect(html).toContain('class="btn primary"');
        expect(html).toContain("Approve");
    });

    test("kind=\"ghost\" appends ghost to class", async () => {
        const html = await render(<Btn kind="ghost">Cancel</Btn>);
        expect(html).toContain('class="btn ghost"');
    });

    test("kind=\"destructive\" appends destructive to class", async () => {
        const html = await render(
            <Btn kind="destructive">Engage kill switch</Btn>,
        );
        expect(html).toContain('class="btn destructive"');
        expect(html).toContain("Engage kill switch");
    });

    test("kind=\"secondary\" suppresses the kind suffix", async () => {
        const html = await render(<Btn kind="secondary">Save</Btn>);
        expect(html).toContain('class="btn"');
        expect(html).not.toContain("secondary");
    });

    test("size=\"sm\" appends sm to class", async () => {
        const html = await render(<Btn kind="ghost" size="sm">Cancel</Btn>);
        expect(html).toContain('class="btn ghost sm"');
    });

    test("size=\"md\" does NOT append md to class", async () => {
        const html = await render(<Btn size="md" />);
        expect(html).toContain('class="btn"');
        expect(html).not.toMatch(/\bmd\b/);
    });

    test("disabled renders the disabled attribute", async () => {
        const html = await render(
            <Btn kind="destructive" disabled>
                Engage kill switch
            </Btn>,
        );
        expect(html).toMatch(/<button[^>]*\sdisabled(=|\s|>)/);
    });

    test("disabled=false (default) does NOT render disabled attribute", async () => {
        const html = await render(<Btn kind="primary">Save</Btn>);
        expect(html).not.toMatch(/<button[^>]*\sdisabled(=|\s|>)/);
    });

    test("HTMX pass-through forwards hx-* attributes", async () => {
        const html = await render(
            <Btn kind="primary" hx-post="/foo" hx-target="#out">
                Save
            </Btn>,
        );
        expect(html).toContain('hx-post="/foo"');
        expect(html).toContain('hx-target="#out"');
        expect(html).toContain('class="btn primary"');
    });

    test("destructured props (kind/size/disabled) do NOT leak to DOM", async () => {
        const html = await render(
            <Btn kind="primary" size="sm" disabled>
                X
            </Btn>,
        );
        // The `kind` and `size` props must not appear as DOM attributes.
        expect(html).not.toMatch(/<button[^>]*\skind=/);
        expect(html).not.toMatch(/<button[^>]*\ssize=/);
        // `disabled` IS a real DOM attribute and should be present.
        expect(html).toMatch(/<button[^>]*\sdisabled(=|\s|>)/);
    });
});

// ---------------------------------------------------------------------------
// Chip — SPEC-035-2-03
// ---------------------------------------------------------------------------

describe("Chip — SPEC-035-2-03", () => {
    test("status variant with tone=\"ok\" renders class=\"chip ok\"", async () => {
        const html = await render(
            <Chip variant="status" tone="ok">RUNNING</Chip>,
        );
        expect(html).toContain('class="chip ok"');
        expect(html).toContain("RUNNING");
    });

    test("status variant with tone=\"err\" renders class=\"chip err\"", async () => {
        const html = await render(
            <Chip variant="status" tone="err">TRIPPED</Chip>,
        );
        expect(html).toContain('class="chip err"');
        expect(html).toContain("TRIPPED");
    });

    test("status variant with no tone renders trimmed class=\"chip\"", async () => {
        const html = await render(<Chip variant="status">PLAIN</Chip>);
        expect(html).toContain('class="chip"');
        expect(html).toContain("PLAIN");
    });

    test("phase variant with tone=\"code\" renders chip-phase code + uppercase text", async () => {
        const html = await render(<Chip variant="phase" tone="code" />);
        expect(html).toContain('class="chip-phase code"');
        expect(html).toContain(">CODE<");
    });

    test("phase variant with tone=\"prd\" uppercases the phase name", async () => {
        const html = await render(<Chip variant="phase" tone="prd" />);
        expect(html).toContain('class="chip-phase prd"');
        expect(html).toContain(">PRD<");
    });

    test("phase variant ignores children — label is the uppercased phase", async () => {
        const html = await render(
            <Chip variant="phase" tone="code">override</Chip>,
        );
        expect(html).toContain(">CODE<");
        expect(html).not.toContain("override");
    });

    test("phase variant without tone falls through to status branch", async () => {
        const html = await render(<Chip variant="phase" />);
        // No tone -> rendered as plain `<span class="chip">` (defensive).
        expect(html).toContain('class="chip"');
    });
});

// ---------------------------------------------------------------------------
// Dot — SPEC-035-2-03
// ---------------------------------------------------------------------------

describe("Dot — SPEC-035-2-03", () => {
    test("default renders class=\"dot muted\"", async () => {
        const html = await render(<Dot />);
        expect(html).toContain('class="dot muted"');
    });

    test("tone=\"ok\" renders class=\"dot ok\"", async () => {
        const html = await render(<Dot tone="ok" />);
        expect(html).toContain('class="dot ok"');
    });

    test("tone=\"err\" renders class=\"dot err\"", async () => {
        const html = await render(<Dot tone="err" />);
        expect(html).toContain('class="dot err"');
    });

    test("live renders class=\"dot live\"", async () => {
        const html = await render(<Dot live />);
        expect(html).toContain('class="dot live"');
    });

    test("live wins over tone (live=true + tone=\"ok\" -> dot live)", async () => {
        const html = await render(<Dot live tone="ok" />);
        expect(html).toContain('class="dot live"');
        expect(html).not.toContain('class="dot live ok"');
        expect(html).not.toContain('class="dot ok"');
    });
});

// ---------------------------------------------------------------------------
// Score — SPEC-035-2-04
// ---------------------------------------------------------------------------

describe("Score — SPEC-035-2-04", () => {
    test("value=88, threshold=85 -> ok color", async () => {
        const html = await render(<Score value={88} threshold={85} />);
        expect(html).toContain("background: var(--ok)");
        expect(html).toContain("width: 88%");
    });

    test("value=85 (boundary, default threshold) -> ok color", async () => {
        const html = await render(<Score value={85} />);
        expect(html).toContain("background: var(--ok)");
    });

    test("value=70 (within 80% of 85) -> warn color", async () => {
        const html = await render(<Score value={70} threshold={85} />);
        expect(html).toContain("background: var(--warn)");
    });

    test("value=68 (= 85*0.8 boundary) -> warn color", async () => {
        const html = await render(<Score value={68} threshold={85} />);
        expect(html).toContain("background: var(--warn)");
    });

    test("value=50 (below warn band) -> err color", async () => {
        const html = await render(<Score value={50} threshold={85} />);
        expect(html).toContain("background: var(--err)");
    });

    test("value=100 -> width 100%", async () => {
        const html = await render(<Score value={100} />);
        expect(html).toContain("width: 100%");
        expect(html).toContain("background: var(--ok)");
    });

    test("value=0 -> width 0% and err color", async () => {
        const html = await render(<Score value={0} />);
        expect(html).toContain("width: 0%");
        expect(html).toContain("background: var(--err)");
    });

    test("renders score-num span with the integer value", async () => {
        const html = await render(<Score value={88} />);
        expect(html).toMatch(
            /<span class=["']score-num meta-mono["']>88<\/span>/,
        );
    });

    test("label renders score-label span", async () => {
        const html = await render(<Score value={88} label="PRD" />);
        expect(html).toContain('<span class="score-label">PRD</span>');
    });

    test("no label -> no score-label element", async () => {
        const html = await render(<Score value={88} />);
        expect(html).not.toContain("score-label");
    });

    test("renders score-track and score-fill wrapper", async () => {
        const html = await render(<Score value={50} />);
        expect(html).toContain('class="score-track"');
        expect(html).toContain('class="score-fill"');
        expect(html).toContain('class="score-inline"');
    });
});

// ---------------------------------------------------------------------------
// CostRing — SPEC-035-2-04
// ---------------------------------------------------------------------------

describe("CostRing — SPEC-035-2-04", () => {
    test("spent=80, cap=100 -> aria-label 80%, warn color", async () => {
        const html = await render(<CostRing spent={80} cap={100} />);
        expect(html).toContain('aria-label="Cost: 80%"');
        expect(html).toContain('stroke="var(--warn)"');
    });

    test("spent=79, cap=100 -> brand color (below 80% threshold)", async () => {
        const html = await render(<CostRing spent={79} cap={100} />);
        expect(html).toContain('aria-label="Cost: 79%"');
        expect(html).toContain('stroke="var(--brand)"');
    });

    test("spent=200, cap=100 -> clamped to 100%", async () => {
        const html = await render(<CostRing spent={200} cap={100} />);
        expect(html).toContain('aria-label="Cost: 100%"');
        // pct=100 -> offset = 0
        expect(html).toContain('stroke-dashoffset="0.0"');
    });

    test("cap=0 -> 0% with no NaN in stroke-dashoffset", async () => {
        const html = await render(<CostRing spent={50} cap={0} />);
        expect(html).toContain('aria-label="Cost: 0%"');
        expect(html).not.toContain("NaN");
        // pct=0 -> offset = circumference
        const circumference = (2 * Math.PI * 34).toFixed(1);
        expect(html).toContain(`stroke-dashoffset="${circumference}"`);
    });

    test("spent=50, cap=100 -> offset is half of circumference", async () => {
        const html = await render(<CostRing spent={50} cap={100} />);
        const circumference = 2 * Math.PI * 34;
        const expectedOffset = (circumference - circumference * 0.5).toFixed(1);
        expect(html).toContain(`stroke-dashoffset="${expectedOffset}"`);
        // dasharray is the full circumference.
        expect(html).toContain(`stroke-dasharray="${circumference.toFixed(1)}"`);
    });

    test("label=\"TODAY\" renders second text element", async () => {
        const html = await render(
            <CostRing spent={50} cap={100} label="TODAY" />,
        );
        // aria-label uses the custom label.
        expect(html).toContain('aria-label="TODAY: 50%"');
        // Second <text> element holds the label.
        const texts = [...html.matchAll(/<text[\s\S]*?<\/text>/g)];
        expect(texts.length).toBe(2);
        expect(texts[1]![0]).toContain("TODAY");
    });

    test("no label -> aria-label uses \"Cost\" default and only one text element", async () => {
        const html = await render(<CostRing spent={50} cap={100} />);
        expect(html).toContain('aria-label="Cost: 50%"');
        const texts = [...html.matchAll(/<text[\s\S]*?<\/text>/g)];
        expect(texts.length).toBe(1);
    });

    test("renders SVG root with class=\"ring\" 80x80", async () => {
        const html = await render(<CostRing spent={50} cap={100} />);
        expect(html).toMatch(/<svg[^>]*class=["']ring["']/);
        expect(html).toMatch(/<svg[^>]*viewBox=["']0 0 80 80["']/);
        expect(html).toMatch(/<svg[^>]*width=["']80["']/);
        expect(html).toMatch(/<svg[^>]*height=["']80["']/);
    });
});

// ---------------------------------------------------------------------------
// Card — SPEC-035-2-05
// ---------------------------------------------------------------------------

describe("Card — SPEC-035-2-05", () => {
    test("default renders class=\"card\" with padding 16px and no border-left", async () => {
        const html = await render(<Card>body</Card>);
        expect(html).toContain('class="card"');
        expect(html).toContain("padding: 16px");
        expect(html).not.toContain("border-left");
        expect(html).toContain("body");
    });

    test("padding=\"sm\" renders padding 12px", async () => {
        const html = await render(<Card padding="sm">x</Card>);
        expect(html).toContain("padding: 12px");
    });

    test("padding=\"lg\" renders padding 24px", async () => {
        const html = await render(<Card padding="lg">x</Card>);
        expect(html).toContain("padding: 24px");
    });

    test("leftBar=\"code\" renders 4px border-left in phase-code", async () => {
        const html = await render(<Card leftBar="code">x</Card>);
        expect(html).toContain(
            "border-left: 4px solid var(--phase-code)",
        );
        expect(html).toContain("padding: 16px");
    });

    test("leftBar=\"prd\" references var(--phase-prd)", async () => {
        const html = await render(<Card leftBar="prd">x</Card>);
        expect(html).toContain("var(--phase-prd)");
    });

    test("leftBar + padding=\"lg\" combines both inline styles", async () => {
        const html = await render(
            <Card leftBar="code" padding="lg">x</Card>,
        );
        expect(html).toContain(
            "border-left: 4px solid var(--phase-code)",
        );
        expect(html).toContain("padding: 24px");
    });

    test("renders no box-shadow declaration (R-15a)", async () => {
        const html = await render(<Card leftBar="code">x</Card>);
        expect(html).not.toContain("box-shadow");
    });

    test("renders children verbatim inside the card div", async () => {
        const html = await render(
            <Card>
                <p class="probe">card-child-marker</p>
            </Card>,
        );
        expect(html).toContain("card-child-marker");
        expect(html).toContain('class="probe"');
    });

    test("all eight phase tokens are accepted by leftBar", async () => {
        const phases = [
            "prd",
            "tdd",
            "plan",
            "spec",
            "code",
            "review",
            "deploy",
            "observe",
        ] as const;
        for (const phase of phases) {
            const html = await render(<Card leftBar={phase}>x</Card>);
            expect(html).toContain(`var(--phase-${phase})`);
        }
    });
});
