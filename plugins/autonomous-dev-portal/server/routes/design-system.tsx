// SPEC-035-4-01 / SPEC-035-4-02 — `/design-system` route + 20 section bodies.
//
// The portal's living design system surface. Renders every primitive that
// ships in `server/components/primitives.tsx` plus token specimens, on a
// single sticky-TOC page that doubles as the canonical visual-regression
// fixture (SPEC-035-4-03).
//
// Compositional rules (per TDD-035 §6.8 / PRD-018 R-21 / R-08):
//   - Each section is a Hono JSX function returning the *inner* content
//     of its `<section id="preview-NN" class="ds-card">` wrapper (the
//     wrapper is rendered once by `DesignSystemPage`).
//   - Visible elements flow through portal primitives (`Btn`, `Chip`,
//     `Dot`, `Score`, `CostRing`, `Card`) or pure token CSS — never raw
//     copied HTML — so visual regression catches drift in the actual
//     component code.
//   - Token-only sections (01, 02, 03, 04, 07) reference `var(--*)` only;
//     no hex literals (SPEC-035-4-02 AC-2).
//   - No `dangerouslySetInnerHTML` anywhere in the view tree (FR-S34).
//
// CSS contract:
//   - `.ds-card` / `.ds-toc` / `.ds-row` / `.ds-grid` / `.ds-swatch` /
//     `.ds-swatch-grid` are added inline to the page via the shared
//     `<style>` block at the top of the body. Keeping them inline (a)
//     scopes them to this surface and (b) means the visual-regression
//     gate covers the styling without requiring a portal.css edit.
//   - All borders and radii reference `var(--line-1)` / 3px per R-15a.
//     No `box-shadow` outside `var(--shadow-*)` references.

import type { Context } from "hono";
import type { FC } from "hono/jsx";
import { getCookie } from "hono/cookie";

import { BrandWordmark } from "../components/brand-wordmark";
import { KillSwitch } from "../components/kill-switch";
import {
    Btn,
    Card,
    Chip,
    CostRing,
    Dot,
    Score,
} from "../components/primitives";
import type { PhaseName } from "../components/primitives";
import { ShellLayout } from "../components/shell";

// ---------------------------------------------------------------------------
// Per-section renderers (1..20). Each returns inner content only.
// ---------------------------------------------------------------------------

const Section01: FC = () => (
    <>
        <h2>Type display</h2>
        <div class="ds-stack">
            <div style="font-family: var(--font-sans); font-size: var(--t-display); line-height: var(--lh-tight);">
                Display 28px Inter
            </div>
            <div style="font-family: var(--font-sans); font-size: var(--t-h1); line-height: var(--lh-tight);">
                H1 20px Inter
            </div>
            <div style="font-family: var(--font-sans); font-size: var(--t-h2); line-height: var(--lh-normal);">
                H2 15px Inter
            </div>
            <div style="font-family: var(--font-sans); font-size: var(--t-h3); line-height: var(--lh-normal);">
                H3 13px Inter
            </div>
            <div style="font-family: var(--font-mono); font-size: var(--t-mono-meta); line-height: var(--lh-normal);">
                mono 12px JetBrains Mono
            </div>
            <div style="font-family: var(--font-sans); font-size: var(--t-tiny); line-height: var(--lh-normal);">
                tiny 11px Inter
            </div>
        </div>
    </>
);

const Section02: FC = () => (
    <>
        <h2>Type body</h2>
        <p style="font-family: var(--font-sans); font-size: var(--t-body); line-height: var(--lh-loose); color: var(--fg-1);">
            Body copy renders at 14px Inter with the loose 1.6 leading
            recommended for paragraphs. Numerals like{" "}
            <span style="font-family: var(--font-mono);">123.45</span> and
            currency such as{" "}
            <span style="font-family: var(--font-mono);">$1,843.20</span> use
            the mono face so columns align.
        </p>
        <div style="font-family: var(--font-mono); font-size: var(--t-mono-body); color: var(--fg-2);">
            req-7f3a2b1c
        </div>
    </>
);

const NEUTRAL_TOKENS = [
    "bg-0",
    "bg-1",
    "bg-2",
    "line-1",
    "line-2",
    "fg-0",
    "fg-1",
    "fg-2",
    "fg-3",
] as const;

const Section03: FC = () => (
    <>
        <h2>Colors neutrals</h2>
        <div class="ds-swatch-grid">
            {NEUTRAL_TOKENS.map((token) => (
                <div class="ds-swatch">
                    <div
                        class="ds-swatch-chip"
                        style={`background: var(--${token}); border-color: var(--line-1);`}
                    ></div>
                    <div class="ds-swatch-label">--{token}</div>
                </div>
            ))}
        </div>
    </>
);

const BRAND_TOKENS = ["brand", "brand-tint", "brand-line"] as const;

const Section04: FC = () => (
    <>
        <h2>Colors brand</h2>
        <div class="ds-swatch-grid">
            {BRAND_TOKENS.map((token) => (
                <div class="ds-swatch">
                    <div
                        class="ds-swatch-chip"
                        style={`background: var(--${token}); border-color: var(--line-1);`}
                    ></div>
                    <div class="ds-swatch-label">--{token}</div>
                </div>
            ))}
        </div>
    </>
);

const STATUS_TONES = ["ok", "warn", "err", "info", "muted"] as const;

const Section05: FC = () => (
    <>
        <h2>Colors semantic</h2>
        <div class="ds-row">
            {STATUS_TONES.map((t) => (
                <Chip variant="status" tone={t}>
                    {t.toUpperCase()}
                </Chip>
            ))}
        </div>
    </>
);

const PHASE_ORDER: PhaseName[] = [
    "prd",
    "tdd",
    "plan",
    "spec",
    "code",
    "review",
    "deploy",
    "observe",
];

const Section06: FC = () => (
    <>
        <h2>Colors phases</h2>
        <div class="ds-row">
            {PHASE_ORDER.map((p) => (
                <Chip variant="phase" tone={p} />
            ))}
        </div>
    </>
);

const SPACING_TOKENS = ["s-1", "s-2", "s-3", "s-4", "s-5", "s-6"] as const;
const RADIUS_TOKENS = ["r-1", "r-2", "r-3"] as const;

const Section07: FC = () => (
    <>
        <h2>Spacing and radii</h2>
        <div class="ds-row" style="align-items: flex-end;">
            {SPACING_TOKENS.map((t) => (
                <div class="ds-stack" style="align-items: center;">
                    <div
                        style={`width: var(--${t}); height: var(--${t}); background: var(--brand);`}
                    ></div>
                    <div
                        style="font-family: var(--font-mono); font-size: var(--t-tiny); color: var(--fg-2);"
                    >
                        --{t}
                    </div>
                </div>
            ))}
        </div>
        <div class="ds-row" style="margin-top: var(--s-4);">
            {RADIUS_TOKENS.map((t) => (
                <div class="ds-stack" style="align-items: center;">
                    <div
                        style={`width: var(--s-8); height: var(--s-8); background: var(--bg-2); border: 1px solid var(--line-1); border-radius: var(--${t});`}
                    ></div>
                    <div
                        style="font-family: var(--font-mono); font-size: var(--t-tiny); color: var(--fg-2);"
                    >
                        --{t}
                    </div>
                </div>
            ))}
        </div>
    </>
);

const Section08: FC = () => (
    <>
        <h2>Elevation</h2>
        <div class="ds-row">
            <Card padding="md">
                <div style="font-family: var(--font-sans); font-size: var(--t-h2);">
                    Hairline only
                </div>
                <div style="font-family: var(--font-sans); font-size: var(--t-meta); color: var(--fg-2);">
                    1px border, no shadow.
                </div>
            </Card>
            {/* R-15a permits `var(--shadow-pop)` references; the surface
                under test is the primitive's class, not a literal shadow. */}
            <div style="box-shadow: var(--shadow-pop);">
                <Card padding="md">
                    <div style="font-family: var(--font-sans); font-size: var(--t-h2);">
                        Shadow pop
                    </div>
                    <div style="font-family: var(--font-sans); font-size: var(--t-meta); color: var(--fg-2);">
                        var(--shadow-pop) outer wrapper.
                    </div>
                </Card>
            </div>
        </div>
    </>
);

const Section09: FC = () => (
    <>
        <h2>Buttons</h2>
        <div class="ds-row">
            <Btn kind="primary">Primary</Btn>
            <Btn kind="secondary">Secondary</Btn>
            <Btn kind="ghost">Ghost</Btn>
            <Btn kind="destructive">Destructive</Btn>
        </div>
        <div class="ds-row" style="margin-top: var(--s-3);">
            <Btn kind="primary" size="sm">
                Primary sm
            </Btn>
            <Btn kind="secondary" size="sm">
                Secondary sm
            </Btn>
            <Btn kind="ghost" size="sm">
                Ghost sm
            </Btn>
            <Btn kind="destructive" size="sm">
                Destructive sm
            </Btn>
        </div>
    </>
);

const Section10: FC = () => (
    <>
        <h2>Status chips</h2>
        <div class="ds-row">
            <Chip variant="status" tone="ok">
                OK
            </Chip>
            <Chip variant="status" tone="warn">
                WARN
            </Chip>
            <Chip variant="status" tone="err">
                ERR
            </Chip>
            <Chip variant="status" tone="info">
                INFO
            </Chip>
            <Chip variant="status" tone="muted">
                MUTED
            </Chip>
            <Chip variant="status" tone="brand">
                BRAND
            </Chip>
        </div>
    </>
);

const Section11: FC = () => (
    <>
        <h2>Phase chips</h2>
        <div class="ds-row">
            {PHASE_ORDER.map((p) => (
                <Chip variant="phase" tone={p} />
            ))}
        </div>
    </>
);

const Section12: FC = () => (
    <>
        <h2>Dots</h2>
        <div class="ds-row" style="align-items: center;">
            <Dot tone="ok" />
            <Dot tone="warn" />
            <Dot tone="err" />
            <Dot tone="info" />
            <Dot tone="muted" />
            <span style="display: inline-flex; align-items: center; gap: var(--s-2);">
                <Dot tone="ok" live />
                <span style="font-family: var(--font-mono); font-size: var(--t-tiny); color: var(--fg-2);">
                    live
                </span>
            </span>
        </div>
    </>
);

const Section13: FC = () => (
    <>
        <h2>Scores</h2>
        <div class="ds-stack">
            <Score value={92} />
            <Score value={70} />
            <Score value={45} />
        </div>
    </>
);

const Section14: FC = () => (
    <>
        <h2>Cost ring</h2>
        <div class="ds-row">
            <CostRing spent={18} cap={120} label="TODAY" />
            <CostRing spent={1843} cap={2500} label="MONTH" />
        </div>
    </>
);

const Section15: FC = () => (
    <>
        <h2>Inputs</h2>
        <div class="ds-stack" style="max-width: 320px;">
            <input
                type="text"
                class="input"
                placeholder="Text input"
                value="Text input"
            />
            <select class="input">
                <option>Select option A</option>
                <option>Select option B</option>
            </select>
            <input
                type="text"
                class="input err"
                placeholder="Error state"
                value="invalid value"
                aria-invalid="true"
            />
            <input
                type="text"
                class="input mono"
                placeholder="mono input"
                value="req-7f3a2b1c"
            />
        </div>
    </>
);

const Section16: FC = () => (
    <>
        <h2>Repo card</h2>
        <div class="ds-row">
            <Card leftBar="code" padding="md">
                <div
                    style="display: flex; align-items: center; gap: var(--s-3);"
                >
                    <span
                        style="font-family: var(--font-mono); font-size: var(--t-h3); color: var(--fg-0);"
                    >
                        autonomous-dev
                    </span>
                    <Chip variant="phase" tone="code" />
                    <Dot tone="ok" live />
                </div>
                <div style="margin-top: var(--s-2);">
                    <Score value={88} />
                </div>
            </Card>
            <Card leftBar="review" padding="md">
                <div
                    style="display: flex; align-items: center; gap: var(--s-3);"
                >
                    <span
                        style="font-family: var(--font-mono); font-size: var(--t-h3); color: var(--fg-0);"
                    >
                        portal-frontend
                    </span>
                    <Chip variant="phase" tone="review" />
                    <Chip variant="status" tone="warn">
                        ATTENTION
                    </Chip>
                </div>
                <div style="margin-top: var(--s-2);">
                    <Score value={62} />
                </div>
            </Card>
        </div>
    </>
);

const Section17: FC = () => (
    <>
        <h2>Kill switch</h2>
        <div class="ds-row">
            <KillSwitch engaged={false} onConfirm="/ops/kill-switch" />
            <KillSwitch engaged={true} onConfirm="/ops/kill-switch" />
        </div>
    </>
);

const Section18: FC = () => (
    <>
        <h2>Cost panel</h2>
        <Card padding="lg">
            <div
                style="display: flex; align-items: center; gap: var(--s-5);"
            >
                <CostRing spent={1843} cap={2500} label="MONTH" />
                <table class="tbl" style="border-collapse: collapse;">
                    <thead>
                        <tr>
                            <th
                                style="text-align: left; padding: var(--s-1) var(--s-3); font-size: var(--t-tiny); color: var(--fg-2);"
                            >
                                Phase
                            </th>
                            <th
                                style="text-align: right; padding: var(--s-1) var(--s-3); font-size: var(--t-tiny); color: var(--fg-2);"
                            >
                                Spent
                            </th>
                            <th
                                style="text-align: right; padding: var(--s-1) var(--s-3); font-size: var(--t-tiny); color: var(--fg-2);"
                            >
                                Cap
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {[
                            ["prd", 320, 500],
                            ["tdd", 412, 500],
                            ["plan", 198, 300],
                            ["spec", 245, 400],
                            ["code", 488, 600],
                            ["review", 180, 200],
                        ].map(([p, spent, cap]) => (
                            <tr>
                                <td
                                    style="padding: var(--s-1) var(--s-3);"
                                >
                                    <Chip
                                        variant="phase"
                                        tone={p as PhaseName}
                                    />
                                </td>
                                <td
                                    style="padding: var(--s-1) var(--s-3); text-align: right; font-family: var(--font-mono); font-size: var(--t-mono-meta);"
                                >
                                    ${spent}
                                </td>
                                <td
                                    style="padding: var(--s-1) var(--s-3); text-align: right; font-family: var(--font-mono); font-size: var(--t-mono-meta); color: var(--fg-2);"
                                >
                                    ${cap}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </Card>
    </>
);

const Section19: FC = () => {
    const ACTIVE_PHASE: PhaseName = "code";
    return (
        <>
            <h2>Timeline</h2>
            <div class="ds-stack">
                {PHASE_ORDER.map((p) => (
                    <div
                        style="display: flex; align-items: center; gap: var(--s-3);"
                    >
                        {p === ACTIVE_PHASE ? (
                            <Dot tone="ok" live />
                        ) : (
                            <Dot tone="ok" />
                        )}
                        <Chip variant="phase" tone={p} />
                        <span
                            style="font-family: var(--font-sans); font-size: var(--t-meta); color: var(--fg-1);"
                        >
                            {p === ACTIVE_PHASE
                                ? `${p} (active)`
                                : `${p} complete`}
                        </span>
                    </div>
                ))}
            </div>
        </>
    );
};

const Section20: FC = () => (
    <>
        <h2>Brand wordmark</h2>
        <div class="ds-stack">
            <div style="background: var(--bg-0); padding: var(--s-3);">
                <BrandWordmark showBrackets={true} theme="light" />
            </div>
            <div
                data-theme="dark"
                style="background: var(--bg-0); padding: var(--s-3); color: var(--fg-0);"
            >
                <BrandWordmark showBrackets={true} theme="dark" />
            </div>
        </div>
    </>
);

// ---------------------------------------------------------------------------
// Section registry — id, label, renderer.
// Order is the canonical TOC order (SPEC-035-4-01 AC-3).
// ---------------------------------------------------------------------------

interface SectionEntry {
    n: number;
    label: string;
    Component: FC;
}

const SECTIONS: SectionEntry[] = [
    { n: 1, label: "Type display", Component: Section01 },
    { n: 2, label: "Type body", Component: Section02 },
    { n: 3, label: "Colors neutrals", Component: Section03 },
    { n: 4, label: "Colors brand", Component: Section04 },
    { n: 5, label: "Colors semantic", Component: Section05 },
    { n: 6, label: "Colors phases", Component: Section06 },
    { n: 7, label: "Spacing and radii", Component: Section07 },
    { n: 8, label: "Elevation", Component: Section08 },
    { n: 9, label: "Buttons", Component: Section09 },
    { n: 10, label: "Status chips", Component: Section10 },
    { n: 11, label: "Phase chips", Component: Section11 },
    { n: 12, label: "Dots", Component: Section12 },
    { n: 13, label: "Scores", Component: Section13 },
    { n: 14, label: "Cost ring", Component: Section14 },
    { n: 15, label: "Inputs", Component: Section15 },
    { n: 16, label: "Repo card", Component: Section16 },
    { n: 17, label: "Kill switch", Component: Section17 },
    { n: 18, label: "Cost panel", Component: Section18 },
    { n: 19, label: "Timeline", Component: Section19 },
    { n: 20, label: "Brand wordmark", Component: Section20 },
];

// ---------------------------------------------------------------------------
// Page-scoped CSS (emitted as a single <style> element). Kept inline so
// the visual-regression gate covers styling without a portal.css edit.
// All declarations reference design tokens; the only literal numeric is
// the 220px TOC width (matches shell.css's rail width convention).
// No `box-shadow:` outside `var(--shadow-*)` references (R-15a CI lint).
// ---------------------------------------------------------------------------

const DESIGN_SYSTEM_CSS = `
.ds-layout {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: var(--s-5);
  align-items: flex-start;
}
.ds-toc {
  position: sticky;
  top: var(--s-3);
  border: 1px solid var(--line-1);
  border-radius: 3px;
  padding: var(--s-3);
  background: var(--bg-1);
  font-family: var(--font-sans);
  font-size: var(--t-meta);
}
.ds-toc h2 {
  margin: 0 0 var(--s-2) 0;
  font-size: var(--t-tiny);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-2);
}
.ds-toc ol { list-style: none; margin: 0; padding: 0; }
.ds-toc li { margin: 0; }
.ds-toc a {
  display: block;
  padding: var(--s-1) 0;
  color: var(--fg-1);
  text-decoration: none;
}
.ds-toc a:hover { color: var(--brand); }
.ds-cards { display: flex; flex-direction: column; gap: var(--s-4); }
.ds-card {
  border: 1px solid var(--line-1);
  border-radius: 3px;
  padding: var(--s-3);
  background: var(--bg-1);
}
.ds-card h2 {
  margin: 0 0 var(--s-3) 0;
  font-family: var(--font-sans);
  font-size: var(--t-h2);
  color: var(--fg-0);
}
.ds-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-2);
  align-items: center;
}
.ds-stack {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  align-items: flex-start;
}
.ds-swatch-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: var(--s-3);
}
.ds-swatch {
  display: flex;
  flex-direction: column;
  gap: var(--s-1);
}
.ds-swatch-chip {
  height: var(--s-10);
  border: 1px solid var(--line-1);
  border-radius: 3px;
}
.ds-swatch-label {
  font-family: var(--font-mono);
  font-size: var(--t-tiny);
  color: var(--fg-2);
}
`;

// ---------------------------------------------------------------------------
// View component — wraps everything in ShellLayout.
// ---------------------------------------------------------------------------

interface DesignSystemPageProps {
    theme: "light" | "dark";
}

export const DesignSystemPage: FC<DesignSystemPageProps> = ({ theme }) => (
    <ShellLayout
        activePath="/design-system"
        theme={theme}
        pageTitle="Design system"
    >
        {/* SPEC-035-4-01 AC-7 — page-scoped CSS (no inline event handlers,
            no JS). Safe under the portal CSP because no `nonce` is needed
            for `<style>`. */}
        <style data-design-system="true">{DESIGN_SYSTEM_CSS}</style>
        <div class="ds-layout" data-section-count={SECTIONS.length}>
            <nav class="ds-toc" aria-label="Design system table of contents">
                <h2>Sections</h2>
                <ol>
                    {SECTIONS.map((s) => (
                        <li>
                            <a href={`#preview-${s.n}`}>
                                {String(s.n).padStart(2, "0")} · {s.label}
                            </a>
                        </li>
                    ))}
                </ol>
            </nav>
            <div class="ds-cards">
                {SECTIONS.map((s) => (
                    <section id={`preview-${s.n}`} class="ds-card">
                        <s.Component />
                    </section>
                ))}
            </div>
        </div>
    </ShellLayout>
);

// ---------------------------------------------------------------------------
// Route handler — public per OQ-035-01 RESOLVED. Reads `portal-theme`
// cookie for SSR theme parity with the rest of the portal surfaces.
// ---------------------------------------------------------------------------

export function designSystemHandler(
    c: Context,
): Response | Promise<Response> {
    const theme = getCookie(c, "portal-theme") === "dark" ? "dark" : "light";
    return c.html(<DesignSystemPage theme={theme} />);
}
