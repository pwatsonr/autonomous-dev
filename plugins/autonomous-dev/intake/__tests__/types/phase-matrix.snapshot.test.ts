/**
 * Snapshot test that locks the canonical PHASE_OVERRIDE_MATRIX shape
 * (SPEC-018-1-04, Task 8 — drift guard).
 *
 * Any change to PHASE_OVERRIDE_MATRIX requires explicit `--updateSnapshot`
 * AND a code-review note pointing at TDD-018 §5.2. The snapshot file is the
 * single point at which the canonical TDD revision is mirrored in test code.
 *
 * @module __tests__/types/phase-matrix.snapshot.test
 */

import { PHASE_OVERRIDE_MATRIX } from '../../types/phase-override';

test('PHASE_OVERRIDE_MATRIX matches TDD-018 §5.2', () => {
  expect(PHASE_OVERRIDE_MATRIX).toMatchSnapshot();
});
