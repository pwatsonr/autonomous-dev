// Homelab discovery surface — read-only page at /portal/homelab.
//
// Renders two tables sourced from the homelab plugin data dir:
//   1. Discovered platforms   — type, host:port, last seen
//   2. Observations / faults  — severity, pattern, resource, platform, discovered_at
//
// When the data dir is absent or empty the view renders an honest empty-state
// rather than fabricated rows. No forms, no POST actions.
//
// CSS: uses only classes already defined in the portal's static CSS
// (tbl, chip, chip.<tone>, main-inner, empty-state, meta-mono, dim, mono)
// so the css-coverage test (#417) stays green.

import type { FC } from "hono/jsx";

import { Topbar } from "../../components/topbar";
import type { HomelabPageData, HomelabPlatform, HomelabObservation } from "../../types/render";

function fmtDate(iso: string): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toISOString().slice(0, 19).replace("T", " ") + " UTC";
}

function severityTone(severity: string): string {
    if (severity === "critical" || severity === "error") return "err";
    if (severity === "warn" || severity === "warning") return "warn";
    return "muted";
}

function PlatformsTable({ platforms }: { platforms: HomelabPlatform[] }): JSX.Element {
    if (platforms.length === 0) {
        return (
            <div class="empty-state">
                <p class="empty-state-hint">
                    No platforms discovered yet — run <code>discover</code> to populate.
                </p>
            </div>
        );
    }
    return (
        <table class="tbl">
            <thead>
                <tr>
                    <th>Type</th>
                    <th>Host : Port</th>
                    <th>Last Seen</th>
                </tr>
            </thead>
            <tbody>
                {platforms.map((p) => (
                    <tr key={p.id}>
                        <td>
                            <span class="chip info">{p.type}</span>
                        </td>
                        <td class="mono">
                            {p.host}:{p.port}
                        </td>
                        <td class="meta-mono dim">{fmtDate(p.last_seen)}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function ObservationsTable({ observations }: { observations: HomelabObservation[] }): JSX.Element {
    if (observations.length === 0) {
        return (
            <div class="empty-state">
                <p class="empty-state-hint">
                    No observations yet — run <code>observe</code> to populate.
                </p>
            </div>
        );
    }
    return (
        <table class="tbl">
            <thead>
                <tr>
                    <th>Severity</th>
                    <th>Pattern</th>
                    <th>Resource</th>
                    <th>Platform</th>
                    <th>Discovered At</th>
                </tr>
            </thead>
            <tbody>
                {observations.map((o) => (
                    <tr key={o.id}>
                        <td>
                            <span class={`chip ${severityTone(o.severity)}`}>
                                {o.severity}
                            </span>
                        </td>
                        <td class="mono">{o.pattern}</td>
                        <td class="mono">{o.resource}</td>
                        <td class="meta-mono dim">{o.platform}</td>
                        <td class="meta-mono dim">{fmtDate(o.discovered_at)}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

/**
 * Read-only homelab discovery page.
 *
 * @param platforms    - Platforms discovered by the homelab plugin.
 * @param observations - Fault observations recorded by the homelab plugin.
 * @returns The homelab page JSX element.
 */
export const HomelabView: FC<HomelabPageData> = ({ platforms, observations }) => (
    <section id="homelab-body">
        <Topbar title="Homelab" subTitle="discovered platforms &amp; observations" />
        <div class="main-inner">
            <h2>Discovered platforms</h2>
            <PlatformsTable platforms={platforms} />

            <h2>Observations / faults</h2>
            <ObservationsTable observations={observations} />
        </div>
    </section>
);
