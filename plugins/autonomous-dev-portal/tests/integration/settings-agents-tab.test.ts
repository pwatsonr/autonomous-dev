// BUG-11 regression test: Settings Agents tab reads live registry
//
// Ensures the settings page with agents tab active renders real agent names
// from the live registry instead of hardcoded fixture data.

import { expect, test } from "bun:test";
import type { Hono } from "hono";

import { buildTestApp } from "../fixtures/test-app-factory";

test("settings Agents tab renders real agent names from live registry", async () => {
    const app: Hono = buildTestApp();

    // GET /settings?tab=agents should render the agents tab with live registry data
    const response = await app.request("/settings?tab=agents");
    expect(response.status).toBe(200);

    const html = await response.text();

    // Should contain real agent names (from manifest scan)
    expect(html).toMatch(/accessibility-reviewer|code-executor|architecture-reviewer/);

    // Should NOT contain stale names from hardcoded fixture
    expect(html).not.toMatch(/\barchitect\b/);
    expect(html).not.toMatch(/\bcoder\b/);
    expect(html).not.toMatch(/\bgate-keeper\b/);

    // Should have the agents tab active
    expect(html).toMatch(/data-tab-panel="agents"[^>]*>/);
    expect(html).not.toMatch(/data-tab-panel="agents"[^>]*hidden/);

    // Should have at least 18 agents listed (based on current manifest).
    // Crawl p10: rows now Inspect via the shared /agents modal endpoint
    // (one source of truth; the old per-row data-agent modal ids and
    // fabricated metric columns are gone).
    const agentRows = html.match(/hx-get="\/agents\/[^"]+\/inspect-modal"/g);
    expect(agentRows).not.toBeNull();
    expect(agentRows!.length).toBeGreaterThanOrEqual(18);
});

test("settings Agents tab inspect modal links use real agent names", async () => {
    const app: Hono = buildTestApp();

    const response = await app.request("/settings?tab=agents");
    expect(response.status).toBe(200);

    const html = await response.text();

    // Inspect links should hit the shared modal endpoint with real names
    expect(html).toMatch(/\/agents\/(accessibility-reviewer|code-executor|architecture-reviewer)\/inspect-modal/);

    // Should NOT have links for stale stub names (end-anchored so
    // `architect` doesn't false-positive on `architecture-reviewer`).
    expect(html).not.toMatch(/\/agents\/(?:architect|coder|gate-keeper)\/inspect-modal/);
});