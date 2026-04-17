# Phase Prompts

This directory contains prompt templates for each pipeline phase.
The daemon's `resolve_phase_prompt()` function loads the template
matching the current request status and substitutes variables.

## Supported Variables

- `{{REQUEST_ID}}` -- The request ID (e.g., REQ-20260408-abcd)
- `{{PROJECT}}` -- Absolute path to the project repository
- `{{STATE_FILE}}` -- Absolute path to the request's state.json
- `{{PHASE}}` -- The current phase name

## File Naming Convention

`{phase-name}.md` -- e.g., `intake.md`, `code.md`, `prd_review.md`

## Fallback

If no prompt file exists for a phase, a minimal fallback prompt is
generated automatically. It instructs Claude to read the state file
and perform the named phase's work.
