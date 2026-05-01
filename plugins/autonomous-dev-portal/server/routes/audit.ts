// SPEC-013-3-01 §Route Table — audit (`GET /audit`).
//
// SPEC-015-4-02 §Audit Page — when an `AuditLogReader` is wired in via
// `setAuditReader(...)`, the handler reads the live HMAC-chained log,
// parses query-string filters, and renders the live page. Without a
// reader (tests, stubbed dev) it falls back to the legacy stub.

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import type { AuditLogReader } from "../services/audit-log-reader";
import { loadAuditStub } from "../stubs/audit";
import type { AuditFilters } from "../types/audit-types";

let activeReader: AuditLogReader | null = null;

/** Wire a reader for production use. Pass `null` to revert to stubs. */
export function setAuditReader(reader: AuditLogReader | null): void {
    activeReader = reader;
}

const MAX_PAGE = 1_000_000;

function parsePage(value: string | undefined): number {
    if (value === undefined) return 1;
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(n, MAX_PAGE);
}

function parseDate(value: string | undefined): {
    ok: boolean;
    date?: Date;
} {
    if (value === undefined || value.length === 0) return { ok: true };
    // Accept either a bare YYYY-MM-DD or a full ISO-8601 string.
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return { ok: false };
    return { ok: true, date: d };
}

export const auditHandler = async (c: Context): Promise<Response> => {
    if (activeReader === null) {
        const rows = await loadAuditStub();
        return renderPage(c, "audit", { rows });
    }
    const startDateRaw = c.req.query("startDate");
    const endDateRaw = c.req.query("endDate");
    const start = parseDate(startDateRaw);
    const end = parseDate(endDateRaw);
    if (!start.ok || !end.ok) {
        return c.json({ error: "INVALID_DATE" }, 400);
    }
    const operatorId = c.req.query("operatorId");
    const action = c.req.query("action");
    const filters: AuditFilters = {
        operatorId:
            operatorId !== undefined && operatorId.length > 0
                ? operatorId
                : undefined,
        action:
            action !== undefined && action.length > 0 ? action : undefined,
        startDate: start.date,
        endDate: end.date,
    };
    const page = parsePage(c.req.query("page"));
    const result = await activeReader.getPage(page, 50, filters);
    return renderPage(c, "audit", { rows: [], page: result, filters });
};
