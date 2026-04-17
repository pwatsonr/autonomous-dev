/**
 * Discord Button Components & Modal Forms.
 *
 * Provides builder functions for:
 * - Kill confirmation buttons (Danger + Secondary)
 * - Cancel confirmation buttons with embedded request ID
 * - Submit modal form with description, repo, and acceptance criteria fields
 *
 * Uses discord.js-compatible raw JSON component payloads so the module
 * can be consumed without importing discord.js at compile time. The
 * actual discord.js Builder classes (ActionRowBuilder, ButtonBuilder,
 * ModalBuilder, TextInputBuilder) are referenced in JSDoc for clarity.
 *
 * Implements SPEC-008-3-03, Tasks 6 & 8.
 *
 * @module discord_components
 */

// ---------------------------------------------------------------------------
// Discord component type/style constants (matching discord.js enums)
// ---------------------------------------------------------------------------

/** Discord component types. */
export const ComponentType = {
  ACTION_ROW: 1,
  BUTTON: 2,
  TEXT_INPUT: 4,
} as const;

/** Discord button styles. */
export const ButtonStyle = {
  Primary: 1,
  Secondary: 2,
  Success: 3,
  Danger: 4,
  Link: 5,
} as const;

/** Discord text input styles. */
export const TextInputStyle = {
  Short: 1,
  Paragraph: 2,
} as const;

// ---------------------------------------------------------------------------
// Component payload types
// ---------------------------------------------------------------------------

/** A single button component. */
export interface ButtonComponent {
  type: typeof ComponentType.BUTTON;
  custom_id: string;
  label: string;
  style: number;
}

/** An action row containing buttons. */
export interface ActionRow<T = ButtonComponent | TextInputComponent> {
  type: typeof ComponentType.ACTION_ROW;
  components: T[];
}

/** A text input component (for modals). */
export interface TextInputComponent {
  type: typeof ComponentType.TEXT_INPUT;
  custom_id: string;
  label: string;
  style: number;
  placeholder?: string;
  required?: boolean;
  max_length?: number;
}

/** A modal dialog definition. */
export interface ModalPayload {
  custom_id: string;
  title: string;
  components: ActionRow<TextInputComponent>[];
}

// ---------------------------------------------------------------------------
// Task 6: Kill Confirmation Buttons
// ---------------------------------------------------------------------------

/**
 * Build the kill confirmation action row.
 *
 * Contains two buttons:
 * - "CONFIRM KILL ALL" (Danger style, custom_id: `kill_confirm`)
 * - "Cancel" (Secondary style, custom_id: `kill_cancel`)
 *
 * @returns An action row with the kill confirmation buttons.
 */
export function buildKillConfirmation(): ActionRow<ButtonComponent> {
  return {
    type: ComponentType.ACTION_ROW,
    components: [
      {
        type: ComponentType.BUTTON,
        custom_id: 'kill_confirm',
        label: 'CONFIRM KILL ALL',
        style: ButtonStyle.Danger,
      },
      {
        type: ComponentType.BUTTON,
        custom_id: 'kill_cancel',
        label: 'Cancel',
        style: ButtonStyle.Secondary,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Task 6: Cancel Confirmation Buttons
// ---------------------------------------------------------------------------

/**
 * Build the cancel confirmation action row for a specific request.
 *
 * Contains two buttons:
 * - "Confirm Cancel" (Danger style, custom_id: `cancel_confirm_{requestId}`)
 * - "Keep Request" (Secondary style, custom_id: `cancel_cancel_{requestId}`)
 *
 * The request ID is embedded in the custom_id so the interaction handler
 * can extract it when the button is clicked.
 *
 * @param requestId - The request ID to embed in the custom IDs.
 * @returns An action row with the cancel confirmation buttons.
 */
export function buildCancelConfirmation(requestId: string): ActionRow<ButtonComponent> {
  return {
    type: ComponentType.ACTION_ROW,
    components: [
      {
        type: ComponentType.BUTTON,
        custom_id: `cancel_confirm_${requestId}`,
        label: 'Confirm Cancel',
        style: ButtonStyle.Danger,
      },
      {
        type: ComponentType.BUTTON,
        custom_id: `cancel_cancel_${requestId}`,
        label: 'Keep Request',
        style: ButtonStyle.Secondary,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Task 8: Submit Modal Form
// ---------------------------------------------------------------------------

/**
 * Build the submit pipeline request modal.
 *
 * Contains 3 fields:
 * - Description (Paragraph, required, max 10000 chars)
 * - Target Repository (Short, optional)
 * - Acceptance Criteria (Paragraph, optional, max 2000 chars)
 *
 * @returns A modal payload ready to be shown via `interaction.showModal()`.
 */
export function buildSubmitModal(): ModalPayload {
  return {
    custom_id: 'submit_modal',
    title: 'Submit Pipeline Request',
    components: [
      {
        type: ComponentType.ACTION_ROW,
        components: [
          {
            type: ComponentType.TEXT_INPUT,
            custom_id: 'description',
            label: 'Description',
            style: TextInputStyle.Paragraph,
            placeholder: 'Describe the feature or task...',
            required: true,
            max_length: 10000,
          },
        ],
      },
      {
        type: ComponentType.ACTION_ROW,
        components: [
          {
            type: ComponentType.TEXT_INPUT,
            custom_id: 'repo',
            label: 'Target Repository',
            style: TextInputStyle.Short,
            placeholder: 'owner/repo-name',
            required: false,
          },
        ],
      },
      {
        type: ComponentType.ACTION_ROW,
        components: [
          {
            type: ComponentType.TEXT_INPUT,
            custom_id: 'acceptance_criteria',
            label: 'Acceptance Criteria',
            style: TextInputStyle.Paragraph,
            placeholder: 'Optional: How will you know this is done?',
            required: false,
            max_length: 2000,
          },
        ],
      },
    ],
  };
}
