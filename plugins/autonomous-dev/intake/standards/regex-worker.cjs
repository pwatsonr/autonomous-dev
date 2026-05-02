// SPEC-021-2-04 §regex-worker — Worker-thread entrypoint for redos-sandbox.
//
// Loaded by `redos-sandbox.ts` via `new Worker(<absolute path to this file>)`.
// Ships as JS (not TS) so the worker boot path has zero compile dependency
// — workers load via the filesystem and a TS loader inside the worker would
// add startup cost + risk.
//
// Hard rules:
//   1. ZERO project-module imports beyond `node:worker_threads`. The worker
//      MUST NOT have access to fs, net, or daemon state.
//   2. NO worker-side timeout — the regex engine holds the worker's event
//      loop; an internal setTimeout would never fire while a catastrophic
//      pattern is backtracking. Main-thread `worker.terminate()` is the
//      single source of truth for the 100ms budget.
//   3. NEVER log to stderr — keep the worker silent so a malicious pattern
//      cannot pollute daemon logs.

const { parentPort, workerData } = require('node:worker_threads');

if (!parentPort) {
  // Loaded directly (not as a worker) — defensive exit.
  process.exit(1);
}

try {
  const { pattern, flags, input } = workerData;
  const re = new RegExp(pattern, flags);
  const start = Date.now();
  const match = re.exec(input);
  const durationMs = Date.now() - start;
  if (!match) {
    parentPort.postMessage({ matches: false, durationMs });
  } else {
    let line = 1;
    for (let i = 0; i < match.index; i++) {
      if (input.charCodeAt(i) === 10) line += 1;
    }
    parentPort.postMessage({
      matches: true,
      matchLine: line,
      groups: Array.from(match).slice(1),
      durationMs,
    });
  }
} catch (err) {
  parentPort.postMessage({
    matches: false,
    error: err && err.message ? err.message : String(err),
  });
}
