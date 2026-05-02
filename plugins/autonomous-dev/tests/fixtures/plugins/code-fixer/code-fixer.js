/**
 * code-fixer FIXTURE entry-point (SPEC-022-2-03).
 *
 * NOT a real fixer. Given a `security-findings` artifact, emits one
 * placeholder `code-patches` entry per finding. Each patch is marked
 * `requires_approval: true` so the chain executor pauses and routes an
 * escalation to a human operator.
 *
 * Real code-modification logic is a future plan. This fixture exists so the
 * standards-to-fix end-to-end test (SPEC-022-2-05) can exercise the wiring
 * without depending on a non-deterministic LLM-backed agent.
 */
'use strict';

module.exports = async function codeFixer(input, ctx) {
  const logger = (ctx && ctx.logger) || console;
  // Two invocation shapes are supported: the chain executor passes the
  // resolved upstream artifacts on `ctx.inputs[<artifact_type>]`; older
  // PLAN-019-1 hook callers pass the raw input as the first arg.
  const findings = (ctx && ctx.inputs && ctx.inputs['security-findings']
    && ctx.inputs['security-findings'].findings)
    || (input && input.findings)
    || [];
  const patches = findings.map((f, i) => ({
    patch_id: 'patch-' + (f.finding_id || ('idx-' + i)),
    target_file: (f.location && f.location.file) || 'unknown',
    target_line: (f.location && f.location.line) || 0,
    placeholder: true,
    suggestion: '// TODO: fix ' + (f.rule_id || 'unknown-rule')
      + ' (fixture stub, no real fix applied)',
    requires_approval: true,
  }));
  if (typeof logger.info === 'function') {
    logger.info('code-fixer fixture emitted ' + patches.length + ' placeholder patches');
  }
  return {
    artifact_type: 'code-patches',
    schema_version: '1.0',
    patches: patches,
  };
};
