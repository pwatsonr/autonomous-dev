#!/usr/bin/env bun
/**
 * Bun entrypoint for the reliability harness (#524).
 *
 * Thin wrapper: all logic lives in `run-harness.ts` (the importable library).
 * This file exists solely to carry the shebang and the `import.meta.main`
 * guard — bun's idiom for "run directly, not imported" (the same idiom the
 * existing `scripts/*.ts` use). Keeping `import.meta` out of `run-harness.ts`
 * lets ts-jest import that module under its CommonJS transform without a
 * SyntaxError, while bun runs this file unchanged.
 *
 *   bun tools/reliability/cli.ts --repo <scratch> --tasks all --repeats 3
 *   bun tools/reliability/cli.ts --repo <scratch> --dry-run    # no daemon, $0
 *
 * COST WARNING: a LIVE run is ~$3 and ~30min PER (task x repeat). Use
 * --dry-run to validate wiring for free; scope cost with --tasks/--repeats.
 *
 * @module tools/reliability/cli
 */

import { main } from './run-harness';

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`Fatal: ${err?.stack ?? err}\n`);
      process.exit(1);
    },
  );
}
