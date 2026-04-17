import { TrustChangeManager } from "../../src/trust/trust-change-manager";
import type {
  AuditTrail,
  PendingChange,
} from "../../src/trust/trust-change-manager";
import type { TrustLevel, TrustLevelChangeRequest } from "../../src/trust/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Captured audit event. */
interface CapturedEvent {
  event_type: string;
  payload: Record<string, unknown>;
}

/** Create a mock AuditTrail that captures all emitted events. */
function createMockAuditTrail(): AuditTrail & { events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];
  return {
    events,
    append: jest.fn(async (event: CapturedEvent) => {
      events.push(event);
    }),
  };
}

/** Build a TrustLevelChangeRequest with sensible defaults. */
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

  // -------------------------------------------------------------------------
  // Test Case 1: Downgrade L2 to L0
  // -------------------------------------------------------------------------
  test("downgrade L2 to L0 creates pending change and resolves to 0 at boundary", () => {
    const change = makeChangeRequest({ fromLevel: 2, toLevel: 0 });
    const pending = manager.requestChange("req-1", change);

    expect(pending).not.toBeNull();
    expect(pending!.status).toBe("pending");
    expect(pending!.fromLevel).toBe(2);
    expect(pending!.toLevel).toBe(0);

    const result = manager.resolveAtGateBoundary("req-1", 2);
    expect(result).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test Case 2: Upgrade L1 to L3 without confirmation
  // -------------------------------------------------------------------------
  test("upgrade L1 to L3 without confirmation remains unchanged at boundary", () => {
    const change = makeChangeRequest({ fromLevel: 1, toLevel: 3 });
    const pending = manager.requestChange("req-1", change);

    expect(pending).not.toBeNull();
    expect(pending!.status).toBe("awaiting_confirmation");

    // Resolve at boundary without confirming -- should return current level
    const result = manager.resolveAtGateBoundary("req-1", 1);
    expect(result).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test Case 3: Upgrade L1 to L3 with confirmation
  // -------------------------------------------------------------------------
  test("upgrade L1 to L3 with confirmation resolves to 3 at boundary", () => {
    const change = makeChangeRequest({ fromLevel: 1, toLevel: 3 });
    manager.requestChange("req-1", change);

    manager.confirmUpgrade("req-1");

    const result = manager.resolveAtGateBoundary("req-1", 1);
    expect(result).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Test Case 4: Upgrade rejected
  // -------------------------------------------------------------------------
  test("rejected upgrade returns original level at boundary", () => {
    const change = makeChangeRequest({ fromLevel: 1, toLevel: 3 });
    manager.requestChange("req-1", change);

    manager.rejectUpgrade("req-1");

    // Pending change should be cleared
    expect(manager.getPendingChange("req-1")).toBeNull();

    // Resolve at boundary returns original level
    const result = manager.resolveAtGateBoundary("req-1", 1);
    expect(result).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test Case 5: Concurrent changes (last-write-wins)
  // -------------------------------------------------------------------------
  test("concurrent changes use last-write-wins and emit superseded event", () => {
    const change1 = makeChangeRequest({
      fromLevel: 2,
      toLevel: 0,
      reason: "first downgrade",
    });
    manager.requestChange("req-1", change1);

    const change2 = makeChangeRequest({
      fromLevel: 2,
      toLevel: 1,
      reason: "second downgrade",
    });
    manager.requestChange("req-1", change2);

    const pending = manager.getPendingChange("req-1");
    expect(pending).not.toBeNull();
    expect(pending!.toLevel).toBe(1);

    // Verify superseded audit event was emitted
    const supersededEvents = audit.events.filter(
      (e) => e.event_type === "trust_level_change_superseded",
    );
    expect(supersededEvents).toHaveLength(1);
    expect(supersededEvents[0].payload.requestId).toBe("req-1");
  });

  // -------------------------------------------------------------------------
  // Test Case 6: No pending change
  // -------------------------------------------------------------------------
  test("resolveAtGateBoundary with no pending change returns current level", () => {
    const result = manager.resolveAtGateBoundary("req-1", 2);
    expect(result).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Test Case 7: Same-level request is a no-op
  // -------------------------------------------------------------------------
  test("same-level request is a no-op (returns null, no pending state)", () => {
    const change = makeChangeRequest({ fromLevel: 2, toLevel: 2 });
    const result = manager.requestChange("req-1", change);

    expect(result).toBeNull();
    expect(manager.getPendingChange("req-1")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test Case 8: Audit event: trust_level_change_requested
  // -------------------------------------------------------------------------
  test("emits trust_level_change_requested on requestChange", () => {
    const change = makeChangeRequest({
      fromLevel: 2,
      toLevel: 0,
      requestedBy: "admin",
      reason: "emergency downgrade",
    });
    manager.requestChange("req-1", change);

    const requestedEvents = audit.events.filter(
      (e) => e.event_type === "trust_level_change_requested",
    );
    expect(requestedEvents).toHaveLength(1);
    expect(requestedEvents[0].payload).toEqual({
      requestId: "req-1",
      fromLevel: 2,
      toLevel: 0,
      requestedBy: "admin",
      reason: "emergency downgrade",
    });
  });

  // -------------------------------------------------------------------------
  // Test Case 9: Audit event: trust_level_changed
  // -------------------------------------------------------------------------
  test("emits trust_level_changed on resolveAtGateBoundary when change applied", () => {
    const change = makeChangeRequest({ fromLevel: 2, toLevel: 0 });
    manager.requestChange("req-1", change);

    manager.resolveAtGateBoundary("req-1", 2);

    const changedEvents = audit.events.filter(
      (e) => e.event_type === "trust_level_changed",
    );
    expect(changedEvents).toHaveLength(1);
    expect(changedEvents[0].payload).toEqual({
      requestId: "req-1",
      fromLevel: 2,
      toLevel: 0,
      appliedAtGate: true,
    });
  });

  // -------------------------------------------------------------------------
  // Test Case 10: Audit event: trust_level_change_superseded
  // -------------------------------------------------------------------------
  test("emits trust_level_change_superseded when concurrent change replaces pending", () => {
    const change1 = makeChangeRequest({
      fromLevel: 2,
      toLevel: 0,
      requestedBy: "user-a",
      reason: "first",
    });
    manager.requestChange("req-1", change1);

    const change2 = makeChangeRequest({
      fromLevel: 2,
      toLevel: 1,
      requestedBy: "user-b",
      reason: "second",
    });
    manager.requestChange("req-1", change2);

    const supersededEvents = audit.events.filter(
      (e) => e.event_type === "trust_level_change_superseded",
    );
    expect(supersededEvents).toHaveLength(1);

    const payload = supersededEvents[0].payload;
    expect(payload.requestId).toBe("req-1");

    const superseded = payload.supersededChange as Record<string, unknown>;
    expect(superseded.toLevel).toBe(0);
    expect(superseded.requestedBy).toBe("user-a");
    expect(superseded.reason).toBe("first");

    const newChange = payload.newChange as Record<string, unknown>;
    expect(newChange.toLevel).toBe(1);
    expect(newChange.requestedBy).toBe("user-b");
    expect(newChange.reason).toBe("second");
  });

  // -------------------------------------------------------------------------
  // Test Case 11: Change clears after application
  // -------------------------------------------------------------------------
  test("getPendingChange returns null after change is applied at boundary", () => {
    const change = makeChangeRequest({ fromLevel: 2, toLevel: 0 });
    manager.requestChange("req-1", change);

    expect(manager.getPendingChange("req-1")).not.toBeNull();

    manager.resolveAtGateBoundary("req-1", 2);

    expect(manager.getPendingChange("req-1")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Additional coverage: audit events for confirm and reject
  // -------------------------------------------------------------------------

  test("emits trust_upgrade_confirmed on confirmUpgrade", () => {
    const change = makeChangeRequest({ fromLevel: 1, toLevel: 3 });
    manager.requestChange("req-1", change);

    manager.confirmUpgrade("req-1");

    const confirmedEvents = audit.events.filter(
      (e) => e.event_type === "trust_upgrade_confirmed",
    );
    expect(confirmedEvents).toHaveLength(1);
    expect(confirmedEvents[0].payload).toEqual({
      requestId: "req-1",
      toLevel: 3,
    });
  });

  test("emits trust_upgrade_rejected on rejectUpgrade", () => {
    const change = makeChangeRequest({ fromLevel: 1, toLevel: 3 });
    manager.requestChange("req-1", change);

    manager.rejectUpgrade("req-1");

    const rejectedEvents = audit.events.filter(
      (e) => e.event_type === "trust_upgrade_rejected",
    );
    expect(rejectedEvents).toHaveLength(1);
    expect(rejectedEvents[0].payload).toEqual({
      requestId: "req-1",
      toLevel: 3,
      reason: "Upgrade rejected",
    });
  });

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------

  test("confirmUpgrade throws when no pending change exists", () => {
    expect(() => manager.confirmUpgrade("nonexistent")).toThrow(
      "No pending change found for requestId: nonexistent",
    );
  });

  test("confirmUpgrade throws when change is not awaiting confirmation", () => {
    const change = makeChangeRequest({ fromLevel: 2, toLevel: 0 });
    manager.requestChange("req-1", change);

    // Downgrade is already "pending", not "awaiting_confirmation"
    expect(() => manager.confirmUpgrade("req-1")).toThrow(
      "not awaiting confirmation",
    );
  });

  test("rejectUpgrade throws when no pending change exists", () => {
    expect(() => manager.rejectUpgrade("nonexistent")).toThrow(
      "No pending change found for requestId: nonexistent",
    );
  });

  test("rejectUpgrade throws when change is not awaiting confirmation", () => {
    const change = makeChangeRequest({ fromLevel: 2, toLevel: 0 });
    manager.requestChange("req-1", change);

    expect(() => manager.rejectUpgrade("req-1")).toThrow(
      "not awaiting confirmation",
    );
  });

  // -------------------------------------------------------------------------
  // Same-level no-op still emits audit event
  // -------------------------------------------------------------------------

  test("same-level request emits trust_level_change_requested with noop flag", () => {
    const change = makeChangeRequest({ fromLevel: 2, toLevel: 2 });
    manager.requestChange("req-1", change);

    const requestedEvents = audit.events.filter(
      (e) => e.event_type === "trust_level_change_requested",
    );
    expect(requestedEvents).toHaveLength(1);
    expect(requestedEvents[0].payload.noop).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Multiple independent requests
  // -------------------------------------------------------------------------

  test("manages independent pending changes for different requestIds", () => {
    const change1 = makeChangeRequest({ fromLevel: 2, toLevel: 0 });
    const change2 = makeChangeRequest({ fromLevel: 1, toLevel: 3 });

    manager.requestChange("req-1", change1);
    manager.requestChange("req-2", change2);

    const pending1 = manager.getPendingChange("req-1");
    const pending2 = manager.getPendingChange("req-2");

    expect(pending1).not.toBeNull();
    expect(pending1!.status).toBe("pending");
    expect(pending1!.toLevel).toBe(0);

    expect(pending2).not.toBeNull();
    expect(pending2!.status).toBe("awaiting_confirmation");
    expect(pending2!.toLevel).toBe(3);

    // Resolve req-1 only
    expect(manager.resolveAtGateBoundary("req-1", 2)).toBe(0);
    expect(manager.getPendingChange("req-1")).toBeNull();

    // req-2 still pending
    expect(manager.getPendingChange("req-2")).not.toBeNull();
  });
});
