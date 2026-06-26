# ONBOARD — Integration & Go-Live (Phase 5)

> Capstone for the ONBOARD initiative (epic #583). Phases 0–4 each shipped a vertical
> slice; this document ties them into **one end-to-end flow**, states honestly what is
> wired vs what needs operator action vs what is a tracked fast-follow, and gives the
> operator a go-live checklist + a way to smoke-test the spine without a live org.
>
> Baseline at Phase 5: **daemon 0.3.37, portal 0.3.43.**

## 1. What ONBOARD is

Link a GitHub org → auto-ingest every repo (read-only) → build per-project/per-repo
memory + a cross-repo graph → propose scoped skills → enroll the repos you want
auto-improved → drive work from the portal and from Discord/Slack `/autodev` triggers,
each run watched for stabilization before it stops. User-authored (`managed:false`)
context is always honored and never modified.

| Phase | What shipped | Status |
|------|---------------|--------|
| 0 | Ownership & scope model (Org/Project/Repo + tags; `scope`/`managed` on agents; multi-scope registry resolution; `managed:false` enforcement) | **Live** (0.3.32) |
| 1 | Read-only org ingestion + scoped memory tree + project inference + blocking-question queue + ingest≠enroll toggle | **Live** (0.3.33) |
| 1.6 | Neo4j cross-repo graph layer (closes Phase 1 AC6) | **Live** (0.3.35) |
| 2 | Scoped **skill** auto-generation (propose → meta-review → human-accept → store) | **Live** (0.3.34) |
| 3 | Portal: org/project/repo views, live ingestion, in-portal question answering, enrollment toggle | **Live** (portal 0.3.43) |
| 4 | Discord/Slack scoped `/autodev` triggers + CI-green-3-day stabilization watch (daemon-side) | **Live, dormant** (0.3.36) — needs bot provisioning |
| 5 | Integration: trigger→daemon spine fix (S6) + this document | **This release** (0.3.37) |

## 2. The end-to-end golden path

The tracked flow from the Phase 5 acceptance criterion ("a fresh org goes from link →
self-improving"). Each step notes the surface and whether it's **wired**, needs an
**operator action**, or has a tracked **boundary**.

1. **Link the org** — `autonomous-dev org link <org>` (or the portal). *Wired.* Writes
   `ownership.org` to `~/.claude/autonomous-dev.json`.
2. **Ingest (read-only)** — `autonomous-dev org ingest`. *Wired.* Crawls every repo via
   `gh`/shallow-clone-to-scratch (never the live checkout, never a crawled repo in place),
   writes per-repo memory under `~/.autonomous-dev/memory/repo/<id>/`, registers repos as
   standalone + **unenrolled**.
3. **Infer projects** — `autonomous-dev project infer` + `graph sync`. *Wired.* Union-find
   over shared deps/owners/schemas, enriched by the Neo4j graph; proposes groupings.
4. **Answer blocking questions** — portal `/onboard/questions` or `questions answer`.
   *Resume path wired; producer is a* **boundary** *(#588).* The answer→resume consumer is
   wired (an answered repo un-blocks on the next crawl); what's missing is the **producer**
   — ingestion does not yet *raise* ambiguity questions, so the queue stays empty until
   #588 lands.
5. **Propose scoped skills** — `autonomous-dev artifact propose` → `artifact accept`.
   *Propose/accept/store wired; load-into-run is a* **boundary** *(#598).* Accepted skills
   are written to `~/.autonomous-dev/artifacts/<scope>/skills/` but are not yet loaded into
   pipeline runs.
6. **Enroll the repos to auto-improve** — portal toggle or `repo enroll <id>`. *Wired
   (field parity verified).* Sets `participate_in_auto_improvement`.
7. **Trigger work** — Discord/Slack `/autodev <project|repo> <id> <task>`. *Logic wired +
   spine fixed (S6); inbound needs* **operator action** *(bots).* The trigger resolves
   scope → authorizes (per-repo) → **enqueues a real, daemon-discoverable pipeline run**
   (the Phase 5 S6 fix; before it, triggers enqueued into a void) → reports back → enters
   the stabilization watch.
8. **Run → stabilize → report** — the daemon runs the full pipeline on the target repo,
   opens a PR, then the watch polls `gh pr checks` and declares the change **stable** after
   CI is green for 3 continuously-observed days (or `regressed`/`expired`), reporting each
   transition back to the channel. *Wired.*

**The S6 fix (this release).** `/autodev` now writes the `state.json` the daemon's
`select_request()` actually scans (mirroring `SubmitHandler`), keyed on the target repo's
**local path** resolved from ownership. A trigger against a repo with **no local checkout**
is refused with `REPO_NOT_RUNNABLE` — clone + allowlist it first. The human-facing repo id
stays in the trigger record/audit/result, so the Phase-4 watch loop still resolves id→path
back to the same file.

## 3. Operator go-live checklist

The spine is shipped + tested, but a live run requires operator-only inputs (secrets,
external apps, real repos). None of these can be done autonomously.

- [ ] **Link a real org + ingest it.** `org link` then `org ingest`. Read-only; safe.
- [ ] **Make target repos runnable.** For any repo you'll `/autodev`, it must (a) have a
      local checkout path in the ownership manifest **and** (b) be on the daemon
      `repositories.allowlist` (`~/.claude/autonomous-dev.json`). The S6 guard enforces (a);
      (b) is the daemon's gate and is the operator's responsibility — a path that's set but
      not allowlisted writes a `state.json` the daemon never scans (silent no-op).
      *(Allowlisting a repo authorizes autonomous $-spending work on it — opt in deliberately.)*
- [ ] **Provision Phase 4 bots** (see `docs/ONBOARD-phase4-deploy.md`): Discord + Slack bot
      apps + tokens (deploy-time secrets, store 0600/env like the Neo4j cred), register the
      `/autodev` slash command, add the supervisor watch-tick hook (call
      `autonomous-dev triggers watch-tick` each daemon loop), and swap the `logNotifier`
      stub for the real bot-post.
- [ ] **Rotate the Neo4j password** (it passed through chat during Phase 1.6). Update
      `~/.autonomous-dev/secrets/neo4j.json` (0600).
- [ ] **Confirm the trigger authz policy.** `/autodev` is gated by the per-repo AuthzEngine
      (who may trigger), **not** by enrollment — a manual chat trigger is operator-directed
      work, distinct from proactive auto-improvement (which the enroll toggle gates). This is
      by design; confirm it matches your intent before enabling the bots.

## 4. Integration boundaries (known, tracked)

Honest accounting of what is *not* yet end-to-end, each with its tracking issue. None
block the core "link → ingest → enroll → trigger → run → stabilize" spine; they are
refinements of scope-awareness and the human-in-the-loop arc.

- **Scoped execution context (#597).** Pipeline runs don't yet load the repo's scoped
  memory or select repo/project-scoped managed agents — a scoped run currently uses global
  agents + no repo memory. The biggest remaining "scoped" refinement.
- **Blocking-question producer (#588).** Ingestion doesn't yet *raise* ambiguity questions,
  so the portal Questions view stays empty. The answer→resume half is wired and waiting.
- **Promoted-skill loading (#598).** Accepted skills are stored but not loaded into runs.
- **Proactive enrollment gate (#588).** `mayAutoImproveScope` (the fail-closed enroll gate)
  has no production caller yet; the proactive self-improvement lifecycle is currently gated
  only by the coarse `repositories.allowlist`. Wire enrollment into the proactive path so an
  allowlisted-but-unenrolled repo isn't auto-improved.

## 5. Smoke-testing the spine without a live org

You can prove the trigger→daemon spine end-to-end without provisioning bots:

1. Pick a throwaway repo with a local checkout; add its path to `repositories.allowlist`
   and register it in ownership with that `path`.
2. Drive a trigger through the intake router (or a unit harness) for that repo.
3. Confirm `state.json` appears at
   `<repo>/.autonomous-dev/requests/REQ-XXXXXX/state.json` and the daemon picks it up
   (`autonomous-dev request list` shows it; the supervisor advances it).
4. `autonomous-dev triggers watch-tick` then tracks completion + stabilization.

The unit suite already locks the spine: `trigger_handler.test.ts` asserts the
discoverable `state.json` is written (and that a no-checkout repo is refused before any DB
write).
