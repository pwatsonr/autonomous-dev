// SPEC-013-1-02 §`lifecycle.test.ts` (smoke) — 3 minimum tests for the
// shutdown coordinator framework. Comprehensive coverage (priority order
// under real signals, force-exit deadline, debounce, throw-and-continue)
// lands in SPEC-013-1-04 once Bun + the test runner are wired up.
//
// TODO(PLAN-013-1 batch 4b): wire to the portal's own bun-test config so
// `bun test` from this directory picks this file up. Today the test file
// stands alone; SPEC-013-1-04 imports the same module and adds the rest.

import { describe, expect, test, beforeEach } from "bun:test";

import {
    _resetForTest,
    _resourcesForTest,
    initLifecycle,
    registerResource,
} from "./lifecycle";

beforeEach(() => {
    _resetForTest();
});

describe("lifecycle (smoke)", () => {
    test("registerResource adds entries in priority order", () => {
        const noop = (): void => {};
        registerResource({ name: "b", priority: 20, cleanup: noop });
        registerResource({ name: "a", priority: 10, cleanup: noop });
        registerResource({ name: "c", priority: 30, cleanup: noop });

        const ordered = _resourcesForTest();
        expect(ordered.map((r) => r.name)).toEqual(["a", "b", "c"]);
        expect(ordered.map((r) => r.priority)).toEqual([10, 20, 30]);
    });

    test("initLifecycle is idempotent", () => {
        const beforeSigterm = process.listenerCount("SIGTERM");
        const beforeSigint = process.listenerCount("SIGINT");

        initLifecycle();
        const afterFirstSigterm = process.listenerCount("SIGTERM");
        const afterFirstSigint = process.listenerCount("SIGINT");
        expect(afterFirstSigterm).toBe(beforeSigterm + 1);
        expect(afterFirstSigint).toBe(beforeSigint + 1);

        // Second call: must NOT add another listener.
        initLifecycle();
        expect(process.listenerCount("SIGTERM")).toBe(afterFirstSigterm);
        expect(process.listenerCount("SIGINT")).toBe(afterFirstSigint);
    });

    test("registerResource validates inputs", () => {
        const noop = (): void => {};

        // empty name
        expect(() =>
            registerResource({ name: "", priority: 1, cleanup: noop }),
        ).toThrow(TypeError);

        // non-integer priority
        expect(() =>
            registerResource({ name: "x", priority: 1.5, cleanup: noop }),
        ).toThrow(TypeError);

        // non-function cleanup
        expect(() =>
            registerResource({
                name: "x",
                priority: 1,
                // deliberate type-violation for the runtime check
                cleanup: "not-a-function" as unknown as () => void,
            }),
        ).toThrow(TypeError);
    });
});
