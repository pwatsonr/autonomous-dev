# SPEC-024-3-01: Egress Allowlist Schema + Linux nftables Firewall + DNS Refresh

## Metadata
- **Parent Plan**: PLAN-024-3
- **Tasks Covered**: Task 1 (egress allowlist schema), Task 2 (Linux nftables firewall), Task 4 (DNS refresh loop)
- **Estimated effort**: 10.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-024-3-01-egress-allowlist-nftables-dns-refresh.md`

## Description
Deliver the Linux side of the per-process egress firewall described in TDD-024 §8. Three artifacts:

1. **Schema extension**: add `egress_allowlist[]` to the cloud-backend plugin manifest schema so each plugin declares the FQDNs (with optional wildcard prefix), ports, and protocols its child process is permitted to reach.
2. **nftables firewall module**: a TypeScript module that, given a child PID and an allowlist, resolves the FQDNs to IPv4/IPv6 addresses and installs `nft` rules in the dedicated `autonomous-dev-egress` table that permit only the allowlisted destinations for that PID's cgroup. The module exposes lifecycle hooks for rule application, removal on PID exit, and rule replacement on DNS refresh.
3. **DNS refresh loop**: a 5-minute background timer that re-resolves every active allowlist's FQDNs, adds rules for any new IPs, and expires rules unseen for ≥1 hour. The refresh loop is shared by both nftables (this spec) and pfctl (SPEC-024-3-02).

This spec does not wire the firewall into session spawn — that is SPEC-024-3-02 task 5. It does not implement macOS — that is SPEC-024-3-02 task 3. It does not enforce trust — SPEC-024-3-02 task 6. It only delivers the schema and the Linux firewall primitives plus the refresh loop the macOS module will reuse.

The daemon must run as root or hold `CAP_NET_ADMIN`; the module surfaces a typed error if it cannot create the nftables table, allowing the spawner (SPEC-024-3-02) to translate that into a clear refusal.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/schemas/plugin-manifest-v2.json` | Modify | Add `egress_allowlist` field with FQDN/port/protocol items |
| `plugins/autonomous-dev/src/firewall/types.ts` | Create | Shared interfaces: `AllowlistEntry`, `ResolvedRule`, `FirewallBackend` |
| `plugins/autonomous-dev/src/firewall/nftables.ts` | Create | Linux nftables backend with `applyRulesForPid`, `removeRulesForPid`, `replaceRulesForPid` |
| `plugins/autonomous-dev/src/firewall/dns-refresh.ts` | Create | Shared 5-minute resolver + 1-hour expiry tracker |
| `plugins/autonomous-dev/src/firewall/nft-cli.ts` | Create | Thin wrapper over `nft` shell calls (mockable in tests) |
| `plugins/autonomous-dev/src/firewall/index.ts` | Create | Re-exports + `selectBackend()` factory (Linux=nftables, others=stub) |

## Implementation Details

### Manifest schema extension

Add the following fragment to `plugin-manifest-v2.json` under the cloud-backend plugin definition (alongside `capabilities`, `entrypoint`, etc.):

```json
"egress_allowlist": {
  "type": "array",
  "description": "FQDNs (with optional '*' wildcard prefix) the plugin's child process may reach. Empty or omitted means no egress is permitted.",
  "items": {
    "type": "object",
    "required": ["fqdn"],
    "additionalProperties": false,
    "properties": {
      "fqdn": {
        "type": "string",
        "pattern": "^(\\*\\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$",
        "description": "FQDN. A leading '*.' matches any single subdomain label."
      },
      "port": { "type": "integer", "minimum": 1, "maximum": 65535, "default": 443 },
      "protocol": { "type": "string", "enum": ["tcp", "udp"], "default": "tcp" }
    }
  }
}
```

The AWS plugin will declare:
```json
"egress_allowlist": [
  { "fqdn": "ecs.*.amazonaws.com" },
  { "fqdn": "ecr.*.amazonaws.com" },
  { "fqdn": "sts.amazonaws.com" }
]
```

Wildcards are expanded by the spawner at spawn time using the resolved AWS region (e.g. `ecs.us-east-1.amazonaws.com`). Resolution semantics live in SPEC-024-3-02; this spec must reject `*` anywhere except as a leading label (the regex enforces this).

### Shared types (`firewall/types.ts`)

```ts
export interface AllowlistEntry { fqdn: string; port: number; protocol: 'tcp' | 'udp'; }
export interface ResolvedRule { fqdn: string; ip: string; family: 'inet' | 'inet6'; port: number; protocol: 'tcp' | 'udp'; lastSeenMs: number; }
export interface FirewallBackend {
  readonly platform: 'linux' | 'darwin' | 'unsupported';
  applyRulesForPid(pid: number, allowlist: AllowlistEntry[]): Promise<void>;
  replaceRulesForPid(pid: number, rules: ResolvedRule[]): Promise<void>;
  removeRulesForPid(pid: number): Promise<void>;
  listActiveAllowlists(): Map<number, AllowlistEntry[]>;
}
export class FirewallUnavailableError extends Error { code = 'FIREWALL_UNAVAILABLE' as const; }
```

### nftables backend (`firewall/nftables.ts`)

Lifecycle:

1. **`init()`** (called once per process): runs `nft list table ip autonomous-dev-egress`; if it fails with exit code 1 (table missing), creates it with:
   ```
   nft add table ip autonomous-dev-egress
   nft add chain ip autonomous-dev-egress output { type filter hook output priority 0 \; policy accept \; }
   ```
   Any other failure throws `FirewallUnavailableError`.
2. **`applyRulesForPid(pid, allowlist)`**:
   - Creates a per-PID cgroup at `/sys/fs/cgroup/autonomous-dev/pid-<pid>` and writes `pid` to `cgroup.procs`. The cgroup creation is wrapped in `try/catch`; on EACCES, throws `FirewallUnavailableError` with hint to run as root or grant `CAP_NET_ADMIN` + cgroup write perms.
   - Records the PID + allowlist in `dns-refresh.register(pid, allowlist, this)`.
   - Calls `dns-refresh.resolveOnce(allowlist)` to get initial `ResolvedRule[]`, then `replaceRulesForPid(pid, resolved)`.
3. **`replaceRulesForPid(pid, rules)`**: builds the rule set in a single transaction:
   ```
   nft -f - <<EOF
   flush chain ip autonomous-dev-egress pid-${pid}
   add chain ip autonomous-dev-egress pid-${pid}
   add rule  ip autonomous-dev-egress output meta cgroup ${cgroupId(pid)} jump pid-${pid}
   add rule  ip autonomous-dev-egress pid-${pid} ip daddr ${ip} ${proto} dport ${port} accept
   ... (one accept rule per ResolvedRule) ...
   add rule  ip autonomous-dev-egress pid-${pid} reject with icmp type admin-prohibited
   EOF
   ```
   The transaction is atomic — readers either see the old or new rules, never a partial set.
4. **`removeRulesForPid(pid)`**: runs `nft delete chain ip autonomous-dev-egress pid-<pid>`, removes the jump rule from `output`, removes the cgroup directory, and unregisters from the refresh loop.

### DNS refresh loop (`firewall/dns-refresh.ts`)

Singleton with one `setInterval(refresh, 5 * 60_000)` registered the first time `register()` is called.

```ts
register(pid: number, allowlist: AllowlistEntry[], backend: FirewallBackend): void;
unregister(pid: number): void;
resolveOnce(allowlist: AllowlistEntry[]): Promise<ResolvedRule[]>;
```

`refresh()` algorithm:

1. For each registered PID's allowlist, call `dns.resolve4(fqdn)` and `dns.resolve6(fqdn)` (Node `dns/promises`). Wildcard FQDNs (`*.foo.com`) cannot be resolved — they must be expanded by the caller before registration; if a registered FQDN starts with `*`, log a warning and skip.
2. Merge the new resolutions into the existing `Map<pid, Map<fqdn, Map<ip, ResolvedRule>>>`, updating `lastSeenMs` for any existing IP and adding new IPs.
3. Evict any rule whose `lastSeenMs < now - 60 * 60_000` (1 hour).
4. If any PID's rule set changed (added or removed any IP), call `backend.replaceRulesForPid(pid, currentRules)`.

Failures resolving a single FQDN must not abort the whole refresh; they are logged at WARN and the existing rules are kept (avoids dropping the world if DNS is briefly unavailable).

### `nft-cli.ts`

Single function: `runNft(stdin: string): Promise<{ stdout: string; stderr: string; exitCode: number }>` using `child_process.spawn('nft', ['-f', '-'], …)`. Tests mock this module entirely; no real `nft` calls run in CI.

### `index.ts` factory

```ts
export function selectBackend(): FirewallBackend {
  if (process.platform === 'linux') return new NftablesBackend();
  if (process.platform === 'darwin') return new PfctlBackend(); // delivered in SPEC-024-3-02
  return new UnsupportedBackend();
}
```

`UnsupportedBackend` returns `platform: 'unsupported'` and throws `FirewallUnavailableError` from every method; SPEC-024-3-02's spawner uses this signal.

## Acceptance Criteria

- [ ] `plugin-manifest-v2.json` validates an AWS-style manifest with `egress_allowlist: [{ fqdn: 'ecs.*.amazonaws.com' }, { fqdn: 'sts.amazonaws.com' }]`.
- [ ] Schema rejects an entry with `fqdn: 'foo.*.bar.com'` (wildcard not in leading position).
- [ ] Schema rejects an entry with `port: 0` and `port: 70000`.
- [ ] Schema accepts an entry with no explicit `port` — default applied is 443.
- [ ] `NftablesBackend.init()` creates the `autonomous-dev-egress` table and `output` chain on first call (verified by mocked `runNft`).
- [ ] `applyRulesForPid(12345, [{fqdn:'sts.amazonaws.com', port:443, protocol:'tcp'}])` resolves the FQDN (mocked DNS), writes 12345 to a cgroup at `/sys/fs/cgroup/autonomous-dev/pid-12345/cgroup.procs`, then issues a single `nft -f -` transaction containing the per-PID chain, jump rule, accept rules per resolved IP, and a final reject.
- [ ] `removeRulesForPid(12345)` deletes the per-PID chain, removes the jump rule, and removes the cgroup directory.
- [ ] When `nft` returns exit 1 with stderr containing "Operation not permitted", the backend throws `FirewallUnavailableError` with `error.message` referencing both `CAP_NET_ADMIN` and root.
- [ ] `dns-refresh.refresh()` adds a new IP to rules within one refresh cycle when a mocked DNS response returns an additional address; verified by inspecting the next `replaceRulesForPid` call.
- [ ] An IP not seen for >1 hour is removed from the rule set on the next refresh; verified by advancing a mocked clock and asserting the IP is absent from the next `replaceRulesForPid` payload.
- [ ] A failed DNS resolution for one FQDN does not affect rules for other FQDNs in the same allowlist (existing rules retained, WARN logged).
- [ ] All `runNft` invocations are routed through `nft-cli.ts`; no test directly spawns `nft`.
- [ ] Coverage for `nftables.ts` and `dns-refresh.ts` is ≥90% (final coverage gate enforced in SPEC-024-3-04 task 11).

## Dependencies

- **Blocks**: SPEC-024-3-02 (pfctl + spawner wiring depends on `firewall/types.ts` and `selectBackend`); SPEC-024-3-04 (unit tests).
- **Blocked by**: PLAN-024-1 (cloud-backend plugin manifests need to declare `egress_allowlist`); PLAN-024-2 (privileged-backends scaffolding ensures cloud backends are even loadable).
- **External**: Node ≥20 (`dns/promises`, `child_process.spawn`); Linux kernel ≥5.8 with cgroup v2 + nftables support.

## Notes

- The cgroup-v2 path `/sys/fs/cgroup/autonomous-dev/...` assumes the operator has mounted cgroup v2 unified hierarchy (default on systemd ≥240). On older systems, the spawner (SPEC-024-3-02) will surface a clear error pointing to the operator opt-in `extensions.allow_unfirewalled_backends: true`.
- `meta cgroup` matching uses the cgroup ID, not the path. `cgroupId(pid)` is implemented by reading `/sys/fs/cgroup/autonomous-dev/pid-<pid>/cgroup.id` (kernel-exposed). The helper is internal to `nftables.ts`.
- Wildcard expansion (`ecs.*.amazonaws.com` → `ecs.us-east-1.amazonaws.com`) happens in the cloud-backend spawn helper (SPEC-024-3-02), not here. This module assumes incoming FQDNs are concrete; it logs and skips any wildcard FQDN it sees.
- Refresh interval (5 min) and stale TTL (1 hour) are constants per TDD-024 §8; making them configurable is explicitly out of scope.
- The dedicated `autonomous-dev-egress` table is namespaced so it never collides with operator firewall rules in `filter` or `inet`. Removal on daemon exit is handled by SPEC-024-3-02's spawner shutdown hook (not this spec).
- The `output` chain has policy `accept` to avoid breaking unrelated host traffic — only PIDs registered in `autonomous-dev-egress`'s per-PID chains are filtered. Non-registered traffic falls through unchanged.
