/**
 * Project inference (ONBOARD Phase 1 — #587, AC2).
 *
 * Cluster repos into candidate projects from per-repo signals — shared owners
 * (CODEOWNERS), shared name prefixes, and shared dependencies — via union-find
 * over pairwise relatedness. Output is **proposals** (id + members + rationale +
 * confidence): PURE and side-effect-free, never written to the ownership
 * manifest (FR-E2 propose-don't-apply). The graph layer (P1.6) can enrich this
 * with Neo4j community detection when available.
 */

export interface RepoSignals {
  repoId: string;
  /** CODEOWNERS teams/users, e.g. '@acme/payments'. */
  owners: string[];
  /** Dependency names. */
  deps: string[];
  /** Optional pre-derived grouping prefix; else derived from the repo name. */
  namePrefix?: string;
}

export interface ProposedProject {
  id: string;
  repoIds: string[];
  rationale: string;
  confidence: number; // 0..1
}

/**
 * CODEOWNERS-style owner tokens (@org/team, @user) found in text, deduped +
 * lowercased. Comment lines are stripped first, and an `@` immediately preceded
 * by a word char is NOT matched — so email-form owners (`* alice@acme.com`,
 * which GitHub CODEOWNERS supports) do not produce a bogus `@acme.com` owner
 * that would wrongly cluster unrelated repos sharing an email domain.
 */
export function parseOwners(text: string): string[] {
  const set = new Set<string>();
  const withoutComments = text.replace(/^\s*#.*$/gm, '');
  for (const m of withoutComments.matchAll(/(?<![a-z0-9._%+-])@[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?/gi)) {
    set.add(m[0].toLowerCase());
  }
  return [...set].sort();
}

/**
 * Build inference signals for a repo from its resolved per-repo memory docs
 * (the substrate ingestion wrote). Owners come from the `ownership` doc
 * (CODEOWNERS); the name prefix is derived from the id. Deps are left empty for
 * now — they are a weak tiebreaker the graph layer (P1.6) will enrich.
 */
export function signalsFromMemory(
  repoId: string,
  docs: { topic: string; content: string }[],
): RepoSignals {
  const ownersDoc = docs.find((d) => d.topic === 'ownership');
  return { repoId, owners: ownersDoc ? parseOwners(ownersDoc.content) : [], deps: [] };
}

/** Grouping prefix from a repo id ('acme/payments-api' → 'payments'). */
export function namePrefixOf(repoId: string): string | undefined {
  const name = repoId.includes('/') ? repoId.split('/').pop()! : repoId;
  const m = name.match(/^([a-z0-9]+)[-_]/i);
  return m ? m[1].toLowerCase() : undefined;
}

function prefixOf(r: RepoSignals): string | undefined {
  return r.namePrefix ?? namePrefixOf(r.repoId);
}

/** Are two repos related enough to be the same project? (strength ≥ 2). */
function linked(a: RepoSignals, b: RepoSignals): boolean {
  let strength = 0;
  if (a.owners.some((o) => b.owners.includes(o))) strength += 2; // shared owner = strong
  const pa = prefixOf(a);
  const pb = prefixOf(b);
  if (pa && pb && pa === pb) strength += 2; // shared name prefix = strong
  if (a.deps.filter((d) => b.deps.includes(d)).length >= 3) strength += 1; // shared deps = weak
  return strength >= 2;
}

function commonOwner(members: RepoSignals[]): string | undefined {
  const counts = new Map<string, number>();
  for (const m of members) for (const o of new Set(m.owners)) counts.set(o, (counts.get(o) ?? 0) + 1);
  for (const [o, c] of counts) if (c === members.length) return o;
  return undefined;
}

function commonPrefix(members: RepoSignals[]): string | undefined {
  const first = prefixOf(members[0]);
  return first && members.every((m) => prefixOf(m) === first) ? first : undefined;
}

function deriveProjectId(members: RepoSignals[]): string {
  const prefix = commonPrefix(members);
  if (prefix) return prefix;
  const owner = commonOwner(members);
  if (owner) return owner.replace(/^@/, '').replace(/\//g, '-').toLowerCase();
  return (
    members
      .map((m) => m.repoId.split('/').pop() ?? m.repoId)
      .sort()[0] ?? 'project'
  );
}

function rationaleFor(members: RepoSignals[]): { text: string; confidence: number } {
  const owner = commonOwner(members);
  const prefix = commonPrefix(members);
  const parts: string[] = [];
  let confidence = 0.5;
  if (owner) {
    parts.push(`shared owner ${owner}`);
    confidence += 0.25;
  }
  if (prefix) {
    parts.push(`shared name prefix "${prefix}"`);
    confidence += 0.25;
  }
  return {
    text: parts.length ? `Grouped by ${parts.join(' + ')}.` : 'Grouped by shared relationships.',
    confidence: Math.min(confidence, 1),
  };
}

/** A repo whose signals place it in 2+ distinct candidate projects. */
export interface AmbiguousMembership {
  repoId: string;
  /** The distinct candidate project ids it could belong to (sorted, length ≥ 2). */
  candidateProjectIds: string[];
}

/**
 * Detect project-membership AMBIGUITY — pure. A repo is ambiguous when its
 * STRONG signals (a shared owner, a shared name prefix) place it in 2+ candidate
 * groupings that derive to *different* project ids. Such a repo is exactly the
 * bridge that union-find would collapse into one project; surfacing it lets a
 * human decide instead. The first concrete producer for the blocking-question
 * queue (#587 AC3 / #588). Returns at most one entry per repo, sorted by id.
 */
export function findAmbiguousMemberships(repos: RepoSignals[]): AmbiguousMembership[] {
  const byId = new Map(repos.map((r) => [r.repoId, r]));
  // Candidate grouping keys: each shared owner token, each shared name prefix.
  const groupMembers = new Map<string, string[]>();
  const push = (key: string, repoId: string): void => {
    const arr = groupMembers.get(key) ?? [];
    if (!arr.includes(repoId)) arr.push(repoId);
    groupMembers.set(key, arr);
  };
  for (const r of repos) {
    for (const o of new Set(r.owners)) push(`owner:${o.toLowerCase()}`, r.repoId);
    const p = prefixOf(r);
    if (p) push(`prefix:${p}`, r.repoId);
  }

  // For each repo, the set of DISTINCT project ids its candidate groups derive to.
  const candidates = new Map<string, Set<string>>();
  for (const memberIds of groupMembers.values()) {
    if (memberIds.length < 2) continue; // a lone-member key is not a candidate project
    const members = memberIds.map((id) => byId.get(id)).filter((m): m is RepoSignals => !!m);
    const pid = deriveProjectId(members);
    for (const id of memberIds) {
      if (!candidates.has(id)) candidates.set(id, new Set());
      candidates.get(id)!.add(pid);
    }
  }

  const out: AmbiguousMembership[] = [];
  for (const [repoId, ids] of candidates) {
    if (ids.size >= 2) out.push({ repoId, candidateProjectIds: [...ids].sort() });
  }
  return out.sort((a, b) => a.repoId.localeCompare(b.repoId));
}

/** Infer candidate projects (proposals) from per-repo signals. Pure. */
export function inferProjects(repos: RepoSignals[]): ProposedProject[] {
  const parent = new Map<string, string>();
  for (const r of repos) parent.set(r.repoId, r.repoId);
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x); // defensive: never deref an uninitialised key
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    parent.set(find(a), find(b));
  };

  for (let i = 0; i < repos.length; i++) {
    for (let j = i + 1; j < repos.length; j++) {
      if (linked(repos[i], repos[j])) union(repos[i].repoId, repos[j].repoId);
    }
  }

  const groups = new Map<string, string[]>();
  for (const r of repos) {
    const root = find(r.repoId);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(r.repoId);
  }

  const proposals: ProposedProject[] = [];
  for (const repoIds of groups.values()) {
    if (repoIds.length < 2) continue; // a lone repo is not a project
    const members = repos.filter((r) => repoIds.includes(r.repoId));
    const { text, confidence } = rationaleFor(members);
    proposals.push({ id: deriveProjectId(members), repoIds: [...repoIds].sort(), rationale: text, confidence });
  }
  return proposals.sort((a, b) => a.id.localeCompare(b.id));
}
