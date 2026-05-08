#!/usr/bin/env node
// reload-plugins: operator entry point for `plugin reload <name>`.
// All testable logic lives in intake/cli/dispatcher.ts; this wrapper just
// translates the dispatcher's Promise<number> into a process exit code.
//
// Per PRD-016 FR-1660, this is the ONLY file in PLAN-030-3 that calls
// process.exit. Spec coverage: SPEC-030-3-02.
//
// The plugin ships TypeScript sources directly (no build step in
// package.json), so we register ts-node in transpile-only mode and import
// the .ts source. The require path is intentionally relative to __dirname
// so the script works from any cwd, and from a node_modules install.

'use strict';

const path = require('node:path');

// Register ts-node so we can require() the .ts dispatcher. transpile-only
// is intentional: type-checking happens in CI via `tsc --noEmit`, not on
// every CLI invocation.
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs' },
});

const { dispatch } = require(path.join(
  __dirname,
  '..',
  'intake',
  'cli',
  'dispatcher.ts',
));

dispatch(process.argv.slice(2))
  .then((code) => {
    // Cap exit codes to the documented contract {0, 1, 2}.
    const safe = code === 0 || code === 1 || code === 2 ? code : 2;
    process.exit(safe);
  })
  .catch((err) => {
    // Defense-in-depth: any uncaught throw maps to exit 2. The dispatcher
    // already catches its own throws; this branch only fires if the
    // require()/import itself fails.
    // eslint-disable-next-line no-console
    console.error(
      `reload-plugins: fatal error: ${err && err.message ? err.message : String(err)}`,
    );
    process.exit(2);
  });
