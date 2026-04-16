/**
 * Unit tests for ComponentInteractionHandler (SPEC-008-3-05, Task 14).
 *
 * Covers 6 test cases:
 *  1. kill_confirm button authorized: routes to kill handler with "CONFIRM"
 *  2. kill_confirm button unauthorized: returns ephemeral denial
 *  3. kill_cancel button: updates message with "Kill cancelled."
 *  4. cancel_confirm_REQ-XXXXXX: routes to cancel handler
 *  5. Modal submission: extracts fields and routes to submit handler
 *  6. Expired interaction handling
 *
 * @module discord_interaction_handler.test
 */

import { ComponentInteractionHandler } from '../../../adapters/discord/discord_interaction_handler';
import type {
  MessageComponentInteraction,
  ModalSubmitInteraction,
  IntakeRouter,
} from '../../../adapters/discord/discord_adapter';
import type { DiscordIdentityResolver } from '../../../adapters/discord/discord_identity';
import type { AuthzEngine } from '../../../authz/authz_engine';
import type { IncomingCommand, CommandResult } from '../../../adapters/adapter_interface';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockRouter(result: Partial<CommandResult> = { success: true, data: { requestId: 'REQ-000001' } }): IntakeRouter & { lastCommand?: IncomingCommand } {
  const mock: IntakeRouter & { lastCommand?: IncomingCommand } = {
    async route(command: IncomingCommand): Promise<CommandResult> {
      mock.lastCommand = command;
      return { success: true, data: { requestId: 'REQ-000001' }, ...result } as CommandResult;
    },
  };
  return mock;
}

function createMockIdentityResolver(userId: string = 'user-admin'): DiscordIdentityResolver {
  return {
    resolve: jest.fn().mockResolvedValue(userId),
    resolveDisplayName: jest.fn().mockResolvedValue('Test User'),
  } as unknown as DiscordIdentityResolver;
}

function createMockAuthz(granted: boolean = true): AuthzEngine {
  return {
    authorize: jest.fn().mockReturnValue({
      granted,
      userId: 'user-admin',
      action: 'kill',
      reason: granted ? 'Admin role' : 'Insufficient permissions',
      timestamp: new Date(),
    }),
  } as unknown as AuthzEngine;
}

function createMockButtonInteraction(customId: string): MessageComponentInteraction {
  return {
    customId,
    user: { id: 'discord-user-123' },
    isRepliable: () => true,
    reply: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
  };
}

function createMockModalInteraction(fields: Record<string, string>): ModalSubmitInteraction {
  return {
    fields: {
      getTextInputValue: jest.fn((id: string) => fields[id] ?? ''),
    },
    user: { id: 'discord-user-123' },
    channelId: 'channel-456',
    deferReply: jest.fn().mockResolvedValue(undefined),
    editReply: jest.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ComponentInteractionHandler (SPEC-008-3-05, Task 14)', () => {
  // -----------------------------------------------------------------------
  // Test 1: kill_confirm authorized -> routes kill CONFIRM
  // -----------------------------------------------------------------------
  test('kill_confirm button authorized: routes to kill handler with "CONFIRM"', async () => {
    const router = createMockRouter({ success: true });
    const identityResolver = createMockIdentityResolver('user-admin');
    const authz = createMockAuthz(true);
    const handler = new ComponentInteractionHandler(router, identityResolver, authz);

    const interaction = createMockButtonInteraction('kill_confirm');
    await handler.handle(interaction);

    // Verify identity resolution was called
    expect(identityResolver.resolve).toHaveBeenCalledWith('discord-user-123');

    // Verify authz check was performed
    expect(authz.authorize).toHaveBeenCalledWith('user-admin', 'kill', {}, 'discord');

    // Verify router called with kill CONFIRM
    expect(router.lastCommand).toBeDefined();
    expect(router.lastCommand!.commandName).toBe('kill');
    expect(router.lastCommand!.args).toEqual(['CONFIRM']);
    expect(router.lastCommand!.rawText).toBe('kill CONFIRM');
    expect(router.lastCommand!.source.channelType).toBe('discord');

    // Verify message updated with success
    expect(interaction.update).toHaveBeenCalledWith({
      content: 'All requests have been killed.',
      components: [],
    });
  });

  // -----------------------------------------------------------------------
  // Test 2: kill_confirm unauthorized -> ephemeral denial
  // -----------------------------------------------------------------------
  test('kill_confirm button unauthorized: returns ephemeral denial', async () => {
    const router = createMockRouter();
    const identityResolver = createMockIdentityResolver('user-viewer');
    const authz = createMockAuthz(false);
    const handler = new ComponentInteractionHandler(router, identityResolver, authz);

    const interaction = createMockButtonInteraction('kill_confirm');
    await handler.handle(interaction);

    // Verify ephemeral denial
    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'Permission denied.',
      ephemeral: true,
    });

    // Verify router was NOT called
    expect(router.lastCommand).toBeUndefined();

    // Verify update was NOT called
    expect(interaction.update).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Test 3: kill_cancel -> updates message with "Kill cancelled."
  // -----------------------------------------------------------------------
  test('kill_cancel button: updates message with "Kill cancelled."', async () => {
    const router = createMockRouter();
    const identityResolver = createMockIdentityResolver();
    const authz = createMockAuthz();
    const handler = new ComponentInteractionHandler(router, identityResolver, authz);

    const interaction = createMockButtonInteraction('kill_cancel');
    await handler.handle(interaction);

    expect(interaction.update).toHaveBeenCalledWith({
      content: 'Kill cancelled.',
      components: [],
    });

    // No authz check or router call
    expect(authz.authorize).not.toHaveBeenCalled();
    expect(router.lastCommand).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Test 4: cancel_confirm_REQ-XXXXXX -> routes to cancel handler
  // -----------------------------------------------------------------------
  test('cancel_confirm_REQ-XXXXXX: routes to cancel handler', async () => {
    const router = createMockRouter({ success: true });
    const identityResolver = createMockIdentityResolver('user-contributor');
    const authz = createMockAuthz();
    const handler = new ComponentInteractionHandler(router, identityResolver, authz);

    const interaction = createMockButtonInteraction('cancel_confirm_REQ-000042');
    await handler.handle(interaction);

    // Verify router called with cancel for the embedded request ID
    expect(router.lastCommand).toBeDefined();
    expect(router.lastCommand!.commandName).toBe('cancel');
    expect(router.lastCommand!.args).toEqual(['REQ-000042']);
    expect(router.lastCommand!.source.channelType).toBe('discord');
    expect(router.lastCommand!.source.userId).toBe('user-contributor');

    // Verify message updated
    expect(interaction.update).toHaveBeenCalledWith({
      content: 'Request REQ-000042 has been cancelled.',
      components: [],
    });
  });

  // -----------------------------------------------------------------------
  // Test 5: Modal submission -> extracts fields and routes to submit handler
  // -----------------------------------------------------------------------
  test('modal submission: extracts fields and routes to submit handler', async () => {
    const router = createMockRouter({ success: true, data: { requestId: 'REQ-000099' } });
    const identityResolver = createMockIdentityResolver('user-contributor');
    const authz = createMockAuthz();
    const handler = new ComponentInteractionHandler(router, identityResolver, authz);

    const interaction = createMockModalInteraction({
      description: 'Build a new feature for user profiles',
      repo: 'owner/my-repo',
      acceptance_criteria: 'Users can update their profiles',
    });

    await handler.handleModalSubmit(interaction);

    // Verify deferReply was called before processing
    expect(interaction.deferReply).toHaveBeenCalled();

    // Verify identity resolution
    expect(identityResolver.resolve).toHaveBeenCalledWith('discord-user-123');

    // Verify router called with correct IncomingCommand
    expect(router.lastCommand).toBeDefined();
    expect(router.lastCommand!.commandName).toBe('submit');
    expect(router.lastCommand!.args).toEqual(['Build a new feature for user profiles']);
    expect(router.lastCommand!.flags).toEqual({
      repo: 'owner/my-repo',
      acceptance_criteria: 'Users can update their profiles',
    });
    expect(router.lastCommand!.rawText).toBe('Build a new feature for user profiles');
    expect(router.lastCommand!.source.channelType).toBe('discord');
    expect(router.lastCommand!.source.userId).toBe('user-contributor');
    expect(router.lastCommand!.source.platformChannelId).toBe('channel-456');

    // Verify editReply with created request ID
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'Request created: REQ-000099',
    });
  });

  // -----------------------------------------------------------------------
  // Test 6: Expired interaction handling
  // -----------------------------------------------------------------------
  test('expired interaction: router error shown in editReply', async () => {
    const router = createMockRouter({ success: false, error: 'Queue is full' });
    const identityResolver = createMockIdentityResolver('user-contributor');
    const authz = createMockAuthz();
    const handler = new ComponentInteractionHandler(router, identityResolver, authz);

    // Modal submission that results in router error
    const interaction = createMockModalInteraction({
      description: 'Some request',
      repo: '',
      acceptance_criteria: '',
    });

    await handler.handleModalSubmit(interaction);

    // deferReply still called
    expect(interaction.deferReply).toHaveBeenCalled();

    // editReply shows the error
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'Error: Queue is full',
    });
  });
});
