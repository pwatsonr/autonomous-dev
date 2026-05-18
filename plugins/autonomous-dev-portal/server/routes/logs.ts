// REQ-000011 — Enhanced logs route with observability features

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import { loadLogsStub } from "../stubs/logs";
import { EnhancedLogReader, type EnhancedReadLogOptions, type EnhancedLogLine } from "../readers/EnhancedLogReader";
import { enhancedLogsHandler } from "./enhanced-logs";

// Enhanced logs reader instance - initialized by server
let activeEnhancedLogsReader: EnhancedLogReader | null = null;

export function setEnhancedLogsReader(reader: EnhancedLogReader): void {
    activeEnhancedLogsReader = reader;
}

// Main logs handler - uses enhanced functionality
export const logsHandler = enhancedLogsHandler;
