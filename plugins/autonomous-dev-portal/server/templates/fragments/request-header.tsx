// SPEC-036-3-01 §Page head + request header region.
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

export const RequestHeader: FC<Props> = ({ request }) => {
    const status = request.status ?? "running";
    const statusTone: StatusTone = status === "gate" ? "warn" : "ok";
    const variantLabel =
        request.variantLabel ?? request.variant ?? "—";
    const phase = request.currentPhase ?? "prd";
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
                    </div>
                </div>
            </div>
            {request.summary !== undefined && request.summary !== "" ? (
                <p class="summary">{request.summary}</p>
            ) : null}
        </section>
    );
};
