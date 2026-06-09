// SPEC-013-3-01 §Route Table — logs (`GET /logs`).

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import { loadLogsStub } from "../stubs/logs";
import type { LogsReader } from "../wiring/logs-reader";

// Global logs reader instance - will be set by the server during initialization
let activeLogsReader: LogsReader | null = null;

export function setLogsReader(reader: LogsReader): void {
    activeLogsReader = reader;
}

export const logsHandler = async (c: Context): Promise<Response> => {
    // Parse query parameters for filtering
    const level = c.req.query("level") || undefined;
    const limitParam = c.req.query("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : undefined;

    if (activeLogsReader) {
        try {
            const lines = await activeLogsReader.readLogs({
                level,
                limit,
            });
            return renderPage(c, "logs", { lines });
        } catch (error) {
            // The reader threw — surface an honest error state to the user
            // instead of silently falling through to fabricated stub data.
            // LiveLog renders a `.l-err` system row when readError is true.
            console.warn("LogsReader failed:", error);
            return renderPage(c, "logs", { lines: [], readError: true });
        }
    }

    // No reader configured — fall back to stub data (dev / CI only).
    const lines = await loadLogsStub();
    return renderPage(c, "logs", { lines });
};
