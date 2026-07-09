#!/usr/bin/env bash
# cli_provenance.sh -- `observability provenance` verb (#694)
#
# Reports every open PR and every `autonomous/*` branch on a repo, classified by
# provenance (daemon-owned vs external concurrent work) so a supervisor can tell
# at a glance which activity is the daemon's and which is a parallel human/agent
# session. External work is labeled as EXPECTED, not a red flag — the whole point
# is to stop misattributing concurrent development as the daemon going rogue.
#
# Dependencies: git, gh (gh optional — PR listing is skipped if absent), jq
# Sources: provenance.sh

set -uo pipefail
# NOTE: `-e` is deliberately NOT set at file scope.

if ! declare -F prov_classify_ref >/dev/null 2>&1; then
    _PROV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    # shellcheck source=provenance.sh
    source "${_PROV_DIR}/provenance.sh"
fi

# ---------------------------------------------------------------------------
# cli_provenance [--project DIR] [--json]
#
# Enumerates:
#   * open PRs         (gh pr list --state open)   keyed by headRefName
#   * autonomous/*     local + remote branches     (git for-each-ref)
# Classifies each ref: daemon | daemon-untracked | external.
#
# Output:
#   default: a table + a summary line (counts). daemon-untracked rows are the
#            only anomalies; external rows are annotated as expected.
#   --json:  {project, refs:[{ref,kind,classification,source,...}], summary:{...}}
#
# Exit codes: 0 always (reporting; an empty repo is not an error). 2 on bad args.
# ---------------------------------------------------------------------------
cli_provenance() {
    local project="" json_mode=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --project) project="${2:-}"; shift 2 ;;
            --json)    json_mode=1; shift ;;
            -h|--help)
                cat <<'EOF'
Usage: autonomous-dev observability provenance [--project DIR] [--json]

Classifies every open PR and autonomous/* branch on the repo as:
  daemon            the daemon's own tracked work (autonomous/REQ-*, request record present)
  daemon-untracked  ANOMALY: namespace branch with no request record — investigate
  external          concurrent human/agent work — EXPECTED, not a red flag
EOF
                return 0 ;;
            *) echo "provenance: unknown arg: $1" >&2; return 2 ;;
        esac
    done
    [[ -n "${project}" ]] || project="$(pwd)"

    if [[ ! -d "${project}/.git" ]]; then
        echo "provenance: not a git repo: ${project}" >&2
        return 2
    fi

    # --- collect refs: "<classification>\t<source>\t<ref>\t<extra>" ----------
    local rows=()
    local ref rid cls

    # open PRs (gh optional)
    if command -v gh >/dev/null 2>&1; then
        local pr_json
        pr_json="$( (cd "${project}" && gh pr list --state open \
            --json number,headRefName,title,author 2>/dev/null < /dev/null) || echo '[]')"
        [[ -n "${pr_json}" ]] || pr_json='[]'
        local line
        while IFS=$'\t' read -r number headref author title; do
            [[ -n "${headref}" ]] || continue
            cls="$(prov_classify_ref "${headref}" "${project}")"
            rows+=("${cls}"$'\t'"pr"$'\t'"${headref}"$'\t'"#${number} @${author}: ${title}")
        done < <(printf '%s' "${pr_json}" | jq -r '.[] | [(.number|tostring), .headRefName, (.author.login // "?"), (.title // "")] | @tsv' 2>/dev/null)
    fi

    # autonomous/* branches (local + remote), de-duplicated by short name
    while IFS= read -r ref; do
        [[ -n "${ref}" ]] || continue
        cls="$(prov_classify_ref "${ref}" "${project}")"
        rows+=("${cls}"$'\t'"branch"$'\t'"${ref}"$'\t'"")
    done < <( (cd "${project}" && git for-each-ref \
        --format='%(refname:short)' \
        'refs/heads/autonomous' 'refs/remotes/*/autonomous' 2>/dev/null) || true)

    # --- summary counts -----------------------------------------------------
    local n_daemon=0 n_untracked=0 n_external=0 r
    for r in "${rows[@]:-}"; do
        [[ -n "${r}" ]] || continue
        case "${r%%$'\t'*}" in
            daemon)           n_daemon=$((n_daemon + 1)) ;;
            daemon-untracked) n_untracked=$((n_untracked + 1)) ;;
            external)         n_external=$((n_external + 1)) ;;
        esac
    done

    if [[ "${json_mode}" -eq 1 ]]; then
        local refs_json="[]"
        if [[ "${#rows[@]}" -gt 0 && -n "${rows[0]:-}" ]]; then
            refs_json="$(
                for r in "${rows[@]}"; do
                    [[ -n "${r}" ]] || continue
                    IFS=$'\t' read -r c s rf ex <<<"${r}"
                    jq -cn --arg c "$c" --arg s "$s" --arg rf "$rf" --arg ex "$ex" \
                        '{classification:$c, source:$s, ref:$rf, detail:$ex}'
                done | jq -s '.'
            )"
        fi
        jq -n --arg project "${project}" \
            --argjson refs "${refs_json}" \
            --argjson daemon "${n_daemon}" \
            --argjson untracked "${n_untracked}" \
            --argjson external "${n_external}" \
            '{project:$project, refs:$refs, summary:{daemon:$daemon, daemon_untracked:$untracked, external:$external}}'
        return 0
    fi

    # --- table --------------------------------------------------------------
    printf 'Provenance report for %s\n' "${project}"
    printf '%-16s %-7s %-34s %s\n' "CLASSIFICATION" "SOURCE" "REF" "DETAIL"
    if [[ "${#rows[@]}" -eq 0 || -z "${rows[0]:-}" ]]; then
        printf '(no open PRs or autonomous/* branches)\n'
    else
        # daemon-untracked first (the anomalies), then daemon, then external
        local order c s rf ex
        for order in daemon-untracked daemon external; do
            for r in "${rows[@]}"; do
                [[ -n "${r}" ]] || continue
                IFS=$'\t' read -r c s rf ex <<<"${r}"
                [[ "${c}" == "${order}" ]] || continue
                printf '%-16s %-7s %-34s %s\n' "${c}" "${s}" "${rf}" "${ex}"
            done
        done
    fi
    printf -- '---\n'
    printf 'daemon=%d  daemon-untracked=%d  external=%d\n' "${n_daemon}" "${n_untracked}" "${n_external}"
    if [[ "${n_untracked}" -gt 0 ]]; then
        printf 'NOTE: %d namespace ref(s) have no request record — investigate (possible stray/impersonating branch).\n' "${n_untracked}"
    fi
    if [[ "${n_external}" -gt 0 ]]; then
        printf 'NOTE: %d external ref(s) are concurrent human/agent work — EXPECTED, not a daemon anomaly.\n' "${n_external}"
    fi
    return 0
}
