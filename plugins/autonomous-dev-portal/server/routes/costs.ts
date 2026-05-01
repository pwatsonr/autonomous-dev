// SPEC-013-3-01 §Route Table — costs (`GET /costs`).

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import { loadCostsStub } from "../stubs/costs";

export const costsHandler = async (c: Context): Promise<Response> => {
    const series = await loadCostsStub();
    return renderPage(c, "costs", { series });
};
