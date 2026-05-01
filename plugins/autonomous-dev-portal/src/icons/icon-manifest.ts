// SPEC-013-4-02 §SVG Icons — type-safe icon name enum.
//
// Every icon under static/icons/ MUST have an entry here, and every
// entry here MUST have a matching SVG file. The build:assets pipeline
// fails if these drift (per the acceptance criteria).
//
// Consumers import IconName and pass it to the JSX <Icon> component
// (server/templates/fragments/icon.tsx) so refactors get type errors
// instead of broken images at runtime.

export const ICON_NAMES = [
    "daemon-running",
    "daemon-stale",
    "daemon-unreachable",
    "request-pending",
    "request-approved",
    "request-rejected",
    "request-executing",
    "request-complete",
    "attention-needed",
    "settings-gear",
    "cost-chart",
    "logs-viewer",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

export function isIconName(value: string): value is IconName {
    return (ICON_NAMES as readonly string[]).includes(value);
}
