// SPEC-013-3-01 §`/health` Handler.
//
// Returns JSON describing daemon freshness and basic component status.
// MUST NOT touch the database or spawn subprocesses; reads heartbeat.json
// only via readDaemonStatus(). MUST NOT require auth (auth middleware in
// PLAN-014 will explicitly skip /health).

import type { Context } from "hono";

import { readDaemonStatus } from "../lib/daemon-status";

export const healthHandler = async (c: Context): Promise<Response> => {
    const daemon = await readDaemonStatus();
    const healthy = daemon.status === "fresh";
    const body = {
        status: healthy ? ("ok" as const) : ("degraded" as const),
        daemon,
        components: { http: "ok", templates: "ok" },
    };
    // 200 when fresh, 503 when stale or dead — load balancers can use this
    // to take the instance out of rotation.
    return c.json(body, healthy ? 200 : 503);
};
