# SPEC-024-3-04: Unit Tests (Firewall + Cost) and Egress Firewall Enforcement Integration Test

## Metadata
- **Parent Plan**: PLAN-024-3
- **Tasks Covered**: Task 11 (unit tests for firewall + cost estimation), Task 12 (integration test: egress firewall enforcement)
- **Estimated effort**: 7 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-024-3-04-firewall-cost-tests-egress-integration.md`

## Description
Final verification spec for PLAN-024-3. Two artifacts:

1. **Unit-test suites** for the firewall modules (nftables, pfctl, dns-refresh, wildcard-expander, trust integration) and the cost-estimation modules (per-cloud heuristics, orchestrator wiring, deploy-estimate CLI). All tests use mocked external dependencies — no real `nft` / `pfctl` calls, no real DNS, no real cloud SDK calls. Coverage gate: ≥90% lines on the firewall and cost-estimation modules combined.
2. **One integration test** that exercises the egress firewall end-to-end: a fixture privileged-backend child process with a tight allowlist (only `httpbin.org`) is spawned, then attempts a connection to `evil.example.com`. The test asserts that the second connection fails at the firewall layer (`ECONNREFUSED` on macOS via `block return`, `ETIMEDOUT` or `EHOSTUNREACH` on Linux via `reject with icmp`). The integration test runs only on Linux and macOS in CI; Windows is skipped.

This spec assumes SPEC-024-3-01 through -03 are merged. It does not modify production code; it only adds test files and the test fixture.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/firewall/test-nftables.test.ts` | Create | Unit tests for `NftablesBackend` |
| `plugins/autonomous-dev/tests/firewall/test-pfctl.test.ts` | Create | Unit tests for `PfctlBackend` |
| `plugins/autonomous-dev/tests/firewall/test-dns-refresh.test.ts` | Create | Unit tests for refresh loop |
| `plugins/autonomous-dev/tests/firewall/test-wildcard-expander.test.ts` | Create | Unit tests for wildcard expansion |
| `plugins/autonomous-dev/tests/hooks/test-cloud-backend-trust.test.ts` | Create | Unit tests for trust extension |
| `plugins/autonomous-dev/tests/deploy/test-cost-estimation.test.ts` | Create | Per-cloud heuristic tests |
| `plugins/autonomous-dev/tests/deploy/test-orchestrator-cost-wiring.test.ts` | Create | Pre-check + ledger emission |
| `plugins/autonomous-dev/tests/cli/test-deploy-estimate.test.ts` | Create | CLI table + JSON modes |
| `plugins/autonomous-dev/tests/integration/test-egress-blocked.test.ts` | Create | End-to-end firewall enforcement |
| `plugins/autonomous-dev/tests/fixtures/firewall-fixture-backend.ts` | Create | Tiny child process used by integration test |
| `plugins/autonomous-dev/tests/fixtures/firewall-fixture-manifest.json` | Create | Plugin manifest for the fixture backend (`egress_allowlist: [{fqdn:'httpbin.org'}]`) |
| `plugins/autonomous-dev/vitest.config.ts` | Modify | Add coverage thresholds for `src/firewall/**` and `src/deploy/**` |

## Implementation Details

### Mocking strategy

All shell-out modules from SPEC-024-3-01 and -02 are mockable single-function modules: `nft-cli.ts::runNft` and `pfctl-cli.ts::runPfctl`. Tests `vi.mock` these and assert on the exact stdin payloads and arg arrays passed in.

DNS is mocked via `vi.mock('dns/promises', () => ({ Resolver: vi.fn(...), resolve4: vi.fn(...), resolve6: vi.fn(...) }))`.

Time is controlled with `vi.useFakeTimers()` for refresh-loop tests.

### Per-file test inventory

**`test-nftables.test.ts`** (≥12 tests):
- `init` creates the table + chain on first call; second call is a no-op.
- `init` throws `FirewallUnavailableError` when `runNft` returns exit code 1 with `Operation not permitted`.
- `applyRulesForPid(12345, [{fqdn:'sts.amazonaws.com', port:443, protocol:'tcp'}])`:
  - Creates cgroup at `/sys/fs/cgroup/autonomous-dev/pid-12345/cgroup.procs` (mocked `fs`).
  - Calls `dns-refresh.register(12345, ...)`.
  - Calls `runNft` once with stdin containing `flush chain ip autonomous-dev-egress pid-12345`, the jump rule, one accept rule per resolved IP, and the trailing `reject with icmp type admin-prohibited`.
- `applyRulesForPid` rejects when cgroup write fails with EACCES; error includes `CAP_NET_ADMIN`.
- `replaceRulesForPid` issues a single atomic transaction (one `runNft` call).
- `removeRulesForPid` deletes the per-PID chain, the jump rule, the cgroup; unregisters from refresh.
- `removeRulesForPid` is idempotent (second call does not throw).
- IPv6 addresses (e.g. `2606:4700::6810:84e5`) produce `ip6 daddr` rules in a separate chain.

**`test-pfctl.test.ts`** (≥10 tests):
- `init` succeeds when `pfctl -s rules` exits 0.
- `init` throws `FirewallUnavailableError` with both `pfctl -e` and `allow_unfirewalled_backends` in the message when stderr contains `pf not enabled`.
- `applyRulesForPid` (with UID side-channel set by the spawner) writes a pf anchor with one `pass out quick … user <uid>` per IP and a final `block return out quick … user <uid>`.
- `removeRulesForPid` runs `pfctl -a autonomous-dev-egress/uid-<uid> -F all`.
- Anchor name is exactly `autonomous-dev-egress/uid-<uid>`.
- All assertions are skipped via `describe.skipIf(process.platform !== 'darwin')` only for tests that touch real files; tests that purely assert on mocked `runPfctl` payloads run on every platform.

**`test-dns-refresh.test.ts`** (≥8 tests):
- `register(pid, allowlist, backend)` schedules the 5-minute interval on first call only.
- `resolveOnce` returns IPv4 + IPv6 results combined.
- `refresh` adds new IPs to the rule set and invokes `backend.replaceRulesForPid` once per affected PID.
- Stale IP (lastSeenMs < now - 1h) is removed on next refresh after advancing fake timers by 1h.
- A failed DNS resolution for one FQDN does not affect rules for other FQDNs (other FQDNs' rules are kept).
- Wildcard FQDNs (`*.foo.com`) are skipped with a WARN log and do not crash the refresh.
- `unregister(pid)` stops further `replaceRulesForPid` calls for that PID.
- When all PIDs are unregistered, the interval is cleared.

**`test-wildcard-expander.test.ts`** (≥4 tests):
- `expandWildcards([{fqdn:'ecs.*.amazonaws.com', …}], 'us-east-1')` returns `[{fqdn:'ecs.us-east-1.amazonaws.com', …}]`.
- Non-wildcard entries pass through unchanged.
- Empty array returns empty array.
- Throws when `region` is empty/undefined and any entry contains `*.`.

**`test-cloud-backend-trust.test.ts`** (≥6 tests):
- Plugin not in `privileged_backends` → `{ ok: false, code: 'CLOUD_BACKEND_NOT_PRIVILEGED' }`.
- Plugin in `privileged_backends` but meta-review status `rejected` → `{ ok: false, code: 'CLOUD_BACKEND_META_REVIEW_FAILED' }` with reviewer notes in `reason`.
- Plugin in `privileged_backends` AND meta-review `approved` → `{ ok: true }`.
- Non-cloud-backend manifest types are not subjected to the new checks (verified by checking `validateCloudBackendTrust` is not called from the trust validator's main flow when `manifest.type !== 'cloud-backend'`).
- Empty `privileged_backends` config is treated as "no plugins approved" (rejection).
- Reason strings include the plugin name verbatim.

**`test-cost-estimation.test.ts`** (≥10 tests):
- AWS: 2 tasks × 0.5 vCPU × 1 hour, memory 1 GiB × 1 hour, image 0.5 GB × 1 run-hour → total within ±$0.005 of `2 * 0.5 * 1.0 * 0.04048 + 2 * 1.0 * 1.0 * 0.004445 + 0.5 * 0.10 * (1/730)`. Confidence 0.85.
- AWS: 0 tasks → estimate 0 with non-empty breakdown showing zeros.
- GCP: 1M requests, no CPU/mem time → exactly $0.40. Confidence 0.65.
- GCP: 0 requests → $0.
- Azure: well-formed params produce non-negative estimate. Confidence 0.6.
- K8s: any params produce `{ estimated_cost_usd: 0, confidence: 0.0, breakdown: [], notes: <non-empty> }`.
- All four backends complete in <50ms (microbenchmark using `performance.now()` over 100 iterations; assertion: average < 50ms).
- Pricing fixtures contain `source_url` and `captured_on` for every cloud (regex assertion).
- `EstimateResult.estimated_cost_usd` always equals the sum of `breakdown[i].subtotal_usd` (validated for each backend with random params).
- `currency` is always `'USD'`.

**`test-orchestrator-cost-wiring.test.ts`** (≥6 tests):
- `runDeploy` calls `backend.estimateDeployCost` exactly once before `backend.deploy`.
- $50 estimate, $100 cap, $0 used → `runDeploy` proceeds; `costLedger.recordEstimate` called with the exact `EstimateResult` fields.
- $50 estimate, $40 cap, $0 used → `runDeploy` throws `DeployRejectedError`; message contains env name, $50, $40, and confidence.
- On rejection, `backend.deploy` is NOT invoked and `costLedger.recordEstimate` is NOT invoked.
- `costLedger.recordEstimate` payload includes `deploy_id`, `env`, `backend`, `estimated_cost_usd`, `breakdown`, `confidence`, `ts`.
- Backend throwing from `estimateDeployCost` propagates a typed error and skips the deploy.

**`test-deploy-estimate.test.ts`** (≥5 tests):
- `deploy estimate --env staging` exit 0; stdout contains backend name, env, total, confidence, and one row per breakdown line.
- `deploy estimate --env staging --json` stdout is parseable JSON matching `EstimateResult & { env, backend }`; no extra log lines on stdout.
- `deploy estimate --env nonexistent` exits 2; stderr contains "env not found".
- Backend error during estimate exits 3; stderr surfaces the backend's error message.
- The CLI does NOT call `deploy()` and does NOT touch the cost ledger (verified by spy assertions).

**`test-egress-blocked.test.ts`** (integration, ≥3 assertions):
- `describe.skipIf(process.platform === 'win32')` wraps the entire suite.
- Setup: spawns the fixture backend via the real session-spawner (with `egress_allowlist: [{fqdn:'httpbin.org'}]`), waiting for "ready" log line on stderr.
- Test 1: fixture connects to `httpbin.org:443` → succeeds (HTTP 200 from `/get`).
- Test 2: fixture connects to `evil.example.com:443` → fails with `ECONNREFUSED` (macOS) or `ETIMEDOUT`/`EHOSTUNREACH` (Linux). The error code assertion is platform-conditional but always non-empty.
- Teardown: kill fixture; assert firewall rules removed (`runNft`/`runPfctl` no longer lists the per-PID/UID chain).
- The integration test requires `CAP_NET_ADMIN` (Linux) or `pfctl` enabled (macOS). When prerequisites are missing, the test is skipped with a clear message rather than failing — CI gates the platform-skip via env var `EGRESS_INTEGRATION=1`.

### Fixture backend (`fixtures/firewall-fixture-backend.ts`)

A minimal Node script:
```ts
process.stdin.once('data', () => {       // wait for "go\n"
  process.stderr.write('ready\n');
  process.stdin.on('data', async chunk => {
    const host = chunk.toString().trim();
    try {
      const sock = net.connect({ host, port: 443, timeout: 5000 });
      sock.once('connect', () => { process.stdout.write(`OK ${host}\n`); sock.destroy(); });
      sock.once('error', err => { process.stdout.write(`ERR ${host} ${err.code}\n`); });
      sock.once('timeout', () => { process.stdout.write(`ERR ${host} ETIMEDOUT\n`); sock.destroy(); });
    } catch (e: any) { process.stdout.write(`ERR ${host} ${e.code}\n`); }
  });
});
```

The integration test sends host names on stdin and parses the `OK`/`ERR` lines on stdout.

### Coverage thresholds (`vitest.config.ts`)

Add to the `coverage` block:
```ts
coverage: {
  thresholds: {
    'src/firewall/**':         { lines: 90, functions: 90, branches: 85 },
    'src/deploy/cost-*.ts':    { lines: 90, functions: 90, branches: 85 },
    'src/cli/commands/deploy-estimate.ts': { lines: 90, functions: 90, branches: 85 },
    'src/hooks/cloud-backend-trust.ts':    { lines: 90, functions: 90, branches: 85 },
  }
}
```

CI fails if any threshold is missed.

## Acceptance Criteria

- [ ] All unit-test files compile and run under `vitest run`.
- [ ] Aggregate coverage for `src/firewall/**` is ≥90% lines, ≥90% functions, ≥85% branches.
- [ ] Aggregate coverage for `src/deploy/cost-*.ts` is ≥90% lines, ≥90% functions, ≥85% branches.
- [ ] No test invokes the real `nft` or `pfctl` binary (verified by `vi.mock` of `nft-cli` / `pfctl-cli` in every firewall test).
- [ ] No test performs a real DNS lookup (verified by `vi.mock` of `dns/promises` in firewall + DNS-refresh tests).
- [ ] No test performs a real network call to a cloud SDK (verified by `vi.mock` of the relevant SDK clients in cost-estimation tests).
- [ ] `test-egress-blocked.test.ts` is skipped on Windows; on Linux/macOS, when `EGRESS_INTEGRATION=1` is set:
  - Connection to `httpbin.org:443` succeeds.
  - Connection to `evil.example.com:443` fails with a network-layer error code (`ECONNREFUSED`, `ETIMEDOUT`, or `EHOSTUNREACH`).
  - Firewall rules for the fixture backend's PID/UID are absent after teardown.
- [ ] `test-egress-blocked.test.ts` is skipped (not failed) when `EGRESS_INTEGRATION` is unset, with a console message stating why.
- [ ] All assertions on error codes use string equality (not regex), to keep failure messages readable.
- [ ] Microbenchmark in `test-cost-estimation.test.ts` asserts each backend's `estimateDeployCost` averages <50ms over 100 iterations.
- [ ] `vitest.config.ts` coverage thresholds are present and CI fails when any threshold is missed (verified by intentionally lowering coverage in a sandbox branch — sanity check, not committed).

## Dependencies

- **Blocks**: Nothing — this is the final spec in PLAN-024-3.
- **Blocked by**: SPEC-024-3-01 (firewall types, nftables, dns-refresh); SPEC-024-3-02 (pfctl, spawner wiring, trust); SPEC-024-3-03 (cost estimation, orchestrator wiring, deploy-estimate CLI).
- **External**: `vitest`, `@vitest/coverage-v8` (already in project devDependencies); `httpbin.org` reachable from CI runners that opt into `EGRESS_INTEGRATION=1`.

## Notes

- The integration test deliberately uses a public host (`httpbin.org`) for the success path because it is a stable HTTP echo service maintained for testing. If `httpbin.org` becomes unavailable, fall back to `example.com` (the IANA reserved domain) — both are safe, well-known, low-traffic targets.
- `evil.example.com` is in the IANA `example.com` reserved zone, so no real DNS record exists; the firewall block is the only thing preventing the connection (DNS resolution itself may fail with `ENOTFOUND` on some CIs, which is also an acceptable outcome — the test accepts any non-success code).
- The "go byte" gate from SPEC-024-3-02 is what makes the integration test deterministic: the fixture backend reads `go\n` only after the spawner has applied firewall rules, so race conditions are impossible.
- IPv6 tests in `test-nftables.test.ts` are kept light — verifying that resolved IPv6 addresses generate `ip6` rules is sufficient; full IPv6 coverage is a future enhancement when the production code adds an IPv6 chain.
- Coverage thresholds are file-scoped (not whole-project) so unrelated PRs don't regress the firewall/cost coverage. The thresholds are intentionally tight (90/90/85) because these modules are security-critical and must be uniformly tested.
- The integration test runs in CI under a dedicated job that sets `EGRESS_INTEGRATION=1` and grants `CAP_NET_ADMIN` to the runner. The default test job leaves it unset so PRs from forks (which can't grant capabilities) still pass. CI configuration changes are tracked in the deploy infra repo (out of scope here).
- All test files use the project's existing `vitest` setup (no Jest, no Mocha); fixture data lives under `tests/fixtures/` to keep `src/` free of test-only artefacts.
