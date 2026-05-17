// PLAN-021 Phase 1A — Typed fixture builders for RequestActionFile.
//
// Provides aRequest, aGate, aFailed, aCancelled, aDone for creating
// consistent test data. Phase 1B will add more complex builders.

interface RequestActionFile {
    id?: string;
    repo?: string;
    title?: string;
    phase?: string;
    status?: "queued" | "running" | "gate" | "done" | "cancelled" | "failed";
    cost?: number;
    variant?: string;
    createdAt?: string;
    completedAt?: string;
    score?: number;
    turns?: number;
    waitedMin?: number;
}

/**
 * Basic request builder with sensible defaults.
 */
export function aRequest(overrides: Partial<RequestActionFile> = {}): RequestActionFile {
    return {
        id: "test-request-1",
        repo: "test-repo",
        title: "Test Request",
        phase: "intake",
        status: "running",
        cost: 0,
        variant: "standard",
        createdAt: new Date().toISOString(),
        turns: 0,
        score: 0,
        ...overrides,
    };
}

/**
 * Request in gate status (awaiting approval).
 */
export function aGate(overrides: Partial<RequestActionFile> = {}): RequestActionFile {
    return aRequest({
        status: "gate",
        phase: "approval",
        ...overrides,
    });
}

/**
 * Failed request with completion timestamp.
 */
export function aFailed(overrides: Partial<RequestActionFile> = {}): RequestActionFile {
    return aRequest({
        status: "failed",
        completedAt: new Date().toISOString(),
        ...overrides,
    });
}

/**
 * Cancelled request with completion timestamp.
 */
export function aCancelled(overrides: Partial<RequestActionFile> = {}): RequestActionFile {
    return aRequest({
        status: "cancelled",
        completedAt: new Date().toISOString(),
        ...overrides,
    });
}

/**
 * Successfully completed request with metrics.
 */
export function aDone(overrides: Partial<RequestActionFile> = {}): RequestActionFile {
    return aRequest({
        status: "done",
        phase: "complete",
        completedAt: new Date().toISOString(),
        score: 85,
        turns: 3,
        cost: 1.25,
        ...overrides,
    });
}