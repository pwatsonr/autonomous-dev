#!/usr/bin/env bash
# SPEC-034-2-01 / TDD-034 §5.8 (M-01)
# Reject hex color literals, hardcoded font-family declarations, and
# hardcoded px sizes in non-token CSS files.
#
# Scans (PRD-025 FR-025-01 — these are the directories the portal CSS
# actually lives in; the prior globs pointed at server/static/ which has
# never existed, so this gate was a silent no-op):
#   plugins/autonomous-dev-portal/static/*.css
#   plugins/autonomous-dev-portal/src/styles/**/*.css
# Excludes:
#   design-tokens.css (the canonical source of truth for tokens).
#
# Exit codes:
#   0 — no violations
#   1 — one or more violations found (file/line printed for each)
#   2 — zero files scanned (fail-closed against future path drift)
set -euo pipefail

PORTAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CSS_FILES=$(find "$PORTAL_DIR/static" "$PORTAL_DIR/src/styles" \
    -name '*.css' ! -name 'design-tokens.css' 2>/dev/null)

# Fail-closed: a token-discipline gate that scans nothing is worse than no
# gate at all because it reads as green. If the directories move again,
# surface it loudly instead of silently passing.
if [ -z "$(printf '%s' "$CSS_FILES" | tr -d '[:space:]')" ]; then
    echo "ERROR: lint-css-tokens scanned 0 CSS files — check scan paths ($PORTAL_DIR/static, $PORTAL_DIR/src/styles)." >&2
    exit 2
fi

EXIT=0

while IFS= read -r file; do
    [ -z "$file" ] && continue

    # Strip `/* … */` block comments (including multi-line ones) before
    # scanning, replacing comment characters with spaces while PRESERVING
    # newlines so `grep -n` still reports the correct line. The old approach
    # allowlisted only lines that themselves started with `/*` or `*`, which
    # missed block-comment CONTINUATION lines (e.g. a bare `   #416 — note`
    # inside a `/* … */` block) — those mis-flagged issue refs like `#416` as
    # hex colors and forced a `GH-NNN` workaround in the CSS (#570). With
    # comments stripped, no comment text can false-positive regardless of how
    # the comment is formatted.
    code=$(perl -0777 -pe 's{/\*.*?\*/}{ (my $c = $&) =~ s/[^\n]/ /g; $c }gse' "$file")

    # 1. Hex color literals (#xxx, #xxxxxx, #xxxxxxxx).
    #    Per TDD-034 §5.8 v1.1: the first char after '#' must be a digit (0-9)
    #    so CSS ID selectors (#main, #sidebar) are not false-positives. Real
    #    color literals expanded to canonical form always lead with a digit.
    #    Allowlist: var() references, url() values (comments already stripped).
    HEX=$(grep -nE '#[0-9][0-9a-fA-F]{2,7}\b' <<<"$code" \
        | grep -vE 'var\(--' \
        | grep -vE 'url\(' || true)
    if [ -n "$HEX" ]; then
        echo "ERROR: Hex color literal in $file:"
        echo "$HEX"
        EXIT=1
    fi

    # 2. Hardcoded font-family (must use var(--font-*)).
    #    Allowlist: font-family: inherit (CSS reset / component isolation)
    #              font-family: none    (rare reset value)
    #    These do not hard-code a specific typeface and do not bypass the
    #    token system; they explicitly inherit or clear the font stack.
    FONT=$(grep -nE 'font-family\s*:' <<<"$code" \
        | grep -v 'var(--font-' \
        | grep -vE 'font-family\s*:\s*(inherit|none)\s*[;,)]' || true)
    if [ -n "$FONT" ]; then
        echo "ERROR: Hardcoded font-family in $file:"
        echo "$FONT"
        EXIT=1
    fi

    # 3. Hardcoded px sizes in font-size / padding / margin / gap / border-radius.
    #    Allowlist: var(--*) references, line-leading comments, 0px and 1px
    #    (border hairlines and CSS resets are intentional, not token regressions).
    #    Structural dimensions (max-width, min-width, width, height) are not
    #    scanned — they are layout-specific, not design tokens.
    PX=$(grep -nE '(font-size|padding|margin|gap|border-radius)\s*:.*[0-9]+px' <<<"$code" \
        | grep -v 'var(--' \
        | grep -vE '\b[01]px\b' || true)
    if [ -n "$PX" ]; then
        echo "ERROR: Hardcoded px size in $file:"
        echo "$PX"
        EXIT=1
    fi
done <<< "$CSS_FILES"

exit $EXIT
