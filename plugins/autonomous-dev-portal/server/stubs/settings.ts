// SPEC-013-3-01 §Stub Data Modules — settings view.

import type { SettingsView } from "../types/render";

const STUB: SettingsView = {
    auth_mode: "localhost",
    port: 7878,
    log_level: "info",
};

export async function loadSettingsStub(): Promise<SettingsView> {
    return STUB;
}
