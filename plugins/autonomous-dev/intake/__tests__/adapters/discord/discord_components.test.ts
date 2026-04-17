/**
 * Unit tests for Discord Button Components & Modal Forms (SPEC-008-3-05, Task 14).
 *
 * Covers 5 test cases:
 *  1. buildKillConfirmation returns ActionRow with 2 buttons (DANGER + SECONDARY)
 *  2. buildCancelConfirmation includes request ID in custom_id
 *  3. buildSubmitModal returns 3 action rows with correct field types
 *  4. Modal max_length constraints verified
 *  5. Button component types and styles verified
 *
 * @module discord_components.test
 */

import {
  buildKillConfirmation,
  buildCancelConfirmation,
  buildSubmitModal,
  ButtonStyle,
  ComponentType,
  TextInputStyle,
} from '../../../adapters/discord/discord_components';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Discord Components (SPEC-008-3-05, Task 14)', () => {
  // -----------------------------------------------------------------------
  // Test 1: buildKillConfirmation returns ActionRow with 2 buttons (DANGER + SECONDARY)
  // -----------------------------------------------------------------------
  test('buildKillConfirmation returns ActionRow with 2 buttons (DANGER + SECONDARY)', () => {
    const row = buildKillConfirmation();

    // Verify ActionRow structure
    expect(row.type).toBe(ComponentType.ACTION_ROW);
    expect(row.components).toHaveLength(2);

    // First button: DANGER style, "CONFIRM KILL ALL"
    const confirmBtn = row.components[0];
    expect(confirmBtn.type).toBe(ComponentType.BUTTON);
    expect(confirmBtn.custom_id).toBe('kill_confirm');
    expect(confirmBtn.label).toBe('CONFIRM KILL ALL');
    expect(confirmBtn.style).toBe(ButtonStyle.Danger);

    // Second button: SECONDARY style, "Cancel"
    const cancelBtn = row.components[1];
    expect(cancelBtn.type).toBe(ComponentType.BUTTON);
    expect(cancelBtn.custom_id).toBe('kill_cancel');
    expect(cancelBtn.label).toBe('Cancel');
    expect(cancelBtn.style).toBe(ButtonStyle.Secondary);
  });

  // -----------------------------------------------------------------------
  // Test 2: buildCancelConfirmation includes request ID in custom_id
  // -----------------------------------------------------------------------
  test('buildCancelConfirmation includes request ID in custom_id', () => {
    const row = buildCancelConfirmation('REQ-000042');

    expect(row.type).toBe(ComponentType.ACTION_ROW);
    expect(row.components).toHaveLength(2);

    // custom_ids embed the request ID
    expect(row.components[0].custom_id).toBe('cancel_confirm_REQ-000042');
    expect(row.components[1].custom_id).toBe('cancel_cancel_REQ-000042');

    // Verify styles
    expect(row.components[0].style).toBe(ButtonStyle.Danger);
    expect(row.components[0].label).toBe('Confirm Cancel');
    expect(row.components[1].style).toBe(ButtonStyle.Secondary);
    expect(row.components[1].label).toBe('Keep Request');

    // Works with different request IDs
    const row2 = buildCancelConfirmation('REQ-000099');
    expect(row2.components[0].custom_id).toBe('cancel_confirm_REQ-000099');
    expect(row2.components[1].custom_id).toBe('cancel_cancel_REQ-000099');
  });

  // -----------------------------------------------------------------------
  // Test 3: buildSubmitModal returns 3 action rows with correct field types
  // -----------------------------------------------------------------------
  test('buildSubmitModal returns 3 action rows with correct field types', () => {
    const modal = buildSubmitModal();

    expect(modal.custom_id).toBe('submit_modal');
    expect(modal.title).toBe('Submit Pipeline Request');
    expect(modal.components).toHaveLength(3);

    // All components are ACTION_ROWs
    for (const row of modal.components) {
      expect(row.type).toBe(ComponentType.ACTION_ROW);
      expect(row.components).toHaveLength(1);
      expect(row.components[0].type).toBe(ComponentType.TEXT_INPUT);
    }

    // Verify field custom_ids
    const customIds = modal.components.map((row) => row.components[0].custom_id);
    expect(customIds).toEqual(['description', 'repo', 'acceptance_criteria']);

    // Description: Paragraph, required
    const descField = modal.components[0].components[0];
    expect(descField.style).toBe(TextInputStyle.Paragraph);
    expect(descField.required).toBe(true);
    expect(descField.label).toBe('Description');

    // Repo: Short, optional
    const repoField = modal.components[1].components[0];
    expect(repoField.style).toBe(TextInputStyle.Short);
    expect(repoField.required).toBe(false);
    expect(repoField.label).toBe('Target Repository');

    // Acceptance criteria: Paragraph, optional
    const criteriaField = modal.components[2].components[0];
    expect(criteriaField.style).toBe(TextInputStyle.Paragraph);
    expect(criteriaField.required).toBe(false);
    expect(criteriaField.label).toBe('Acceptance Criteria');
  });

  // -----------------------------------------------------------------------
  // Test 4: Modal max_length constraints
  // -----------------------------------------------------------------------
  test('modal fields have correct max_length constraints', () => {
    const modal = buildSubmitModal();

    // Description: max_length 10000
    const descField = modal.components[0].components[0];
    expect(descField.max_length).toBe(10000);

    // Repo: no max_length
    const repoField = modal.components[1].components[0];
    expect(repoField.max_length).toBeUndefined();

    // Acceptance criteria: max_length 2000
    const criteriaField = modal.components[2].components[0];
    expect(criteriaField.max_length).toBe(2000);
  });

  // -----------------------------------------------------------------------
  // Test 5: Button component types and styles verified
  // -----------------------------------------------------------------------
  test('all buttons have correct component type and style constants', () => {
    // Verify the constants themselves
    expect(ComponentType.ACTION_ROW).toBe(1);
    expect(ComponentType.BUTTON).toBe(2);
    expect(ComponentType.TEXT_INPUT).toBe(4);

    expect(ButtonStyle.Primary).toBe(1);
    expect(ButtonStyle.Secondary).toBe(2);
    expect(ButtonStyle.Success).toBe(3);
    expect(ButtonStyle.Danger).toBe(4);
    expect(ButtonStyle.Link).toBe(5);

    expect(TextInputStyle.Short).toBe(1);
    expect(TextInputStyle.Paragraph).toBe(2);

    // Verify kill buttons use the correct type constant
    const killRow = buildKillConfirmation();
    for (const btn of killRow.components) {
      expect(btn.type).toBe(2); // BUTTON
    }

    // Verify cancel buttons use the correct type constant
    const cancelRow = buildCancelConfirmation('REQ-000001');
    for (const btn of cancelRow.components) {
      expect(btn.type).toBe(2); // BUTTON
    }
  });
});
