# SPEC-018-3-02: `submit-bug` Interactive Flow & Bug-Context Validation

## Metadata
- **Parent Plan**: PLAN-018-3
- **Tasks Covered**: Task 3 (interactive `submit-bug` subcommand), Task 4 (bug-context validation on `--type bug`)
- **Estimated effort**: 6 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-018-3-02-submit-bug-interactive-flow-bug-context-validation.md`

## Description
Add the dedicated `autonomous-dev request submit-bug` subcommand that walks an operator through entering a structured `BugReport` payload — interactively when stdin is a TTY, or via CLI flags when scripted. Concurrently, harden the existing `request submit --type bug` path so it refuses bug submissions that arrive without a populated `bug_context`, pointing operators at the right command. This is the user-facing intake surface for bug-typed requests; without it, operators cannot ergonomically file a bug end-to-end.

Interactive prompts are implemented with `inquirer@9.x` (pinned). All prompts validate inline using the AJV schema from SPEC-018-3-01; the user is re-prompted on validation failure rather than the command aborting. Non-interactive mode (closed stdin, all required flags supplied) skips inquirer entirely and validates once at the end.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/cli/commands/submit-bug.ts` | Create | New subcommand with interactive + non-interactive modes |
| `plugins/autonomous-dev/src/cli/commands/request-submit.ts` | Modify | Reject `--type bug` without `--bug-context-path` or interactive answers |
| `plugins/autonomous-dev/src/cli/lib/bug-prompts.ts` | Create | Inquirer prompt definitions, reusable across channels (Claude App imports later) |
| `plugins/autonomous-dev/src/cli/lib/bug-context-loader.ts` | Create | Loads + validates `--bug-context-path <file>` payloads |
| `plugins/autonomous-dev/package.json` | Modify | Pin `"inquirer": "^9.2.0"` |

## Implementation Details

### Subcommand Wiring (`bin/autonomous-dev.sh` & dispatcher)

Extend the bash dispatcher's request-subcommand allowlist (per SPEC-011-1-01) to include `submit-bug`. The bash layer performs no validation on the bug fields — all field validation lives in the TS handler.

### `submit-bug.ts` — Mode Detection

```typescript
const isInteractive = process.stdin.isTTY === true && !opts.nonInteractive;
const report: BugReport = isInteractive
  ? await runInteractivePrompts(opts)
  : await collectFromFlags(opts);

const ajv = new Ajv();
const validate = ajv.compile(BugReportSchema);
if (!validate(report)) {
  process.stderr.write(`Error: bug report validation failed:\n${formatErrors(validate.errors)}\n`);
  process.exit(1);
}

await submitToDaemon({ request_type: 'bug', bug_context: report, repo: opts.repo });
```

### Interactive Prompt Sequence (`bug-prompts.ts`)

Order matters; each prompt corresponds to a `BugReport` field:

1. `title` — input, validate `length 1..200`
2. `description` — `editor` (opens `$EDITOR`) or fallback to multiline input
3. `reproduction_steps` — looped `input` prompt; empty line ends the loop; `≥1` item required
4. `expected_behavior` — input, `length 1..2000`
5. `actual_behavior` — input, `length 1..2000`
6. `error_messages` — looped `input`; empty line ends the loop; zero items allowed
7. `environment.os` — input, default = output of `process.platform + os.release()`
8. `environment.runtime` — input, default = `node ${process.version}`
9. `environment.version` — input, default = read from nearest `package.json#version`
10. `severity` — `list` choice from `[low, medium, high, critical]`, default `medium`
11. `affected_components` (optional) — looped input; skippable
12. `labels` (optional) — comma-separated input
13. `user_impact` (optional) — input

Pressing **Ctrl-C** at any prompt: catch the `SIGINT`, print `\nCancelled — no request submitted.` to stderr, exit with code 130 (standard SIGINT exit).

### Non-Interactive Flag Mode (`collectFromFlags`)

Flags, all repeatable for arrays:

| Flag | Maps to | Repeatable |
|------|---------|-----------|
| `--title <s>` | `title` | no |
| `--description <s>` | `description` | no |
| `--repro-step <s>` | `reproduction_steps[]` | yes |
| `--expected <s>` | `expected_behavior` | no |
| `--actual <s>` | `actual_behavior` | no |
| `--error-message <s>` | `error_messages[]` | yes |
| `--os <s>` | `environment.os` | no |
| `--runtime <s>` | `environment.runtime` | no |
| `--version <s>` | `environment.version` | no |
| `--severity <s>` | `severity` | no |
| `--component <s>` | `affected_components[]` | yes |
| `--label <s>` | `labels[]` | yes |
| `--user-impact <s>` | `user_impact` | no |

Defaults applied for `environment.*` fields use the same auto-detected values as interactive mode.

### Bug-Context Validation (`request-submit.ts` modification)

After validating `--type` (per SPEC-018-3-01), insert:

```typescript
if (opts.type === 'bug') {
  const ctx = opts.bugContextPath
    ? await loadBugContext(opts.bugContextPath)
    : null;
  if (!ctx) {
    process.stderr.write(
      `Error: bug-typed requests require bug context. ` +
      `Use 'autonomous-dev request submit-bug' or pass --bug-context-path <file>\n`
    );
    process.exit(1);
  }
  payload.bug_context = ctx;
}
```

`loadBugContext(path)` (in `bug-context-loader.ts`):

1. Read file at `path`; reject with `Error: bug context file not found: <path>` (exit 1) if missing.
2. Parse JSON; reject with `Error: bug context file is not valid JSON: <path>` (exit 1) on parse failure.
3. AJV-validate against `BugReportSchema`; on failure reject with `Error: bug context validation failed:\n<errors>` (exit 1).
4. Return the validated `BugReport`.

## Acceptance Criteria

- [ ] `autonomous-dev request submit-bug --repo /tmp/r` in a real terminal walks through prompts 1–13 in order.
- [ ] Pressing Ctrl-C during any interactive prompt prints `Cancelled — no request submitted.` to stderr, exits 130, and writes nothing to the requests directory.
- [ ] Empty input on `reproduction_steps` first iteration re-prompts with `At least one reproduction step is required` and does not advance.
- [ ] Non-interactive mode `echo "" | autonomous-dev request submit-bug --repo /tmp/r --title T --description D --repro-step S --expected E --actual A` succeeds without any prompt.
- [ ] Non-interactive mode missing `--title` exits 1 with `Error: bug report validation failed:\n  title: must have required property 'title'`.
- [ ] `autonomous-dev request submit --type bug --description X` (no context) exits 1 with stderr exactly: `Error: bug-typed requests require bug context. Use 'autonomous-dev request submit-bug' or pass --bug-context-path <file>`.
- [ ] `autonomous-dev request submit --type bug --bug-context-path /tmp/valid.json` succeeds when the JSON validates against `BugReportSchema`.
- [ ] `autonomous-dev request submit --type bug --bug-context-path /tmp/missing.json` exits 1 with `Error: bug context file not found: /tmp/missing.json`.
- [ ] `--bug-context-path` pointing to malformed JSON exits 1 with `Error: bug context file is not valid JSON: <path>`.
- [ ] `--bug-context-path` pointing to JSON that fails schema validation exits 1 with the AJV error list.
- [ ] `autonomous-dev request submit-bug --help` lists every flag from the table above.

## Dependencies

- **Blocking**: SPEC-018-3-01 (BugReport interface, schema, `--type` flag).
- **Blocking**: PLAN-018-1 (RequestType enum, state schema accepts `bug_context` field).
- **Blocking**: PLAN-018-2 (daemon `select_request` propagates `bug_context` into the spawned session).
- `inquirer@^9.2.0` (new npm dep — pin in `package.json`).
- AJV (existing on main).

## Notes

- Inquirer is pinned to `^9.2.0` to avoid breakage from inquirer 10's API rewrite. Upgrading is a deliberate future spec.
- The `editor` prompt for `description` requires `$EDITOR` to be set; falls back to a multi-line `input` prompt if unset. Documented in `--help` text.
- The `--bug-context-path` flag is intentionally accepted on **both** `submit` and `submit-bug` to support scripted workflows that pre-build the JSON elsewhere (e.g. a `gh issue view` pipeline).
- `--from-issue <github-url>` (mentioned in PLAN-018-3 risk table) is **out of scope** here; it is a follow-up spec.
- The Ctrl-C exit code is 130 (`128 + SIGINT(2)`) to match shell convention; tests assert this exact code.
- All prompts use UTF-8; no emoji or special characters in default values.
