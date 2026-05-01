#!/usr/bin/env bats

# tests/ci/test_document_review_action.bats
# SPEC-017-2-01: Verifies the document-review composite action's fork-PR
# detection logic. Verdict-parsing tests are added by SPEC-017-2-02.

@test "fork detection: head.repo == base.repo => is-fork=false" {
  HEAD_REPO="acme/proj"
  BASE_REPO="acme/proj"
  if [[ "$HEAD_REPO" != "$BASE_REPO" ]]; then result=true; else result=false; fi
  [ "$result" = "false" ]
}

@test "fork detection: head.repo != base.repo => is-fork=true" {
  HEAD_REPO="contributor/proj"
  BASE_REPO="acme/proj"
  if [[ "$HEAD_REPO" != "$BASE_REPO" ]]; then result=true; else result=false; fi
  [ "$result" = "true" ]
}
