#!/usr/bin/env node
/**
 * PRD-025 conformance audit — deterministic pre-release gate.
 *
 * Encodes machine-checkable conformance invariants, each tied to a specific
 * FR. Every check reads source and asserts a condition; the gate fails the
 * release if any regress. Seeded with the FR-025 fixes (PRs #378-#382) so the
 * drift that produced issues #354-#362 cannot silently return.
 *
 * Design: a gate must be deterministic, fast, and CI-native — no network, no
 * Claude, no test runner. Add a check by appending to CHECKS. Keep each check
 * a pure string/parse assertion over a tracked source file.
 *
 * Run: `node scripts/ci/conformance-audit.js`  (exit 0 = conformant, 1 = drift)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function read(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    return null;
  }
}

const pass = (detail) => ({ ok: true, detail: detail || '' });
const fail = (detail) => ({ ok: false, detail: detail || '' });

/**
 * Each check: { id, issue, fr, desc, run() -> {ok, detail} }.
 * `id` is stable (referenced in failures); `issue`/`fr` are for traceability.
 */
const CHECKS = [
  {
    id: 'parallel-disk-thresholds',
    issue: 355,
    fr: 'PRD-004 App. D',
    desc: 'Parallel defaults max_tracks=3, warn=2 GB, hard=5 GB; validator requires hard > warn',
    run() {
      const s = read('plugins/autonomous-dev/src/parallel/config.ts');
      if (s === null) return fail('config.ts not found');
      const defaultsOk =
        /max_tracks:\s*3\b/.test(s) &&
        /disk_warning_threshold_gb:\s*2\b/.test(s) &&
        /disk_hard_limit_gb:\s*5\b/.test(s);
      // The validator must reject hard <= warning (i.e. require hard > warning).
      const validatorOk = /disk_hard_limit_gb\s*<=\s*cfg\.disk_warning_threshold_gb/.test(s);
      if (!defaultsOk) return fail('disk-threshold defaults regressed (expected 3/2/5)');
      if (!validatorOk) return fail('validator no longer enforces hard > warning');
      return pass();
    },
  },
  {
    id: 'intake-source-integrity',
    issue: 358,
    fr: 'FR-025-17',
    desc: 'submit_handler derives request source from the channel (no hard-coded source)',
    run() {
      const s = read('plugins/autonomous-dev/intake/handlers/submit_handler.ts');
      if (s === null) return fail('submit_handler.ts not found');
      if (/\bsource:\s*'cli'\s*,/.test(s)) return fail("hard-coded source: 'cli' present");
      if (!/channelTypeToRequestSource\(command\.source\.channelType\)/.test(s)) {
        return fail('source is not derived via channelTypeToRequestSource');
      }
      return pass();
    },
  },
  {
    id: 'hook-points-plan-spec',
    issue: 359,
    fr: 'FR-1108',
    desc: 'HookPoint enum declares plan-pre-author and spec-pre-author',
    run() {
      const s = read('plugins/autonomous-dev/intake/hooks/types.ts');
      if (s === null) return fail('hooks/types.ts not found');
      const ok = /'plan-pre-author'/.test(s) && /'spec-pre-author'/.test(s);
      return ok ? pass() : fail('missing plan-pre-author / spec-pre-author hook point');
    },
  },
  {
    id: 'hotfix-skips-tdd',
    issue: 359,
    fr: 'FR-1102',
    desc: 'HOTFIX phase-override skips tdd and tdd_review',
    run() {
      const s = read('plugins/autonomous-dev/intake/types/phase-override.ts');
      if (s === null) return fail('phase-override.ts not found');
      const m = s.match(/HOTFIX\][\s\S]*?skippedPhases:\s*\[([\s\S]*?)\]/);
      if (!m) return fail('HOTFIX.skippedPhases not found');
      const list = m[1];
      const ok = /'tdd'/.test(list) && /'tdd_review'/.test(list);
      return ok ? pass() : fail('HOTFIX does not skip tdd/tdd_review');
    },
  },
  {
    id: 'specialist-reviewers-registered',
    issue: 359,
    fr: 'FR-1242/1261',
    desc: 'The 4 specialist reviewers are registered in the default reviewer chains',
    run() {
      const s = read('plugins/autonomous-dev/config_defaults/reviewer-chains.json');
      if (s === null) return fail('reviewer-chains.json not found');
      let cfg;
      try {
        cfg = JSON.parse(s);
      } catch (e) {
        return fail(`reviewer-chains.json invalid JSON: ${e.message}`);
      }
      const names = new Set();
      for (const t of Object.values(cfg.request_types ?? {})) {
        for (const gate of Object.values(t ?? {})) {
          for (const entry of gate ?? []) if (entry && entry.name) names.add(entry.name);
        }
      }
      const required = [
        'ux-ui-reviewer',
        'accessibility-reviewer',
        'qa-edge-case-reviewer',
        'rule-set-enforcement-reviewer',
      ];
      const missing = required.filter((r) => !names.has(r));
      return missing.length === 0
        ? pass()
        : fail(`specialist reviewers not registered in any chain: ${missing.join(', ')}`);
    },
  },
  {
    id: 'spec-review-has-ux-ui',
    issue: 359,
    fr: 'FR-1262',
    desc: 'ux-ui-reviewer is in a default spec_review chain',
    run() {
      const s = read('plugins/autonomous-dev/config_defaults/reviewer-chains.json');
      if (s === null) return fail('reviewer-chains.json not found');
      let cfg;
      try {
        cfg = JSON.parse(s);
      } catch (e) {
        return fail(`reviewer-chains.json invalid JSON: ${e.message}`);
      }
      const found = Object.values(cfg.request_types ?? {}).some((t) =>
        (t?.spec_review ?? []).some((e) => e && e.name === 'ux-ui-reviewer'),
      );
      return found
        ? pass()
        : fail('no spec_review chain contains ux-ui-reviewer');
    },
  },
  {
    id: 'trivial-docs-skips-design',
    issue: 526,
    fr: 'PRD-526',
    desc: 'TASK_SIZE_SKIP_MATRIX[trivial-docs] skips prd/tdd/plan and the writer unions type+size skips',
    run() {
      const po = read('plugins/autonomous-dev/intake/types/phase-override.ts');
      if (po === null) return fail('phase-override.ts not found');
      // The trivial-docs skip set must drop all upfront design phases.
      const m = po.match(/'trivial-docs':\s*\[([\s\S]*?)\]/);
      if (!m) return fail("TASK_SIZE_SKIP_MATRIX['trivial-docs'] not found");
      const list = m[1];
      const skipsAll =
        /'prd'/.test(list) &&
        /'prd_review'/.test(list) &&
        /'tdd'/.test(list) &&
        /'tdd_review'/.test(list) &&
        /'plan'/.test(list) &&
        /'plan_review'/.test(list);
      if (!skipsAll) {
        return fail("trivial-docs does not skip all of prd/prd_review/tdd/tdd_review/plan/plan_review");
      }
      // getSkippedPhases must UNION the type's skips with the size's skips.
      const unions =
        /PHASE_OVERRIDE_MATRIX\[type\]\?\.skippedPhases[\s\S]*?TASK_SIZE_SKIP_MATRIX\[size\]/.test(po);
      if (!unions) return fail('getSkippedPhases does not union type + size skip sets');
      // The writer must compute phase_overrides via the unioning helper, not
      // the type-only matrix path it used pre-#526.
      const writer = read('plugins/autonomous-dev/intake/lib/state_json_writer.ts');
      if (writer === null) return fail('state_json_writer.ts not found');
      if (!/getSkippedPhases\(\s*requestType\s*,\s*taskSize\s*\)/.test(writer)) {
        return fail('state_json_writer does not union type+size via getSkippedPhases(requestType, taskSize)');
      }
      return pass();
    },
  },
  {
    id: 'daemon-status-uptime-fields',
    issue: 356,
    fr: 'FR-404',
    desc: 'Daemon writes start_time + portal daemon-status surfaces uptime/iteration/active-request',
    run() {
      const daemon = read('plugins/autonomous-dev/bin/supervisor-loop.sh');
      if (daemon === null) return fail('supervisor-loop.sh not found');
      if (!/start_time:\s*\(if\s*\$start/.test(daemon)) {
        return fail('write_heartbeat does not emit start_time');
      }
      const route = read('plugins/autonomous-dev-portal/server/routes/daemon-status.ts');
      if (route === null) return fail('daemon-status.ts route not found');
      const ok =
        /uptimeSeconds/.test(route) &&
        /iterationCount/.test(route) &&
        /activeRequestId/.test(route);
      return ok ? pass() : fail('daemon-status body missing uptime/iteration/active-request fields');
    },
  },
  {
    id: 'ops-health-circuit-breaker',
    issue: 356,
    fr: 'FR-935',
    desc: 'OpsHealth surfaces circuit-breaker state from crash-state.json',
    run() {
      const s = read('plugins/autonomous-dev-portal/server/wiring/ops-readers.ts');
      if (s === null) return fail('ops-readers.ts not found');
      const ok = /circuitBreaker/.test(s) && /crash-state\.json/.test(s);
      return ok ? pass() : fail('readOpsHealth does not populate circuitBreaker from crash-state.json');
    },
  },
  {
    id: 'portal-referrer-policy',
    issue: 356,
    fr: 'FR-S33',
    desc: 'Portal default Referrer-Policy = same-origin',
    run() {
      const s = read('plugins/autonomous-dev-portal/server/security/security-headers.ts');
      if (s === null) return fail('security-headers.ts not found');
      const ok = /referrerPolicy:\s*"same-origin"/.test(s);
      return ok ? pass() : fail('default Referrer-Policy is not same-origin');
    },
  },
  {
    id: 'portal-dashboard-freshness',
    issue: 356,
    fr: 'FR-903',
    desc: 'Dashboard auto-refresh interval <= 5s',
    run() {
      const s = read('plugins/autonomous-dev-portal/server/templates/views/dashboard.tsx');
      if (s === null) return fail('dashboard.tsx not found');
      const m = s.match(/DASHBOARD_POLLING_TRIGGER\s*=\s*'every\s+(\d+)s/);
      if (!m) return fail('DASHBOARD_POLLING_TRIGGER not found');
      const secs = parseInt(m[1], 10);
      return secs <= 5 ? pass() : fail(`dashboard refresh ${secs}s exceeds 5s`);
    },
  },
  {
    id: 'config-change-apply-merges',
    issue: 386,
    fr: 'FR-025-05',
    desc: 'Portal config-change apply merges proposed over existing config (no destructive overwrite)',
    run() {
      const s = read('plugins/autonomous-dev/bin/supervisor-loop.sh');
      if (s === null) return fail('supervisor-loop.sh not found');
      // Must merge proposed over the existing config so a partial proposal
      // cannot destroy unmentioned keys like repositories.allowlist. The
      // supervisor uses jq `*` deep-merge since #507 (was `+` shallow-merge in
      // #386); accept either operator — both preserve the no-destructive-
      // overwrite invariant this check guards. A true regression would be the
      // `destructive` path below.
      const merges = /\.\[0\]\s*[*+]\s*\.\[1\]\.proposed/.test(s);
      // The old destructive path wrote `.proposed` straight over CONFIG_FILE.
      const destructive = /jq '\.proposed' "\$\{marker\}"\s*>\s*"\$\{cfg_tmp\}"/.test(s);
      if (!merges) return fail('config-change apply no longer merges proposed over existing config');
      if (destructive) return fail('destructive replace of CONFIG_FILE present (regression of #386)');
      return pass();
    },
  },
  {
    id: 'stale-gate-no-resurrection',
    issue: 390,
    fr: 'portal-audit-2026-06-11',
    desc: 'Terminal requests cannot be resurrected by stale gate markers (portal guard + daemon sweep)',
    run() {
      const reader = read('plugins/autonomous-dev-portal/server/wiring/request-ledger-reader.ts');
      if (reader === null) return fail('request-ledger-reader.ts not found');
      // Portal half: the gate overlay must bail out on terminal statuses.
      const guard =
        /existing\.status === "done"[\s\S]{0,200}existing\.status === "cancelled"[\s\S]{0,200}existing\.status === "failed"/.test(reader);
      if (!guard) return fail('gate overlay terminal-status guard missing (regression of #390 portal half)');
      const sl = read('plugins/autonomous-dev/bin/supervisor-loop.sh');
      if (sl === null) return fail('supervisor-loop.sh not found');
      // Daemon half: the marker sweep must exist and be called from the loop.
      if (!/reconcile_portal_markers\(\)\s*\{/.test(sl)) return fail('reconcile_portal_markers() missing');
      // The call site is `reconcile_portal_markers || log_error ...` in the
      // main loop — match it specifically (comments/definition don't count).
      if (!/^\s*reconcile_portal_markers\s*\|\|/m.test(sl)) {
        return fail('reconcile_portal_markers defined but never called from the loop');
      }
      return pass();
    },
  },
  {
    id: 'dashboard-no-fabrication',
    issue: 389,
    fr: 'portal-audit-2026-06-11',
    desc: 'Dashboard renders real/empty data — seeded demo builders must not return',
    run() {
      const s = read('plugins/autonomous-dev-portal/server/wiring/dashboard-readers.ts');
      if (s === null) return fail('dashboard-readers.ts not found');
      if (/seededRng|buildActivityFeed\s*\(|buildAgentUtilRows\s*\(|build14DayCostBars\s*\(|sparklinePoints\s*\(/.test(
        s.replace(/\/\/[^\n]*/g, ''))) {
        return fail('seeded demo builder present in dashboard-readers (regression of #389)');
      }
      if (!/read14DayCostBars/.test(s)) return fail('real ledger-driven read14DayCostBars missing');
      const route = read('plugins/autonomous-dev-portal/server/routes/dashboard.ts');
      if (route === null) return fail('routes/dashboard.ts not found');
      if (/passRatePct:\s*94\.2|burnRateCap\s*=\s*400|queueOldestMin:\s*82/.test(route)) {
        return fail('hardcoded KPI constants present in dashboard route (regression of #389)');
      }
      return pass();
    },
  },
];

function main() {
  let failed = 0;
  for (const c of CHECKS) {
    let r;
    try {
      r = c.run();
    } catch (e) {
      r = fail(`check threw: ${e && e.message ? e.message : String(e)}`);
    }
    if (!r.ok) failed++;
    const mark = r.ok ? 'PASS' : 'FAIL';
    const tail = r.detail ? `\n        ${r.detail}` : '';
    console.log(`[${mark}] ${c.id}  (#${c.issue} · ${c.fr})  ${c.desc}${tail}`);
  }
  const total = CHECKS.length;
  console.log(`\nconformance-audit: ${total - failed}/${total} checks passed`);
  if (failed > 0) {
    console.error(
      `\n${failed} conformance check(s) FAILED — PRD-025 drift detected. ` +
        `Resolve the regression(s) above before releasing.`,
    );
    process.exit(1);
  }
}

main();
