// SPEC-036-3-01 §Page head + request header region.
// SPEC-037-7-01 — `.rd-head` becomes a 2-column flex with `.rd-stat` on
// the right (cost / turns / score) and `.rd-meta` gains a trailing
// `started <ts>` segment when `request.startedAt` is set.
//
// Renders the request-detail page head: H1 with the request id in <code>,
// followed by status + variant chips. The meta region (id =
// `request-${id}-meta`) is the OOB-swap target for gate actions, so its
// container element id is stable.

import type { FC } from "hono/jsx";

import { Chip } from "../../components/primitives";
import type { PhaseName, StatusTone } from "../../components/primitives";
import type { RequestRecord } from "../../types/render";

interface Props {
    request: RequestRecord;
}

/** SPEC-037-7-01 — server-side cost formatter. Keeps `Intl.NumberFormat`
 *  out of JSX so the rendered HTML is deterministic across locales. */
function formatCost(n: number): string {
    return `$${n.toFixed(2)}`;
}

/** SPEC-037-7-01 — compact timestamp helper shared with the timeline.
 *  Mirrors `formatTimestampCompact` in `request-timeline.tsx`. Returns
 *  the input verbatim when it does not parse. */
function formatStartedAt(iso: string): string {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return iso;
    return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

export const RequestHeader: FC<Props> = ({ request }) => {
    const status = request.status ?? "running";
    const statusTone: StatusTone = status === "gate" ? "warn" : "ok";
    const variantLabel =
        request.variantLabel ?? request.variant ?? "—";
    const phase = request.currentPhase ?? "prd";
    const cost = request.cost ?? 0;
    const turns = request.turns ?? 0;
    const score = request.score ?? 0;
    const startedAt = request.startedAt;
    return (
        <section
            id={`request-${request.id}-meta`}
            class="sec request-header"
        >
            <div class="rd-head">
                <div>
                    <h1>
                        Request <code>{request.id}</code>
                    </h1>
                    <div class="rd-meta">
                        <span>{request.repo}</span>
                        <span class="dot-sep">·</span>
                        <Chip
                            variant="phase"
                            tone={phase as PhaseName}
                        />
                        <span class="dot-sep">·</span>
                        <Chip variant="status" tone={statusTone}>
                            {status.toUpperCase()}
                        </Chip>
                        <span class="dot-sep">·</span>
                        <span class="chip variant">{variantLabel}</span>
                        {startedAt !== undefined && startedAt !== "" ? (
                            <>
                                <span class="dot-sep">·</span>
                                <span class="meta-mono">
                                    started {formatStartedAt(startedAt)}
                                </span>
                            </>
                        ) : null}
                    </div>
                </div>
                {/* SPEC-037-7-01 — right-column stat block. */}
                <div class="rd-stat">
                    <div>
                        <span class="rd-stat-num">{formatCost(cost)}</span>
                        <span class="rd-stat-lbl">cost</span>
                    </div>
                    <div>
                        <span class="rd-stat-num">{turns}</span>
                        <span class="rd-stat-lbl">turns</span>
                    </div>
                    <div>
                        <span class="rd-stat-num">{score}</span>
                        <span class="rd-stat-lbl">score</span>
                    </div>
                </div>
            </div>
            {request.summary !== undefined && request.summary !== "" ? (
                <p class="summary">{request.summary}</p>
            ) : null}
        </section>
    );
};
