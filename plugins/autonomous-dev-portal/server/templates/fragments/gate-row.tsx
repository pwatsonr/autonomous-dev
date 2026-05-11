// SPEC-037-4-03 §GateRow — kit-shape three-column approval row.
//
// Replaces the legacy `.approval-item.risk-{level}` markup with the
// kit's `.gate-row.gate-{type}` row inside a `.gate-list` container.
// Layout is `180px / 1fr / auto` (left meta column / mid content /
// right cost+actions); the `gate-{type}` modifier paints the left
// border per kit `app.css:432-439`. The legacy `riskLevel` schema is
// gone — see SPEC-037-4-04 for the data shape rebuild.
//
// `data-gate-type` is required on every row so SPEC-037-4-02's
// segmented-filter JS can toggle visibility without re-parsing
// class strings.

import type { FC } from "hono/jsx";

import { Btn, Chip } from "../../components/primitives";
import type { PhaseName } from "../../components/primitives";
import type {
    ApprovalGateType,
    ApprovalItem,
    ApprovalPhase,
} from "../../types/render";

/**
 * Map raw gate-type strings to human-readable labels for the
 * `.gate-type-tag` rendered in the left meta column. Unknown values
 * echo back verbatim so an unmapped type surfaces visibly.
 */
export const gateTypeLabel = (t: ApprovalGateType | string): string => {
    switch (t) {
        case "reviewer-chain":
            return "Reviewer chain";
        case "standards-violation":
            return "Standards";
        case "cost-cap":
            return "Cost cap";
        default:
            return t;
    }
};

/**
 * Map raw variant ids to human-readable labels. The portal's variant
 * registry lives in the daemon; until we wire it here, this fallback
 * humanizes the id (kebab → Title Case) so the chip always reads
 * naturally. Stubs and the daemon may also pre-resolve a label.
 */
export const variantLabel = (v: string): string => {
    if (!v) return "";
    return v
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
};

/**
 * Phase tones for the kit's `Chip` accept the `PhaseName` union.
 * `ApprovalPhase` is a superset (includes `"build"`) so we widen the
 * value to a string for the chip — `primitives.css` carries a rule for
 * every entry in `ApprovalPhase`, so the visual map is preserved.
 */
const phaseChipTone = (p: ApprovalPhase): PhaseName => {
    // `build` maps to `code` in the primitives kit; everything else is
    // a 1:1 match. Keeping this in one place means downstream callers
    // never have to think about the mismatch.
    if (p === "build") return "code";
    return p as PhaseName;
};

export const GateRow: FC<ApprovalItem> = (g) => (
    <div
        class={`gate-row gate-${g.gateType}`}
        data-gate-type={g.gateType}
        data-approval-id={g.id}
    >
        <div class="gate-left">
            <div class="gate-type-tag">{gateTypeLabel(g.gateType)}</div>
            <div class="gate-wait meta-mono">waited {g.waitedMin}m</div>
        </div>
        <div class="gate-mid">
            <div class="r-title">{g.summary}</div>
            <div class="gate-detail">{g.detail}</div>
            <div class="gate-meta">
                <span class="r-id meta-mono">{g.id}</span>
                <span class="dot-sep">·</span>
                <span>{g.repo}</span>
                <span class="dot-sep">·</span>
                <Chip variant="phase" tone={phaseChipTone(g.phase)}>
                    {g.phase.toUpperCase()}
                </Chip>
                <span class="dot-sep">·</span>
                <span class="chip variant sm">{variantLabel(g.variant)}</span>
            </div>
        </div>
        <div class="gate-right">
            <div class="gate-cost meta-mono">${g.cost.toFixed(2)}</div>
            <div class="gate-actions">
                {/* `a.btn` matches the kit Btn class shape; we render an
                    anchor so the href navigates without an HTMX hop. */}
                <a
                    class="btn sm"
                    href={`/repo/${g.repo}/request/${g.id}`}
                >
                    Open
                </a>
                <Btn
                    size="sm"
                    kind="primary"
                    hx-post={`/api/approvals/${g.id}/approve`}
                    hx-target={`[data-approval-id="${g.id}"]`}
                    hx-swap="outerHTML"
                >
                    Approve
                </Btn>
                <Btn
                    size="sm"
                    kind="destructive"
                    hx-post={`/api/approvals/${g.id}/reject`}
                    hx-target={`[data-approval-id="${g.id}"]`}
                    hx-swap="outerHTML"
                >
                    Reject
                </Btn>
            </div>
        </div>
    </div>
);
