// FR-026-11 — Pipeline swimlanes: 8-column board grouped by phase.
//
// View-local fragment. Each column = one phase (PRD → Observe).
// Column header: colored dot + phase label + card count badge.
// Column body: stacked `.pcard` cards with:
//   - id + priority (top-left mono)
//   - title
//   - progress bar
//   - agent avatar (initials) + ETA (bottom-left)
//   - cost (bottom-right)
//   - `.live` / `.attn` / `.blocked` state modifiers
//   - `data-phase` attribute resolved to `--lane-color` via CSS
// Empty lane shows a dash placeholder.
//
// Cards link to `/requests/:id` (keyboard accessible, WCAG 2.2 AA).
//
// ARIA notes:
//   - .pipeline-shell is role=region.
//   - .pipeline-header and .pipeline-body are presentational divs — NOT
//     role=row/grid (the kanban is not a 2D matrix; grid composite-widget
//     arrow-key navigation would be wrong here).
//   - Each .lane is role=list with role=listitem on each .pcard.
//   - Card aria-label includes the state ("blocked", "needs attention",
//     "live") for screen-reader users (WCAG 1.4.1 color-not-sole-signal).
//   - A small text chip ("BLOCKED", "ATTN", "LIVE") inside each .pcard
//     provides the same state signal for users who cannot distinguish
//     border-left colors (color-blindness, low contrast).
//   - Progress bar % is set via CSS custom property --pbar-pct instead
//     of an inline style.
//   - Phase colors are applied via data-phase on .pcard (CSS resolves
//     --lane-color via .pcard[data-phase=...] rules).
//   - Phase dot colors are applied via data-phase on .ph-dot (CSS resolves
//     background via .ph-dot[data-phase=...] rules).

import type { FC } from "hono/jsx";
import type { PhaseGroup, SwimlaneCard } from "../../wiring/dashboard-readers";

/** Derive 1–2 uppercase initials from an agent name ("code-executor" → "CE"). */
function agentInitials(name: string): string {
    return name
        .split("-")
        .map((s) => (s[0] ?? "").toUpperCase())
        .join("")
        .slice(0, 2);
}

/** Map card state to the aria-label suffix and the visible chip label. */
function stateInfo(state: SwimlaneCard["state"]): { label: string; chip: string | null } {
    if (state === "blocked")  return { label: "blocked",          chip: "BLOCKED" };
    if (state === "attn")     return { label: "needs attention",  chip: "ATTN"    };
    if (state === "live")     return { label: "live",             chip: "LIVE"    };
    return { label: "", chip: null };
}

const PipelineCard: FC<{ card: SwimlaneCard }> = ({ card }) => {
    const stateClass =
        card.state === "attn"
            ? " attn"
            : card.state === "blocked"
            ? " blocked"
            : card.state === "live"
            ? " live"
            : "";

    const { label: stateLabel, chip: stateChip } = stateInfo(card.state);
    const priorityLabel = card.priority.toUpperCase();
    const initials = agentInitials(card.agent);
    const costLabel = `$${card.cost.toFixed(2)}`;

    // aria-label includes state for screen-reader users (WCAG 1.4.1).
    const ariaLabel = stateLabel.length > 0
        ? `${card.id}: ${card.title} — ${card.phase} phase, ${card.priority} priority, ${stateLabel}`
        : `${card.id}: ${card.title} — ${card.phase} phase, ${card.priority} priority`;

    return (
        <a
            href={`/requests/${encodeURIComponent(card.id)}`}
            class={`pcard${stateClass}`}
            data-phase={card.phase}
            aria-label={ariaLabel}
        >
            <div class="pid">
                {card.id}
                {" · "}
                <span class="priority-label">{priorityLabel}</span>
                {/* Non-color state chip for color-blind users (WCAG 1.4.1) */}
                {stateChip != null ? (
                    <span class="pcard-state-chip" aria-hidden="true">{stateChip}</span>
                ) : null}
            </div>
            <div class="ptitle">{card.title}</div>
            {/*
              * Progress bar: the inner span's width is driven by a CSS custom
              * property --pbar-pct. Setting a CSS variable via style= is the
              * accepted CSP-safe pattern for dynamic numeric values (the value
              * is a data declaration, not an executable style rule).
              */}
            <div
                class="pbar"
                role="progressbar"
                aria-valuenow={card.pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${card.pct}% complete`}
            >
                <span style={`--pbar-pct:${card.pct}%`}></span>
            </div>
            <div class="pfoot">
                <span class="agent">
                    <span class="av" aria-hidden="true">{initials}</span>
                    <span class="dim">{card.eta}</span>
                </span>
                <span class="spacer"></span>
                <span class="mono">{costLabel}</span>
            </div>
        </a>
    );
};

export interface DashboardSwimlanesProps {
    groups: PhaseGroup[];
}

/**
 * FR-026-11 — 8-column pipeline swimlanes.
 *
 * Renders `.pipeline-shell` / `.pipeline-header` / `.pipeline-body` as
 * defined in dashboard.css. Each `.lane` receives phase-keyed cards.
 *
 * ARIA: role=region on the shell. Header and body are presentational.
 * Each lane is role=list; cards are role=listitem (implicit on <a> inside
 * a list, but we wrap explicitly for clarity).
 */
export const DashboardSwimlanes: FC<DashboardSwimlanesProps> = ({ groups }) => (
    <div class="pipeline-shell" role="region" aria-label="Pipeline swimlanes">
        {/* Column headers — presentational, no grid/row roles */}
        <div class="pipeline-header" aria-hidden="true">
            {groups.map((g) => (
                <div class="ph-col" key={g.phase}>
                    <span class="ph-dot" data-phase={g.phase} aria-hidden="true"></span>
                    <span>{g.label}</span>
                    <span class="ph-count">{g.cards.length}</span>
                </div>
            ))}
        </div>
        {/* Lane body — each lane is a list of cards */}
        <div class="pipeline-body">
            {groups.map((g) => (
                <div
                    class="lane"
                    key={g.phase}
                    role="list"
                    aria-label={`${g.label}: ${g.cards.length} item${g.cards.length !== 1 ? "s" : ""}`}
                >
                    {g.cards.length === 0 ? (
                        <span class="dim mono lane-empty" aria-label="No items">—</span>
                    ) : (
                        g.cards.map((card) => (
                            <div role="listitem" key={card.id}>
                                <PipelineCard card={card} />
                            </div>
                        ))
                    )}
                </div>
            ))}
        </div>
    </div>
);
