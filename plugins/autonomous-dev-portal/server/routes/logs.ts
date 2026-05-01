// SPEC-013-3-01 §Route Table — logs (`GET /logs`).

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import { loadLogsStub } from "../stubs/logs";

export const logsHandler = async (c: Context): Promise<Response> => {
    const lines = await loadLogsStub();
    return renderPage(c, "logs", { lines });
};
