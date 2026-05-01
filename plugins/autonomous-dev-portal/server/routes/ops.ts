// SPEC-013-3-01 §Route Table — ops (`GET /ops`).

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import { loadOpsStub } from "../stubs/ops";

export const opsHandler = async (c: Context): Promise<Response> => {
    const health = await loadOpsStub();
    return renderPage(c, "ops", { health });
};
