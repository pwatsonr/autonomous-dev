// SPEC-036-4-01 §Tab Shell — segmented-control nav for the Settings page.
//
// Pure function of `activeTab`. Renders one `<button class="seg-btn">`
// per id in `TAB_IDS`; the button matching `activeTab` carries the `on`
// class. The nav element exposes `data-active-tab` for the client-side
// `static/js/settings-tabs.js` module to read on `DOMContentLoaded`.
//
// No client state, no side effects — server emits the truth.

import type { FC } from "hono/jsx";

import { TAB_IDS, type TabId } from "../../types/render";

interface Props {
    activeTab: TabId;
}

const TAB_LABELS: Record<TabId, string> = {
    general: "General",
    variants: "Variants",
    standards: "Standards",
    backends: "Backends",
    agents: "Agents",
};

export const SettingsTabs: FC<Props> = ({ activeTab }) => (
    <nav
        class="seg seg-tabs"
        role="tablist"
        aria-label="Settings sections"
        data-active-tab={activeTab}
    >
        {TAB_IDS.map((id) => {
            const classes = id === activeTab ? "seg-btn active" : "seg-btn";
            return (
                <button
                    type="button"
                    class={classes}
                    role="tab"
                    aria-selected={id === activeTab ? "true" : "false"}
                    aria-controls={`settings-panel-${id}`}
                    data-tab={id}
                >
                    {TAB_LABELS[id]}
                </button>
            );
        })}
    </nav>
);
