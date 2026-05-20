#!/usr/bin/env bash
###############################################################################
# comparator.sh — output-tail comparator for evidence verification
#
# PLAN-042 Phase B (PRD-024 / TDD-041 §D-04, ADR-041-03).
#
# The executor agents claim evidence as `{command, exit_code, output_tail}`.
# Phase B's verifier needs to decide whether a claimed output_tail
# substantially matches an actual observed output_tail (either from the
# audit log, when present, or from a re-execution). Exact-string compare
# would produce a >90% false-positive rate because test runners emit
# slightly different output across runs (timing, file ordering, parallel
# worker line numbers).
#
# Algorithm per TDD-041 §D-04:
#   1. Normalize whitespace (collapse runs of spaces; strip trailing).
#   2. Strip ANSI escape sequences.
#   3. Strip numeric durations  (\b\d+(\.\d+)?\s*(ms|s|seconds)\b).
#   4. Strip ISO-8601 timestamps.
#   5. Line-multiset subsequence check: actual ⊇ X% of claimed's
#      non-empty lines.
#
# Threshold default: 0.5 (50%). This is the empirical threshold from
# TDD-041 §D-04; the file ships at 50% with metrics so the threshold can
# be revisited from real data. Override via `VERIFICATION_TAIL_THRESHOLD`
# env var (decimal 0..1).
#
# Public functions (source this file, then call):
#
#   normalize_tail <<< "raw text"          -> stdout normalized text
#   compare_output_tails CLAIMED ACTUAL    -> exit 0 (match) | 1 (no match)
#                                              prints overlap ratio (0..1)
#                                              followed by verdict to stdout
#
# The output is a single line:  "<ratio> <verdict>"  where verdict is
# "match" or "mismatch". Callers can capture with read -r.
###############################################################################

# Threshold — TDD-041 §D-04 "50% chosen empirically".
: "${VERIFICATION_TAIL_THRESHOLD:=0.5}"

# normalize_tail: read raw text on stdin, write normalized text to stdout.
# Steps mirror TDD-041 §D-04 in order.
normalize_tail() {
    # 1. Strip ANSI escape sequences (CSI: ESC[…m or ESC[…K etc).
    # 2. Strip ISO-8601 timestamps.
    # 3. Strip numeric durations (NNN ms / NN.N s / NN seconds).
    #    `\b` isn't portable in BSD sed; we anchor on a leading
    #    whitespace OR start-of-line + a trailing whitespace OR
    #    end-of-line via two passes.
    # 4. Collapse runs of spaces, strip trailing whitespace, drop blank
    #    lines (we operate on non-empty lines only per TDD-041).
    sed -E \
        -e $'s/\x1B\\[[0-9;]*[A-Za-z]//g' \
        -e 's/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})?//g' \
        -e 's/([[:space:]]|^)[0-9]+(\.[0-9]+)?[[:space:]]*(ms|seconds|sec|s)([[:space:]]|$)/\1\4/g' \
        -e 's/([[:space:]]|^)[0-9]+(\.[0-9]+)?[[:space:]]*(ms|seconds|sec|s)([[:space:]]|$)/\1\4/g' \
        -e 's/[[:space:]]+/ /g' \
        -e 's/^[[:space:]]+//' \
        -e 's/[[:space:]]+$//' \
    | awk 'NF>0'
}

# compare_output_tails CLAIMED ACTUAL
#
# Returns:
#   stdout: "<ratio> <verdict>"  (ratio decimal 0..1; verdict match|mismatch)
#   exit  : 0 on match, 1 on mismatch
#
# Empty claimed tail: degenerate. We treat empty-claim as `match` with
# ratio 1.0 — there's nothing to verify. (Phase B's job is to flag
# fabrication; an empty claim isn't a fabrication, it's an absence.
# PR #339's empty-evidence-array guard catches the absence case.)
compare_output_tails() {
    local claimed="$1" actual="$2"
    local threshold="${VERIFICATION_TAIL_THRESHOLD}"

    local norm_claimed norm_actual
    norm_claimed="$(printf '%s' "${claimed}" | normalize_tail)"
    norm_actual="$(printf '%s' "${actual}" | normalize_tail)"

    # Count claimed non-empty lines (post-normalize).
    local claimed_total
    claimed_total=$(printf '%s\n' "${norm_claimed}" | awk 'NF>0' | wc -l | tr -d ' ')

    if [[ "${claimed_total}" -eq 0 ]]; then
        printf '1.000 match\n'
        return 0
    fi

    # For each non-empty claimed line, ask: does it appear in the actual
    # tail? "Line-multiset subsequence" per TDD-041: count duplicates;
    # an actual line consumed by one claimed match can't satisfy another.
    #
    # Implementation: write claimed + actual to temp files (awk -v can't
    # carry multi-line strings safely), then awk reads actual first to
    # build a multiset, then walks claimed counting matches.
    local tmpdir matched
    tmpdir=$(mktemp -d 2>/dev/null) || tmpdir="/tmp/cmp.$$"
    mkdir -p "${tmpdir}"
    printf '%s\n' "${norm_claimed}" > "${tmpdir}/claimed"
    printf '%s\n' "${norm_actual}"  > "${tmpdir}/actual"

    matched=$(awk '
        NR == FNR {
            if (length($0) > 0) actual_count[$0]++
            next
        }
        {
            if (length($0) == 0) next
            if (($0 in actual_count) && actual_count[$0] > 0) {
                actual_count[$0]--
                matched++
            }
        }
        END { print matched + 0 }
    ' "${tmpdir}/actual" "${tmpdir}/claimed")
    rm -rf "${tmpdir}"

    # Ratio = matched / claimed_total. Use awk for floating-point.
    local ratio verdict
    ratio=$(awk -v m="${matched}" -v t="${claimed_total}" \
        'BEGIN { if (t > 0) printf "%.3f", m / t; else printf "0.000" }')

    # Compare against threshold.
    local pass
    pass=$(awk -v r="${ratio}" -v th="${threshold}" \
        'BEGIN { print (r + 0 >= th + 0) ? 1 : 0 }')
    if [[ "${pass}" == "1" ]]; then
        verdict="match"
    else
        verdict="mismatch"
    fi

    printf '%s %s\n' "${ratio}" "${verdict}"
    [[ "${verdict}" == "match" ]]
}
