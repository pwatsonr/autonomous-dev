// SPEC-015-4-03 §degradation-banner — Hono JSX banner rendered above
// every page when the daemon is stale or down. Returns null for the
// `none` severity so BaseLayout can drop it cheaply.
//
// ARIA contract:
//   - severity=warning → role="status", aria-live="polite"
//   - severity=error   → role="alert",  aria-live="assertive"
// Screen readers announce the error case immediately while the warning
// case is announced when the user is idle.

import type { FC } from "hono/jsx";

import type { BannerConfig } from "../../health/health-types";

interface Props {
    banner: BannerConfig;
}

export const DegradationBanner: FC<Props> = ({ banner }) => {
    if (banner.severity === "none") return <></>;
    const cls =
        banner.severity === "warning"
            ? "banner banner--warning"
            : "banner banner--error";
    const liveness = banner.ariaRole === "alert" ? "assertive" : "polite";
    return (
        <div class={cls} role={banner.ariaRole} aria-live={liveness}>
            <strong class="banner__message">{banner.message}</strong>
            <span class="banner__details"> {banner.details}</span>
            {banner.showRetry && (
                <button
                    type="button"
                    class="banner__retry"
                    hx-get="/health"
                    hx-trigger="click"
                    hx-swap="none"
                >
                    Retry
                </button>
            )}
        </div>
    );
};
