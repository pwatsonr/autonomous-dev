# SPEC-024-3-02: macOS pfctl Firewall + Session-Spawn Wiring + Trust Integration

## Metadata
- **Parent Plan**: PLAN-024-3
- **Tasks Covered**: Task 3 (macOS pfctl firewall), Task 5 (session-spawn firewall wiring), Task 6 (trust integration extension)
- **Estimated effort**: 10 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-024-3-02-pfctl-spawn-wiring-trust-integration.md`

## Description
Complete the per-process egress firewall by adding the macOS backend, wiring the firewall into the cloud-backend spawn path, and extending the trust validator to gate cloud-backend registration on both the privileged-backends allowlist and meta-review.

Three artifacts:

1. **pfctl backend (macOS)**: implements the `FirewallBackend` interface from SPEC-024-3-01 using `pfctl` anchors. macOS pf cannot match per-PID, so this backend filters per-UID — the spawn helper assigns each cloud backend a unique effective UID via `setuid` so the per-UID model is functionally per-process.
2. **Session-spawn integration**: extends the existing session spawner so that when a plugin declares `egress_allowlist`, the spawner (a) selects the platform's firewall backend via `selectBackend()`, (b) expands wildcard FQDNs against the resolved cloud region, (c) applies rules right after the child PID is known but before `exec`, (d) tears the rules down on child exit. On Linux without nftables (or macOS without pfctl), the spawner refuses to launch unless `extensions.allow_unfirewalled_backends: true`.
3. **Trust validator extension**: adds two checks to the cloud-backend code path of the existing trust validator: (a) the plugin's name appears in `extensions.privileged_backends[]`, (b) the agent-meta-reviewer (already triggered by `capabilities: ['network', 'privileged-env']`) returned approval. Either check failing rejects the registration with an actionable error.

This spec assumes SPEC-024-3-01 is merged: it imports `FirewallBackend`, `AllowlistEntry`, `selectBackend`, `FirewallUnavailableError`, and the `dns-refresh` singleton.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/firewall/pfctl.ts` | Create | macOS pf backend; implements `FirewallBackend` per-UID |
| `plugins/autonomous-dev/src/firewall/pfctl-cli.ts` | Create | Thin wrapper over `pfctl` shell calls (mockable) |
| `plugins/autonomous-dev/src/firewall/index.ts` | Modify | Register `PfctlBackend` in `selectBackend()` (SPEC-024-3-01 left a stub) |
| `plugins/autonomous-dev/src/sessions/session-spawner.ts` | Modify | Integrate firewall lifecycle around child spawn |
| `plugins/autonomous-dev/src/sessions/wildcard-expander.ts` | Create | Expand `ecs.*.amazonaws.com` → `ecs.<region>.amazonaws.com` |
| `plugins/autonomous-dev/src/hooks/trust-validator.ts` | Modify | Add cloud-backend privileged-backends + meta-review checks |
| `plugins/autonomous-dev/src/hooks/cloud-backend-trust.ts` | Create | Helper module containing the new checks (keeps trust-validator.ts diff small) |

## Implementation Details

### `firewall/pfctl.ts` — macOS backend

State per backend instance:
- `activeAllowlists: Map<uid, AllowlistEntry[]>`
- `anchorName(uid)` returns `autonomous-dev-egress/uid-<uid>`

Lifecycle:

1. **`init()`**: runs `pfctl -a autonomous-dev-egress -s rules` to verify pfctl is enabled. If `pfctl: pf not enabled` is in stderr, throws `FirewallUnavailableError` with hint `Run 'sudo pfctl -e' or set extensions.allow_unfirewalled_backends: true`.
2. **`applyRulesForPid(pid, allowlist)`**: pfctl is per-UID, so this method:
   - Reads the child PID's effective UID from `/proc/<pid>/status` is not portable on macOS; instead, the spawner (`session-spawner.ts`) passes the UID separately via a private overload `applyRulesForUid(uid, allowlist)`. The `applyRulesForPid(pid, allowlist)` signature is preserved by reading `process.getuid()`-equivalent via `Number(execSync('id -u -P …'))` only as fallback.
   - Calls `dns-refresh.register(uid, allowlist, this)` (refresh loop is keyed on the unit-of-isolation, which is UID on macOS, PID on Linux — refresh module accepts a generic numeric key).
   - Calls `dns-refresh.resolveOnce(allowlist)` and forwards to `replaceRulesForPid`.
3. **`replaceRulesForPid(pid_or_uid, rules)`**: emits a pf anchor block and loads it atomically:
   ```
   pass out quick proto tcp from any to <ip> port <port> user <uid>
   ... (one per ResolvedRule) ...
   block return out quick from any to any user <uid>
   ```
   The block is loaded via `echo "$RULES" | pfctl -a autonomous-dev-egress/uid-<uid> -f -`. The trailing `block return` ensures non-allowlisted destinations are denied with TCP RST (faster failure than silent drop).
4. **`removeRulesForPid(pid_or_uid)`**: runs `pfctl -a autonomous-dev-egress/uid-<uid> -F all` to flush the per-UID anchor; unregisters from refresh loop.

The `FirewallBackend` contract from SPEC-024-3-01 must remain intact — `pfctl.ts` exports the same shape but internally treats the `pid` parameter as a UID on macOS. This indirection is documented in the file header.

### `firewall/pfctl-cli.ts`

Single function: `runPfctl(args: string[], stdin?: string): Promise<{ stdout: string; stderr: string; exitCode: number }>`. Mocked in tests; no real `pfctl` calls in CI.

### Session-spawner integration

In `sessions/session-spawner.ts`, around the existing child-process spawn for cloud-backend plugins (introduced in PLAN-024-2), add:

```ts
import { selectBackend, FirewallUnavailableError } from '../firewall';
import { expandWildcards } from './wildcard-expander';

const allowlist = manifest.egress_allowlist ?? [];
const requiresFirewall = allowlist.length > 0;
const allowUnfirewalled = config.extensions?.allow_unfirewalled_backends === true;

let backend: FirewallBackend | null = null;
if (requiresFirewall) {
  try {
    backend = selectBackend();
    await backend.init();
  } catch (e) {
    if (e instanceof FirewallUnavailableError && !allowUnfirewalled) {
      throw new Error(
        `Cloud backend "${manifest.name}" requires per-process egress firewall, ` +
        `but the platform's firewall is unavailable: ${e.message}. ` +
        `Set extensions.allow_unfirewalled_backends: true to launch without firewall (NOT RECOMMENDED).`
      );
    }
    if (allowUnfirewalled) { logger.warn(`Launching ${manifest.name} WITHOUT firewall (operator opt-in)`); backend = null; }
    else throw e;
  }
}

// Resolve wildcards against the backend's region (extracted from the deploy params or env).
const concreteAllowlist = expandWildcards(allowlist, deployContext.region);

const child = await spawnChild(/* existing args */);

if (backend) {
  // Apply BEFORE the child makes its first network call. spawnChild() must be implemented
  // to pause the child until applyRulesForPid resolves (existing PLAN-024-2 contract:
  // child reads a "go" byte from stdin before initialising network).
  try {
    await backend.applyRulesForPid(child.pid!, concreteAllowlist);
  } catch (e) {
    child.kill('SIGKILL');
    throw e;
  }
  child.stdin.write('go\n');

  child.once('exit', () => {
    void backend.removeRulesForPid(child.pid!).catch(err =>
      logger.warn(`Failed to remove firewall rules for pid=${child.pid}: ${err.message}`));
  });
}
```

The "go byte" gate is the contract from PLAN-024-2 — children must wait for an explicit OK before starting any network. This spec assumes that contract and adds firewall application between spawn and OK.

### `wildcard-expander.ts`

```ts
export function expandWildcards(entries: AllowlistEntry[], region: string): AllowlistEntry[] {
  return entries.map(e => ({ ...e, fqdn: e.fqdn.replace(/^\*\./, `${region}.`) }));
}
```

If `region` is empty/undefined, throw `Error('region required to expand wildcard FQDN: ' + entry.fqdn)`.

### Trust validator extension

In `hooks/trust-validator.ts`, the existing PLAN-019-3 path validates plugins against the trust manifest and triggers meta-review for plugins declaring privileged capabilities. After that path runs, add a hook for plugins whose manifest type is `cloud-backend`:

```ts
import { validateCloudBackendTrust } from './cloud-backend-trust';

// existing flow ...
if (manifest.type === 'cloud-backend') {
  const result = await validateCloudBackendTrust(manifest, config, metaReviewResult);
  if (!result.ok) return { ok: false, reason: result.reason, code: result.code };
}
```

`hooks/cloud-backend-trust.ts`:

```ts
export async function validateCloudBackendTrust(
  manifest: PluginManifest,
  config: AutonomousDevConfig,
  metaReviewResult: MetaReviewResult
): Promise<{ ok: true } | { ok: false; reason: string; code: string }> {
  const privileged = config.extensions?.privileged_backends ?? [];
  if (!privileged.includes(manifest.name)) {
    return { ok: false,
      code: 'CLOUD_BACKEND_NOT_PRIVILEGED',
      reason: `Cloud backend "${manifest.name}" is not in extensions.privileged_backends. ` +
              `Add it to your config to enable, after security review.` };
  }
  if (metaReviewResult.status !== 'approved') {
    return { ok: false,
      code: 'CLOUD_BACKEND_META_REVIEW_FAILED',
      reason: `Cloud backend "${manifest.name}" failed agent-meta-reviewer: ${metaReviewResult.notes ?? 'no notes'}.` };
  }
  return { ok: true };
}
```

The meta-review is already triggered by the existing PLAN-019-3 flow because cloud backends declare `capabilities: ['network', 'privileged-env']`; this spec only consumes its result.

## Acceptance Criteria

- [ ] `PfctlBackend.init()` succeeds when `pfctl -s rules` exits 0; throws `FirewallUnavailableError` with both `pfctl -e` and `allow_unfirewalled_backends` in the message when stderr contains `pf not enabled`.
- [ ] `applyRulesForPid` on macOS writes a pf anchor at `autonomous-dev-egress/uid-<uid>` containing exactly: one `pass out quick … user <uid>` per resolved IP, then a final `block return out quick … user <uid>`.
- [ ] `removeRulesForPid` flushes the per-UID anchor (`pfctl -F all` against that anchor); subsequent `listActiveAllowlists()` does not include the UID.
- [ ] `selectBackend()` returns `PfctlBackend` on macOS; `NftablesBackend` on Linux; `UnsupportedBackend` elsewhere.
- [ ] Session spawner applies firewall rules between PID known and child receiving `go\n`; verified by ordering assertion in test (mocked `child_process` records the order of `applyRulesForPid` and `child.stdin.write('go')`).
- [ ] Session spawner refuses to launch when `selectBackend().init()` throws `FirewallUnavailableError` and `allow_unfirewalled_backends` is false; the error message contains the plugin name and points to the opt-in flag.
- [ ] Session spawner launches with a WARN log (not an error) when `allow_unfirewalled_backends: true`.
- [ ] When `applyRulesForPid` throws after the child is spawned, the spawner kills the child with SIGKILL before propagating the error (no leaked privileged process).
- [ ] Child exit triggers `removeRulesForPid` exactly once; failure to remove is logged at WARN but does not throw.
- [ ] `expandWildcards([{fqdn:'ecs.*.amazonaws.com', port:443, protocol:'tcp'}], 'us-east-1')` returns `[{fqdn:'ecs.us-east-1.amazonaws.com', …}]`.
- [ ] `expandWildcards` throws if `region` is empty and any entry has a wildcard.
- [ ] Trust validator rejects a `cloud-backend` plugin not in `privileged_backends`; error code is `CLOUD_BACKEND_NOT_PRIVILEGED`.
- [ ] Trust validator rejects a `cloud-backend` plugin where meta-review returned `status !== 'approved'`; error code is `CLOUD_BACKEND_META_REVIEW_FAILED`.
- [ ] Trust validator approves a `cloud-backend` plugin that is privileged AND meta-review-approved.
- [ ] Non-cloud-backend plugins are unaffected by the new checks (validated by ensuring `validateCloudBackendTrust` is not invoked for `manifest.type !== 'cloud-backend'`).
- [ ] `pfctl-cli.ts` is the only module that calls `pfctl`; tests mock it entirely.

## Dependencies

- **Blocks**: SPEC-024-3-04 (unit + integration tests assume the spawner integration is in place).
- **Blocked by**: SPEC-024-3-01 (uses `FirewallBackend`, `AllowlistEntry`, `selectBackend`, `dns-refresh`); PLAN-024-1 (cloud-backend manifests with `egress_allowlist`); PLAN-024-2 (session spawner exists and supports the "go byte" gate, plus `privileged_backends` config); PLAN-019-3 (trust validator and meta-review framework).
- **External**: macOS 13+ (pfctl with anchors); Node ≥20 for the spawner bits.

## Notes

- The PID/UID confusion in `pfctl.ts` is intentional: keeping the `FirewallBackend` interface uniform (one `applyRulesForPid` signature) allows callers to remain platform-agnostic. The translation from PID → UID is internal to the macOS backend, which uses the spawner-provided UID it received via a side-channel set up in `session-spawner.ts` (the spawner sets the child's effective UID right before exec; pfctl's backend reads it from a per-PID map populated by the spawner).
- pfctl's per-UID model means two cloud backends sharing a UID would share an allowlist. The spawner must allocate a unique UID per backend instance from the pool `extensions.cloud_backend_uid_range` (defined in PLAN-024-2). If allocation fails, the spawner refuses to launch.
- Long-term, Apple is deprecating pfctl in favour of `nfilter`; the abstraction over `FirewallBackend` keeps the migration localised when `nfilter` becomes stable. Documented in the macOS section of the operator guide (out of scope here).
- The "go byte" gating is critical: applying firewall rules after the child has already opened a network connection would leak the first packet to the host network. The PLAN-024-2 spawner contract guarantees the child blocks on stdin until "go\n" arrives.
- Trust integration is intentionally additive: the new checks run only for `manifest.type === 'cloud-backend'` so non-cloud plugins keep their existing PLAN-019-3 behaviour with zero new gates.
- The error codes (`CLOUD_BACKEND_NOT_PRIVILEGED`, `CLOUD_BACKEND_META_REVIEW_FAILED`) are stable identifiers; SPEC-024-3-04's tests assert on these codes, and operator docs reference them.
