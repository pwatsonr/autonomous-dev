// SPEC-013-3-01 §Stub Data Modules — settings view.
// SPEC-036-4 — extends the stub to populate the redesigned five-tab
// Settings surface (general / variants / standards / backends / agents).

import type {
    AgentRecord,
    AgentRunRef,
    AllowlistEntry,
    DeployBackend,
    NotificationsConfig,
    PipelineVariant,
    SettingsData,
    SettingsView,
    StandardRule,
    TrustOverride,
} from "../types/render";

const STUB: SettingsView = {
    auth_mode: "localhost",
    port: 7878,
    log_level: "info",
};

export async function loadSettingsStub(): Promise<SettingsView> {
    return STUB;
}

// ---- SPEC-036-4 stub data shapes -------------------------------------------
//
// These deliver enough realism for snapshot/integration tests and the
// Storybook-ish visual review of the new tabs. They will be replaced by
// daemon registry reads once PLAN-036-5 wires persistence.

const TRUST_OVERRIDES: TrustOverride[] = [
    {
        repo: "acme/widgets",
        level: "L1",
        source: "~/.claude/autonomous-dev.json",
    },
    {
        repo: "system/core",
        level: "L3",
        source: "policy",
        immutable: true,
    },
];

const ALLOWLIST: AllowlistEntry[] = [
    {
        id: "rep-1",
        path: "/Users/op/repos/acme",
        status: "ok",
        addedAt: "2026-04-12T11:30:00Z",
    },
    {
        id: "rep-2",
        path: "/Users/op/repos/beta",
        status: "ok",
        addedAt: "2026-04-15T08:21:00Z",
    },
    {
        id: "rep-3",
        path: "/Users/op/repos/legacy-portal",
        status: "missing",
        addedAt: "2025-12-03T14:00:00Z",
    },
];

const NOTIFICATIONS: NotificationsConfig = {
    discordWebhook: "",
    slackWebhook: "",
    discordStatus: "muted",
    slackStatus: "muted",
    notifyDefault: "none",
    dndEnabled: false,
    dndStart: "22:00",
    dndEnd: "07:00",
};

const VARIANTS: PipelineVariant[] = [
    {
        id: "p8",
        label: "8-phase canonical",
        desc: "PRD → TDD → PLAN → SPEC → CODE → REVIEW → DEPLOY → OBSERVE",
        phases: [
            "prd",
            "tdd",
            "plan",
            "spec",
            "code",
            "review",
            "deploy",
            "observe",
        ],
        // SPEC-037-5-03 — reviewer chain per phase (`.rev-line` rendering).
        reviewers: {
            review: ["qa-edge-case", "security-reviewer"],
            code: ["code-reviewer"],
            deploy: ["release-manager"],
        },
    },
    {
        id: "fast",
        label: "Fast-track (4-phase)",
        desc: "PLAN → CODE → REVIEW → OBSERVE for tiny changes.",
        phases: ["plan", "code", "review", "observe"],
        reviewers: {
            review: ["qa-edge-case"],
            code: ["code-reviewer"],
        },
    },
];

const STANDARDS: StandardRule[] = [
    {
        id: "S-101",
        severity: "blocking",
        desc: "All public functions must have doc comments.",
        applies: "*",
        source: "global.yaml",
        immutable: false,
        hits: 4,
    },
    {
        id: "S-201",
        severity: "warn",
        desc: "Avoid TODOs in committed code.",
        applies: "*",
        source: "global.yaml",
        immutable: false,
        hits: 11,
    },
    {
        id: "S-301",
        severity: "advisory",
        desc: "Prefer named exports over default exports.",
        applies: "acme,beta",
        source: "team.yaml",
        immutable: false,
        hits: 0,
    },
];

// SPEC-037-5-04 — backend cards consume `name`, `kind` ("bundled"/"plugin"),
// `cost`, `caps`, and `status` ("available"/"not-installed") in addition to
// the legacy fields. The stub fans out across both kinds so the snapshot
// asserts the chip-class flip and the `not-installed` action footer.
const BACKENDS: DeployBackend[] = [
    {
        id: "fly-prod",
        label: "Fly.io (prod)",
        name: "Fly.io (prod)",
        kind: "bundled",
        enabled: true,
        health: "ok",
        cost: "$0.012 / run",
        caps: ["regions:auto", "blue/green", "rollback"],
        status: "available",
    },
    {
        id: "k8s-stage",
        label: "Kubernetes (staging)",
        name: "Kubernetes (staging)",
        kind: "bundled",
        enabled: true,
        health: "warn",
        cost: "$0.008 / run",
        caps: ["multi-region", "rollback"],
        status: "available",
    },
    {
        id: "render-canary",
        label: "Render (canary)",
        name: "Render (canary)",
        kind: "plugin",
        enabled: false,
        health: "muted",
        cost: "$0.020 / run",
        caps: ["preview-urls"],
        status: "not-installed",
    },
];

const AGENT_NAMES = [
    "architect",
    "code-reviewer",
    "coder",
    "dependency-auditor",
    "docs-writer",
    "explainer",
    "gate-keeper",
    "intake",
    "linter",
    "merger",
    "observer",
    "planner",
    "prd-author",
    "release-manager",
    "researcher",
    "security-reviewer",
    "spec-author",
    "tdd-author",
] as const;

function buildRecentRuns(seed: number): AgentRunRef[] {
    // Capped at 5 per agent (PLAN-036-4 risk row 6).
    const states: Array<"success" | "failed" | "cancelled"> = [
        "success",
        "success",
        "failed",
        "success",
        "cancelled",
    ];
    return states.map((status, i) => ({
        id: `run-${seed}-${i}`,
        startedAt: new Date(
            Date.UTC(2026, 4, 9, 12, seed % 60, i * 10),
        ).toISOString(),
        status,
        durationMs: 1500 + ((seed + i) % 7) * 350,
        cost: 0.25 + ((seed + i) % 5) * 0.13,
    }));
}

const AGENTS: AgentRecord[] = AGENT_NAMES.map((name, i) => {
    const state: AgentRecord["state"] =
        i < 6 ? "active" : i < 13 ? "shadow" : "frozen";
    return {
        name,
        role: name.split("-")[0] ?? name,
        state,
        approvalPct: 60 + (i * 7) % 40,
        precisionPct: 55 + (i * 11) % 45,
        recallPct: 50 + (i * 13) % 50,
        version: `1.${i}.0`,
        lastTrainedAt: new Date(
            Date.UTC(2026, 3, 1 + (i % 28), 9, 0, 0),
        ).toISOString(),
        recentRuns: buildRecentRuns(i),
    };
});

const SETTINGS_DATA: SettingsData = {
    activeTab: "general",
    trustLevel: "L2",
    trustOverrides: TRUST_OVERRIDES,
    allowlist: ALLOWLIST,
    costCaps: { perRequest: 1.0, daily: 25.0, monthly: 500.0 },
    currentSpend: { today: 4.18, month: 67.42 },
    notifications: NOTIFICATIONS,
    variants: VARIANTS,
    standards: STANDARDS,
    backends: BACKENDS,
    agents: AGENTS,
    // SPEC-037-5-02 — flat defaults consumed by the rebuilt General tab.
    dailyCap: 25,
    defaultVariant: "p8",
    defaultBackend: "fly-prod",
};

/**
 * SPEC-036-4 — load the rich Settings data shape used by the redesigned
 * five-tab page. The stub returns a deep clone so callers may mutate
 * `activeTab` or any nested value without leaking state into other tests.
 */
export async function loadSettingsData(): Promise<SettingsData> {
    return JSON.parse(JSON.stringify(SETTINGS_DATA)) as SettingsData;
}
