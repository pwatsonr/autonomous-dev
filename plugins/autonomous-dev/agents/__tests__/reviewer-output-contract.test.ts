/**
 * Snapshot test: every reviewer agent .md file must contain the canonical
 * Output Instruction anchor phrase (REQ-000068).
 *
 * TC-024: reviewer file discovery finds at least 11 reviewer files.
 * TC-025: every *-reviewer.md contains the anchor phrase.
 *
 * This test is a drift-catcher: any future reviewer added without the
 * canonical Output Instruction will fail here automatically.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const AGENTS_DIR = join(__dirname, '..');
const ANCHOR =
  'As the **absolute last line** of stdout, print exactly ONE compact JSON object';

const reviewerFiles = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('-reviewer.md'));

describe('reviewer agent output contract', () => {
  test('TC-024: reviewer file discovery finds the expected set', () => {
    expect(reviewerFiles.length).toBeGreaterThanOrEqual(11);
    expect(reviewerFiles).toEqual(
      expect.arrayContaining([
        'standards-meta-reviewer.md',
        'doc-reviewer.md',
        'quality-reviewer.md',
        'security-reviewer.md',
        'qa-edge-case-reviewer.md',
        'ux-ui-reviewer.md',
        'accessibility-reviewer.md',
        'rule-set-enforcement-reviewer.md',
        'architecture-reviewer.md',
        'agent-meta-reviewer.md',
        'artifact-meta-reviewer.md',
      ]),
    );
  });

  test.each(reviewerFiles)(
    'TC-025: %s contains the canonical Output Instruction anchor',
    (file) => {
      const content = readFileSync(join(AGENTS_DIR, file), 'utf8');
      expect(content).toContain(ANCHOR);
    },
  );
});
