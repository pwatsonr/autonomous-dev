/**
 * Committed snapshot of every entry in `K8S_OPERATIONS` (SPEC-024-2-05).
 *
 * Each operation snapshot captures the `rules` array exactly as it is
 * shipped to `createNamespacedRole`. The structural shape of these rules
 * IS the scope enforcement boundary at the Kubernetes API level — any
 * widening of `apiGroups`, `resources`, `verbs`, or removal of
 * `resourceNames` MUST surface as a snapshot diff for explicit review.
 *
 * Note on filename: the spec lists this snapshot as `k8s-roles.snap`,
 * but Jest's standard snapshotResolver names the file
 * `k8s-roles.test.ts.snap`. We follow Jest convention; the file's
 * purpose and contents match the spec exactly.
 */

import { K8S_OPERATIONS } from '../../intake/cred-proxy/scopers/operation-catalog';

describe('K8S_OPERATIONS snapshots', () => {
  for (const op of Object.keys(K8S_OPERATIONS)) {
    it(`rules for ${op}`, () => {
      const spec = K8S_OPERATIONS[op];
      // Snapshot only the rules array — the requiredScopeKeys live with
      // the Role-binding logic, not the Role itself.
      expect(spec.rules).toMatchSnapshot();
    });
  }

  it('every operation declares at least one rule', () => {
    for (const [name, spec] of Object.entries(K8S_OPERATIONS)) {
      expect(spec.rules.length).toBeGreaterThan(0);
      // Defensive: the rules' verbs/resources/apiGroups arrays MUST be
      // present and non-empty. A wide-open rule (e.g., empty verbs list)
      // would slip past the snapshot if not asserted explicitly.
      for (const rule of spec.rules) {
        expect(rule.apiGroups.length).toBeGreaterThan(0);
        expect(rule.resources.length).toBeGreaterThan(0);
        expect(rule.verbs.length).toBeGreaterThan(0);
        // Reference `name` so the eslint no-unused-var rule does not
        // suppress the loop iterator in test strictness mode.
        expect(typeof name).toBe('string');
      }
    }
  });
});
