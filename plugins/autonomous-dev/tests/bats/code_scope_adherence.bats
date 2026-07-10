#!/usr/bin/env bats
# #678 — spec-adherence gate. check_code_scope_adherence must FAIL an off-scope
# code diff but be strictly fail-open (never block legit work when unsure).

PLUGIN_DIR_PATH=""
setup() {
    PLUGIN_DIR_PATH="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    TEST_WORK_DIR="$(mktemp -d)"
    export HOME="$TEST_WORK_DIR"
    mkdir -p "$TEST_WORK_DIR/.autonomous-dev/logs"
    set +e; source "$PLUGIN_DIR_PATH/bin/supervisor-loop.sh"; set -e

    RID="REQ-000999"
    PROJ="$TEST_WORK_DIR/proj"
    mkdir -p "$PROJ"
    git -C "$PROJ" init -q -b main
    git -C "$PROJ" config user.email t@t; git -C "$PROJ" config user.name t
    mkdir -p "$PROJ/plugins/autonomous-dev/intake/handlers" "$PROJ/docs/specs"
    echo "base" > "$PROJ/README.md"
    git -C "$PROJ" add -A; git -C "$PROJ" commit -qm base
    git -C "$PROJ" checkout -q -b "autonomous/$RID"
}
teardown() { rm -rf "$TEST_WORK_DIR"; }

_commit() { git -C "$PROJ" add -A; git -C "$PROJ" commit -qm change; }

@test "SC-01 ON-SCOPE: diff touches a file named in the spec → 0 (pass)" {
    echo "Implement plugins/autonomous-dev/intake/handlers/cancel_finalizer.ts" > "$PROJ/docs/specs/$RID-spec.md"
    echo "x" > "$PROJ/plugins/autonomous-dev/intake/handlers/cancel_finalizer.ts"; _commit
    run check_code_scope_adherence "$RID" "$PROJ"; [ "$status" -eq 0 ]
}

@test "SC-02 OFF-SCOPE: diff touches only files NOT in the spec → 1 (fail)" {
    echo "Implement plugins/autonomous-dev/intake/handlers/cancel_finalizer.ts" > "$PROJ/docs/specs/$RID-spec.md"
    mkdir -p "$PROJ/plugins/autonomous-dev-portal/server/routes"
    echo "x" > "$PROJ/plugins/autonomous-dev-portal/server/routes/homelab.ts"; _commit
    run check_code_scope_adherence "$RID" "$PROJ"; [ "$status" -eq 1 ]
}

@test "SC-03 FAIL-OPEN: no spec docs → 0 (can't judge)" {
    echo "x" > "$PROJ/plugins/autonomous-dev-portal/nope.ts" 2>/dev/null || { mkdir -p "$PROJ/plugins/autonomous-dev-portal"; echo x > "$PROJ/plugins/autonomous-dev-portal/nope.ts"; }; _commit
    run check_code_scope_adherence "$RID" "$PROJ"; [ "$status" -eq 0 ]
}

@test "SC-04 FAIL-OPEN: docs/tests-only diff (own generated docs) → 0" {
    echo "spec mentions intake/handlers" > "$PROJ/docs/specs/$RID-spec.md"
    # only the request's own generated plan doc changed
    mkdir -p "$PROJ/docs/plans"; echo "plan" > "$PROJ/docs/plans/$RID-plan.md"; _commit
    run check_code_scope_adherence "$RID" "$PROJ"; [ "$status" -eq 0 ]
}

@test "SC-05 ON-SCOPE by parent dir: spec names the dir, diff adds a new file there → 0" {
    echo "changes live under plugins/autonomous-dev/intake/handlers/" > "$PROJ/docs/specs/$RID-spec.md"
    echo "x" > "$PROJ/plugins/autonomous-dev/intake/handlers/new_helper.ts"; _commit
    run check_code_scope_adherence "$RID" "$PROJ"; [ "$status" -eq 0 ]
}

# --- remote-ref path: exercises diff_base=origin/<base> + the in-check fetch ---
# Give PROJ an origin (bare) with main + the branch pushed, so origin/main
# resolves and the check diffs against it (not the local base).
_add_origin() {
    REM="$TEST_WORK_DIR/rem.git"; git init -q --bare "$REM"
    git -C "$PROJ" remote add origin "$REM"
    git -C "$PROJ" push -q origin \
        "refs/heads/main:refs/heads/main" \
        "refs/heads/autonomous/$RID:refs/heads/autonomous/$RID"
    git -C "$PROJ" fetch -q origin
}

@test "SC-06 REMOTE path ON-SCOPE: origin/main base, branch touches a spec-named file → 0" {
    echo "Implement plugins/autonomous-dev/intake/handlers/cancel_finalizer.ts" > "$PROJ/docs/specs/$RID-spec.md"
    echo "x" > "$PROJ/plugins/autonomous-dev/intake/handlers/cancel_finalizer.ts"; _commit
    _add_origin
    run check_code_scope_adherence "$RID" "$PROJ"; [ "$status" -eq 0 ]
}

@test "SC-07 REMOTE path OFF-SCOPE: origin/main base, branch touches only non-spec files → 1" {
    echo "Implement plugins/autonomous-dev/intake/handlers/cancel_finalizer.ts" > "$PROJ/docs/specs/$RID-spec.md"
    mkdir -p "$PROJ/plugins/autonomous-dev-portal/server/routes"
    echo "x" > "$PROJ/plugins/autonomous-dev-portal/server/routes/homelab.ts"; _commit
    _add_origin
    run check_code_scope_adherence "$RID" "$PROJ"; [ "$status" -eq 1 ]
}
