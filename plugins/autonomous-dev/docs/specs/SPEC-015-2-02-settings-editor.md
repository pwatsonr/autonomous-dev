# SPEC-015-2-02: Settings Editor — Schema Render, Validate-on-Save, Atomic Write

## Metadata
- **Parent Plan**: PLAN-015-2
- **Tasks Covered**: Task 5 (settings page), Task 6 (validation chain), Task 7 (POST /settings handler), Task 8 (422 error UI)
- **Estimated effort**: 7 hours

## Description

Implement the live settings editor: a server-rendered Handlebars form mirroring `~/.claude/autonomous-dev.json`, a validation chain composing PLAN-014-3 primitives (path canonicalization, ReDoS-safe regex compilation, allowed-roots check), and the `POST /settings` endpoint that performs atomic writes through the intake router's `config-set` command. Validation failures return 422 with field-scoped error fragments swapped via HTMX. Success rewrites the panel and triggers a `daemon-reload` for active-behavior fields. The HTTP client is in SPEC-015-2-03 and is consumed here by reference; the daemon-reload event consumer is out of scope (handled by the daemon itself).

The atomic write is delegated to the intake router so the portal never touches `~/.claude/autonomous-dev.json` directly. The router's `config-set` command performs `tmp + fsync + rename` per TDD-002 §2; the portal's only durability guarantee is "if `config-set` returned `ok: true`, the new config is committed."

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/portal/templates/pages/settings.hbs` | Create | Full settings page with the four sections |
| `src/portal/templates/fragments/field-error.hbs` | Create | Inline error message fragment |
| `src/portal/lib/config-validator.ts` | Create | `ConfigurationValidator` class + rule registry |
| `src/portal/lib/form-parser.ts` | Create | `parseFormDataToConfig` (dotted keys → nested object) |
| `src/portal/routes/settings.ts` | Create | GET and POST handlers |
| `src/portal/app.ts` | Modify | Mount `settingsRouter` |
| `src/portal/lib/index.ts` | Modify | Re-export `ConfigurationValidator`, `parseFormDataToConfig` |

## Implementation Details

### Form Schema

The page renders four sections; each can be re-rendered with inline errors without rewriting the whole form.

| Section | Fields | Form keys | Type |
|---|---|---|---|
| Cost Management | Daily cap, monthly cap | `costCaps.daily`, `costCaps.monthly` | number (USD) |
| Trust Levels | Per-repo dropdown | `trustLevels.<repoSlug>` | enum: untrusted/basic/trusted |
| Repository Allowlist | List of paths | `allowlist[]` | string[] |
| Notifications | Slack webhook, email | `notifications.slack.webhook`, `notifications.email.to` | string |

### Form Parser

`parseFormDataToConfig(formData: FormData): Record<string, unknown>` rules:

1. Keys without dots → top-level properties.
2. Keys with dots → split on `.`, walk into nested objects, creating intermediates on demand.
3. Keys ending with `[]` → append to an array under the base name.
4. Numeric-looking values for fields registered in `NUMERIC_FIELDS` constant (e.g., `costCaps.daily`) are parsed via `parseFloat`. Non-numeric becomes `null` (validator catches).
5. Empty strings remain empty strings.
6. Form keys NOT in the schema registry are silently dropped (defense in depth).

Example: `{ "costCaps.daily" => "10", "allowlist[]" => "/a", "allowlist[]" => "/b" }` becomes `{ costCaps: { daily: 10 }, allowlist: ["/a", "/b"] }`.

### Validation Chain

```typescript
export interface ValidationContext {
  fullConfig: Record<string, unknown>;
  userHomeDir: string;
  allowedRoots: string[];
  operatorId: string;
}

export interface ValidationSummary {
  valid: boolean;
  fieldErrors: Record<string, string>;   // key = dotted field path, value = message
  warnings: string[];
}

export class ConfigurationValidator {
  async validateConfiguration(config: Record<string, unknown>, ctx: ValidationContext): Promise<ValidationSummary>;
}
```

Rule registry:

| Field | Rule |
|---|---|
| `costCaps.daily` | Must be `> 0` and `<= 10000`. NaN/null/empty → "Daily cost cap must be a positive number" |
| `costCaps.monthly` | Must be `> 0` and `<= 100000`. If `< (daily * 28)`, append warning "Monthly cap is less than 28x daily cap; may trigger frequently" |
| `allowlist[i]` | (1) `canonicalizePath` (PLAN-014-3); (2) reject if outside `ctx.allowedRoots`; (3) reject if path missing OR not a directory OR no `.git` subdir → "Path is not a git repository: <path>" |
| `trustLevels.<repo>` | Must be `untrusted`/`basic`/`trusted`. Else → "Invalid trust level: <value>" |
| `notifications.slack.webhook` | If non-empty, must match `/^https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+$/` |
| `notifications.email.to` | If non-empty, must match the existing `isValidEmail` helper |

Rules run via `Promise.all`. Any rule with `valid: false` adds an entry to `fieldErrors`. The summary is `valid` iff `fieldErrors` is empty. Allowlist `git` check uses `fs.stat('.git')` rather than spawning `git`.

### POST `/settings` Handler

1. CSRF middleware (PLAN-014-2) runs first. Reaching the handler implies CSRF passed.
2. `getOperatorId(c)`, parse formData, `parseFormDataToConfig` → `proposedConfig`.
3. `validator.validateConfiguration(proposedConfig, ctx)` → `summary`.
4. If `!summary.valid`: re-render `pages/settings` with `settings = proposedConfig` (sticky values), `fieldErrors = summary.fieldErrors`, `warnings`. Return 422.
5. Else: `intakeClient.submitCommand({command:'config-set', requestId: uuid, source:'portal', sourceUserId, configChanges: proposedConfig})`.
6. If `!success`: re-render with `serviceError = response.error`. Return 503.
7. Audit: `auditLogger.logConfigChange({operatorId, changedKeys: flattenKeys(proposedConfig), intakeCommandId, timestamp})`. Audit stores ONLY key paths, never values.
8. If `requiresDaemonReload(proposedConfig)` (from SPEC-015-2-03): `intakeClient.submitCommand({command:'daemon-reload', source:'portal', sourceUserId, comment:'Settings change requiring daemon reload'})`. Failure here logs but does NOT fail the user request — config commit already succeeded.
9. Re-render `pages/settings` with `successMessage = 'Settings saved successfully'` and any `warnings`. Return 200.

### GET `/settings`

Read current config via PLAN-015-1 read-only accessor, enumerate repositories, render with no errors. `settings = currentConfig`.

### HTMX Swap on Validation Error

The form root has `hx-target="this"` and `hx-swap="outerHTML"`. On 422 the server returns the same page template; each input renders `field-error.hbs` partial below it when `fieldErrors[fieldName]` is set. Sticky values come from the user's submitted values (not on-disk config) so editing a value to `0` shows `value="0"` adjacent to its error message.

### Field Error Fragment

```handlebars
{{#if message}}
<div class="field-error" role="alert" data-field="{{field}}">
  <span class="error-icon" aria-hidden="true">!</span>
  <span class="error-text">{{message}}</span>
</div>
{{/if}}
```

Used per input: `{{> field-error field="costCaps.daily" message=fieldErrors.[costCaps.daily]}}`. The `[bracket]` Handlebars syntax is required because field names contain dots.

## Acceptance Criteria

- [ ] `parseFormDataToConfig({costCaps.daily: "10"})` returns `{costCaps: {daily: 10}}` (number) when registered numeric
- [ ] `parseFormDataToConfig` collapses repeated `allowlist[]` entries into an array preserving order
- [ ] `parseFormDataToConfig` drops keys not in the schema registry
- [ ] `validateConfiguration` returns `valid:false` with `fieldErrors["costCaps.daily"]` set when value is `0`, negative, NaN, null, or `> 10000`
- [ ] `validateConfiguration` returns `valid:true` with a warning when `monthly < daily * 28`
- [ ] `validateConfiguration` rejects allowlist paths outside `ctx.allowedRoots`
- [ ] `validateConfiguration` rejects allowlist paths that exist but are not git repositories
- [ ] `validateConfiguration` rejects trust levels outside the enum
- [ ] POST `/settings` with invalid input returns 422, re-renders with sticky values and inline `field-error` fragments
- [ ] POST `/settings` with valid input calls `intakeClient.submitCommand({command:'config-set'})` exactly once
- [ ] POST `/settings` with a cost-cap change triggers a second `daemon-reload` command
- [ ] POST `/settings` with notification-only changes does NOT call `daemon-reload`
- [ ] POST `/settings` with intake `success:false` returns 503 and re-renders with `serviceError`
- [ ] Daemon-reload failure after config-set success does NOT fail the user request (logged only)
- [ ] Audit entry contains `changedKeys` (dotted paths) but NO config values
- [ ] GET `/settings` reads current config via the read-only accessor (no intake call)
- [ ] CSRF middleware runs before POST handler

## Test Cases

1. **Form parser dotted** — `{costCaps.daily: "10"}` → `{costCaps:{daily:10}}`.
2. **Form parser array** — two `allowlist[]` entries → array preserving order.
3. **Form parser unknown key dropped** — `{evilKey:"x"}` → result has no `evilKey`.
4. **Validator daily zero** — `{costCaps:{daily:0,monthly:100}}` → `valid:false`, error `/positive/`.
5. **Validator monthly warning** — `{costCaps:{daily:10,monthly:100}}` → `valid:true`, `warnings.length>=1`.
6. **Validator allowlist outside root** — `allowlist:["/etc/passwd"]`, `allowedRoots:["/Users/op"]` → `valid:false`, error mentions "not in allowed root".
7. **Validator allowlist non-git** — mock fs: dir exists, no `.git` → `valid:false`, error `/not a git repository/`.
8. **Validator allowlist happy** — mock fs: dir + `.git` exists → `valid:true`.
9. **Validator trust invalid** — `trustLevels:{repoA:"godmode"}` → `valid:false`.
10. **POST happy path** — `submitCommand` called once with `config-set`. 200, body contains "Settings saved successfully".
11. **POST cost-cap triggers reload** — TWO submitCommand calls: `config-set` then `daemon-reload`.
12. **POST notifications-only no reload** — ONE submitCommand call.
13. **POST 422 sticky values** — `daily=0`. Response 422; HTML contains `value="0"` AND `<div class="field-error">` adjacent.
14. **POST 503 on intake failure** — mock `success:false, error:"Connection refused"`. Response 503; HTML contains "Connection refused".
15. **POST reload failure non-fatal** — `config-set` returns success; `daemon-reload` throws. Response 200 (with warning logged).
16. **Audit no values leaked** — submit valid form. Audit entry has `changedKeys` array; serialized JSON does NOT contain submitted values.

## Dependencies

- SPEC-015-2-03: `IntakeRouterClient` instance (injected); `requiresDaemonReload`, `flattenKeys` helpers
- PLAN-014-2: CSRF middleware (mounted before `POST /settings`)
- PLAN-014-3: `canonicalizePath`, `isInAllowedRoot` primitives; `isValidEmail` helper
- PLAN-015-1: Read-only config accessor for GET handler
- TDD-002: Atomic write semantics (intake router responsibility, not the portal)
- Existing `auditLogger.logConfigChange` from PLAN-009-5

## Notes

- Atomic writes are NOT performed by the portal. The portal sends a `config-set` command; the intake router does the tmp+fsync+rename. This intentional split centralizes durability semantics in one place per the project's single-writer-per-file principle.
- The form is intentionally NOT submitted via JSON+fetch. HTMX with `application/x-www-form-urlencoded` gives sticky values and inline errors essentially for free, with progressive enhancement (the page works without JS).
- Sticky values use the user's submitted (potentially invalid) input, NOT the on-disk config. A user who typed `0` for daily cap should see `0` after the 422 with the error highlighted, not the old valid value reset under their fingers.
- Audit log values are intentionally key paths only, not values. Operators reviewing the audit log can correlate timestamps with on-disk config history if value diffs are needed; centralizing values here would create a secondary copy that complicates rotation and PII handling.
- A failed `daemon-reload` after a successful `config-set` is logged but does not surface as a user error: the canonical config is already updated, and the daemon will pick it up on its next natural restart even if the explicit signal was lost.
