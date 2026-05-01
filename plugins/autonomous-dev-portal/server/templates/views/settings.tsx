// SPEC-013-3-03 §Views — settings view component.

import type { FC } from "hono/jsx";

import type { RenderProps } from "../../types/render";

export const SettingsView: FC<RenderProps["settings"]> = ({ config }) => (
    <section class="settings">
        <h1>Settings</h1>
        <dl>
            <dt>Authentication mode</dt>
            <dd>{config.auth_mode}</dd>
            <dt>Port</dt>
            <dd>{String(config.port)}</dd>
            <dt>Log level</dt>
            <dd>{config.log_level}</dd>
        </dl>
    </section>
);
