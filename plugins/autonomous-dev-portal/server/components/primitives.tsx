/**
 * Primitive components — TDD-035 §6.5 / PRD-018 R-08.
 *
 * API AUTHORITY (TDD-035 §6.5.0): the prop signatures in this file are the
 * authoritative consumer contract for TDD-018-C surface adoption and all
 * future portal surface work. They supersede the design kit's prop names.
 *
 * Kit -> R-08 renames:
 *   - Chip:  `kind` (kit) -> `variant` (R-08)
 *   - Score: `n`    (kit) -> `value`   (R-08)
 *
 * Surface authors must use these prop names. The kit's original prop names
 * are not supported and will not be accepted in code review.
 *
 * All components are pure Hono JSX function components: no hooks, no state,
 * no side effects (TDD §6.5 invariant).
 *
 * Specs:
 *   - SPEC-035-2-01: skeleton + shared types (this file's header)
 *   - SPEC-035-2-02: Btn
 *   - SPEC-035-2-03: Chip, Dot
 *   - SPEC-035-2-04: Score, CostRing
 *   - SPEC-035-2-05: Card
 *   - SPEC-035-2-06: .tbl CSS contract (no JSX primitive)
 *   - SPEC-035-2-07: primitives.css (state matrices, motion, focus)
 */

import type { FC } from "hono/jsx";

/** Status tone palette shared across Chip (status variant) and Dot. */
export type StatusTone =
    | "ok"
    | "warn"
    | "err"
    | "info"
    | "muted"
    | "brand";

/**
 * Role-tone palette (SPEC-037-6-03). Maps to kit rules
 * `.chip.role-author / .role-reviewer / .role-specialist / .role-generic`
 * at `app.css:409-412`. Used by the Costs reviewer-spend chip and any
 * other reviewer-role contexts. Kept separate from {@link StatusTone}
 * so the status palette stays semantically narrow.
 */
export type RoleTone =
    | "role-author"
    | "role-reviewer"
    | "role-specialist"
    | "role-generic";

/** Eight portal phases — used by Chip (phase variant) and Card.leftBar. */
export type PhaseName =
    | "prd"
    | "tdd"
    | "plan"
    | "spec"
    | "code"
    | "review"
    | "deploy"
    | "observe";

// ---------------------------------------------------------------------------
// Btn — SPEC-035-2-02 (TDD §6.5.1)
// ---------------------------------------------------------------------------

type BtnKind = "primary" | "secondary" | "ghost" | "destructive";
type BtnSize = "sm" | "md";

export interface BtnProps {
    /** Visual kind. Default `"secondary"`. The default is suppressed from
     *  the class string so secondary buttons render as `class="btn"`. */
    kind?: BtnKind;
    /** Size variant. Default `"md"`. The default is suppressed from the
     *  class string (no `md` token is emitted). */
    size?: BtnSize;
    /** When `true`, sets the boolean `disabled` attribute on the button. */
    disabled?: boolean;
    /** Button label / inner content. */
    children?: unknown;
    /** Pass-through for HTMX (`hx-*`) and other DOM attributes. */
    [key: string]: unknown;
}

/**
 * SPEC-035-2-02 §Btn — single button primitive.
 *
 * Class composition (verbatim per TDD §6.5.1):
 *   - Always include `"btn"`.
 *   - Append `kind` only when `kind !== "secondary"`.
 *   - Append `"sm"` when `size === "sm"`. Never append `"md"`.
 *   - Class string is space-joined in the order [btn, kind?, sm?].
 *
 * `...rest` forwards every undocumented prop to the underlying `<button>`,
 * which is how HTMX attributes (`hx-post`, `hx-target`, ...) reach the DOM.
 */
export const Btn: FC<BtnProps> = ({
    kind = "secondary",
    size = "md",
    disabled = false,
    children,
    ...rest
}) => {
    const classes = ["btn"];
    if (kind !== "secondary") classes.push(kind);
    if (size === "sm") classes.push("sm");
    return (
        <button class={classes.join(" ")} disabled={disabled} {...rest}>
            {children}
        </button>
    );
};

// ---------------------------------------------------------------------------
// Chip + Dot — SPEC-035-2-03 (TDD §6.5.2 / §6.5.3)
// ---------------------------------------------------------------------------

type ChipVariant = "status" | "phase" | "backend";

/** Optional size variant. Maps to kit `.chip.sm` (`app.css:408`). */
type ChipSize = "sm";

export interface ChipProps {
    /** `"status"` for tone-driven status chips, `"phase"` for phase chips,
     *  `"backend"` for deploy-backend markers (SPEC-037-6-03). */
    variant: ChipVariant;
    /** Tone token. For `"status"` accepts `StatusTone` or `RoleTone`
     *  (SPEC-037-6-03); for `"phase"` accepts `PhaseName`. Ignored for
     *  `"backend"`. */
    tone?: StatusTone | RoleTone | PhaseName;
    /** Compact sizing (`.chip.sm`). Optional; default unset. */
    size?: ChipSize;
    /** Inner text for status / backend chips. Ignored for phase chips
     *  (R-11: phase chips always render the uppercase phase name). */
    children?: unknown;
}

/**
 * SPEC-035-2-03 §Chip — status / phase classification badge.
 * Extended by SPEC-037-6-03 with the `"backend"` variant + optional
 * `size="sm"` and the `RoleTone` palette.
 *
 * Phase variant (R-11): renders `<span class="chip-phase {tone}">` with
 * the phase name uppercased as the text content. Any `children` are
 * intentionally ignored to keep phase labels canonical.
 *
 * Status variant: renders `<span class="chip {tone?}{ sm?}">` with
 * `children` verbatim. Accepts both {@link StatusTone} and
 * {@link RoleTone} tokens. Consumers are responsible for uppercase
 * (R-10) on tone='ok|warn|err|info'; role-* and backend variants render
 * sentence case per the kit rules.
 *
 * Backend variant: renders `<span class="chip backend{ sm?}">{children}</span>`
 * — kit `app.css:396` covers the backend palette; SPEC-037-6-03 expects
 * `size="sm"` for the Costs deploy-backend column.
 *
 * The 6px colored dot rendered before phase-chip text is delivered by the
 * CSS `::before` pseudo-element in primitives.css — never injected here.
 */
export const Chip: FC<ChipProps> = ({ variant, tone, size, children }) => {
    if (variant === "phase" && tone) {
        return (
            <span class={`chip-phase ${tone}`}>
                {(tone as string).toUpperCase()}
            </span>
        );
    }
    if (variant === "backend") {
        const cls = ["chip", "backend"];
        if (size === "sm") cls.push("sm");
        return <span class={cls.join(" ")}>{children}</span>;
    }
    const cls = ["chip"];
    if (tone) cls.push(tone);
    if (size === "sm") cls.push("sm");
    return <span class={cls.join(" ")}>{children}</span>;
};

/** Dot's tone palette is intentionally narrower than Chip's (no "brand"). */
type DotTone = "ok" | "warn" | "err" | "info" | "muted";

export interface DotProps {
    /** Tone token. Default `"muted"`. */
    tone?: DotTone;
    /** When `true`, renders `<span class="dot live">` (pulsing) and the
     *  tone is suppressed — the live state is visually canonical (R-15). */
    live?: boolean;
}

/**
 * SPEC-035-2-03 §Dot — 8px state indicator with optional pulse.
 *
 * `live` overrides `tone`: a live dot is always rendered as
 * `<span class="dot live">` regardless of any tone passed. The pulse
 * animation is applied by `.dot.live` in primitives.css via `@keyframes
 * pulse` (R-15 canonical motion).
 */
export const Dot: FC<DotProps> = ({ tone = "muted", live = false }) => (
    <span class={`dot ${live ? "live" : tone}`}></span>
);

// ---------------------------------------------------------------------------
// Score + CostRing — SPEC-035-2-04 (TDD §6.5.4 / §6.5.5)
// ---------------------------------------------------------------------------

export interface ScoreProps {
    /** Score in 0..100. Drives the fill width and color band. */
    value: number;
    /** Threshold for the "ok" band. Default `85`. The "warn" band is
     *  `>= threshold * 0.8`; below that is "err". */
    threshold?: number;
    /** Optional label rendered before the bar (e.g. "PRD"). */
    label?: string;
}

/**
 * SPEC-035-2-04 §Score — 0..100 horizontal bar with threshold color.
 *
 * Color logic (TDD §6.5.4):
 *   value >= threshold        -> var(--ok)
 *   value >= threshold * 0.8  -> var(--warn)
 *   else                      -> var(--err)
 *
 * The fill width and color are inline-styled because both depend on the
 * `value` prop; the rest of the chrome (`.score-track`, `.score-num`, ...)
 * lives in primitives.css.
 */
export const Score: FC<ScoreProps> = ({ value, threshold = 85, label }) => {
    const ok = value >= threshold;
    const color = ok
        ? "var(--ok)"
        : value >= threshold * 0.8
        ? "var(--warn)"
        : "var(--err)";
    return (
        <span class="score-inline">
            {label && <span class="score-label">{label}</span>}
            <span class="score-track">
                <span
                    class="score-fill"
                    style={`width: ${value}%; background: ${color}`}
                ></span>
            </span>
            <span class="score-num meta-mono">{value}</span>
        </span>
    );
};

export interface CostRingProps {
    /** Cost spent so far. */
    spent: number;
    /** Cap (denominator). When `0`, the percentage is `0` (no NaN). */
    cap: number;
    /** Optional label rendered below the percentage (e.g. "TODAY"). */
    label?: string;
}

/**
 * SPEC-035-2-04 §CostRing — 80x80 SVG donut for spent/cap.
 *
 * Math (TDD §6.5.5 — exact):
 *   pct          = cap > 0 ? min(100, spent/cap * 100) : 0
 *   circumference = 2 * PI * 34
 *   offset        = circumference - circumference * pct / 100
 *   color         = pct >= 80 ? var(--warn) : var(--brand)
 *
 * `toFixed(1)` on the dash math and `toFixed(0)` on the percentage text
 * keep float drift sub-pixel — well below the 0.1% visual-regression
 * threshold. R-15a: no shadows; the ring is flat.
 */
export const CostRing: FC<CostRingProps> = ({ spent, cap, label }) => {
    const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
    const circumference = 2 * Math.PI * 34;
    const offset = circumference - (circumference * pct) / 100;
    const color = pct >= 80 ? "var(--warn)" : "var(--brand)";

    return (
        <svg
            class="ring"
            viewBox="0 0 80 80"
            width="80"
            height="80"
            aria-label={`${label ?? "Cost"}: ${pct.toFixed(0)}%`}
        >
            <circle
                cx="40"
                cy="40"
                r="34"
                fill="none"
                stroke="var(--bg-3)"
                stroke-width="8"
            />
            <circle
                cx="40"
                cy="40"
                r="34"
                fill="none"
                stroke={color}
                stroke-width="8"
                stroke-dasharray={circumference.toFixed(1)}
                stroke-dashoffset={offset.toFixed(1)}
                stroke-linecap="round"
                transform="rotate(-90 40 40)"
            />
            <text
                x="40"
                y="38"
                text-anchor="middle"
                font-family="var(--font-mono)"
                font-weight="700"
                font-size="14"
                fill="var(--fg-0)"
            >
                {`${pct.toFixed(0)}%`}
            </text>
            {label && (
                <text
                    x="40"
                    y="52"
                    text-anchor="middle"
                    font-family="var(--font-mono)"
                    font-size="9"
                    fill="var(--fg-2)"
                >
                    {label}
                </text>
            )}
        </svg>
    );
};

// ---------------------------------------------------------------------------
// Card — SPEC-035-2-05 (TDD §6.5.6)
// ---------------------------------------------------------------------------

type CardPadding = "sm" | "md" | "lg";

export interface CardProps {
    /** When set, renders a 4px phase-colored left bar (R-12 motif). */
    leftBar?: PhaseName;
    /** Padding token: `sm`=12px, `md`=16px, `lg`=24px. Default `"md"`. */
    padding?: CardPadding;
    /** Card body content. */
    children?: unknown;
}

/**
 * SPEC-035-2-05 §Card — hairline container with optional left bar.
 *
 * The card chrome (1px border, 3px radius, no shadow per R-15a) lives in
 * `.card` in primitives.css. `leftBar` adds an inline `border-left: 4px
 * solid var(--phase-{leftBar})` — the system's one decorative motif (R-12).
 */
export const Card: FC<CardProps> = ({ leftBar, padding = "md", children }) => {
    const padMap: Record<CardPadding, string> = {
        sm: "12px",
        md: "16px",
        lg: "24px",
    };
    const style = leftBar
        ? `border-left: 4px solid var(--phase-${leftBar}); padding: ${padMap[padding]}`
        : `padding: ${padMap[padding]}`;

    return (
        <div class="card" style={style}>
            {children}
        </div>
    );
};
