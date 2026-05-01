// SPEC-013-3-03 §Views — ops view component.

import type { FC } from "hono/jsx";

import type { RenderProps } from "../../types/render";

export const OpsView: FC<RenderProps["ops"]> = ({ health }) => (
    <section class="ops">
        <h1>Ops</h1>
        <h2>Daemon</h2>
        <dl>
            <dt>Status</dt>
            <dd>{health.daemon.status}</dd>
            <dt>PID</dt>
            <dd>{health.daemon.pid !== null ? String(health.daemon.pid) : "—"}</dd>
        </dl>
        <h2>Components</h2>
        <ul>
            {Object.entries(health.components).map(([name, status]) => (
                <li class={`component status-${status}`}>
                    <strong>{name}</strong>: {status}
                </li>
            ))}
        </ul>
    </section>
);
