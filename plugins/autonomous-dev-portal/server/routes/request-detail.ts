// SPEC-013-3-01 §Path Parameter Validation — `GET /repo/:repo/request/:id`.
//
// Validates both path parameters with strict regexes BEFORE touching the
// stub. Any mismatch yields a 404 via notFound(c) so attackers can't probe
// for resource existence based on parsing-error messages.
//
// Repo slug:  ^[a-z0-9][a-z0-9-]{0,63}$  (lowercase, dash-allowed, 1–64 chars)
// Request ID: ^REQ-[0-9]{6}$              (exactly 6 digits)

import type { Context } from "hono";

import { notFound, renderPage } from "../lib/response-utils";
import { loadRequestStub } from "../stubs/requests";

const REPO_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REQ_ID_RE = /^REQ-[0-9]{6}$/;

export const requestDetailHandler = async (c: Context): Promise<Response> => {
    const repo = c.req.param("repo");
    const id = c.req.param("id");

    if (typeof repo !== "string" || !REPO_RE.test(repo)) {
        return notFound(c);
    }
    if (typeof id !== "string" || !REQ_ID_RE.test(id)) {
        return notFound(c);
    }

    const request = await loadRequestStub(repo, id);
    if (request === null) {
        return notFound(c);
    }

    return renderPage(c, "request-detail", { request });
};
