// FR-026-20 — Request Detail v3: Topbar right-slot content.
//
// Renders the Topbar's `rightSlot` for the request-detail page:
//   - Priority chip (brand tone, uppercase)
//   - Repo chip (neutral)
//   - Back button (ghost btn, links to /requests)
//
// This is NOT a full section — it is the JSX fragment passed to
// `<Topbar rightSlot={...} />` so it sits inside the sticky topbar header.
//
// CSS classes consumed from app.css:
//   .chip.brand, .chip, .btn.ghost, .btn.sm
//
// Accessibility: the Back button has aria-label describing its destination.

import type { FC } from "hono/jsx";

interface Props {
    /** Priority string (e.g. "HIGH", "MEDIUM"). */
    priority: string;
    /** Repo slug displayed as a chip. */
    repo: string;
    /** Author display name rendered as dim mono text. */
    author?: string;
}

/**
 * FR-026-20 — Topbar right-slot content for the request-detail page.
 *
 * @param props - {@link Props}
 */
export const RdV3TopbarRight: FC<Props> = ({ priority, repo, author }) => (
    <>
        <span class="chip brand rd-priority-chip">
            {priority.toUpperCase()}
        </span>
        <span class="chip rd-repo-chip">{repo}</span>
        {author !== undefined && author !== "" ? (
            <span class="meta-mono dim rd-author">{author}</span>
        ) : null}
        <a
            href="/requests"
            class="btn sm ghost"
            aria-label="Back to requests list"
        >
            &larr; Back
        </a>
    </>
);
