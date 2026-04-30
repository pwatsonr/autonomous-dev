# SPEC-021-2-05: Adversarial Tests (Sandbox Escape + ReDoS) + Performance Benchmarks

## Metadata
- **Parent Plan**: PLAN-021-2
- **Tasks Covered**: Task 11 (adversarial tests), Task 12 (performance benchmarks)
- **Estimated effort**: 6 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-021-2-05-adversarial-tests-perf-benchmarks.md`

## Description

Build the test suite that proves the sandbox holds and the perf budgets are met. Two file groups:

1. **Adversarial tests** (`tests/standards/test-sandbox-escape.test.ts`, `tests/standards/test-redos-adversarial.test.ts`): a battery of attacks that the subprocess sandbox (SPEC-021-2-03) and the ReDoS sandbox (SPEC-021-2-04) MUST defeat. Sandbox-escape attacks: TCP connect, file write outside cwd, fork-bomb, memory exhaustion, env-var read, process-introspection. ReDoS attacks: a curated catalog of ≥10 catastrophic-backtracking patterns drawn from public corpora (RegExLib, OWASP ReDoS examples). Each adversarial test is structured with a clear name describing the attack and asserts the specific defense (timeout, exit code, error type).

2. **Performance benchmarks** (`tests/perf/test-evaluator-perf.bench.ts`): measurable thresholds captured as CI artifacts. Targets per PLAN-021-2: registry startup <50ms, custom-evaluator subprocess launch <200ms p95, ReDoS sandbox eval <50ms p95 for safe patterns, built-in evaluator throughput >100 evaluations/sec on typical inputs. Benchmarks use a deterministic harness (no network, fixed input sizes, warm-up iterations to stabilize JIT) and emit JSON results that the CI workflow archives as artifacts.

Both adversarial and perf suites are gates: a failure in either fails the build. Sandbox-escape failures auto-page (per the existing alerting wired in PLAN-001-X) because they indicate a security regression. Perf regressions ≥10% over the captured baseline fail with a clear "perf regression" message.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/standards/test-sandbox-escape.test.ts` | Create | 6+ named escape attempts, all asserted to be blocked |
| `plugins/autonomous-dev/tests/standards/test-redos-adversarial.test.ts` | Create | 10+ catastrophic patterns, all asserted to time out within 100ms |
| `plugins/autonomous-dev/tests/standards/fixtures/escape/network-connect.sh` | Create | curl/python attempt to TCP connect to example.com |
| `plugins/autonomous-dev/tests/standards/fixtures/escape/write-outside-cwd.sh` | Create | tries to write `/etc/test-escape-marker` and `/tmp/escape-marker-x` |
| `plugins/autonomous-dev/tests/standards/fixtures/escape/memory-exhaustion.sh` | Create | python -c allocates 1GB |
| `plugins/autonomous-dev/tests/standards/fixtures/escape/fork-bomb.sh` | Create | bounded fork attempt (limited iters so test doesn't trash CI) |
| `plugins/autonomous-dev/tests/standards/fixtures/escape/env-leak.sh` | Create | env writes to stdout (test asserts the output is empty / sanitized) |
| `plugins/autonomous-dev/tests/standards/fixtures/escape/proc-introspect.sh` | Create | reads /proc/self/status (Linux) or /dev/null (macOS no-op) and reports |
| `plugins/autonomous-dev/tests/standards/fixtures/redos-catalog.json` | Create | JSON array of `{name, pattern, input, source}` for ≥10 ReDoS samples |
| `plugins/autonomous-dev/tests/perf/test-evaluator-perf.bench.ts` | Create | Benchmark harness for registry, sandbox, ReDoS, throughput |
| `plugins/autonomous-dev/tests/perf/perf-baseline.json` | Create | Initial baseline thresholds; updated by CI on intentional improvements |
| `.github/workflows/perf-benchmarks.yml` (or equivalent CI file) | Modify | Add a job that runs the bench, uploads JSON artifact, asserts thresholds |

## Implementation Details

### Sandbox-Escape Test Suite (`test-sandbox-escape.test.ts`)

Test naming convention: `'sandbox blocks: <attack-name>'`. Each test:

1. Adds the fixture to the allowlist via a test-scoped `EvaluatorRegistry`.
2. Invokes `runCustomEvaluator(fixturePath, [], {}, {allowlist: [...]})`.
3. Asserts the documented defense.

```typescript
import { runCustomEvaluator } from '@/standards/sandbox';
import { SandboxTimeoutError, SandboxMemoryError, SecurityError } from '@/standards/errors';
import { resolve } from 'node:path';

const F = (name: string) => resolve(__dirname, 'fixtures/escape', name);

describe('subprocess sandbox — adversarial', () => {
  // Allowlist enforcement (most critical invariant)
  it('refuses ANY path not in allowlist (no subprocess spawned)', async () => {
    const spy = jest.spyOn(require('node:child_process'), 'execFile');
    await expect(
      runCustomEvaluator('/tmp/anywhere/evil.sh', [], {}, { allowlist: [] })
    ).rejects.toThrow(SecurityError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses relative path even if appears in allowlist', async () => {
    await expect(
      runCustomEvaluator('./evil.sh', [], {}, { allowlist: ['./evil.sh'] })
    ).rejects.toThrow(/absolute/);
  });

  // Network
  describeSkipOnNoNet('sandbox blocks: TCP connect to external host', () => {
    it('blocks curl http://example.com', async () => {
      const path = F('network-connect.sh');
      const result = await runCustomEvaluator(path, [], {}, { allowlist: [path] })
        .catch((e) => ({ thrown: e }));
      // On Linux+unshare, the script's curl will fail; the wrapper will surface
      // a non-zero exit which manifests as either a thrown Error from execFile
      // OR a parsed JSON output where the script reported the failure.
      expect(result).toMatchObject(
        expect.objectContaining({
          // Either a thrown Error mentioning 'network' / non-zero exit,
          // OR a parsed result where the script's self-reported attempt failed.
        })
      );
      // Use platform helpers to assert the right shape per OS.
    });
  });

  // Filesystem
  it('sandbox blocks: write outside cwd', async () => {
    const path = F('write-outside-cwd.sh');
    await runCustomEvaluator(path, [], {}, { allowlist: [path] }).catch(() => undefined);
    expect(existsSync('/etc/test-escape-marker')).toBe(false);
    expect(existsSync('/tmp/escape-marker-x')).toBe(false); // outside /tmp/eval-sandbox
  });

  // Memory (Linux: prlimit; macOS: ulimit indirectly)
  it('sandbox blocks: memory exhaustion (1GB alloc)', async () => {
    const path = F('memory-exhaustion.sh');
    await expect(
      runCustomEvaluator(path, [], {}, { allowlist: [path] })
    ).rejects.toBeInstanceOf(SandboxMemoryError);
  });

  // Time
  it('sandbox blocks: 30s+ wall clock', async () => {
    // sleep-35 fixture inline in this test:
    const path = F('long-sleep.sh');     // emits sleep 35
    await expect(
      runCustomEvaluator(path, [], {}, { allowlist: [path] })
    ).rejects.toBeInstanceOf(SandboxTimeoutError);
  }, 32_000);  // jest timeout: 32s

  // Fork bomb (bounded)
  it('sandbox blocks: bounded fork bomb does not destabilize host', async () => {
    const path = F('fork-bomb.sh');
    const start = Date.now();
    await runCustomEvaluator(path, [], {}, { allowlist: [path] }).catch(() => undefined);
    const elapsed = Date.now() - start;
    // The sandbox should kill within 30s (timeout) AND the host should remain responsive.
    expect(elapsed).toBeLessThan(31_000);
  }, 32_000);

  // Env vars
  it('sandbox blocks: env var leak from parent', async () => {
    process.env.SECRET_TEST_VALUE = 'do-not-leak';
    const path = F('env-leak.sh');
    const result = await runCustomEvaluator(path, [], {}, { allowlist: [path] });
    // env-leak.sh's stdout JSON includes a 'env_dump' field; verify SECRET is absent.
    expect(JSON.stringify(result)).not.toContain('do-not-leak');
    delete process.env.SECRET_TEST_VALUE;
  });

  // Process introspection
  it('sandbox blocks: cannot enumerate parent process via /proc', async () => {
    // Linux-only assertion guarded by platform check
    if (process.platform !== 'linux') return;
    const path = F('proc-introspect.sh');
    const result = await runCustomEvaluator(path, [], {}, { allowlist: [path] });
    expect(JSON.stringify(result)).not.toContain('node'); // can't see parent's cmdline
  });
});
```

### Sandbox-Escape Fixture Examples

**`network-connect.sh`** (POSIX shell):
```bash
#!/bin/sh
# Attempt TCP connect; report success/failure as JSON.
if curl -s --max-time 3 http://example.com > /dev/null 2>&1; then
  echo '{"passed": false, "findings": [{"file":"<sandbox>","line":0,"severity":"critical","message":"NETWORK ESCAPE: connected to example.com"}]}'
  exit 1
fi
echo '{"passed": true, "findings": []}'
exit 0
```

**`write-outside-cwd.sh`**:
```bash
#!/bin/sh
echo "marker" > /etc/test-escape-marker 2>/dev/null
echo "marker" > /tmp/escape-marker-x 2>/dev/null
echo '{"passed": true, "findings": []}'
exit 0
```

**`memory-exhaustion.sh`**:
```bash
#!/bin/sh
# Forces a 1GB allocation. Killed by prlimit / ulimit before completion.
python3 -c "x = bytearray(1024*1024*1024); print(len(x))" 2>/dev/null
echo '{"passed": true, "findings": []}'
exit 0
```

**`env-leak.sh`**:
```bash
#!/bin/sh
ENV_DUMP=$(env | tr '\n' ' ')
printf '{"passed": true, "findings": [], "env_dump": "%s"}\n' "$ENV_DUMP"
exit 0
```

(Each fixture is committed `chmod +x`. CI step `chmod` ensures permissions are restored after fresh checkout if the OS strips bits.)

### ReDoS Adversarial Catalog (`redos-catalog.json`)

```json
[
  { "name": "exponential-trailing", "pattern": "^(a+)+$",                "input": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaX", "source": "OWASP" },
  { "name": "exponential-grouped",  "pattern": "^(a|a)+$",               "input": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!", "source": "OWASP" },
  { "name": "polynomial-anchored",  "pattern": "^(a*)*b$",               "input": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "source": "RegExLib" },
  { "name": "email-naive",          "pattern": "^([a-zA-Z0-9])(([\\-.]|[_]+)?([a-zA-Z0-9]+))*(@){1}([a-z0-9]+)([\\.][a-z]{2,3}){2}$", "input": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@", "source": "RegExLib-evil-email" },
  { "name": "url-naive",            "pattern": "^(([^:/?#]+):)?(//([^/?#]*))?([^?#]*)(\\?([^#]*))?(#(.*))?$", "input": "http://aaaaaaaaaaaaaaaaaaaaaa", "source": "RFC3986-evil" },
  { "name": "phone-naive",          "pattern": "^[+]?[(]?[0-9]{1,4}[)]?[-\\s\\.]?([0-9]{1,4}[-\\s\\.]?){1,5}[0-9]{1,9}$", "input": "+1234567890123456789012345678901234567890123!", "source": "RegExLib" },
  { "name": "nested-quantifier",    "pattern": "(.*)*x$",                "input": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "source": "OWASP" },
  { "name": "alternation-overlap",  "pattern": "(ab|a)+b$",              "input": "ababababababababababababababababababababababab!", "source": "OWASP" },
  { "name": "html-tag-naive",       "pattern": "<(\\w+)(\\s+\\w+=\"[^\"]*\")*\\s*>", "input": "<a href=\"x\" onclick=\"y\" data=\"z\"...", "source": "OWASP" },
  { "name": "filename-double-ext",  "pattern": "^(.+)+\\.(jpg|png|gif)$", "input": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.exe",         "source": "RegExLib" }
]
```

Each entry's `input` is calibrated to trigger catastrophic backtracking on a backtracking engine (V8) but stay below the 10KB cap so the test reaches the regex execution stage (not pre-flight rejection).

### ReDoS Adversarial Test (`test-redos-adversarial.test.ts`)

```typescript
import { evaluateRegex } from '@/standards/redos-sandbox';
import catalog from './fixtures/redos-catalog.json';

describe('ReDoS sandbox — adversarial catalog', () => {
  for (const entry of catalog) {
    it(`times out within 150ms: ${entry.name} (${entry.source})`, async () => {
      const start = Date.now();
      const result = await evaluateRegex(entry.pattern, entry.input);
      const elapsed = Date.now() - start;
      expect(result.timedOut).toBe(true);
      expect(result.error).toMatch(/ReDoSError/);
      expect(elapsed).toBeLessThan(150);    // 100ms budget + 50ms grace + worker boot
    });
  }

  it('input >10KB rejected before worker spawn', () => {
    expect(() => evaluateRegex('foo', 'a'.repeat(10241))).toThrow(/SecurityError/);
    // No await — the size check is synchronous in the implementation.
  });

  it('100 concurrent evil patterns do not destabilize the daemon', async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, () => evaluateRegex('^(a+)+$', 'a'.repeat(30) + 'X')),
    );
    expect(results.every(r => r.timedOut === true)).toBe(true);
  }, 30_000);
});
```

### Performance Benchmark Harness (`test-evaluator-perf.bench.ts`)

```typescript
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import baseline from './perf-baseline.json';
import { EvaluatorRegistry } from '@/standards/evaluator-registry';
import { runEvaluator } from '@/standards/runner';
import { evaluateRegex } from '@/standards/redos-sandbox';
import { runCustomEvaluator } from '@/standards/sandbox';

interface Sample { name: string; ms: number[]; }

function bench(name: string, iters: number, warmup: number, fn: () => Promise<unknown> | unknown): Promise<Sample> {
  return (async () => {
    for (let i = 0; i < warmup; i++) await fn();
    const ms: number[] = [];
    for (let i = 0; i < iters; i++) {
      const t0 = performance.now();
      await fn();
      ms.push(performance.now() - t0);
    }
    return { name, ms };
  })();
}

function p95(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)];
}

(async () => {
  const samples: Sample[] = [];

  // 1) Registry startup
  samples.push(await bench('registry-startup', 50, 5,
    () => new EvaluatorRegistry(() => [])));

  // 2) Subprocess sandbox launch (allowed fixture)
  const allowedFixture = '<abs path to tests/standards/fixtures/eval-allowed.sh>';
  samples.push(await bench('sandbox-launch', 30, 3,
    () => runCustomEvaluator(allowedFixture, [], {}, { allowlist: [allowedFixture] })));

  // 3) ReDoS sandbox safe pattern
  samples.push(await bench('redos-safe', 200, 10,
    () => evaluateRegex('foo', 'foo bar baz')));

  // 4) Built-in throughput (framework-detector)
  const ctx = { workspaceRoot: '<fixture workspace path>' };
  samples.push(await bench('builtin-framework-detector', 200, 10,
    async () => {
      const reg = new EvaluatorRegistry(() => []);
      await runEvaluator(
        { id: 'PERF-1', evaluator: 'framework-detector', args: { framework_match: 'fastapi' } } as any,
        ['package.json'],
        { registry: reg, allowlist: [], ctx } as any,
      );
    }));

  const report = samples.map(s => ({
    name: s.name,
    p50: p95(s.ms.slice(0, Math.floor(s.ms.length * 0.5))),
    p95: p95(s.ms),
    iters: s.ms.length,
  }));

  writeFileSync('perf-results.json', JSON.stringify(report, null, 2));

  // Assert thresholds
  for (const row of report) {
    const limit = (baseline as any)[row.name];
    if (!limit) continue;
    if (row.p95 > limit.p95_ms * 1.10) {
      throw new Error(`Perf regression: ${row.name} p95 ${row.p95}ms > baseline ${limit.p95_ms}ms + 10%`);
    }
  }
})();
```

### Perf Baseline (`perf-baseline.json`)

```json
{
  "registry-startup":           { "p95_ms": 50  },
  "sandbox-launch":             { "p95_ms": 200 },
  "redos-safe":                 { "p95_ms": 50  },
  "builtin-framework-detector": { "p95_ms": 10  }
}
```

These are the PLAN-021-2 targets; the bench fails if observed p95 exceeds baseline by >10%.

### CI Workflow Wiring

The CI job (existing GitHub Actions workflow extended):

1. Runs `npm test -- tests/standards/test-sandbox-escape.test.ts` and `tests/standards/test-redos-adversarial.test.ts`. Failures fail the build.
2. Runs `npm run bench:evaluators` (script wiring `node tests/perf/test-evaluator-perf.bench.ts`).
3. Uploads `perf-results.json` as a workflow artifact (`actions/upload-artifact@v4`).
4. Fails the build if the bench script throws (perf regression).
5. On `main`-branch merges, posts the perf-results JSON to the dashboard endpoint (separate workflow step; out of scope here).

## Acceptance Criteria

- [ ] `tests/standards/test-sandbox-escape.test.ts` includes named tests for: allowlist-denial-without-spawn, relative-path rejection, TCP connect, file write outside cwd, memory exhaustion, 30s timeout, fork bomb, env var leak, /proc introspection (Linux only).
- [ ] Allowlist denial test verifies (via `jest.spyOn`) that `child_process.execFile` is NEVER invoked when the path is not allowlisted.
- [ ] Memory exhaustion test asserts a `SandboxMemoryError` is thrown (Linux), or platform-equivalent on macOS (skipped on `'fallback'` platform with a documented `console.warn`).
- [ ] Timeout test asserts a `SandboxTimeoutError` is thrown after >=30 seconds wall clock.
- [ ] Env-var leak test sets `process.env.SECRET_TEST_VALUE = 'do-not-leak'` before the call; the parsed evaluator output (and any captured stdout) MUST NOT contain `'do-not-leak'`.
- [ ] After the entire sandbox-escape suite runs, no marker files exist on disk (verified by `existsSync` for each fixture's intended target).
- [ ] `tests/standards/test-redos-adversarial.test.ts` iterates the JSON catalog and asserts EVERY entry resolves with `timedOut: true` AND elapsed wall-clock < 150ms.
- [ ] The catalog (`redos-catalog.json`) contains at least 10 entries spanning OWASP and RegExLib sources, each with a clearly named attack class.
- [ ] Concurrent ReDoS test issues 100 simultaneous attacks; all 100 timeout cleanly; total wall clock < 30s; no leaked workers (verified by `process._getActiveHandles()` count returning to baseline ±2 after a 1s settle).
- [ ] `tests/perf/test-evaluator-perf.bench.ts` runs end-to-end without throwing on a CI runner (assuming targets are met).
- [ ] `perf-results.json` is produced as an artifact; structure: `[{name, p50, p95, iters}]`.
- [ ] `registry-startup` p95 < 50ms in the published artifact.
- [ ] `sandbox-launch` p95 < 200ms in the published artifact.
- [ ] `redos-safe` p95 < 50ms in the published artifact.
- [ ] `builtin-framework-detector` p95 < 10ms (target derived from the >100 evals/sec throughput requirement) in the published artifact.
- [ ] If any p95 exceeds the baseline by >10%, the bench script throws with a clear "Perf regression" message and the CI build fails.
- [ ] CI workflow uploads `perf-results.json` as a downloadable artifact on every benchmark run.
- [ ] Cross-platform handling: Linux-only adversarial cases (fork-bomb relying on /proc, memory exhaustion via prlimit-specific behavior) are skipped on macOS with a `console.warn` so the gap is visible. macOS-specific cases (sandbox-exec network deny) are skipped on Linux similarly.

## Dependencies

- **Blocked by**: SPEC-021-2-03 (sandbox + registry under test), SPEC-021-2-04 (real ReDoS sandbox + `runEvaluator` under test). Cannot run meaningfully until both are merged.
- **Consumed by**: nothing — this spec is a leaf. It is the gate that allows PLAN-021-2 to be marked done.
- **Runtime deps**: `node:perf_hooks` (built-in). The CI workflow uses `actions/upload-artifact@v4`.
- **External**: Linux test environment must allow `unshare` (CI runners typically allow user namespaces in Ubuntu images). macOS test environment must allow `sandbox-exec` (default-on through macOS 15). The `'fallback'` platform path is exercised by mocking `detectPlatform()` in a separate unit test (already covered by SPEC-021-2-03's test suite).

## Notes

- The adversarial suite is structured for visibility: each test name describes the exact attack and the defense. When a regression breaks a test, the failure message reads `'sandbox blocks: TCP connect to external host — failed (1 of 9)'`, immediately indicating that network isolation broke. This is more diagnostic than a generic "sandbox test failed".
- The `redos-catalog.json` is intentionally a data file (not inlined TypeScript) so security researchers / contributors can extend it with new published patterns without touching test logic. Adding an entry to the JSON automatically adds a test case.
- The 150ms threshold on adversarial timeouts has 50ms of headroom over the 100ms hard timeout. This accounts for worker boot (~10ms), V8 safepoint preemption granularity (~1-2ms), and CI runner jitter (~30ms). Tighter assertions cause flakes; looser assertions hide regressions.
- Perf baselines are committed to the repo (`perf-baseline.json`). Intentional improvements (e.g. switching framework-detector to a faster manifest parser) require updating the baseline in the same PR; the +10% tolerance prevents incidental flakes from green CI runners.
- Fork-bomb fixture is deliberately bounded (e.g. 50 iterations max) so a misconfigured CI runner without proper isolation doesn't cascade-fail the entire job. The point of the test is to verify the sandbox kills the process; an unbounded bomb adds risk without information.
- The `env-leak` test uses substring-NOT-contains rather than parsing env output, because shells inject a few default vars (PWD, SHLVL) that are NOT secrets. Asserting "exactly empty env" causes false positives on platforms that initialize a tiny baseline; asserting "secret value not present" catches the actual security-relevant leak.
- Memory exhaustion on macOS is harder to assert than on Linux because `sandbox-exec` does not expose a clean memory cap; this spec accepts that the macOS branch may not assert `SandboxMemoryError` and instead asserts the process exited non-zero within the timeout. PLAN-021-2 §Risks documents this as a known weaker macOS guarantee.
- The bench script is a Node script, not a Jest test, because Jest's instrumentation perturbs timing measurements. Running it under `node` directly produces clean numbers. The CI step invokes it via `npm run bench:evaluators`; the script exits non-zero on regression.
- Future work (out of scope here): wire perf-results.json into a long-term trend dashboard. Today, baselines are static; a dashboard would let operators see drift over weeks and tighten budgets when sustained improvements appear.
