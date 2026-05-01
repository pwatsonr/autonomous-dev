// SPEC-013-4-03 §Error Page Template.
//
// Unified status-aware error page that handles 403, 404, 422, 500, and
// 503. Status-specific bits are kept declarative:
//   - icon name → resolved against the SVG manifest from SPEC-013-4-02
//   - help text → short, user-actionable line
//   - extra section → 404 navigation suggestions or 503 troubleshooting
//
// Accessibility contract (verified by SPEC-013-4-04 tests):
//   - <main role="main" aria-labelledby="error-heading">
//   - <h1 id="error-heading"> with the status-specific title
//   - <p class="error-message" role="alert"> for screen-reader announce
//   - "Return to Dashboard" link carries `autofocus` for keyboard users
//
// CSP-compatible: no inline <script>, no inline style="…", no on*
// handlers. The "Go Back" button uses an inline event-only string for
// data-attribute → an HTMX or vanilla-JS handler in portal.css /
// portal.js owns the browser-history call. We therefore expose the
// intent via `data-action="history-back"` rather than `onclick="…"`.

import type { FC } from "hono/jsx";

import type { IconName } from "../../../src/icons/icon-manifest";
import type { ErrorContext, ErrorStatusCode } from "../../lib/error-context";
import { STATUS_TITLES } from "../../lib/error-context";
import { ErrorDetails } from "../fragments/error-details";
import { TroubleshootingSteps } from "../fragments/troubleshooting-steps";

const STATUS_HELP: Readonly<Record<ErrorStatusCode, string>> = {
    403: "If you believe this is a mistake, contact your administrator.",
    404: "Check the URL or use the navigation below to get back on track.",
    422: "Please review your input and try again.",
    500: "The error has been logged. Please retry or return to the dashboard.",
    503: "Please wait a moment and try again. The steps below may help recover the daemon.",
};

const STATUS_ICONS: Readonly<Record<ErrorStatusCode, IconName>> = {
    403: "attention-needed",
    404: "request-rejected",
    422: "attention-needed",
    500: "attention-needed",
    503: "daemon-unreachable",
};

interface NavSuggestion {
    href: string;
    label: string;
}

const NAV_SUGGESTIONS: readonly NavSuggestion[] = [
    { href: "/", label: "Portfolio Dashboard" },
    { href: "/approvals", label: "Approvals" },
    { href: "/settings", label: "Settings" },
    { href: "/ops", label: "Ops" },
];

const NavigationSuggestions: FC = () => (
    <nav class="error-nav-suggestions" aria-label="Suggested pages">
        <ul>
            {NAV_SUGGESTIONS.map((s) => (
                <li>
                    <a href={s.href} class="btn btn-secondary">
                        {s.label}
                    </a>
                </li>
            ))}
        </ul>
    </nav>
);

/**
 * Inline SVG `<use>` reference. The actual symbol is fetched from the
 * served SVG file via `<use href="…#icon" />`. CSS controls size and
 * color so this template stays styling-free.
 */
const ErrorIcon: FC<{ name: IconName }> = ({ name }) => (
    <svg
        class="error-icon-svg"
        width="64"
        height="64"
        aria-hidden="true"
        focusable="false"
    >
        <use href={`/static/icons/${name}.svg#icon`} />
    </svg>
);

export const ErrorPage: FC<ErrorContext> = ({
    statusCode,
    message,
    details,
    requestPath,
    daemonHealth,
}) => {
    const title = STATUS_TITLES[statusCode];
    const help = STATUS_HELP[statusCode];
    const icon = STATUS_ICONS[statusCode];
    return (
        <main
            class="error-page"
            role="main"
            aria-labelledby="error-heading"
        >
            <div class="error-icon" aria-hidden="true">
                <ErrorIcon name={icon} />
            </div>
            <h1 id="error-heading">
                Error {String(statusCode)}: {title}
            </h1>
            <p class="error-message" role="alert">
                {message}
            </p>
            <p class="error-help">{help}</p>

            {statusCode === 404 ? <NavigationSuggestions /> : null}
            {statusCode === 503 && daemonHealth !== undefined ? (
                <TroubleshootingSteps health={daemonHealth} />
            ) : null}
            {details !== undefined && details !== "" ? (
                <ErrorDetails details={details} requestPath={requestPath} />
            ) : null}

            <div class="error-actions">
                <button
                    type="button"
                    class="btn btn-secondary"
                    data-action="history-back"
                >
                    Go Back
                </button>
                <a href="/" class="btn btn-primary" autofocus>
                    Return to Dashboard
                </a>
            </div>
        </main>
    );
};
