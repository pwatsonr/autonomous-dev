# code-fixer (FIXTURE)

This is a **fixture** plugin used by SPEC-022-2-03 / SPEC-022-2-05 end-to-end
tests. It is NOT a production plugin and is not meant to ship in the
marketplace.

What it does: given a `security-findings` artifact, emits one placeholder
`code-patches` entry per finding. Every emitted patch carries
`requires_approval: true` so the chain executor pauses for human approval.

Why a fixture: the real `code-fixer` logic (LLM-driven patch synthesis) is a
future plan. The fixture lets the standards-to-fix integration test exercise
the full wiring deterministically — produce/consume declarations, the
approval gate, and the resume path — without depending on a live model call.

The fixture's manifest declares:
- `consumes[security-findings].on_failure = 'warn'` — if the reviewer fails,
  the fixer is skipped; no findings means no patches needed.
- `produces[code-patches].on_failure = 'block'` — if the fixer itself fails,
  the chain halts; patches are security-critical, partial failures must
  surface.
- `produces[code-patches].requires_approval = true` — the chain pauses after
  the patch is produced and awaits operator approval before proceeding.
