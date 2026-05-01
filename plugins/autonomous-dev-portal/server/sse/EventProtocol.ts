// SPEC-015-1-02 — Event id allocator, sequence counter, SSE framing.
//
// Stateless helpers + a single SequenceCounter per SSEEventBus. The
// counter is bus-wide so reconnecting clients can use Last-Event-ID to
// deduplicate.

import { randomBytes } from "node:crypto";

import type { PortalEvent } from "../events/types";

export class SequenceCounter {
    private value = 0;
    next(): number {
        this.value += 1;
        return this.value;
    }
    current(): number {
        return this.value;
    }
}

/** Generate a sortable-ish event id. Format: `evt_<ms>_<rand6>`. */
export function generateEventId(now: () => number = Date.now): string {
    return `evt_${String(now())}_${randomBytes(3).toString("hex")}`;
}

/** Generate a connection id. Format: `conn_<ms>_<rand6>`. */
export function generateConnectionId(now: () => number = Date.now): string {
    return `conn_${String(now())}_${randomBytes(3).toString("hex")}`;
}

/**
 * Format a PortalEvent as the SSE wire frame:
 *   id: <event.id>\n
 *   event: <event.type>\n
 *   data: <JSON.stringify(event)>\n
 *   \n
 */
export function formatSSE(event: PortalEvent): string {
    const data = JSON.stringify(event);
    return `id: ${event.id}\nevent: ${event.type}\ndata: ${data}\n\n`;
}
