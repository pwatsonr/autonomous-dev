// SPEC-013-3-01 §Route Table — approvals (`GET /approvals`).
// SPEC-037-4-04 — propagates `costCapDailyUsd` to the view so the KPI
// strip's "Cost cap" sub-line has a real value out of the box.
// PLAN-038 TASK-013 — swapped to real approvals reader. Empty queue
// renders the honest empty-state "No approvals waiting".

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import { readApprovalsQueue } from "../wiring/approvals-reader";

export const approvalsHandler = async (c: Context): Promise<Response> => {
    const { items, costCapDailyUsd } = await readApprovalsQueue();
    return renderPage(c, "approvals", { items, costCapDailyUsd });
};
