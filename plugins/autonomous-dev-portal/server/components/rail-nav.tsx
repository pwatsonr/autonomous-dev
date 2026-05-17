// SPEC-035-1-02 §RailNav — section nav rendered inside the left rail.
// SPEC-037-3-01 — extended from 5 to 7 portal-core nav entries with inline
//                 Lucide icons + mono uppercase group labels (OPERATE/SYSTEM).
// SPEC-037-3-02 — added optional `requestsCount` + `agentsAlertCount` badge
//                 inputs alongside the existing `approvalsCount` contract.
//
// Renders the portal's primary section navigation as a `<nav class="rail-nav">`
// containing two groups (Operate / System) per TDD-035 SS 6.2. Active-route
// detection is driven by the `activePath` prop supplied from the request URL
// (passed through ShellLayout). Approvals / Requests / Agents items optionally
// render a count badge when their corresponding prop is `> 0`.
//
// Homelab is intentionally omitted from portal core (SPEC-037-3-01 §Objective):
// a future `autonomous-dev-homelab` plugin will contribute that entry via the
// planned portal-plugin-contribution mechanism — do NOT hardcode it here.
//
// Composition (per TDD-035 SS 6.2 + SPEC-037-3-01 SS 4):
//   <nav class="rail-nav" aria-label="Primary">
//     <div class="rail-nav-group" data-group="operate">
//       <div class="rail-nav-group-label">OPERATE</div>
//       <a href="/"          class="rail-nav-item …" aria-current?>…</a>
//       <a href="/approvals" …><span class="ic">…icon…</span>Approvals<span class="count">N</span></a>
//       <a href="/requests"  …>…</a>
//       <a href="/costs"     …>…</a>
//     </div>
//     <div class="rail-nav-group" data-group="system">
//       <div class="rail-nav-group-label">SYSTEM</div>
//       <a href="/agents" …>…</a>
//       <a href="/settings"        …>…</a>
//       <a href="/ops"             …>…</a>
//     </div>
//   </nav>

import type { FC } from "hono/jsx";

import { icon } from "../lib/icons";

/** Group identifier for the two rail-nav sections. */
export type NavGroup = "operate" | "system";

/** Single navigation entry rendered inside the rail. */
export interface NavItem {
    /** Anchor href; matched against `activePath` for active-state detection. */
    readonly href: string;
    /** Visible label rendered after the icon span. */
    readonly label: string;
    /** Group bucket — controls which `<div class="rail-nav-group">` it lives in. */
    readonly group: NavGroup;
    /** Lucide icon basename (no extension); rendered inline via `icon()`. */
    readonly iconName: string;
}

/**
 * The portal's primary navigation entries, in display order.
 *
 * Items 1–4 belong to the "operate" group (day-to-day operator actions).
 * Items 5–7 belong to the "system" group (configuration / chrome).
 *
 * Ordering is intentional and load-bearing — tests and the active-state
 * highlighting both depend on it. See SPEC-037-3-01 AC-01.
 */
export const NAV_ITEMS: readonly NavItem[] = [
    { href: "/", label: "Dashboard", group: "operate", iconName: "activity" },
    { href: "/approvals", label: "Approvals", group: "operate", iconName: "shield-alert" },
    { href: "/requests", label: "Requests", group: "operate", iconName: "git-pull-request" },
    { href: "/logs", label: "Logs", group: "operate", iconName: "logs-viewer" },
    { href: "/costs", label: "Costs", group: "operate", iconName: "dollar-sign" },
    { href: "/agents", label: "Agents", group: "system", iconName: "bot" },
    { href: "/repos", label: "Repos", group: "system", iconName: "git-branch" },
    { href: "/settings", label: "Settings", group: "system", iconName: "sliders" },
    { href: "/ops", label: "Ops", group: "system", iconName: "terminal" },
];

/** Group label text rendered inside each `.rail-nav-group-label`. */
const GROUP_LABELS: Record<NavGroup, string> = {
    operate: "OPERATE",
    system: "SYSTEM",
};

/**
 * SPEC-037-3-02 — internal badge-resolution map.
 *
 * Routes badge anchors → which prop on `RailNavProps` supplies the integer.
 * Other items never render a badge.
 */
const BADGE_MAP: Record<string, keyof RailNavCounts> = {
    "/approvals": "approvalsCount",
    "/requests": "requestsCount",
    "/agents": "agentsAlertCount",
};

/**
 * SPEC-037-3-02 AC-06 — screen-reader suffix per badge anchor.
 *
 * When a badge renders, the anchor's `aria-label` is augmented with
 * `<label> (<N> <noun>)` so assistive tech announces the pending count.
 */
const BADGE_NOUN: Record<string, string> = {
    "/approvals": "pending",
    "/requests": "active",
    "/agents": "",
};

/** Internal shape passed into `renderItem` so the 3 optional counts flow as one arg. */
interface RailNavCounts {
    approvalsCount?: number;
    requestsCount?: number;
    agentsAlertCount?: number;
}

export interface RailNavProps extends RailNavCounts {
    /** Current request path; the matching item gets `.active` + `aria-current`. */
    activePath: string;
}

/**
 * Returns the numeric badge value for an item, or `undefined` when the
 * badge should be suppressed (zero, undefined, NaN, negative).
 */
function resolveBadge(
    item: NavItem,
    counts: RailNavCounts,
): number | undefined {
    const propKey = BADGE_MAP[item.href];
    if (propKey === undefined) return undefined;
    const value = counts[propKey];
    if (typeof value !== "number") return undefined;
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return value;
}

/**
 * Builds the anchor's `aria-label`. Default is the label text; when a
 * badge is present the count is appended for screen-reader clarity
 * (SPEC-037-3-02 AC-06).
 */
function ariaLabelFor(item: NavItem, badge: number | undefined): string {
    if (badge === undefined) return item.label;
    const noun = BADGE_NOUN[item.href] ?? "";
    if (noun === "") return `${item.label} (${badge})`;
    return `${item.label} (${badge} ${noun})`;
}

function renderItem(
    item: NavItem,
    activePath: string,
    counts: RailNavCounts,
): unknown {
    const isActive = item.href === activePath;
    // Class string is composed manually (not via a className library) to
    // match the rest of the portal's hand-rolled JSX style.
    const cls = isActive ? "rail-nav-item active" : "rail-nav-item";
    const badge = resolveBadge(item, counts);
    // SPEC-037-3-01 AC-03: inline Lucide SVG at 14px to match the kit's
    // `.rail-nav .ic { width:14px }` slot reservation.
    const iconMarkup = icon(item.iconName, 14);
    return (
        <a
            href={item.href}
            class={cls}
            aria-current={isActive ? "page" : undefined}
            aria-label={ariaLabelFor(item, badge)}
        >
            <span
                class="ic"
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: iconMarkup }}
            ></span>
            <span class="label">{item.label}</span>
            {badge !== undefined ? <span class="count">{badge}</span> : null}
        </a>
    );
}

/**
 * SPEC-035-1-02 §RailNav (extended by SPEC-037-3-01/02).
 *
 * Section navigation rendered inside `<aside class="rail">`. Splits the
 * NAV_ITEMS into two groups — "operate" (Dashboard, Approvals, Requests,
 * Costs) and "system" (Agents, Settings, Ops) — and marks the active
 * anchor with `aria-current="page"` + an `.active` class. Surfaces a
 * count badge on the Approvals / Requests / Agents anchors when their
 * corresponding count prop is `> 0`.
 */
export const RailNav: FC<RailNavProps> = ({
    activePath,
    approvalsCount,
    requestsCount,
    agentsAlertCount,
}) => {
    const counts: RailNavCounts = {
        approvalsCount,
        requestsCount,
        agentsAlertCount,
    };
    const operate = NAV_ITEMS.filter((i) => i.group === "operate");
    const system = NAV_ITEMS.filter((i) => i.group === "system");
    return (
        <nav class="rail-nav" aria-label="Primary">
            <div class="rail-nav-group" data-group="operate">
                <div class="rail-nav-group-label">
                    {GROUP_LABELS.operate}
                </div>
                {operate.map((item) => renderItem(item, activePath, counts))}
            </div>
            <div class="rail-nav-group" data-group="system">
                <div class="rail-nav-group-label">
                    {GROUP_LABELS.system}
                </div>
                {system.map((item) => renderItem(item, activePath, counts))}
            </div>
        </nav>
    );
};
