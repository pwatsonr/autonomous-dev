// SPEC-015-2-02 §Form Schema
//
// Reusable wrapper for one section of the settings form. Each section is
// its own <fieldset> so HTMX can swap a single section's outer HTML on a
// 422 response without re-rendering the whole form. The section legend
// doubles as the section's accessible name.

import type { FC } from "hono/jsx";

interface Props {
    /** URL-safe slug; becomes the section element id. */
    id: string;
    title: string;
    description?: string;
    children?: unknown;
}

export const SettingsSection: FC<Props> = ({
    id,
    title,
    description,
    children,
}) => (
    <fieldset
        id={`settings-section-${id}`}
        class="settings-section"
        data-section={id}
    >
        <legend class="settings-section__title">{title}</legend>
        {description ? (
            <p class="settings-section__description">{description}</p>
        ) : null}
        <div class="settings-section__body">{children}</div>
    </fieldset>
);
