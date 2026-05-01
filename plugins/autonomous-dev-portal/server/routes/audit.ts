// SPEC-013-3-01 §Route Table — audit (`GET /audit`).

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import { loadAuditStub } from "../stubs/audit";

export const auditHandler = async (c: Context): Promise<Response> => {
    const rows = await loadAuditStub();
    return renderPage(c, "audit", { rows });
};
