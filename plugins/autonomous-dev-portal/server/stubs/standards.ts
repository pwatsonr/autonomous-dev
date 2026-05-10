// SPEC-036-1-06 §stubs/standards.ts — minimal hand-written rule set.
//
// Drives the Dashboard's standards-drift summary in stub mode. Three
// rules cover all three severities. At least one rule has `hits > 0`
// so the drift table renders a row in the default render.
//
// `applies` predicate strings keyed off repo names from
// `stubs/repos.ts` (see lib/standards-drift.ts for the predicate
// grammar — `"*"` matches every repo).

import type { StandardRule } from "../types/render";

const STUB: StandardRule[] = [
    {
        id: "STD-001",
        severity: "blocking",
        desc: "All public functions must have a doc comment.",
        applies: "*",
        source: "tdd-036",
        immutable: true,
        hits: 3,
    },
    {
        id: "STD-002",
        severity: "warn",
        desc: "Avoid `any` in TypeScript surface types.",
        applies: "acme",
        source: "tdd-036",
        immutable: false,
        hits: 1,
    },
    {
        id: "STD-003",
        severity: "advisory",
        desc: "Prefer named exports over default exports.",
        applies: "*",
        source: "tdd-036",
        immutable: false,
        hits: 0,
    },
];

export async function loadStandardsStub(): Promise<StandardRule[]> {
    return STUB;
}
