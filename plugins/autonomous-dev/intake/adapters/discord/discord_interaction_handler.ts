/**
 * Discord Component Interaction Handler.
 *
 * Routes button clicks and modal submissions to the appropriate actions:
 * - Kill confirm/cancel buttons
 * - Cancel confirm/cancel buttons (with embedded request ID)
 * - Submit modal form submissions
 *
 * Validates button clicker authorization before executing destructive
 * actions (kill). Unauthorized users receive an ephemeral denial.
 *
 * Implements SPEC-008-3-03, Task 7.
 *
 * @module discord_interaction_handler
 */

import type {
  MessageComponentInteraction,
  ModalSubmitInteraction,
  IntakeRouter,
} from './discord_adapter';
import type { DiscordIdentityResolver } from './discord_identity';
import type { AuthzEngine } from '../../authz/authz_engine';
import type { IncomingCommand } from '../adapter_interface';

// ---------------------------------------------------------------------------
// ComponentInteractionHandler
// ---------------------------------------------------------------------------

/**
 * Handles button clicks and modal submissions from Discord.
 *
 * Routing is based on the `customId` prefix:
 * - `kill_confirm`         -> Execute kill with CONFIRM, after authz check
 * - `kill_cancel`          -> Dismiss with "Kill cancelled."
 * - `cancel_confirm_{id}`  -> Execute cancel for the embedded request ID
 * - `cancel_cancel_{id}`   -> Dismiss with "Cancel aborted."
 *
 * Modal submissions (custom_id: `submit_modal`) extract description, repo,
 * and acceptance_criteria fields and route them through the IntakeRouter
 * as a `submit` command.
 */
export class ComponentInteractionHandler {
  constructor(
    private router: IntakeRouter,
    private identityResolver: DiscordIdentityResolver,
    private authz: AuthzEngine,
  ) {}

  // -----------------------------------------------------------------------
  // Button interaction routing
  // -----------------------------------------------------------------------

  /**
   * Handle a message component (button) interaction.
   *
   * Routes by custom_id:
   * - `kill_confirm`  -> {@link handleKillConfirm}
   * - `kill_cancel`   -> Update with "Kill cancelled."
   * - `cancel_confirm_{requestId}` -> {@link handleCancelConfirm}
   * - `cancel_cancel_{requestId}`  -> Update with "Cancel aborted."
   *
   * @param interaction - The Discord message component interaction.
   */
  async handle(interaction: MessageComponentInteraction): Promise<void> {
    const customId = interaction.customId;

    if (customId === 'kill_confirm') {
      await this.handleKillConfirm(interaction);
    } else if (customId === 'kill_cancel') {
      await interaction.update({ content: 'Kill cancelled.', components: [] });
    } else if (customId.startsWith('cancel_confirm_')) {
      const requestId = customId.replace('cancel_confirm_', '');
      await this.handleCancelConfirm(interaction, requestId);
    } else if (customId.startsWith('cancel_cancel_')) {
      await interaction.update({ content: 'Cancel aborted.', components: [] });
    }
  }

  // -----------------------------------------------------------------------
  // Kill confirmation (with authorization)
  // -----------------------------------------------------------------------

  /**
   * Handle the kill confirmation button click.
   *
   * Validates that the clicker is authorized (admin role required for kill).
   * If denied, replies with an ephemeral "Permission denied." message.
   * If granted, routes a `kill CONFIRM` command through the IntakeRouter.
   *
   * @param interaction - The Discord button interaction.
   */
  private async handleKillConfirm(
    interaction: MessageComponentInteraction,
  ): Promise<void> {
    const userId = await this.identityResolver.resolve(interaction.user.id);
    const decision = this.authz.authorize(userId, 'kill', {}, 'discord');
    if (!decision.granted) {
      await interaction.reply({ content: 'Permission denied.', ephemeral: true });
      return;
    }

    const result = await this.router.route({
      commandName: 'kill',
      args: ['CONFIRM'],
      flags: {},
      rawText: 'kill CONFIRM',
      source: { channelType: 'discord', userId, timestamp: new Date() },
    });

    await interaction.update({
      content: result.success ? 'All requests have been killed.' : `Error: ${result.error}`,
      components: [],
    });
  }

  // -----------------------------------------------------------------------
  // Cancel confirmation
  // -----------------------------------------------------------------------

  /**
   * Handle a cancel confirmation button click.
   *
   * Extracts the request ID from the custom_id and routes a `cancel`
   * command through the IntakeRouter.
   *
   * @param interaction - The Discord button interaction.
   * @param requestId   - The request ID extracted from the custom_id.
   */
  private async handleCancelConfirm(
    interaction: MessageComponentInteraction,
    requestId: string,
  ): Promise<void> {
    const userId = await this.identityResolver.resolve(interaction.user.id);

    const result = await this.router.route({
      commandName: 'cancel',
      args: [requestId],
      flags: {},
      rawText: `cancel ${requestId}`,
      source: { channelType: 'discord', userId, timestamp: new Date() },
    });

    await interaction.update({
      content: result.success
        ? `Request ${requestId} has been cancelled.`
        : `Error: ${result.error}`,
      components: [],
    });
  }

  // -----------------------------------------------------------------------
  // Modal submission handling
  // -----------------------------------------------------------------------

  /**
   * Handle a modal submission interaction.
   *
   * Extracts the description, repo, and acceptance_criteria fields from
   * the modal and routes them as a `submit` command through the IntakeRouter.
   *
   * The reply is deferred because submit processing may take time (NLP
   * parsing, duplicate detection, etc.).
   *
   * @param interaction - The Discord modal submit interaction.
   */
  async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const description = interaction.fields.getTextInputValue('description');
    const repo = interaction.fields.getTextInputValue('repo') || undefined;
    const criteria = interaction.fields.getTextInputValue('acceptance_criteria') || undefined;

    await interaction.deferReply();

    const userId = await this.identityResolver.resolve(interaction.user.id);
    const command: IncomingCommand = {
      commandName: 'submit',
      args: [description],
      flags: {
        ...(repo ? { repo } : {}),
        ...(criteria ? { acceptance_criteria: criteria } : {}),
      },
      rawText: description,
      source: {
        channelType: 'discord',
        userId,
        platformChannelId: interaction.channelId,
        timestamp: new Date(),
      },
    };

    const result = await this.router.route(command);
    await interaction.editReply({
      content: result.success
        ? `Request created: ${(result.data as Record<string, unknown>).requestId}`
        : `Error: ${result.error}`,
    });
  }
}
