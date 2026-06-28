#!/usr/bin/env bun
/**
 * Executable launcher for best-effort lifecycle hook emission (#561 / #568).
 *
 * The emission LOGIC lives in `bin/hooks-cli.ts` (it exports `main` and is
 * imported by the jest CLI suite). This thin wrapper is the file that gets
 * RUN — by the bats suite and by the daemon's `dispatch_phase_session` via
 * `bun run bin/hooks-emit.ts emit <point> ...`. Keeping run-vs-import split
 * avoids the bun/ts-jest module conflict (see the note at the bottom of
 * `bin/review-gate-cli.ts`).
 *
 * Usage: `bun run bin/hooks-emit.ts emit <hook-point> --request-id <id> \
 *          --repo <path> --phase <phase> [--request-type <type>]`
 *
 * @module bin/hooks-emit
 */

import { main } from './hooks-cli';

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    // BEST-EFFORT: a launcher-level throw must still never block the pipeline.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[warn] hooks-emit: ${message}\n`);
    process.exit(0);
  });
