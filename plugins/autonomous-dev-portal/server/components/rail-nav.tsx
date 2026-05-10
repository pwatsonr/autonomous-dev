// SPEC-035-1-02 §RailNav — section nav rendered inside the left rail.
//
// Renders the portal's primary section navigation as a `<nav class="rail-nav">`
// containing two groups (Operate / System) per TDD-035 SS 6.2. Active-route
// detection is driven by the `activePath` prop supplied from the request URL
// (passed through ShellLayout). The Approvals item optionally renders a
// pending-count badge when `approvalsCount > 0`.
//
// Composition (per TDD-035 SS 6.2):
//   <nav class="rail-nav" aria-label="Primary">
//     <div class="rail-nav-group" data-group="operate">
//       <a href="/"          class="rail-nav-item …" aria-current?>…</a>
//       <a href="/approvals" …><span class="ic"/>Approvals<span class="count">N</span></a>
//       <a href="/costs"     …>…</a>
//       <a href="/ops"       …>…</a>
//     </div>
//     <div class="rail-nav-group" data-group="system">
//       <a href="/settings"  …>…</a>
//     </div>
//   </nav>
//
// AC mapping (vs. user task contract):
//   - exports `RailNav({ activePath, approvalsCount? })`           — AC-component
//   - five items in two groups (Operate: 4, System: 1)              — AC-items
//   - active item gets `aria-current="page"` and `.active` class    — AC-active
//   - Approvals shows count badge only when `approvalsCount > 0`    — AC-badge

import type { FC } from "hono/jsx";

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
}

/**
 * The portal's primary navigation entries, in display order.
 *
 * Items 1–4 belong to the "operate" group (day-to-day operator actions).
 * Item 5 belongs to the "system" group (configuration / chrome).
 *
 * Ordering is intentional and load-bearing — tests and the active-state
 * highlighting both depend on it.
 */
export const NAV_ITEMS: readonly NavItem[] = [
    { href: "/", label: "Dashboard", group: "operate" },
    { href: "/approvals", label: "Approvals", group: "operate" },
    { href: "/costs", label: "Costs", group: "operate" },
    { href: "/ops", label: "Ops", group: "operate" },
    { href: "/settings", label: "Settings", group: "system" },
];

export interface RailNavProps {
    /** Current request path; the matching item gets `.active` + `aria-current`. */
    activePath: string;
    /**
     * Optional pending-approvals count. When `> 0`, a `<span class="count">`
     * badge renders inside the Approvals anchor. `0`, `undefined`, or omitted
     * suppresses the badge entirely.
     */
    approvalsCount?: number;
}

function renderItem(
    item: NavItem,
    activePath: string,
    approvalsCount: number | undefined,
): unknown {
    const isActive = item.href === activePath;
    // Class string is composed manually (not via a className library) to
    // match the rest of the portal's hand-rolled JSX style.
    const cls = isActive ? "rail-nav-item active" : "rail-nav-item";
    const showCount =
        item.href === "/approvals" &&
        typeof approvalsCount === "number" &&
        approvalsCount > 0;
    return (
        <a
            href={item.href}
            class={cls}
            aria-current={isActive ? "page" : undefined}
        >
            <span class="ic" aria-hidden="true"></span>
            <span class="label">{item.label}</span>
            {showCount ? <span class="count">{approvalsCount}</span> : null}
        </a>
    );
}

/**
 * SPEC-035-1-02 §RailNav
 *
 * Section navigation rendered inside `<aside class="rail">`. Splits the five
 * NAV_ITEMS into two groups — "operate" (Dashboard, Approvals, Costs, Ops) and
 * "system" (Settings) — and marks the active anchor with `aria-current="page"`
 * + an `.active` class. Optionally surfaces a count badge on the Approvals
 * item when `approvalsCount > 0`.
 */
export const RailNav: FC<RailNavProps> = ({ activePath, approvalsCount }) => {
    const operate = NAV_ITEMS.filter((i) => i.group === "operate");
    const system = NAV_ITEMS.filter((i) => i.group === "system");
    return (
        <nav class="rail-nav" aria-label="Primary">
            <div class="rail-nav-group" data-group="operate">
                {operate.map((item) => renderItem(item, activePath, approvalsCount))}
            </div>
            <div class="rail-nav-group" data-group="system">
                {system.map((item) => renderItem(item, activePath, approvalsCount))}
            </div>
        </nav>
    );
};
