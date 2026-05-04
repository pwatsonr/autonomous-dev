# SPEC-029-3-01: ESLint `no-restricted-syntax` Rule for `process.exit` in Test Files

## Metadata
- **Parent Plan**: PLAN-029-3 (CI Gate — ESLint Rule, CI Grep, `--ci` Flag, JUnit Reporter)
- **Parent TDD**: TDD-029
- **Parent PRD**: PRD-016
- **Tasks Covered**: PLAN-029-3 Task 1 (add ESLint `no-restricted-syntax` rule scoped to `**/*.test.ts` and `**/*.spec.ts` that fails on any `process.exit(...)` call)
- **Estimated effort**: 2 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/.eslintrc.js` (modifications)
- **Depends on**: SPEC-029-1-05 (the post-migration tree must be `process.exit`-free, otherwise the rule's first run reports existing violations and blocks merge)

## Description

Add a `no-restricted-syntax` rule to `plugins/autonomous-dev/.eslintrc.js` that fires `error`-level for any `process.exit(...)` call inside `**/*.test.ts` or `**/*.spec.ts` files. After this spec ships, `npm run lint` from `plugins/autonomous-dev/` (or the equivalent CI lint job) flags any reintroduction of `process.exit` in a test file with an actionable error message referencing PRD-016 FR-1660. This is the first of three independent gates (lint + CI grep + meta-test) that PLAN-029-3 builds; together they make the harness-pattern regression a one-way ratchet.

This spec's contract is local-developer-feedback: the ESLint rule fires in editors with ESLint plugins (VS Code, Cursor, JetBrains) and in `npm run lint` runs before commit. The CI-side grep backstop (SPEC-029-3-02) and the meta-test (SPEC-029-3-04) catch any regression that slips past the editor.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/.eslintrc.js` | Modify | Add an `overrides` entry for `**/*.test.ts` and `**/*.spec.ts` containing the `no-restricted-syntax` rule |

One commit. Body references `Refs PRD-016 FR-1660; TDD-029 §7.1 option A; PLAN-029-3 Task 1`.

## Implementation Details

### Step 1: Locate the ESLint config

The canonical config path is `plugins/autonomous-dev/.eslintrc.js` (created by PLAN-016-1 Task 6 per the parent plan). Confirm the file exists. If not, surface as a PR comment — this spec assumes the config is in place.

```
$ ls plugins/autonomous-dev/.eslintrc.js
```

If the file is named differently (`.eslintrc.cjs`, `.eslintrc.json`, `eslint.config.js`), use the actual path. The rule format below is for legacy `.eslintrc.js`/`.eslintrc.cjs`. For flat config (`eslint.config.js`), translate accordingly:

- Legacy: `module.exports = { overrides: [...] }`.
- Flat: an array of config objects; one config object handles `files: ['**/*.test.ts', ...]` with the rule.

The rule body (selector + message) is identical across formats.

### Step 2: Add the `overrides` entry

Edit the config to add the following (or append to an existing `overrides` array):

```js
overrides: [
  // ... existing override entries (unchanged)
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='process'][callee.property.name='exit']",
          message:
            'process.exit() is forbidden in test files. Use expect()/throw — jest controls process lifecycle. (PRD-016 FR-1660)',
        },
      ],
    },
  },
],
```

Rules:

- The `files` glob MUST cover both `*.test.ts` and `*.spec.ts`. The autonomous-dev plugin currently uses `*.test.ts` exclusively, but `*.spec.ts` is included for forward compatibility.
- The selector MUST be the literal string `"CallExpression[callee.object.name='process'][callee.property.name='exit']"`. ESLint's selector parser is strict; equivalent-looking variants (e.g., omitting the inner brackets) silently fail to match.
- The message MUST include `PRD-016 FR-1660` so the error trace links back to the requirement. Without that anchor, a reader hitting the error in a future PR has no breadcrumb to the rationale.
- The severity MUST be `'error'`, not `'warn'`. Warnings do not fail CI; errors do.
- If the config already has a `no-restricted-syntax` rule globally, this `overrides` entry's rule REPLACES (not extends) the global rule for `*.test.ts` / `*.spec.ts`. ESLint does not auto-merge `no-restricted-syntax` arrays across `overrides`. If the global rule has other patterns (unlikely for this codebase), the override entry MUST include them too.

### Step 3: Local lint check (clean tree)

After editing, run from `plugins/autonomous-dev/`:

```
$ npx eslint 'tests/**/*.test.ts'
```

Expected outcome: exit code 0. The post-SPEC-029-1-05 tree contains zero `process.exit` calls in test files, so the rule fires zero times.

If ANY error fires, that means SPEC-029-1-05's invariant is broken (a `process.exit` survived the migration). Stop and surface to the orchestrator; this spec cannot ship until the tree is clean.

### Step 4: Local lint check (regression test)

Verify the rule actually catches a violation. Create a scratch file (do NOT commit):

```
$ cat > /tmp/scratch.test.ts <<'EOF'
test('scratch', () => {
  if (false) {
    process.exit(1);
  }
});
EOF
```

Run ESLint against the scratch file using the project's config:

```
$ npx eslint --config plugins/autonomous-dev/.eslintrc.js /tmp/scratch.test.ts
```

Expected outcome: ESLint emits exactly one error pointing at the `process.exit(1)` line with the message `process.exit() is forbidden in test files. Use expect()/throw — jest controls process lifecycle. (PRD-016 FR-1660)`. Exit code is non-zero.

Delete the scratch file:

```
$ rm /tmp/scratch.test.ts
```

Document the regression-test outcome in the PR description (a short fenced block showing the ESLint output). The scratch file is NOT included in any commit.

### Step 5: Commit

```
chore(eslint): forbid process.exit in test files (PRD-016 FR-1660)

Add a no-restricted-syntax rule scoped to **/*.test.ts and **/*.spec.ts
that fires error-level on any process.exit(...) call. The message text
references PRD-016 FR-1660 so future violators have a breadcrumb to the
rationale.

This is the first of three independent gates (lint + CI grep + meta-test)
that PLAN-029-3 builds. The CI grep step (SPEC-029-3-02) and meta-test
(SPEC-029-3-04) are belt-and-braces backstops for the cases this AST
selector misses (e.g., globalThis.process.exit, process["exit"]).

Verified locally:
  - `npx eslint tests/**/*.test.ts` exits 0 on the clean post-PLAN-029-1
    tree.
  - A scratch file with `process.exit(1)` produces the expected
    FR-1660 error (output captured in PR description).

Refs PRD-016 FR-1660; TDD-029 §7.1 option A; PLAN-029-3 Task 1.
```

### What NOT to do

- Do NOT use severity `'warn'`. Warnings do not fail CI; the gate is meaningless without `'error'`.
- Do NOT widen the file glob beyond `*.test.ts` and `*.spec.ts`. `process.exit` is legitimate in some non-test code (CLI entry points, scripts); a broader rule would block legitimate uses.
- Do NOT narrow the file glob to a specific test directory. The rule MUST cover all test files in the plugin (and any added later) to keep the gate one-way.
- Do NOT add equivalent rule patterns for `process["exit"]` or `globalThis.process.exit`. The ESLint AST selector cannot reliably match those without false positives. Defense-in-depth is delegated to the CI grep step (SPEC-029-3-02), which uses regex matching.
- Do NOT modify any test file in this spec. The rule's correctness is verified against the existing tree; modifying tests changes the verification's meaning.
- Do NOT run `eslint --fix` against the tree. The rule has no autofix; running `--fix` is a no-op for `no-restricted-syntax` but may surface other lint issues that this spec is not scoped to address.
- Do NOT commit the scratch file from Step 4. The scratch file is a local verification artifact, not source.
- Do NOT add a `// eslint-disable-next-line` escape hatch in any test file as part of this spec. If a legitimate need to use `process.exit` in a test arises later (none is expected), it would require its own SPEC defining the exception.

## Acceptance Criteria

- [ ] `plugins/autonomous-dev/.eslintrc.js` (or the actual config path) contains an `overrides` entry whose `files` array includes both `'**/*.test.ts'` and `'**/*.spec.ts'`.
- [ ] The `overrides` entry's `rules['no-restricted-syntax']` is `['error', { selector: "CallExpression[callee.object.name='process'][callee.property.name='exit']", message: '...PRD-016 FR-1660...' }]`.
- [ ] The rule's severity is exactly `'error'` (not `'warn'`).
- [ ] The rule's message contains the literal string `PRD-016 FR-1660`.
- [ ] The selector string is exactly `"CallExpression[callee.object.name='process'][callee.property.name='exit']"`.
- [ ] `npx eslint 'tests/**/*.test.ts'` from `plugins/autonomous-dev/` exits 0 (no rule violations on the post-PLAN-029-1 tree).
- [ ] Running ESLint against a scratch file containing `process.exit(1)` inside a `.test.ts` produces exactly one error pointing at the `process.exit` call with the documented message.
- [ ] Exactly one commit lands. Body matches the §Step 5 template; references `PRD-016 FR-1660; TDD-029 §7.1 option A; PLAN-029-3 Task 1`.
- [ ] No test files modified. No production source files modified. No CI workflow files modified (workflow changes belong to SPEC-029-3-02). Verified by `git diff --name-only HEAD~1..HEAD` returning exactly the eslintrc path.
- [ ] The PR description (or commit body) records the regression-test scratch-file output as a short fenced block.

## Dependencies

- **Blocked by**: SPEC-029-1-05. The post-migration tree must be `process.exit`-free; otherwise this spec's first lint run reports existing violations and blocks merge.
- **Blocks**: SPEC-029-3-04 (meta-test). The meta-test is the third gate; the ESLint rule is the first gate. Both must ship for the regression to be hard to introduce.
- **Integration with**: SPEC-029-3-02 (CI grep step). The grep step is the second gate and runs in CI even on PRs that bypass local lint.

## Notes

- The ESLint rule is the local-feedback gate. It fires in the editor before the developer commits, which is the cheapest place to catch the regression. The CI grep is the network-side gate; the meta-test is the test-time gate. The three together cover the "developer skipped pre-commit hook," "developer used a different editor," and "CI workflow regressed" scenarios.
- The selector string's exact form is fragile but correct as written. Alternatives (`MemberExpression[object.name='process']`, etc.) match different AST shapes. The given selector matches the specific shape `process.exit(...)` (CallExpression whose callee is a MemberExpression `process.exit`). Variants like `globalThis.process.exit(...)` produce a different AST and are NOT caught — that gap is the whole reason for the CI grep backstop.
- The `**/*.spec.ts` half of the glob is forward-compatible. The autonomous-dev plugin uses `*.test.ts` today; including `*.spec.ts` future-proofs the gate against a project that adopts the spec naming.
- A reviewer's checklist for this PR: (1) read the diff (single file, ~12 lines added), (2) confirm the selector string is the documented literal, (3) confirm the message contains `PRD-016 FR-1660`, (4) read the regression-test output in the PR description and confirm the message matches.
- If the project later adopts ESLint flat config (`eslint.config.js`), this spec's rule translates one-for-one. The translation is mechanical and would land as a follow-up PR; this spec is not blocked on it.
- After this spec ships, a developer who introduces `process.exit` in a `.test.ts` will see the error in their editor before they commit. This is the desired UX: the gate fires at the moment of writing, not days later in CI.
