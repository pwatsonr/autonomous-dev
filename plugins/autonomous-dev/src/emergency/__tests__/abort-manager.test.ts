/**
 * Unit tests for AbortManager (SPEC-009-4-4, Task 10).
 *
 * Tests the global and per-request AbortController management, composite
 * signal creation, and lifecycle operations (register, deregister, reset).
 */

import { AbortManager } from "../abort-manager";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AbortManager", () => {
  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  it("returns a composite AbortSignal on registerRequest", () => {
    const manager = new AbortManager();
    const signal = manager.registerRequest("req-1");

    expect(signal).toBeDefined();
    expect(signal.aborted).toBe(false);
  });

  it("tracks registered request IDs", () => {
    const manager = new AbortManager();
    manager.registerRequest("req-1");
    manager.registerRequest("req-2");
    manager.registerRequest("req-3");

    const ids = manager.getActiveRequestIds();
    expect(ids).toEqual(["req-1", "req-2", "req-3"]);
  });

  it("deregisters a request without aborting its signal", () => {
    const manager = new AbortManager();
    const signal = manager.registerRequest("req-1");
    manager.registerRequest("req-2");

    manager.deregisterRequest("req-1");

    expect(manager.getActiveRequestIds()).toEqual(["req-2"]);
    // Signal is NOT aborted on deregister
    expect(signal.aborted).toBe(false);
  });

  // -----------------------------------------------------------------------
  // abortAll
  // -----------------------------------------------------------------------

  it("abortAll aborts all registered request signals", () => {
    const manager = new AbortManager();
    const signal1 = manager.registerRequest("req-1");
    const signal2 = manager.registerRequest("req-2");
    const signal3 = manager.registerRequest("req-3");

    manager.abortAll("KILL_GRACEFUL");

    expect(signal1.aborted).toBe(true);
    expect(signal2.aborted).toBe(true);
    expect(signal3.aborted).toBe(true);
  });

  it("abortAll is idempotent -- second call is a no-op", () => {
    const manager = new AbortManager();
    const signal = manager.registerRequest("req-1");

    manager.abortAll("KILL_GRACEFUL");
    expect(signal.aborted).toBe(true);

    // Second call should not throw
    expect(() => manager.abortAll("KILL_HARD")).not.toThrow();
    expect(signal.aborted).toBe(true);
  });

  it("isAborted returns true after abortAll", () => {
    const manager = new AbortManager();
    manager.registerRequest("req-1");

    expect(manager.isAborted()).toBe(false);
    manager.abortAll("KILL_HARD");
    expect(manager.isAborted()).toBe(true);
  });

  // -----------------------------------------------------------------------
  // abortRequest (single request)
  // -----------------------------------------------------------------------

  it("abortRequest aborts only the specified request", () => {
    const manager = new AbortManager();
    const signal1 = manager.registerRequest("req-1");
    const signal2 = manager.registerRequest("req-2");
    const signal3 = manager.registerRequest("req-3");

    manager.abortRequest("req-2", "CANCEL");

    expect(signal1.aborted).toBe(false);
    expect(signal2.aborted).toBe(true);
    expect(signal3.aborted).toBe(false);
  });

  it("abortRequest is a no-op for unknown requestId", () => {
    const manager = new AbortManager();
    manager.registerRequest("req-1");

    // Should not throw
    expect(() => manager.abortRequest("unknown", "CANCEL")).not.toThrow();
  });

  it("abortRequest is idempotent for the same request", () => {
    const manager = new AbortManager();
    const signal = manager.registerRequest("req-1");

    manager.abortRequest("req-1", "CANCEL");
    expect(signal.aborted).toBe(true);

    // Second call should not throw
    expect(() => manager.abortRequest("req-1", "CANCEL")).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // Composite signal: global abort cascades to registered requests
  // -----------------------------------------------------------------------

  it("global abort cascades to composite signals", () => {
    const manager = new AbortManager();
    const signal1 = manager.registerRequest("req-1");
    const signal2 = manager.registerRequest("req-2");

    expect(signal1.aborted).toBe(false);
    expect(signal2.aborted).toBe(false);

    manager.abortAll("KILL_GRACEFUL");

    expect(signal1.aborted).toBe(true);
    expect(signal2.aborted).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Registration after global abort returns pre-aborted signal
  // -----------------------------------------------------------------------

  it("signals from registrations after abortAll are pre-aborted", () => {
    const manager = new AbortManager();
    manager.abortAll("KILL_HARD");

    const signal = manager.registerRequest("req-late");
    expect(signal.aborted).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Reset
  // -----------------------------------------------------------------------

  it("reset creates fresh controllers so new registrations are not pre-aborted", () => {
    const manager = new AbortManager();
    manager.registerRequest("req-1");
    manager.abortAll("KILL_GRACEFUL");

    expect(manager.isAborted()).toBe(true);
    expect(manager.getActiveRequestIds()).toEqual(["req-1"]);

    manager.reset();

    expect(manager.isAborted()).toBe(false);
    expect(manager.getActiveRequestIds()).toEqual([]);

    // New registration gets a non-aborted signal
    const signal = manager.registerRequest("req-new");
    expect(signal.aborted).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Multiple requests: independent lifecycle
  // -----------------------------------------------------------------------

  it("supports registering, aborting, and deregistering multiple requests independently", () => {
    const manager = new AbortManager();

    const signal1 = manager.registerRequest("req-1");
    const signal2 = manager.registerRequest("req-2");
    const signal3 = manager.registerRequest("req-3");

    // Cancel req-2 only
    manager.abortRequest("req-2", "CANCEL");
    expect(signal1.aborted).toBe(false);
    expect(signal2.aborted).toBe(true);
    expect(signal3.aborted).toBe(false);

    // Deregister req-1 (completed normally)
    manager.deregisterRequest("req-1");
    expect(manager.getActiveRequestIds()).toEqual(["req-2", "req-3"]);

    // req-1 signal still not aborted (it completed, wasn't cancelled)
    expect(signal1.aborted).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Abort reason propagation
  // -----------------------------------------------------------------------

  it("propagates abort reason via the signal", () => {
    const manager = new AbortManager();
    const signal = manager.registerRequest("req-1");

    let receivedReason: unknown = null;
    signal.addEventListener("abort", () => {
      receivedReason = signal.reason;
    });

    manager.abortRequest("req-1", "CANCEL");
    expect(receivedReason).toBe("CANCEL");
  });

  it("propagates global abort reason via all signals", () => {
    const manager = new AbortManager();
    const signal1 = manager.registerRequest("req-1");
    const signal2 = manager.registerRequest("req-2");

    const reasons: unknown[] = [];
    signal1.addEventListener("abort", () => reasons.push(signal1.reason));
    signal2.addEventListener("abort", () => reasons.push(signal2.reason));

    manager.abortAll("KILL_HARD");

    // Both signals fire; the composite fires from the global controller's abort
    expect(reasons.length).toBe(2);
  });
});
