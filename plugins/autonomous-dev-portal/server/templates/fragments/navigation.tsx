// SPEC-013-3-03 §Navigation Component.
//
// Site navigation rendered inside the BaseLayout <header>. The item
// whose href matches `activePath` is marked with both `aria-current`
// and the `active` CSS class (CSS lives in PLAN-013-4 portal.css).
//
// Includes a <DaemonStatusPill> that polls /api/daemon-status every
// 30s via HTMX outerHTML swap. The /api endpoint is owned by PLAN-015;
// this template only wires the hx-* attributes.

import type { FC } from "hono/jsx";

import { DaemonStatusPill } from "./daemon-status-pill";

interface NavItem {
    href: string;
    label: string;
}

const NAV_ITEMS: readonly NavItem[] = [
    { href: "/", label: "Dashboard" },
    { href: "/approvals", label: "Approvals" },
    { href: "/settings", label: "Settings" },
    { href: "/costs", label: "Costs" },
    { href: "/logs", label: "Logs" },
    { href: "/ops", label: "Ops" },
    { href: "/audit", label: "Audit" },
];

export const Navigation: FC<{ activePath: string }> = ({ activePath }) => (
    <nav aria-label="Primary">
        <ul>
            {NAV_ITEMS.map((item) => {
                const isActive = item.href === activePath;
                return (
                    <li class={isActive ? "active" : undefined}>
                        <a
                            href={item.href}
                            aria-current={isActive ? "page" : undefined}
                        >
                            {item.label}
                        </a>
                    </li>
                );
            })}
        </ul>
        <DaemonStatusPill status="unknown" />
    </nav>
);
