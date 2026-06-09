// FR-026-01 — Topbar: sticky frosted-glass page header.
//
// Renders a `<header class="topbar">` that is sticky at the top of the
// `.main` scroll container.  It intentionally does NOT reference any
// routing context so it can be composed by any view without coupling.
//
// Composition:
//   <Topbar title="Requests" liveIndicator />
//   <Topbar title="Settings" subTitle="General" rightSlot={<SomeButton />} />
//
// CSS contract (defined in app.css):
//   .topbar        — position:sticky; top:0; backdrop-filter:blur(8px)
//   .topbar-inner  — flex row; max-width:1480px; margin:0 auto
//   .topbar h1     — font-size:var(--t-topbar)  (17px)
//   .topbar .sub   — secondary label (muted mono)
//   .topbar .spacer — flex:1 gap between left and right
//   .topbar .live-indicator — animated dot + label
//
// This component is CSP-clean: no inline styles or scripts.

import type { FC } from "hono/jsx";

export interface TopbarProps {
    /** Main page title rendered in the sticky header h1 (font 17px). */
    title: string;
    /**
     * Optional secondary label displayed after the title, rendered in
     * muted monospace as a sub-caption.
     */
    subTitle?: string;
    /**
     * When true, renders the animated `live` dot + "LIVE" label in the
     * topbar to signal that the page subscribes to real-time updates.
     */
    liveIndicator?: boolean;
    /**
     * Optional JSX slot rendered at the trailing (right) edge of the
     * topbar, after the flex spacer.  Use for page-level action buttons
     * or filter controls.
     */
    rightSlot?: unknown;
}

/**
 * FR-026-01 — Sticky topbar component.
 *
 * Renders the `.topbar` / `.topbar-inner` chrome defined in app.css.
 * Views that adopt the v3 layout should place this as the first child
 * of their `.main-inner` wrapper (or as a sibling before it if they
 * want the topbar to span the full content width without the 1480px cap).
 *
 * @param props - {@link TopbarProps}
 * @returns The topbar `<header>` element.
 */
export const Topbar: FC<TopbarProps> = ({
    title,
    subTitle,
    liveIndicator = false,
    rightSlot,
}) => {
    return (
        <header class="topbar">
            <div class="topbar-inner">
                <h1>{title}</h1>
                {subTitle !== undefined ? (
                    <span class="sub">{subTitle}</span>
                ) : null}
                <span class="spacer"></span>
                {liveIndicator ? (
                    <span class="live-indicator" aria-label="Live updates active">
                        <span class="dot live" aria-hidden="true"></span>
                        LIVE
                    </span>
                ) : null}
                {rightSlot !== undefined ? rightSlot : null}
            </div>
        </header>
    );
};
