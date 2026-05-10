// SPEC-036-2-01 §FR-10 — Costs stub. Operator-realistic data:
//   8 phases, 6 reviewers (mix of generic + specialist), 3 envs across
//   2 backends, 30 daily points.

import type { CostSeries } from "../types/render";

const DAILY_POINTS = [
    { label: "d1", value: 8.4 },
    { label: "d2", value: 11.2 },
    { label: "d3", value: 9.7 },
    { label: "d4", value: 14.8 },
    { label: "d5", value: 12.3 },
    { label: "d6", value: 6.5 },
    { label: "d7", value: 5.9 },
    { label: "d8", value: 13.6 },
    { label: "d9", value: 17.2 },
    { label: "d10", value: 15.4 },
    { label: "d11", value: 11.0 },
    { label: "d12", value: 9.3 },
    { label: "d13", value: 7.8 },
    { label: "d14", value: 18.4 },
    { label: "d15", value: 14.0 },
    { label: "d16", value: 12.6 },
    { label: "d17", value: 10.8 },
    { label: "d18", value: 16.4 },
    { label: "d19", value: 19.0 },
    { label: "d20", value: 13.2 },
    { label: "d21", value: 8.6 },
    { label: "d22", value: 7.2 },
    { label: "d23", value: 11.8 },
    { label: "d24", value: 14.4 },
    { label: "d25", value: 12.0 },
    { label: "d26", value: 16.6 },
    { label: "d27", value: 13.8 },
    { label: "d28", value: 11.4 },
    { label: "d29", value: 14.2 },
    { label: "d30", value: 12.8 },
];

const PHASE_SPEND = [
    { phase: "prd", cost: 18.42, pct: 5 },
    { phase: "tdd", cost: 32.18, pct: 9 },
    { phase: "plan", cost: 41.55, pct: 12 },
    { phase: "spec", cost: 28.74, pct: 8 },
    { phase: "code", cost: 96.12, pct: 28 },
    { phase: "review", cost: 64.31, pct: 18 },
    { phase: "deploy", cost: 39.86, pct: 11 },
    { phase: "observe", cost: 30.92, pct: 9 },
];

const REVIEWER_SPEND = [
    {
        name: "qa-edge-case",
        role: "specialist" as const,
        runs: 142,
        fpRate: 0.06,
        cost: 28.4,
    },
    {
        name: "ux-ui",
        role: "specialist" as const,
        runs: 98,
        fpRate: 0.11,
        cost: 19.8,
    },
    {
        name: "accessibility",
        role: "specialist" as const,
        runs: 64,
        fpRate: 0.08,
        cost: 14.2,
    },
    {
        name: "rule-set",
        role: "generic" as const,
        runs: 312,
        fpRate: 0.04,
        cost: 22.6,
    },
    {
        name: "security",
        role: "specialist" as const,
        runs: 56,
        fpRate: 0.13,
        cost: 16.8,
    },
    {
        name: "format-check",
        role: "generic" as const,
        runs: 488,
        fpRate: null,
        cost: 9.4,
    },
];

const DEPLOY_SPEND = [
    {
        env: "prod",
        backend: "gcp",
        deploys: 14,
        lastDeploy: "14:31",
        health: "ok" as const,
        cost: 22.4,
    },
    {
        env: "staging",
        backend: "k8s",
        deploys: 32,
        lastDeploy: "13:48",
        health: "ok" as const,
        cost: 11.8,
    },
    {
        env: "edge",
        backend: "aws",
        deploys: 8,
        lastDeploy: "12:22",
        health: "warn" as const,
        cost: 5.6,
    },
];

const TOTAL_MTD = 352.1;

const STUB: CostSeries = {
    points: DAILY_POINTS,
    budgetUsd: 500,
    phaseSpend: PHASE_SPEND,
    reviewerSpend: REVIEWER_SPEND,
    deploySpend: DEPLOY_SPEND,
    totalMtd: TOTAL_MTD,
    requestCount: 84,
    costCap: 500,
};

export async function loadCostsStub(): Promise<CostSeries> {
    return STUB;
}
