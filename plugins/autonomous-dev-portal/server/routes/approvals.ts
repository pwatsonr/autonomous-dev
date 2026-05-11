// SPEC-013-3-01 §Route Table — approvals (`GET /approvals`).
// SPEC-037-4-04 — propagates `costCapDailyUsd` to the view so the KPI
// strip's "Cost cap" sub-line has a real value out of the box.

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import { loadApprovalsStub } from "../stubs/approvals";

export const approvalsHandler = async (c: Context): Promise<Response> => {
    const { items, costCapDailyUsd } = await loadApprovalsStub();
    return renderPage(c, "approvals", { items, costCapDailyUsd });
};
