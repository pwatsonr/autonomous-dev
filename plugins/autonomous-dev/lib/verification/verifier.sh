#!/usr/bin/env bash
###############################################################################
# verifier.sh — Phase B evidence verifier (log-mode)
#
# PLAN-042 Phase B (PRD-024 / TDD-041 §2, ADR-041-01, ADR-041-02).
#
# After PR #339's empty-evidence guard fires, the daemon calls this verifier
# on the executor's phase-result envelope. For each claim in `evidence[]`,
# the verifier:
#
#   1. Classifies the command as idempotent | non_idempotent | unclassifiable
#      against the embedded allowlist / denylist (ADR-041-02).
#   2. Checks presence in the Phase A audit log (TDD-041 §D-05) — was the
#      command actually invoked?
#   3. For idempotent commands, may re-execute the command in the worktree
#      with CLAUDE_* / ANTHROPIC_* env stripped, and compare exit code +
#      output_tail against the claim.
#   4. For non-idempotent commands, verifies against the audit log only
#      (no re-exec — they're destructive).
#   5. Writes one JSONL row to ${req_dir}/verification-report.jsonl
#      describing what was checked and the verdict.
#
# PHASE B IS LOG-MODE ONLY. Verdicts are written to the report but the
# verifier MUST NOT modify the phase-result envelope. Phase C will flip
# this. To support that future, the verifier honors a mode argument:
#   verify_envelope <req_dir> <phase> [mode]   mode: log (default) | refuse
# In Phase B `mode=log` is the only behavior used by spawn-session.sh.
#
# Environment:
#   VERIFICATION_MODE          log|refuse  (default: log). spawn-session.sh
#                              does not set this in Phase B — callers wanting
#                              to test refuse-mode locally can export it.
#   VERIFICATION_REEXEC        0|1 (default: 1) — enable idempotent re-exec.
#                              Disabled in unit tests where the daemon
#                              cannot actually shell out.
#   VERIFICATION_REEXEC_TIMEOUT_S  Default 300 (per TDD-041 §D-03).
#
# Public functions (source this file, then call):
#
#   classify_command CMD            -> stdout: idempotent|non_idempotent|unclassifiable
#   reexecute_command CMD CWD TIMEOUT
#                                   -> stdout JSON: {exit_code, output_tail}
#   verify_envelope REQ_DIR PHASE [MODE]
#                                   -> writes ${req_dir}/verification-report.jsonl
#                                   -> prints a one-line calibration summary
#                                      to stderr:
#                                        verification_summary: phase=X verified=N would_have_failed=M
#                                   -> exit 0 always in log mode (the verifier
#                                      never blocks); in refuse mode (Phase C)
#                                      a non-zero exit will signal "override
#                                      phase-result to fail" but Phase B keeps
#                                      the function side-effect-free.
###############################################################################

set -u

# Resolve our own directory so we can source siblings without depending on
# the caller's CWD.
__VERIFIER_DIR__="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib/verification/comparator.sh
source "${__VERIFIER_DIR__}/comparator.sh"
# shellcheck source=lib/verification/audit-log-reader.sh
source "${__VERIFIER_DIR__}/audit-log-reader.sh"

# ─────────────────────────────────────────────────────────────────────────
# Classification — ADR-041-02, TDD-041 §D-02.
#
# Phase B ships the SHORTEST defensible idempotent allowlist (per the
# brief's bail clause): the four test/build runners that account for the
# overwhelming majority of executor evidence today. Phase C expands.
#
# Allowlist matches by FIRST TOKEN of the claim. We deliberately do not
# look at flags — the goal is breadth, not precision, in log mode.
# False positives in this phase only mean extra re-execution; false
# negatives only mean unclassifiable.
#
# Denylist matches the first token AND by heuristic regex (per
# TDD-041 §D-02). Anything matching is classified non_idempotent.
#
# Anything not on either list is `unclassifiable`. Per ADR-041-02
# deny-by-default-in-refuse-mode — but in log mode, unclassifiable just
# generates a "would_have_failed" record. Phase C's refuse mode will
# read the same record and act on it.
# ─────────────────────────────────────────────────────────────────────────

# Idempotent allowlist (first-token match).
#
# Phase C expansion (PLAN-042 T-042-C-01, TDD-041 §D-02): curated from the
# TDD's "Idempotent" examples row plus the well-known test/build/lint/type-
# checker runners that account for the bulk of executor evidence. Deny-by-
# default: if you're unsure whether a tool is safe to re-execute, leave it
# OFF this list — the worst case is one would-be-verified phase falls
# through to `unclassifiable` and gets refused. Adding entries later is a
# one-line PR.
#
# Each entry is the FIRST TOKEN of the claim, after env-var prefix stripping
# (the classify_command stripper drops `FOO=bar` prefixes).
__VERIFIER_IDEMPOTENT_TOKENS__=(
    # JS / TS test runners
    bun     # bun test, bun run …
    npm     # npm test, npm run …  (test/lint scripts — destructive subcommands handled by regex denylist)
    pnpm    # pnpm test, pnpm run …
    yarn    # yarn test, yarn run …
    npx     # npx tsc, npx eslint, npx vitest …
    vitest  # vitest run
    jest    # jest --ci
    mocha   # mocha test/
    cypress # cypress run
    playwright  # playwright test

    # TypeScript / JS lint/type tools
    tsc     # tsc --noEmit
    eslint  # eslint .
    prettier  # prettier --check .

    # Python
    pytest  # pytest -k …
    ruff    # ruff check src/
    mypy    # mypy src/
    black   # black --check .
    flake8  # flake8 src/

    # Rust
    cargo   # cargo test, cargo check, cargo build, cargo clippy
            # (cargo publish is non-idempotent but handled by the regex
            # denylist below if/when added — for now cargo publish would
            # still match `cargo` here; deny regex is the gate)

    # Go
    go      # go test, go vet, go build

    # Java / Gradle / Maven
    gradle  # gradle test
    mvn     # mvn test

    # Misc safe build/test
    make    # make test, make check  (only safe subcommands; destructive
            # `make install` would need a deny regex — not adding speculatively)

    # Read-only git/gh
    git     # git status, git diff, git log — destructive `git push` /
            # `git reset --hard` are caught by the non-idempotent regex
            # denylist BEFORE this check runs (per classify_command order).
    gh      # gh pr view / gh pr list — `gh pr create` caught by regex.

    # Shell built-ins commonly used as evidence
    ls
    cat
    grep
    rg
    head
    tail
    wc
    find
)

# Non-idempotent denylist (first-token match).
__VERIFIER_NON_IDEMPOTENT_TOKENS__=(
    rm      # rm -rf, even though the heuristic also catches it
)

# Non-idempotent heuristic regexes (full-command match).
# Per TDD-041 §D-02. Compiled lazily at classify_command call.
__VERIFIER_NON_IDEMPOTENT_REGEXES__=(
    '^git[[:space:]]+push'
    '^gh[[:space:]]+pr[[:space:]]+create'
    '^npm[[:space:]]+publish'
    '^docker[[:space:]]+push'
    '^terraform[[:space:]]+apply'
    '^rm[[:space:]]+-rf'
)

classify_command() {
    local cmd="$1"
    # Strip leading whitespace + env-var prefixes like "FOO=bar BAR=baz cmd".
    # Per TDD-041 §D-02 we strip env prefixes; rough approach: drop tokens
    # of the form WORD=… until we hit a token without `=`.
    local stripped="${cmd}"
    while [[ "${stripped}" =~ ^([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)(.*)$ ]]; do
        stripped="${BASH_REMATCH[2]}"
    done
    local first_token
    first_token="$(printf '%s' "${stripped}" | awk '{print $1}')"

    # Non-idempotent heuristic regex check FIRST. A `git push` is
    # non-idempotent even though `git` itself isn't on the deny list.
    local re
    for re in "${__VERIFIER_NON_IDEMPOTENT_REGEXES__[@]}"; do
        if [[ "${stripped}" =~ ${re} ]]; then
            printf 'non_idempotent\n'
            return 0
        fi
    done

    # Non-idempotent first-token check.
    local tok
    for tok in "${__VERIFIER_NON_IDEMPOTENT_TOKENS__[@]}"; do
        if [[ "${first_token}" == "${tok}" ]]; then
            printf 'non_idempotent\n'
            return 0
        fi
    done

    # Idempotent first-token check.
    for tok in "${__VERIFIER_IDEMPOTENT_TOKENS__[@]}"; do
        if [[ "${first_token}" == "${tok}" ]]; then
            printf 'idempotent\n'
            return 0
        fi
    done

    printf 'unclassifiable\n'
}

# ─────────────────────────────────────────────────────────────────────────
# Re-execution — TDD-041 §D-03.
#
# Runs CMD with CLAUDE_* / ANTHROPIC_* env stripped, stdin /dev/null,
# capped at TIMEOUT seconds (default 300). Captures combined stdout/stderr;
# returns the last 50 lines as output_tail.
#
# Output: a compact JSON object to stdout — {exit_code, output_tail,
# duration_ms, error}. error is "" on success, "timeout" or
# "infrastructure" otherwise.
# ─────────────────────────────────────────────────────────────────────────

reexecute_command() {
    local cmd="$1" cwd="$2" timeout_s="${3:-300}"

    # Strip CLAUDE_* and ANTHROPIC_* env vars per TDD-041 §D-03. Build
    # the env invocation by listing what to unset.
    local -a env_unset=()
    local v
    # Read names from environment via `compgen -e`, falling back to
    # `env | cut`. Both are safe under `set -u`.
    while IFS= read -r v; do
        case "${v}" in
            CLAUDE_*|ANTHROPIC_*) env_unset+=("${v}") ;;
        esac
    done < <(compgen -e 2>/dev/null || env | awk -F= '{print $1}')

    local tmp_out
    tmp_out=$(mktemp 2>/dev/null) || tmp_out="/tmp/reexec.$$.out"

    local start_ms end_ms duration_ms
    start_ms=$(date +%s 2>/dev/null || echo 0)

    local rc=0
    # macOS lacks GNU `timeout` by default; use it if present, else fall
    # back to a backgrounded subshell.
    local timeout_bin
    timeout_bin="$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)"

    # Strip CLAUDE_*/ANTHROPIC_* via an in-shell `unset` inside the subshell
    # (portable; `env --unset=` is GNU-only and, placed before `env`, the
    # shell would try to exec `--unset=…` as a command → exit 127). env_unset
    # now holds bare NAMEs.
    if [[ -n "${timeout_bin}" ]]; then
        ( cd "${cwd}" \
            && { [[ ${#env_unset[@]} -gt 0 ]] && unset "${env_unset[@]}" || true; } \
            && "${timeout_bin}" "${timeout_s}" bash -c "${cmd}" </dev/null \
        ) > "${tmp_out}" 2>&1 || rc=$?
    else
        # Fallback: best-effort, no timeout enforcement. Rare on macOS
        # without coreutils — production paths should install coreutils.
        ( cd "${cwd}" \
            && { [[ ${#env_unset[@]} -gt 0 ]] && unset "${env_unset[@]}" || true; } \
            && bash -c "${cmd}" </dev/null \
        ) > "${tmp_out}" 2>&1 || rc=$?
    fi

    end_ms=$(date +%s 2>/dev/null || echo 0)
    duration_ms=$(( (end_ms - start_ms) * 1000 ))

    local error=""
    # timeout(1) returns 124 on timeout.
    if [[ "${rc}" -eq 124 ]]; then
        error="timeout"
    fi

    local output_tail
    output_tail=$(tail -n 50 "${tmp_out}" 2>/dev/null || true)
    rm -f "${tmp_out}"

    jq -nc \
        --argjson rc "${rc}" \
        --arg tail "${output_tail}" \
        --argjson dur "${duration_ms}" \
        --arg err "${error}" \
        '{exit_code: $rc, output_tail: $tail, duration_ms: $dur, error: $err}'
}

# ─────────────────────────────────────────────────────────────────────────
# verify_envelope REQ_DIR PHASE [MODE]
#
# Read ${req_dir}/phase-result-<phase>.json, iterate evidence[], run all
# checks per claim, write ${req_dir}/verification-report.jsonl. The report
# is daemon-owned (mode 0600).
#
# In log mode (the only Phase B behavior), the function returns 0 and
# does NOT modify the envelope.
# ─────────────────────────────────────────────────────────────────────────

verify_envelope() {
    local req_dir="$1" phase="$2"
    local mode="${3:-${VERIFICATION_MODE:-log}}"

    # Only the three executor phases produce evidence today.
    case "${phase}" in
        integration|deploy|test) ;;
        *) return 0 ;;
    esac

    local envelope="${req_dir}/phase-result-${phase}.json"
    [[ -f "${envelope}" ]] || return 0

    local claimed_status
    claimed_status=$(jq -r '.status // "fail"' "${envelope}" 2>/dev/null || echo "fail")
    # We only verify CLAIMED-PASS envelopes. status=fail short-circuits
    # (no point verifying a failure).
    [[ "${claimed_status}" == "pass" ]] || return 0

    local evidence_count
    evidence_count=$(jq '(.evidence // []) | length' "${envelope}" 2>/dev/null || echo 0)
    [[ "${evidence_count}" -ge 1 ]] || return 0

    local report="${req_dir}/verification-report.jsonl"
    # Truncate + chmod 0600. Daemon-owned per TDD-041 §D-06.
    : > "${report}" 2>/dev/null || return 0
    chmod 0600 "${report}" 2>/dev/null || true

    local verified=0 would_have_failed=0
    local audit_present=0
    if audit_log_exists "${req_dir}"; then
        audit_present=1
    fi

    local i
    for ((i = 0; i < evidence_count; i++)); do
        local row
        row=$(jq -c ".evidence[${i}]" "${envelope}" 2>/dev/null || echo "{}")
        local cmd claim_exit claim_tail
        cmd=$(printf '%s' "${row}" | jq -r '.command // ""' 2>/dev/null || echo "")
        claim_exit=$(printf '%s' "${row}" | jq -r '.exit_code // 0' 2>/dev/null || echo 0)
        claim_tail=$(printf '%s' "${row}" | jq -r '.output_tail // ""' 2>/dev/null || echo "")

        local classification
        classification=$(classify_command "${cmd}")

        # Default check verdicts.
        local presence_check="skipped"
        local exit_code_check="skipped"
        local output_tail_check="skipped"
        local reexec_check="skipped"
        local verdict="verified"
        local reason=""

        if [[ "${audit_present}" -eq 0 ]]; then
            # Audit log missing — Phase A's shim failed open. Per the
            # brief: skip verification gracefully and log it.
            presence_check="skipped"
            verdict="verified"
            reason="audit_log_absent"
        else
            # Presence check is always done when the audit log exists.
            if audit_log_has_command "${req_dir}" "${cmd}"; then
                presence_check="pass"
            else
                presence_check="fail"
                verdict="would_have_failed"
                reason="command_not_in_audit_log"
            fi
        fi

        # Branch on classification.
        case "${classification}" in
            idempotent)
                # Optionally re-execute. Phase A's audit log has
                # exit_code=null (PreToolUse-only), so the only way to
                # verify exit code + output tail today is to re-run.
                if [[ "${VERIFICATION_REEXEC:-1}" == "1" ]]; then
                    local worktree="${req_dir}/worktree"
                    if [[ ! -d "${worktree}" ]]; then
                        # No isolation worktree (single-track loop): re-execute
                        # in the PROJECT REPO ROOT, not req_dir. req_dir is
                        # <project>/.autonomous-dev/requests/<id> — never a git
                        # repo root — so repo-relative `git`/`gh` commands fail
                        # there with exit 128, guaranteeing a false mismatch (#486).
                        local project_root
                        project_root="$(cd "${req_dir}/../../.." 2>/dev/null && pwd)"
                        if [[ -n "${project_root}" && -d "${project_root}" ]]; then
                            worktree="${project_root}"
                        else
                            worktree="${req_dir}"
                        fi
                    fi
                    local reexec_json
                    reexec_json=$(reexecute_command \
                        "${cmd}" "${worktree}" \
                        "${VERIFICATION_REEXEC_TIMEOUT_S:-300}" 2>/dev/null || echo '{}')
                    local actual_exit actual_tail rexec_err
                    actual_exit=$(printf '%s' "${reexec_json}" | jq -r '.exit_code // 1' 2>/dev/null || echo 1)
                    actual_tail=$(printf '%s' "${reexec_json}" | jq -r '.output_tail // ""' 2>/dev/null || echo "")
                    rexec_err=$(printf '%s' "${reexec_json}" | jq -r '.error // ""' 2>/dev/null || echo "")
                    reexec_check="pass"
                    # Exit code compare
                    if [[ "${actual_exit}" == "${claim_exit}" ]]; then
                        exit_code_check="pass"
                    else
                        exit_code_check="fail"
                        reexec_check="fail"
                        if [[ "${verdict}" != "would_have_failed" ]]; then
                            verdict="would_have_failed"
                            reason="exit_code_mismatch claimed=${claim_exit} actual=${actual_exit}"
                        fi
                    fi
                    # Output-tail compare.
                    local cmp_line cmp_ratio cmp_verdict
                    cmp_line=$(compare_output_tails "${claim_tail}" "${actual_tail}" || true)
                    cmp_ratio=$(printf '%s' "${cmp_line}" | awk '{print $1}')
                    cmp_verdict=$(printf '%s' "${cmp_line}" | awk '{print $2}')
                    if [[ "${cmp_verdict}" == "match" ]]; then
                        output_tail_check="pass"
                    else
                        output_tail_check="fail"
                        reexec_check="fail"
                        if [[ "${verdict}" != "would_have_failed" ]]; then
                            verdict="would_have_failed"
                            reason="output_tail_mismatch ratio=${cmp_ratio}"
                        fi
                    fi
                    if [[ -n "${rexec_err}" ]]; then
                        reexec_check="fail"
                        if [[ "${verdict}" != "would_have_failed" ]]; then
                            verdict="would_have_failed"
                            reason="reexec_${rexec_err}"
                        fi
                    fi
                fi
                ;;
            non_idempotent)
                # Audit-log-only check. Presence already done above; we
                # do NOT re-execute. The audit log can't tell us exit
                # code or output tail in Phase A (PreToolUse-only), so
                # the exit/tail checks stay "skipped".
                :
                ;;
            unclassifiable)
                # ADR-041-02 originally denied-by-default here, but in refuse
                # mode that refuses EVERY phase whose agent ran any unlisted
                # read-only command (file, diff <(..), VAR=$(..)) — an observed
                # 100% false-positive rate that blocked all integrations (#486).
                # We cannot safely re-execute an unclassifiable command, so we
                # fall back to the presence check alone (consistent with the
                # audit_log_absent fail-open above) rather than forcing a
                # refusal. Presence still catches a command the agent claimed
                # but never actually ran.
                if [[ "${verdict}" != "would_have_failed" ]]; then
                    reason="unclassifiable_presence_only"
                fi
                ;;
        esac

        if [[ "${verdict}" == "verified" ]]; then
            verified=$((verified + 1))
        else
            would_have_failed=$((would_have_failed + 1))
        fi

        local ts
        ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        jq -nc \
            --arg ts "${ts}" \
            --arg phase "${phase}" \
            --arg cmd "${cmd}" \
            --arg cls "${classification}" \
            --arg pres "${presence_check}" \
            --arg ec "${exit_code_check}" \
            --arg ot "${output_tail_check}" \
            --arg rx "${reexec_check}" \
            --arg verd "${verdict}" \
            --arg reason "${reason}" \
            '{
                ts: $ts,
                phase: $phase,
                command: $cmd,
                classification: $cls,
                checks: {
                    presence: $pres,
                    exit_code: $ec,
                    output_tail: $ot,
                    re_execution: $rx
                },
                verdict: $verd,
                reason: $reason
            }' >> "${report}" 2>/dev/null || true
    done

    # Calibration summary to stderr (the daemon log).
    printf 'verification_summary: phase=%s verified=%d would_have_failed=%d\n' \
        "${phase}" "${verified}" "${would_have_failed}" >&2

    # Phase B is log-only: always return 0. Phase C will branch on `mode`.
    if [[ "${mode}" == "refuse" && "${would_have_failed}" -gt 0 ]]; then
        # Phase C will translate this to an envelope-override. For now,
        # report it via the exit code only.
        return 2
    fi
    return 0
}
