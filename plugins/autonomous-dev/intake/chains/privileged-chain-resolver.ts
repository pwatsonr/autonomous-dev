/**
 * Privileged-chain allowlist resolver (SPEC-022-2-04).
 *
 * Operators allowlist `<producer-id>:<consumer-id>@<version-glob>` entries
 * in `extensions.privileged_chains[]`. A chain that includes a consume
 * declaration on a `requires_approval: true` artifact must have every
 * producer→consumer pair in that chain represented in the allowlist before
 * the executor will run it.
 *
 * Glob grammar:
 *   - `*`  → matches every version
 *   - `N.x` (e.g. `1.x`) → matches `N.<anything>` (any minor/patch)
 *   - `N.M.x` (e.g. `1.2.x`) → matches `N.M.<anything>`
 *   - exact (`1.2.3`) → matches that string only
 *
 * The resolver has no I/O; it is pure given the allowlist and chain.
 *
 * @module intake/chains/privileged-chain-resolver
 */

import type { HookManifest } from '../hooks/types';

const ENTRY_RE = /^([^:]+):([^@]+)@(.+)$/;

export interface ChainPair {
  producerId: string;
  consumerId: string;
  consumerVersion: string;
  /**
   * True iff the consume edge is on a `requires_approval` artifact path.
   * Only privileged pairs require an allowlist match.
   */
  requiresApproval: boolean;
}

export class PrivilegedChainResolver {
  /**
   * Build the producer→consumer pair list for `order` and decide whether
   * every privileged pair is allowlisted.
   *
   * Returns `{ allowed: true, missing: [] }` when the chain includes no
   * privileged pairs (the structural check is satisfied vacuously).
   */
  matches(
    order: ReadonlyArray<{ id: string; version: string; manifest: HookManifest }>,
    allowlist: ReadonlyArray<string>,
  ): { allowed: boolean; missing: string[] } {
    const pairs = this.collectPairs(order);
    const missing: string[] = [];
    for (const pair of pairs) {
      if (!pair.requiresApproval) continue;
      const ok = allowlist.some((entry) => this.matchEntry(entry, pair));
      if (!ok) {
        missing.push(`${pair.producerId}:${pair.consumerId}@${pair.consumerVersion}`);
      }
    }
    return { allowed: missing.length === 0, missing };
  }

  /**
   * Collect producer→consumer pairs from a topological order. A pair is
   * privileged when EITHER (a) the consumer's manifest has a `consumes`
   * entry with `requires_approval: true` for an artifact the producer
   * emits, OR (b) the producer emits an artifact with `requires_approval:
   * true` that the consumer consumes (covers both spec spellings).
   */
  collectPairs(
    order: ReadonlyArray<{ id: string; version: string; manifest: HookManifest }>,
  ): ChainPair[] {
    const pairs: ChainPair[] = [];
    for (let i = 0; i < order.length - 1; i++) {
      const producer = order[i];
      const consumer = order[i + 1];
      const sharedTypes = this.sharedArtifacts(producer.manifest, consumer.manifest);
      if (sharedTypes.length === 0) continue;
      const requiresApproval = sharedTypes.some((t) =>
        this.isApprovalEdge(producer.manifest, consumer.manifest, t),
      );
      pairs.push({
        producerId: producer.id,
        consumerId: consumer.id,
        consumerVersion: consumer.version,
        requiresApproval,
      });
    }
    return pairs;
  }

  /** Artifact types both produced by `producer` and consumed by `consumer`. */
  private sharedArtifacts(producer: HookManifest, consumer: HookManifest): string[] {
    const produced = new Set((producer.produces ?? []).map((p) => p.artifact_type));
    const out: string[] = [];
    for (const c of consumer.consumes ?? []) {
      if (produced.has(c.artifact_type)) out.push(c.artifact_type);
    }
    return out;
  }

  /** True if either side flags this artifact edge as `requires_approval`. */
  private isApprovalEdge(
    producer: HookManifest,
    consumer: HookManifest,
    artifactType: string,
  ): boolean {
    const prod = (producer.produces ?? []).find((p) => p.artifact_type === artifactType);
    if (prod?.requires_approval === true) return true;
    const cons = (consumer.consumes ?? []).find((c) => c.artifact_type === artifactType);
    if (cons?.requires_approval === true) return true;
    return false;
  }

  /** Decide whether one allowlist entry matches one chain pair. */
  matchEntry(entry: string, pair: ChainPair): boolean {
    const m = ENTRY_RE.exec(entry);
    if (!m) return false;
    const [, prodPattern, consPattern, versionGlob] = m;
    if (prodPattern !== pair.producerId) return false;
    if (consPattern !== pair.consumerId) return false;
    return this.versionMatches(versionGlob, pair.consumerVersion);
  }

  versionMatches(glob: string, version: string): boolean {
    if (glob === '*') return true;
    if (glob.endsWith('.x')) {
      const prefix = glob.slice(0, -2); // drop `.x`
      // Accept N.x → matches `N.<anything>`; N.M.x → matches `N.M.<anything>`.
      return version === prefix || version.startsWith(`${prefix}.`);
    }
    return glob === version;
  }
}
