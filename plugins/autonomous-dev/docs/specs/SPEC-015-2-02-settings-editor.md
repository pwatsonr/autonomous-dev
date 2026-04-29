# SPEC-015-2-02: Settings Editor — Schema Render, Validate-on-Save, Atomic Write

## Metadata
- **Parent Plan**: PLAN-015-2
- **Tasks Covered**: Task 5 (settings page form), Task 6 (server-side validation chain), Task 7 (POST /settings handler), Task 8 (422 error UI)
- **Estimated effort**: 7 hours

## Description

Implement the live settings editor: a server-rendered Handlebars form that reflects the current `~/.claude/autonomous-dev.json` configuration, a server-side validation chain composing PLAN-014-3 primitives (path canonicalization, ReDoS-safe regex compilation, allowed-roots check), and the `POST /settings` endpoint that performs atomic writes through the intake router's `config-set` command. Validation failures return 422 with field-scoped error fragments swapped via HTMX. Success rewrites the panel and triggers a daemon-reload signal for active-behavior fields (cost caps, trust levels). This spec excludes the HTTP client (SPEC-015-2-03) and the daemon-reload event consumer (out of scope; handled by the daemon itself in TDD-001).

The atomic write is delegated to the intake router (so the portal never touches `~/.claude/autonomous-dev.json` directly). The router's `config-set` command performs `tmp + fsync + rename` per TDD-002 §2; the portal's only durability guarantee is "if `config-set` returned `ok: true`, the new config is committed."

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/portal/templates/pages/settings.hbs` | Create | Full settings page with sections |
| `src/portal/templates/fragments/settings-section.hbs` | Create | Reusable section partial (rendered server-side per HTMX swap) |
| `src/portal/templates/fragments/field-error.hbs` | Create | Inline error message fragment |
| `src/portal/lib/config-validator.ts` | Create | `ConfigurationValidator` class + rule registry |
| `src/portal/lib/form-parser.ts` | Create | `parseFormDataToConfig` (dotted keys → nested object) |
| `src/portal/routes/settings.ts` | Create | GET and POST handlers |
| `src/portal/app.ts` | Modify | Mount `settingsRouter` |
| `src/portal/lib/index.ts` | Modify | Re-export `ConfigurationValidator`, `parseFormDataToConfig` |

## Implementation Details

### Form Schema

The settings page renders four sections, each backed by a Handlebars `{{#section}}` block so HTMX can swap a single section on validation error without re-rendering the whole form.

| Section | Fields | Field name (form) | Type |
|---------|--------|-------------------|------|
| Cost Management | Daily cap, monthly cap | `costCaps.daily`, `costCaps.monthly` | number (USD) |
| Trust Levels | Per-repo dropdown | `trustLevels.<repoSlug>` | enum: untrusted/basic/trusted |
| Repository Allowlist | List of paths | `allowlist[]` | string[] |
| Notifications | Slack webhook, email | `notifications.slack.webhook`, `notifications.email.to` | string |

### Form Field → Config Path Mapping

`parseFormDataToConfig(formData: FormData): Record<string, unknown>` converts dotted form keys into a nested object:

```typescript
parseFormDataToConfig(new URLSearchParams("costCaps.daily=10&costCaps.monthly=300&allowlist[]=/a&allowlist[]=/b"))
// =>
{ costCaps: { daily: 10, monthly: 300 }, allowlist: ["/a", "/b"] }
```

Rules:
1. Keys without dots become top-level properties.
2. Keys with dots are split on `.` and walked into nested objects, creating intermediate objects on demand.
3. Keys ending with `[]` are appended to an array under their base name. Multiple values per key (HTML form convention) collapse into a single array.
4. Numeric-looking values for fields registered as `type=number` (see `NUMERIC_FIELDS` constant in `form-parser.ts`) are converted via `parseFloat`. Non-numeric (e.g., empty string) becomes `null`, which the validator catches.
5. Empty strings remain empty strings (validator decides whether empty is valid).
6. Form keys NOT in the schema registry are silently dropped (no through-write of unknown keys — defense in depth).

### Validation Chain

```typescript
export interface ValidationContext {
  fullConfig: Record<string, unknown>;
  userHomeDir: string;
  allowedRoots: string[];
  operatorId: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;            // human-readable, displayed in field-error fragment
  warnings?: string[];       // shown but submission allowed
}

export interface ValidationSummary {
  valid: boolean;
  fieldErrors: Record<string, string>;   // key = field path, value = message
  warnings: string[];
}

export class ConfigurationValidator {
  async validateConfiguration(
    config: Record<string, unknown>,
    ctx: ValidationContext
  ): Promise<ValidationSummary>;
}
```

#### Rule Registry

| Field | Rule |
|-------|------|
| `costCaps.daily` | Must be `> 0` and `<= 10000`. NaN/null/undefined → "Daily cost cap must be a positive number" |
| `costCaps.monthly` | Must be `> 0` and `<= 100000`. If `< (daily * 28)`, append warning "Monthly cap is less than 28x daily cap; may trigger frequently" |
| `allowlist[i]` | (1) Canonicalize via PLAN-014-3's `canonicalizePath`. (2) Reject if outside `ctx.allowedRoots`. (3) Reject if path does not exist OR is not a directory OR has no `.git` subdirectory. Error: "Path is not a git repository: <path>" |
| `trustLevels.<repo>` | Must be one of `untrusted`, `basic`, `trusted`. Other values → "Invalid trust level: <value>" |
| `notifications.slack.webhook` | If non-empty, must match `/^https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+$/` |
| `notifications.email.to` | If non-empty, must match RFC-5322-lite pattern (existing helper `isValidEmail`) |

Rules run in parallel with `Promise.all`. The summary aggregates: any rule with `valid: false` contributes to `fieldErrors`; warnings are concatenated. The summary is `valid` iff `fieldErrors` is empty.

ReDoS protection on regex pattern fields (if added later — not in this scope) reuses the test-compile primitive from PLAN-014-3 (`testCompileRegex(pattern, { timeoutMs: 50, maxInputLength: 256 })`).

### POST `/settings` Handler

```typescript
async function postSettings(c: Context): Promise<Response> {
  // 1. CSRF — handled by middleware (PLAN-014-2). If we reach here, CSRF passed.
  const operatorId = getOperatorId(c);
  const formData = await c.req.formData();
  const proposedConfig = parseFormDataToConfig(formData);

  // 2. Validate
  const summary = await validator.validateConfiguration(proposedConfig, {
    fullConfig: proposedConfig,
    userHomeDir: process.env.HOME ?? '/',
    allowedRoots: portalConfig.allowedRoots,
    operatorId,
  });

  if (!summary.valid) {
    // Re-render the form WITH error annotations, return 422
    return c.html(
      renderTemplate('pages/settings', {
        settings: proposedConfig,        // user's submitted values (sticky form)
        fieldErrors: summary.fieldErrors,
        warnings: summary.warnings,
        repositories: await loadRepoList(),
      }),
      422
    );
  }

  // 3. Submit to intake router
  const intakeResponse = await intakeClient.submitCommand({
    command: 'config-set',
    requestId: crypto.randomUUID(),
    source: 'portal',
    sourceUserId: operatorId,
    configChanges: proposedConfig,
  });

  if (!intakeResponse.success) {
    return c.html(
      renderTemplate('pages/settings', {
        settings: proposedConfig,
        serviceError: intakeResponse.error ?? 'Configuration update failed',
        repositories: await loadRepoList(),
      }),
      503
    );
  }

  // 4. Audit log
  await auditLogger.logConfigChange({
    operatorId,
    changedKeys: flattenKeys(proposedConfig),
    intakeCommandId: intakeResponse.commandId,
    timestamp: new Date().toISOString(),
  });

  // 5. Daemon reload if needed (delegated to SPEC-015-2-03 helper)
  if (requiresDaemonReload(proposedConfig)) {
    await intakeClient.submitCommand({
      command: 'daemon-reload',
      requestId: crypto.randomUUID(),
      source: 'portal',
      sourceUserId: operatorId,
      comment: 'Settings change requiring daemon reload',
    });
  }

  // 6. Re-render success
  return c.html(
    renderTemplate('pages/settings', {
      settings: proposedConfig,
      successMessage: 'Settings saved successfully',
      repositories: await loadRepoList(),
      warnings: summary.warnings,
    }),
    200
  );
}
```

`requiresDaemonReload` returns `true` if any of these top-level paths changed: `costCaps.*`, `trustLevels.*`, `circuitBreaker.enabled`, `killSwitch.engaged`. Pure UI/notification fields do NOT trigger reload.

`flattenKeys` produces dotted paths, e.g., `["costCaps.daily", "costCaps.monthly", "allowlist"]`, used by the audit log to identify what changed without exposing values (per audit minimization principle from PLAN-014-3).

### HTMX Swap on Validation Error

The form's root has `hx-target="this"` and `hx-swap="outerHTML"`. On 422, the server returns the same page template with `fieldErrors` populated; each section renders inline `field-error.hbs` partials below offending inputs. Sticky form values come from `settings` (the user's submitted values, NOT the on-disk config), so the user sees their typing preserved.

### Field Error Fragment

```handlebars
{{!-- field-error.hbs --}}
{{#if message}}
<div class="field-error" role="alert" data-field="{{field}}">
  <span class="error-icon" aria-hidden="true">!</span>
  <span class="error-text">{{message}}</span>
</div>
{{/if}}
```

Sections include this partial after each input:

```handlebars
<input type="number" id="cost-daily" name="costCaps.daily"
       value="{{settings.costCaps.daily}}"
       class="{{#if fieldErrors.[costCaps.daily]}}error{{/if}}">
{{> field-error field="costCaps.daily" message=fieldErrors.[costCaps.daily]}}
```

The `[costCaps.daily]` Handlebars literal-key syntax is required because the field name contains a dot.

### GET `/settings` Handler

Loads the current config via the read-only data accessor (PLAN-015-1), enumerates known repositories, and renders the page with no errors and no warnings. No user submitted values yet, so `settings = currentConfig` (read from disk).

```typescript
async function getSettings(c: Context): Promise<Response> {
  const settings = await configAccessor.read();
  const repositories = await loadRepoList();
  return c.html(renderTemplate('pages/settings', { settings, repositories }), 200);
}
```

## Acceptance Criteria

- [ ] `parseFormDataToConfig` converts `{costCaps.daily: "10"}` to `{costCaps: {daily: 10}}` (number) when the field is registered numeric
- [ ] `parseFormDataToConfig` collapses repeated `allowlist[]` entries into a single array preserving order
- [ ] `parseFormDataToConfig` drops keys not in the schema registry (defense in depth)
- [ ] `validateConfiguration` returns `valid: false` with `fieldErrors["costCaps.daily"]` set when value is `0`, negative, NaN, null, or > 10000
- [ ] `validateConfiguration` returns `valid: true` with a warning when `monthly < daily * 28`
- [ ] `validateConfiguration` rejects allowlist paths outside `ctx.allowedRoots` with a "not in allowed root" message
- [ ] `validateConfiguration` rejects allowlist paths that exist but are not git repositories
- [ ] `validateConfiguration` rejects trust levels not in the enum with a clear error
- [ ] POST `/settings` with invalid input returns 422, re-renders the form with sticky values, displays inline `field-error` fragments
- [ ] POST `/settings` with valid input calls `intakeClient.submitCommand({command: 'config-set', ...})` exactly once
- [ ] POST `/settings` with valid input AND a cost-cap change triggers a second `daemon-reload` command
- [ ] POST `/settings` with a notification-only change (no daemon-reload triggers) does NOT call `daemon-reload`
- [ ] POST `/settings` with intake router returning `ok: false` returns 503 and re-renders with `serviceError` populated
- [ ] Successful POST writes one audit entry containing `changedKeys` (dotted paths) and `intakeCommandId`
- [ ] Audit entry contains NO config values, only key paths (audit minimization)
- [ ] GET `/settings` reads current config via the read-only accessor (no intake router call)
- [ ] CSRF middleware is mounted before the POST handler

## Test Cases

1. **Form parser dotted key** — Input `FormData{ "costCaps.daily" => "10" }`. Assert: `{ costCaps: { daily: 10 } }`.
2. **Form parser array key** — Input `FormData{ "allowlist[]" => "/a", "allowlist[]" => "/b" }`. Assert: `{ allowlist: ["/a","/b"] }`.
3. **Form parser unknown key dropped** — Input `FormData{ "evilKey" => "x" }`. Assert: `evilKey` not present in result.
4. **Validator daily cap zero** — `validateConfiguration({ costCaps: { daily: 0, monthly: 100 } })`. Assert: `valid=false`, `fieldErrors["costCaps.daily"]` matches `/positive/`.
5. **Validator monthly cap warning** — `validateConfiguration({ costCaps: { daily: 10, monthly: 100 } })`. (100 < 10*28=280). Assert: `valid=true`, `warnings.length >= 1`.
6. **Validator allowlist outside root** — Pass `allowlist: ["/etc/passwd"]`, `allowedRoots: ["/Users/op"]`. Assert: `valid=false`, error mentions "not in allowed root".
7. **Validator allowlist non-git** — Mock fs so `/Users/op/foo` exists, is dir, has no `.git`. Assert: `valid=false`, error mentions "not a git repository".
8. **Validator allowlist happy path** — Mock `/Users/op/repo` exists, is dir, has `.git`. Assert: `valid=true`.
9. **Validator trust level invalid** — `trustLevels: { repoA: "godmode" }`. Assert: `valid=false`, error mentions "Invalid trust level".
10. **POST happy path** — Submit valid form. Assert: `intakeClient.submitCommand` called once with `command: 'config-set'`. Response status 200. HTML contains "Settings saved successfully".
11. **POST cost-cap change triggers reload** — Submit form changing `costCaps.daily`. Assert: TWO `submitCommand` calls (`config-set` then `daemon-reload`).
12. **POST notification-only change skips reload** — Submit form changing only `notifications.email.to`. Assert: ONE `submitCommand` call.
13. **POST 422 sticky values** — Submit form with `costCaps.daily=0`. Assert: response 422; HTML body contains `value="0"` in the daily input AND `<div class="field-error">` adjacent.
14. **POST 503 on intake failure** — Mock `submitCommand` to return `{success:false, error:"Connection refused"}`. Assert: response 503; HTML contains "Connection refused" in the `serviceError` slot.
15. **Audit no values leaked** — Submit valid form. Inspect audit log entry. Assert: contains `changedKeys` array but NO `daily`, `monthly`, or path values.

## Dependencies

- SPEC-015-2-03: `IntakeRouterClient` instance (injected)
- PLAN-014-2: CSRF middleware (mounted before `POST /settings`)
- PLAN-014-3: `canonicalizePath`, `isInAllowedRoot`, `testCompileRegex` primitives
- PLAN-015-1: Read-only config accessor for GET handler
- TDD-002: Atomic write semantics (intake router responsibility)
- Existing `auditLogger.logConfigChange` from PLAN-009-5

## Notes

- Atomic writes are NOT performed by the portal. The portal sends a `config-set` command; the intake router does the tmp+fsync+rename. This intentional split centralizes durability semantics in one place per the project's principle of single-writer-per-file.
- The form is intentionally NOT submitted via JavaScript fetch + JSON. We use HTMX with `application/x-www-form-urlencoded` because it gives us sticky values and inline errors for free, with progressive enhancement (the page works without JS).
- Sticky values use the user's submitted (potentially invalid) input, NOT the on-disk config. This is critical UX: a user who typed `0` for daily cap should see `0` after the 422 with the error highlighted, not the old valid value reset under their fingers.
- Audit log values are intentionally only key paths, not values. Operators reviewing the audit log can correlate timestamps with on-disk config history if value diffs are needed; centralizing values in the audit log creates a secondary copy that complicates rotation and PII handling.
- The `allowlist` validator's git check uses `fs.stat(.git)` rather than executing `git`. This is fast and avoids spawning subprocesses inside the request handler.
- ReDoS protection is inherited from PLAN-014-3 primitives. We do NOT introduce regex pattern fields in this scope, but the rule registry has space for them (see `notifications.slack.webhook` for a fixed-pattern check; that pattern is hard-coded and not user-supplied).
- The 503 response intentionally re-renders the form with sticky values. The user can edit and retry without losing input.
