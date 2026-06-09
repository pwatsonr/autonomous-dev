// FR-026-31 — Firewall egress allowlist tile for the v3 Ops view.
//
// Design spec: /tmp/design_extract/autonomous-dev-v3/project/views.jsx
// §OpsView — `.ops-tile` "Firewall · egress allowlist" block.
//
// The daemon does not expose a live firewall allowlist API today.
// This tile renders "unavailable" when no entries are supplied, rather
// than fabricating data.

import type { FC } from "hono/jsx";

/** A single egress allowlist entry. */
export interface FirewallEntry {
    /** Hostname or glob pattern (e.g. "api.anthropic.com", "*.ts.net"). */
    host: string;
    /** Enforcement mode. */
    mode: "ALLOW" | "DENY";
}

export interface OpsFirewallTileProps {
    /** Firewall egress entries. Empty or undefined renders "unavailable". */
    entries?: FirewallEntry[];
}

/**
 * FR-026-31 §firewall tile.
 *
 * Renders a per-host ALLOW/DENY table inside an `.ops-tile`.  When `entries`
 * is absent or empty, an honest "unavailable" disclosure is rendered rather
 * than fabricated data.
 *
 * @param props - {@link OpsFirewallTileProps}
 * @returns The firewall tile JSX element.
 */
export const OpsFirewallTile: FC<OpsFirewallTileProps> = ({ entries }) => {
    const hasEntries = Array.isArray(entries) && entries.length > 0;
    const allowCount = hasEntries ? entries.filter((e) => e.mode === "ALLOW").length : 0;
    const denyCount = hasEntries ? entries.filter((e) => e.mode === "DENY").length : 0;

    return (
        <div class="ops-tile">
            <h3>Firewall · egress allowlist</h3>
            <div class="sub">
                {hasEntries
                    ? `${String(allowCount + denyCount)} hosts · ${String(denyCount)} deny rule${denyCount !== 1 ? "s" : ""} active`
                    : "egress policy unavailable"}
            </div>
            {hasEntries ? (
                <ul class="firewall-list" role="list" aria-label="Egress allowlist entries">
                    {entries.map((r) => {
                        const tone = r.mode === "DENY" ? "err" : "ok";
                        return (
                            <li class="firewall-row" key={r.host}>
                                <span
                                    class={`dot ${tone}`}
                                    aria-hidden="true"
                                />
                                <span class="firewall-host">{r.host}</span>
                                <span class={`firewall-mode ${tone}`}>
                                    {r.mode}
                                </span>
                            </li>
                        );
                    })}
                </ul>
            ) : (
                <p class="ops-unavail">
                    Firewall egress state is not tracked by this daemon
                    version. Configure a firewall integration to enable
                    live allowlist inspection.
                </p>
            )}
        </div>
    );
};
