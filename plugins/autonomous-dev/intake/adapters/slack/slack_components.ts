/**
 * Slack Block Kit Interactive Components & Modal Forms.
 *
 * Provides builder functions for:
 * - Kill confirmation blocks (Danger button with nested Slack confirm dialog)
 * - Cancel confirmation blocks with embedded request ID
 * - Submit modal form with description, repo, and acceptance criteria fields
 *
 * Uses Slack Block Kit JSON payloads directly. The kill confirmation button
 * uses Slack's built-in nested `confirm` dialog (two-step confirmation),
 * providing an extra safety layer compared to other platforms.
 *
 * Implements SPEC-008-4-03, Tasks 7 & 9.
 *
 * @module slack_components
 */

import type { SlackBlock } from '../../notifications/formatters/slack_formatter';

// ---------------------------------------------------------------------------
// Slack Modal type
// ---------------------------------------------------------------------------

/**
 * A Slack modal view payload for `views.open`.
 */
export interface SlackModal {
  trigger_id: string;
  view: {
    type: 'modal';
    callback_id: string;
    title: { type: 'plain_text'; text: string };
    submit: { type: 'plain_text'; text: string };
    close: { type: 'plain_text'; text: string };
    blocks: SlackBlock[];
  };
}

// ---------------------------------------------------------------------------
// Task 7: Kill Confirmation Blocks
// ---------------------------------------------------------------------------

/**
 * Build the kill confirmation Block Kit blocks.
 *
 * Contains:
 * - A section block with the emergency kill switch warning.
 * - An actions block with two buttons:
 *   - "CONFIRM KILL ALL" (danger style, action_id: `kill_confirm`) with a
 *     nested Slack confirm dialog for two-step confirmation.
 *   - "Cancel" (action_id: `kill_cancel`)
 *
 * Key Slack difference from Discord: The kill confirmation button uses
 * Slack's built-in nested `confirm` dialog, providing an extra safety layer.
 *
 * @returns An array of Slack Block Kit blocks.
 */
export function buildKillConfirmationBlocks(): SlackBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':rotating_light: *Emergency Kill Switch* :rotating_light:\n' +
              'This will immediately stop ALL running pipeline processes and pause all active requests.',
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'CONFIRM KILL ALL' },
          style: 'danger',
          action_id: 'kill_confirm',
          confirm: {
            title: { type: 'plain_text', text: 'Are you absolutely sure?' },
            text: { type: 'mrkdwn', text: 'This will halt all pipeline activity.' },
            confirm: { type: 'plain_text', text: 'Kill All' },
            deny: { type: 'plain_text', text: 'Go Back' },
          },
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Cancel' },
          action_id: 'kill_cancel',
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Task 7: Cancel Confirmation Blocks
// ---------------------------------------------------------------------------

/**
 * Build the cancel confirmation Block Kit blocks for a specific request.
 *
 * Contains:
 * - A section block describing the cancel action.
 * - An actions block with two buttons:
 *   - "Confirm Cancel" (danger style, action_id: `cancel_confirm_{requestId}`)
 *   - "Keep Request" (action_id: `cancel_cancel_{requestId}`)
 *
 * The request ID is embedded in the action_id so the interaction handler
 * can extract it when the button is clicked.
 *
 * @param requestId - The request ID to embed in the action IDs.
 * @returns An array of Slack Block Kit blocks.
 */
export function buildCancelConfirmationBlocks(requestId: string): SlackBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Are you sure you want to cancel *${requestId}*? This will clean up all associated branches and PRs.`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Confirm Cancel' },
          style: 'danger',
          action_id: `cancel_confirm_${requestId}`,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Keep Request' },
          action_id: `cancel_cancel_${requestId}`,
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Task 9: Submit Modal Form
// ---------------------------------------------------------------------------

/**
 * Build the submit pipeline request modal for `views.open`.
 *
 * Contains 3 input blocks:
 * - Description (required, multiline, max 10000 chars)
 * - Target Repository (optional)
 * - Acceptance Criteria (optional, multiline, max 2000 chars)
 *
 * The modal is opened via `views.open` with the `trigger_id` from the
 * original slash command interaction. The `view_submission` payload is
 * routed through the interaction handler, which extracts field values
 * and constructs an IncomingCommand for the submit handler.
 *
 * @param triggerId - The trigger_id from the Slack interaction.
 * @returns A SlackModal payload ready for `views.open`.
 */
export function buildSubmitModal(triggerId: string): SlackModal {
  return {
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: 'submit_modal',
      title: { type: 'plain_text', text: 'Submit Pipeline Request' },
      submit: { type: 'plain_text', text: 'Submit' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'description_block',
          label: { type: 'plain_text', text: 'Description' },
          element: {
            type: 'plain_text_input',
            action_id: 'description',
            multiline: true,
            placeholder: { type: 'plain_text', text: 'Describe the feature or task...' },
            max_length: 10000,
          },
        },
        {
          type: 'input',
          block_id: 'repo_block',
          optional: true,
          label: { type: 'plain_text', text: 'Target Repository' },
          element: {
            type: 'plain_text_input',
            action_id: 'repo',
            placeholder: { type: 'plain_text', text: 'owner/repo-name' },
          },
        },
        {
          type: 'input',
          block_id: 'criteria_block',
          optional: true,
          label: { type: 'plain_text', text: 'Acceptance Criteria' },
          element: {
            type: 'plain_text_input',
            action_id: 'acceptance_criteria',
            multiline: true,
            placeholder: { type: 'plain_text', text: 'Optional: How will you know this is done?' },
            max_length: 2000,
          },
        },
      ],
    },
  };
}
