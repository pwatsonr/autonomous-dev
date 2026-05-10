#!/usr/bin/env bash
# SPEC-035-4-04 §Goldens size guard.
#
# If total bytes of `tests/visual-regression/goldens/` exceeds 512000 bytes
# (500 KB) AND `.gitattributes` does not contain a git-lfs filter line for
# the goldens directory, exit 1 with `GOLDEN_SIZE_EXCEEDED:` so the PR is
# blocked until git-lfs tracking is wired up.
#
# Below the threshold, goldens are committed as inline blobs (current
# bootstrap state); above it, git-lfs is required to keep clones cheap.

set -euo pipefail

GOLD_DIR="tests/visual-regression/goldens"
THRESHOLD_BYTES=512000  # 500 KB

if [[ ! -d "${GOLD_DIR}" ]]; then
  # Nothing to weigh yet. The presence check (separate script) handles the
  # "no goldens" failure mode; this guard is purely about size policy.
  exit 0
fi

# Sum the byte sizes of every regular file under the goldens dir. `du`'s
# `-sb` is GNU-only; `find -exec stat` is portable across alpine/jammy/macOS
# and avoids surprises in the Playwright Docker image.
total=$(find "${GOLD_DIR}" -type f -exec wc -c {} + 2>/dev/null | awk 'END { print $1 + 0 }')

if [[ "${total}" -le "${THRESHOLD_BYTES}" ]]; then
  exit 0
fi

# Over the threshold — require LFS tracking. Any line in .gitattributes
# that mentions both the goldens path glob AND `filter=lfs` counts.
if [[ -f .gitattributes ]] && \
   grep -E "tests/visual-regression/goldens/\*\.png[[:space:]]+.*filter=lfs" \
        .gitattributes > /dev/null 2>&1; then
  exit 0
fi

echo "GOLDEN_SIZE_EXCEEDED: tests/visual-regression/goldens/ exceeds 500KB without git-lfs tracking. Run \"git lfs track \\\"tests/visual-regression/goldens/*.png\\\"\" and re-stage."
exit 1
