// SPEC-013-3-01 §Route Table — settings (`GET /settings`).

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import { loadSettingsStub } from "../stubs/settings";

export const settingsHandler = async (c: Context): Promise<Response> => {
    const config = await loadSettingsStub();
    return renderPage(c, "settings", { config });
};
