#!/usr/bin/env bun
/**
 * Executable launcher for the reviewer-chain gate (#561).
 *
 * The gate LOGIC lives in `bin/review-gate-cli.ts` (it exports `main` and is
 * imported by the jest CLI suite). This thin wrapper is the file that gets
 * RUN — by the bats suite today and, once enabled, by the daemon's review
 * phase. Keeping run-vs-import split avoids the bun/ts-jest module conflict:
 * referencing `require`/`module` here would force bun into CommonJS-only mode
 * (the file uses `import`), while `import.meta` would break ts-jest's CJS
 * transpile — but since nothing imports THIS file, it stays pure ESM and bun
 * runs it directly.
 *
 * Usage: `bun run bin/review-gate.ts --repo <p> --request-type <t> --gate <g>`
 * (see `--help`). Emits a GateDecision JSON to stdout; exit 0 on completion,
 * 1 on hard error.
 *
 * @module bin/review-gate
 */

import { main } from './review-gate-cli';

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  });
