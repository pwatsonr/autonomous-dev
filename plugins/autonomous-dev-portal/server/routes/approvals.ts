// SPEC-013-3-01 §Route Table — approvals (`GET /approvals`).

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import { loadApprovalsStub } from "../stubs/approvals";

export const approvalsHandler = async (c: Context): Promise<Response> => {
    const items = await loadApprovalsStub();
    return renderPage(c, "approvals", { items });
};
