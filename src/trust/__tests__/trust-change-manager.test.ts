/**
 * Unit tests for TrustChangeManager (SPEC-009-1-4 cross-ref to SPEC-009-1-3).
 *
 * Covers downgrade, upgrade with/without confirmation, concurrent changes
 * (last-write-wins), same-level no-op, and all audit event emissions.
 */

import { TrustChangeManager } from "../trust-change-manager";
import type { AuditTrail } from "../trust-change-manager";
import type { TrustLevel, TrustLevelChangeRequest } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedEvent {
  event_type: string;
  payload: Record<string, unknown>;
}

function createMockAuditTrail(): AuditTrail & { events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];
  return {
    events,
    append: jest.fn(async (event: CapturedEvent) => {
      events.push(event);
    }),
  };
}

function makeChangeRequest(
  overrides: Partial<TrustLevelChangeRequest> & {
    fromLevel: TrustLevel;
    toLevel: TrustLevel;
  },
): TrustLevelChangeRequest {
  return {
    requestId: overrides.requestId ?? "req-1",
    fromLevel: overrides.fromLevel,
    toLevel: overrides.toLevel,
    requestedBy: overrides.requestedBy ?? "user-1",
    requestedAt: overrides.requestedAt ?? new Date("2026-04-08T12:00:00Z"),
    reason: overrides.reason ?? "test change",
    status: overrides.status ?? "pending",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TrustChangeManager", () => {
  let manager: TrustChangeManager;
  let audit: ReturnType<typeof createMockAuditTrail>;

  beforeEach(() => {
    audit = createMockAuditTrail();
    manager = new TrustChangeManager(audit);
  });

  test("downgrade L2 to L0 creates pending change and resolves at boundary", () => {
    const change = makeChangeRequest({ fromLevel: 2, toLevel: 0 });
    const pending = manager.requestChange("req-1", change);

    expect(pending).not.toBeNull();
    expect(pending!.status).toBe("pending");
    expect(pending!.toLevel).toBe(0);

    const result = manager.resolveAtGateBoundary("req-1", 2);
    expect(result).toBe(0);
  });

  test("upgrade L1 to L3 without confirmation remains unchanged at boundary", () => {
    const change = makeChangeRequest({ fromLevel: 1, toLevel: 3 });
    const pending = manager.requestChange("req-1", change);

    expect(pending!.status).toBe("awaiting_confirmation");

    const result = manager.resolveAtGateBoundary("req-1", 1);
    expect(result).toBe(1);
  });

  test("upgrade L1 to L3 with confirmation resolves to 3 at boundary", () => {
    const change = makeChangeRequest({ fromLevel: 1, toLevel: 3 });
    manager.requestChange("req-1", change);
    manager.confirmUpgrade("req-1");

    const result = manager.resolveAtGateBoundary("req-1", 1);
    expect(result).toBe(3);
  });

  test("rejected upgrade returns original level at boundary", () => {
    const change = makeChangeRequest({ fromLevel: 1, toLevel: 3 });
    manager.requestChange("req-1", change);
    manager.rejectUpgrade("req-1");

    expect(manager.getPendingChange("req-1")).toBeNull();
    expect(manager.resolveAtGateBoundary("req-1", 1)).toBe(1);
  });

  test("concurrent changes use last-write-wins and emit superseded event", () => {
    manager.requestChange(
      "req-1",
      makeChangeRequest({ fromLevel: 2, toLevel: 0, reason: "first" }),
    );
    manager.requestChange(
      "req-1",
      makeChangeRequest({ fromLevel: 2, toLevel: 1, reason: "second" }),
    );

    expect(manager.getPendingChange("req-1")!.toLevel).toBe(1);

    const superseded = audit.events.filter(
      (e) => e.event_type === "trust_level_change_superseded",
    );
    expect(superseded).toHaveLength(1);
  });

  test("resolveAtGateBoundary with no pending change returns current level", () => {
    expect(manager.resolveAtGateBoundary("req-1", 2)).toBe(2);
  });

  test("same-level request is a no-op", () => {
    const result = manager.requestChange(
      "req-1",
      makeChangeRequest({ fromLevel: 2, toLevel: 2 }),
    );
    expect(result).toBeNull();
    expect(manager.getPendingChange("req-1")).toBeNull();
  });

  test("emits trust_level_change_requested on requestChange", () => {
    manager.requestChange(
      "req-1",
      makeChangeRequest({ fromLevel: 2, toLevel: 0, requestedBy: "admin" }),
    );

    const events = audit.events.filter(
      (e) => e.event_type === "trust_level_change_requested",
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload.requestedBy).toBe("admin");
  });

  test("emits trust_level_changed on resolveAtGateBoundary when change applied", () => {
    manager.requestChange(
      "req-1",
      makeChangeRequest({ fromLevel: 2, toLevel: 0 }),
    );
    manager.resolveAtGateBoundary("req-1", 2);

    const events = audit.events.filter(
      (e) => e.event_type === "trust_level_changed",
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload.toLevel).toBe(0);
  });

  test("getPendingChange returns null after change is applied at boundary", () => {
    manager.requestChange(
      "req-1",
      makeChangeRequest({ fromLevel: 2, toLevel: 0 }),
    );
    manager.resolveAtGateBoundary("req-1", 2);
    expect(manager.getPendingChange("req-1")).toBeNull();
  });

  test("confirmUpgrade throws when no pending change exists", () => {
    expect(() => manager.confirmUpgrade("nonexistent")).toThrow(
      "No pending change found",
    );
  });

  test("rejectUpgrade throws when no pending change exists", () => {
    expect(() => manager.rejectUpgrade("nonexistent")).toThrow(
      "No pending change found",
    );
  });
});
