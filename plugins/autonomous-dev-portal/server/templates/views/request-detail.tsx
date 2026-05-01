// SPEC-013-3-03 §Views — request-detail view component.

import type { FC } from "hono/jsx";

import type { RenderProps } from "../../types/render";
import { RequestTimeline } from "../fragments/request-timeline";

export const RequestDetailView: FC<RenderProps["request-detail"]> = ({
    request,
}) => (
    <section class="request-detail">
        <h1>
            {request.repo} / {request.id}
        </h1>
        <p class="summary">{request.summary}</p>
        <RequestTimeline requestId={request.id} phases={request.phases} />
    </section>
);
