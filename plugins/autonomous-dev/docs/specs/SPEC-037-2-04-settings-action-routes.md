# SPEC-037-2-04: Settings Action Routes (save / allowlist / notifications)

## Metadata
- **Parent Plan**: PLAN-037-2-mount-missing-routes
- **Parent PRD**: PRD-018-portal-visual-redesign (Settings page)
- **Tasks Covered**: PLAN-037-2 §Scope item 5
- **Estimated effort**: 0.75 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09
- **Safety Class**: ELEVATED (writes to `~/.claude/autonomous-dev.json`; sends external network calls)

## 1. Summary

Add five POST routes that back the Settings page tabs: a single form-save endpoint, an
allowlist add endpoint with git-worktree validation, and three notification test fan-outs
(Discord webhook, Slack webhook, the generic `send` channel). All five use existing
infrastructure: the atomic config writer from `lib/config-writer.ts`, the notification
engine from `lib/notifications`, and the audit logger.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                                                                       |
|-------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1  | Register `POST /settings` (form-encoded; same path as the GET — Hono dispatches by method), `POST /api/settings/allowlist`, and `POST /api/settings/notifications/test/{discord,slack,send}`.      |
| FR-2  | `POST /settings` MUST parse the form body, validate against the existing settings schema (Zod or equivalent), and write via the existing atomic-write helper (`fs.writeFile` to a temp file + rename). |
| FR-3  | On schema failure, return 422 with an HTML error fragment naming the bad field. On write failure, return 500 with a generic-error fragment.                                                        |
| FR-4  | `POST /api/settings/allowlist` body `{path: string}` MUST validate the path via `git -C <path> rev-parse --is-inside-work-tree`. Non-repo → 422 `{error:"not-a-git-repo"}`.                          |
| FR-5  | Allowlist add MUST refuse paths outside the operator's home tree (`!path.startsWith(homedir())`) and reject symlinks via `fs.realpath` → 403 `{error:"path-outside-home"}` or `{error:"symlink-rejected"}`. |
| FR-6  | The three notification test endpoints MUST call into the existing notification engine with a fixed test payload `{title:"Portal test", body:"Triggered by <actor> at <iso>"}`. No request-supplied content. |
| FR-7  | Each successful mutation MUST emit an audit entry: `settings_saved`, `settings_allowlist_added`, or `notification_test_sent` with channel name and result.                                          |
| FR-8  | All five POST routes MUST honor upstream CSRF middleware — no per-route exemption.                                                                                                                  |
| FR-9  | After a successful save, return the updated settings fragment (`text/html`) for HTMX `outerHTML` swap. Returning the full page is forbidden — it would trip HTMX's swap target.                    |
| FR-10 | Notification test routes MUST timeout the outbound call at 5_000ms; timeout → 504 `{error:"notification-timeout"}` and an audit entry with `result:"timeout"`.                                       |

## 3. Acceptance Criteria

### AC-1: Settings save happy path (FR-2, FR-7, FR-9)
```
POST /settings with valid form
→ 200 text/html (updated form fragment)
→ ~/.claude/autonomous-dev.json updated atomically
→ audit entry settings_saved appended
```

### AC-2: Settings save validation failure (FR-3)
```
POST /settings missing required field
→ 422 + HTML error fragment naming the field
→ config file UNCHANGED
```

### AC-3: Allowlist add happy path (FR-4)
```
POST /api/settings/allowlist {"path":"/Users/op/repos/foo"} where foo is a git repo
→ 200 + HTML row fragment
→ audit entry settings_allowlist_added
```

### AC-4: Allowlist non-repo (FR-4)
```
POST /api/settings/allowlist {"path":"/tmp/not-a-repo"}
→ 422 {"error":"not-a-git-repo"}
```

### AC-5: Allowlist symlink/escape (FR-5)
```
POST /api/settings/allowlist {"path":"/etc/passwd"} OR a symlink pointing outside home
→ 403 {"error":"path-outside-home"} OR {"error":"symlink-rejected"}
```

### AC-6: Notification test happy path (FR-6, FR-7)
```
POST /api/settings/notifications/test/discord
→ 200 {"sent":true,"channel":"discord"}
→ outbound POST to configured Discord webhook with fixed payload
→ audit entry notification_test_sent {channel:"discord", result:"ok"}
```

### AC-7: Notification test timeout (FR-10)
```
Given the upstream Discord webhook stalls for >5s
→ 504 {"error":"notification-timeout","channel":"discord"}
→ audit entry with result:"timeout"
```

### AC-8: CSRF on all five routes (FR-8)
```
POST without valid CSRF token → 403 from upstream middleware
```

## 4. Implementation

**File: `plugins/autonomous-dev-portal/server/routes/settings-actions.ts`** (new).

```ts
import { Hono } from "hono";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { realpath } from "node:fs/promises";

export interface SettingsActionDeps {
    writeConfig: (next: SettingsShape) => Promise<void>;
    addAllowlist: (path: string) => Promise<void>;
    notify: (channel: "discord"|"slack"|"send", payload: { title: string; body: string }) =>
        Promise<{ ok: true } | { ok: false; reason: "timeout" | "error" }>;
    audit: AuditLogger;
    schema: { parse(input: unknown): SettingsShape };
}

export function buildSettingsActionRoutes(deps: SettingsActionDeps): Hono {
    const r = new Hono();
    r.post("/settings", async (c) => { /* parse form, validate, write, audit, return fragment */ });
    r.post("/api/settings/allowlist", async (c) => {
        const body = await c.req.json() as { path?: unknown };
        if (typeof body.path !== "string") return c.json({ error: "invalid-body" }, 400);
        const real = await realpath(body.path).catch(() => null);
        if (real === null || !real.startsWith(homedir()))
            return c.json({ error: "path-outside-home" }, 403);
        const r = spawnSync("git", ["-C", real, "rev-parse", "--is-inside-work-tree"]);
        if (r.status !== 0) return c.json({ error: "not-a-git-repo" }, 422);
        await deps.addAllowlist(real);
        await deps.audit.append({ event: "settings_allowlist_added", path: real });
        return c.html(/* row fragment */);
    });
    for (const ch of ["discord","slack","send"] as const) {
        r.post(`/api/settings/notifications/test/${ch}`, async (c) => {
            const result = await deps.notify(ch, {
                title: "Portal test",
                body: `Triggered by ${actor} at ${new Date().toISOString()}`,
            });
            await deps.audit.append({ event:"notification_test_sent", channel: ch,
                result: result.ok ? "ok" : result.reason });
            if (!result.ok && result.reason === "timeout")
                return c.json({ error: "notification-timeout", channel: ch }, 504);
            if (!result.ok) return c.json({ error: "notification-failed", channel: ch }, 502);
            return c.json({ sent: true, channel: ch });
        });
    }
    return r;
}
```

## 5. Tests

**Integration — `tests/integration/settings-actions.test.ts`:**

| Test ID | Scenario                        | Assert                                                          |
|---------|---------------------------------|-----------------------------------------------------------------|
| SA-01   | save happy                       | 200 + fragment, config file updated, audit entry                |
| SA-02   | save validation fail             | 422 + error fragment, config UNCHANGED                          |
| SA-03   | allowlist happy                  | 200 + row, audit entry, store contains path                     |
| SA-04   | allowlist non-repo               | 422 not-a-git-repo                                              |
| SA-05   | allowlist outside home / symlink | 403                                                             |
| SA-06   | notification happy (mocked)      | 200 sent:true, audit ok                                         |
| SA-07   | notification timeout (mocked)    | 504 + audit result:timeout                                      |
| SA-08   | CSRF rejection                   | 403 upstream                                                    |

## 6. Verification

```bash
curl -i -X POST -b session=... -H "X-CSRF-Token: $TOK" \
  --data-urlencode "general.timezone=UTC" http://localhost:8787/settings
# Expect: 200 + HTML fragment

curl -i -X POST -b session=... -H "X-CSRF-Token: $TOK" \
  -H "Content-Type: application/json" -d '{"path":"/Users/op/repos/foo"}' \
  http://localhost:8787/api/settings/allowlist
# Expect: 200 + row fragment OR 422/403 as appropriate

curl -i -X POST -b session=... -H "X-CSRF-Token: $TOK" \
  http://localhost:8787/api/settings/notifications/test/discord
# Expect: 200 {"sent":true,"channel":"discord"}
```
