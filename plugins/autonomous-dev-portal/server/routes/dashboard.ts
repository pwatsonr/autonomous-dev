// SPEC-013-3-01 §Route Table — dashboard (`GET /`).
//
// Loads the stubbed repo summary and delegates rendering to renderPage.
// MUST NOT inspect HX-Request directly — that is renderPage's job.

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import { loadDashboardStub } from "../stubs/repos";

export const dashboardHandler = async (c: Context): Promise<Response> => {
    const data = await loadDashboardStub();
    return renderPage(c, "dashboard", { data });
};
