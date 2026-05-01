// SPEC-013-4-03 §Troubleshooting Steps Fragment.
//
// 503-specific recovery guidance rendered inside <ErrorPage> when the
// daemon health context is present. The shell commands are hard-coded
// (no template substitution) so a future plan PLAN-015-* can replace
// the static list with dynamically detected failure modes.

import type { FC } from "hono/jsx";

import type { DaemonHealth } from "../../lib/error-context";

interface Props {
    health: DaemonHealth;
}

export const TroubleshootingSteps: FC<Props> = ({ health }) => (
    <section
        class="daemon-status-info"
        role="region"
        aria-labelledby="ts-heading"
    >
        <h2 id="ts-heading">Daemon Status: {health.status}</h2>
        <p>{health.message}</p>
        {health.lastHeartbeat !== undefined ? (
            <p>
                <strong>Last heartbeat:</strong>{" "}
                <time>{health.lastHeartbeat.toISOString()}</time>{" "}
                <strong>Age:</strong>{" "}
                {String(Math.floor(health.stalenessSeconds ?? 0))}s
            </p>
        ) : null}
        <div class="daemon-troubleshooting">
            <h3>Troubleshooting Steps</h3>
            <ol>
                <li>
                    Check daemon process:{" "}
                    <code>ps aux | grep supervisor-loop</code>
                </li>
                <li>
                    Start daemon: <code>claude daemon start</code>
                </li>
                <li>
                    View logs:{" "}
                    <code>tail -f ~/.autonomous-dev/logs/daemon.log</code>
                </li>
                <li>
                    Restart portal: <code>claude portal restart</code>
                </li>
            </ol>
        </div>
    </section>
);
