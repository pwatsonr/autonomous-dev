// SPEC-037-7-01 §Request Detail page-head row.
//
// Emits the kit-parity page-head above the request header:
//
//   <div class="page-head">
//     <div class="back-row">
//       <a class="back" href="/">← Back</a>
//       <span class="r-id meta-mono">REQ-XXXXXX</span>
//     </div>
//     <div class="head-actions">
//       <Btn ... data-request-action="pause">Pause</Btn>
//       <Btn kind="destructive" data-request-action="kill">Kill</Btn>
//     </div>
//   </div>
//
// POST handlers for the Pause / Kill buttons are deferred (PLAN-037-7
// Out of Scope) — the buttons render without `disabled` so future wiring
// is a JSX-only change.

import type { FC } from "hono/jsx";

import { Btn } from "../../components/primitives";

interface Props {
    requestId: string;
}

export const RequestPageHead: FC<Props> = ({ requestId }) => (
    <div class="page-head">
        <div class="back-row">
            <a class="back" href="/">
                ← Back
            </a>
            <span class="r-id meta-mono">{requestId}</span>
        </div>
        <div class="head-actions">
            <Btn data-request-action="pause">Pause</Btn>
            <Btn kind="destructive" data-request-action="kill">
                Kill
            </Btn>
        </div>
    </div>
);
