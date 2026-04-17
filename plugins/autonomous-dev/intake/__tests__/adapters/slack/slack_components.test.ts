/**
 * Unit tests for Slack Block Kit Components & Modal Forms (SPEC-008-4-03, Tasks 7 & 9).
 *
 * Covers spec test cases 9-11, 12, 15-16:
 *  9. Kill button has danger style with nested confirm dialog (title, text, confirm, deny)
 * 10. Kill button action_id = 'kill_confirm'
 * 11. Cancel button action_id = 'cancel_confirm_REQ-000042'
 * 12. Modal has 3 input blocks with correct action_id, multiline, max_length
 * 15. Modal structure validation
 * 16. Modal trigger_id passed through to views.open payload
 *
 * @module slack_components.test
 */

import {
  buildKillConfirmationBlocks,
  buildCancelConfirmationBlocks,
  buildSubmitModal,
  type SlackModal,
} from '../../../adapters/slack/slack_components';

// ---------------------------------------------------------------------------
// Type helpers for accessing nested block structures
// ---------------------------------------------------------------------------

interface ButtonElement {
  type: string;
  text: { type: string; text: string };
  style?: string;
  action_id: string;
  confirm?: {
    title: { type: string; text: string };
    text: { type: string; text: string };
    confirm: { type: string; text: string };
    deny: { type: string; text: string };
  };
}

interface ActionsBlock {
  type: string;
  elements: ButtonElement[];
}

interface InputBlock {
  type: string;
  block_id: string;
  optional?: boolean;
  label: { type: string; text: string };
  element: {
    type: string;
    action_id: string;
    multiline?: boolean;
    max_length?: number;
    placeholder?: { type: string; text: string };
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Slack Components (SPEC-008-4-03, Tasks 7 & 9)', () => {
  // -----------------------------------------------------------------------
  // Task 7: Kill Confirmation Blocks
  // -----------------------------------------------------------------------
  describe('buildKillConfirmationBlocks', () => {
    test('returns 2 blocks: section + actions', () => {
      const blocks = buildKillConfirmationBlocks();

      expect(blocks).toHaveLength(2);
      expect(blocks[0].type).toBe('section');
      expect(blocks[1].type).toBe('actions');
    });

    test('section block contains emergency kill switch warning', () => {
      const blocks = buildKillConfirmationBlocks();
      const section = blocks[0];

      const text = (section.text as { text: string }).text;
      expect(text).toContain(':rotating_light:');
      expect(text).toContain('Emergency Kill Switch');
      expect(text).toContain('stop ALL running pipeline processes');
    });

    // Test 10: Kill button action_id = 'kill_confirm'
    test('first button has action_id "kill_confirm"', () => {
      const blocks = buildKillConfirmationBlocks();
      const actions = blocks[1] as unknown as ActionsBlock;
      const confirmBtn = actions.elements[0];

      expect(confirmBtn.action_id).toBe('kill_confirm');
      expect(confirmBtn.text.text).toBe('CONFIRM KILL ALL');
    });

    test('first button has danger style', () => {
      const blocks = buildKillConfirmationBlocks();
      const actions = blocks[1] as unknown as ActionsBlock;
      const confirmBtn = actions.elements[0];

      expect(confirmBtn.style).toBe('danger');
    });

    // Test 9: Kill button has nested confirm dialog
    test('kill button has nested confirm dialog with title, text, confirm, deny', () => {
      const blocks = buildKillConfirmationBlocks();
      const actions = blocks[1] as unknown as ActionsBlock;
      const confirmBtn = actions.elements[0];

      expect(confirmBtn.confirm).toBeDefined();
      expect(confirmBtn.confirm!.title.type).toBe('plain_text');
      expect(confirmBtn.confirm!.title.text).toBe('Are you absolutely sure?');
      expect(confirmBtn.confirm!.text.type).toBe('mrkdwn');
      expect(confirmBtn.confirm!.text.text).toBe('This will halt all pipeline activity.');
      expect(confirmBtn.confirm!.confirm.type).toBe('plain_text');
      expect(confirmBtn.confirm!.confirm.text).toBe('Kill All');
      expect(confirmBtn.confirm!.deny.type).toBe('plain_text');
      expect(confirmBtn.confirm!.deny.text).toBe('Go Back');
    });

    test('second button is cancel with action_id "kill_cancel"', () => {
      const blocks = buildKillConfirmationBlocks();
      const actions = blocks[1] as unknown as ActionsBlock;
      const cancelBtn = actions.elements[1];

      expect(cancelBtn.action_id).toBe('kill_cancel');
      expect(cancelBtn.text.text).toBe('Cancel');
      expect(cancelBtn.style).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Task 7: Cancel Confirmation Blocks
  // -----------------------------------------------------------------------
  describe('buildCancelConfirmationBlocks', () => {
    // Test 11: Cancel button action_id for REQ-000042
    test('cancel confirm action_id = "cancel_confirm_REQ-000042"', () => {
      const blocks = buildCancelConfirmationBlocks('REQ-000042');
      const actions = blocks[1] as unknown as ActionsBlock;
      const confirmBtn = actions.elements[0];

      expect(confirmBtn.action_id).toBe('cancel_confirm_REQ-000042');
    });

    test('cancel cancel action_id embeds request ID', () => {
      const blocks = buildCancelConfirmationBlocks('REQ-000042');
      const actions = blocks[1] as unknown as ActionsBlock;
      const cancelBtn = actions.elements[1];

      expect(cancelBtn.action_id).toBe('cancel_cancel_REQ-000042');
    });

    test('section text mentions the request ID', () => {
      const blocks = buildCancelConfirmationBlocks('REQ-000042');
      const section = blocks[0];
      const text = (section.text as { text: string }).text;

      expect(text).toContain('*REQ-000042*');
      expect(text).toContain('clean up all associated branches and PRs');
    });

    test('confirm cancel button has danger style', () => {
      const blocks = buildCancelConfirmationBlocks('REQ-000042');
      const actions = blocks[1] as unknown as ActionsBlock;
      const confirmBtn = actions.elements[0];

      expect(confirmBtn.style).toBe('danger');
      expect(confirmBtn.text.text).toBe('Confirm Cancel');
    });

    test('keep request button has no style (default)', () => {
      const blocks = buildCancelConfirmationBlocks('REQ-000042');
      const actions = blocks[1] as unknown as ActionsBlock;
      const keepBtn = actions.elements[1];

      expect(keepBtn.style).toBeUndefined();
      expect(keepBtn.text.text).toBe('Keep Request');
    });
  });

  // -----------------------------------------------------------------------
  // Task 9: Submit Modal Form
  // -----------------------------------------------------------------------
  describe('buildSubmitModal', () => {
    // Test 15: Modal structure
    test('modal has 3 input blocks', () => {
      const modal = buildSubmitModal('trigger-123');
      const blocks = modal.view.blocks as InputBlock[];

      expect(blocks).toHaveLength(3);
      for (const block of blocks) {
        expect(block.type).toBe('input');
      }
    });

    test('modal has correct callback_id and type', () => {
      const modal = buildSubmitModal('trigger-123');

      expect(modal.view.type).toBe('modal');
      expect(modal.view.callback_id).toBe('submit_modal');
    });

    test('modal has submit and close buttons', () => {
      const modal = buildSubmitModal('trigger-123');

      expect(modal.view.submit.text).toBe('Submit');
      expect(modal.view.close.text).toBe('Cancel');
    });

    test('modal title is "Submit Pipeline Request"', () => {
      const modal = buildSubmitModal('trigger-123');

      expect(modal.view.title.text).toBe('Submit Pipeline Request');
    });

    // Test 16: Modal trigger_id
    test('trigger_id is passed through', () => {
      const modal = buildSubmitModal('trigger-abc-456');

      expect(modal.trigger_id).toBe('trigger-abc-456');
    });

    // Test 12/15: description block (required, multiline, max 10000)
    test('description block is required, multiline, max_length 10000', () => {
      const modal = buildSubmitModal('trigger-123');
      const blocks = modal.view.blocks as InputBlock[];
      const descBlock = blocks.find((b) => b.block_id === 'description_block')!;

      expect(descBlock).toBeDefined();
      expect(descBlock.label.text).toBe('Description');
      expect(descBlock.optional).toBeUndefined(); // required by default (not optional)
      expect(descBlock.element.action_id).toBe('description');
      expect(descBlock.element.multiline).toBe(true);
      expect(descBlock.element.max_length).toBe(10000);
    });

    // Test 12/15: repo block (optional)
    test('repo block is optional', () => {
      const modal = buildSubmitModal('trigger-123');
      const blocks = modal.view.blocks as InputBlock[];
      const repoBlock = blocks.find((b) => b.block_id === 'repo_block')!;

      expect(repoBlock).toBeDefined();
      expect(repoBlock.optional).toBe(true);
      expect(repoBlock.label.text).toBe('Target Repository');
      expect(repoBlock.element.action_id).toBe('repo');
    });

    // Test 12/15: acceptance criteria block (optional, multiline, max 2000)
    test('acceptance criteria block is optional, multiline, max_length 2000', () => {
      const modal = buildSubmitModal('trigger-123');
      const blocks = modal.view.blocks as InputBlock[];
      const criteriaBlock = blocks.find((b) => b.block_id === 'criteria_block')!;

      expect(criteriaBlock).toBeDefined();
      expect(criteriaBlock.optional).toBe(true);
      expect(criteriaBlock.label.text).toBe('Acceptance Criteria');
      expect(criteriaBlock.element.action_id).toBe('acceptance_criteria');
      expect(criteriaBlock.element.multiline).toBe(true);
      expect(criteriaBlock.element.max_length).toBe(2000);
    });

    // Placeholder text on all fields
    test('all input fields have placeholder text', () => {
      const modal = buildSubmitModal('trigger-123');
      const blocks = modal.view.blocks as InputBlock[];

      for (const block of blocks) {
        expect(block.element.placeholder).toBeDefined();
        expect(block.element.placeholder!.type).toBe('plain_text');
        expect(block.element.placeholder!.text.length).toBeGreaterThan(0);
      }
    });
  });
});
