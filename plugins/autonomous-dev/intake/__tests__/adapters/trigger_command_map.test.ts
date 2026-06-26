/**
 * Unit tests for the scoped /autodev → trigger command mapper (ONBOARD P6, #583).
 *
 * @module intake/__tests__/adapters/trigger_command_map.test
 */

import { buildTriggerCommand } from '../../adapters/trigger_command_map';

describe('buildTriggerCommand', () => {
  it('produces a trigger command with the scoped grammar + messageId dedup key', () => {
    const c = buildTriggerCommand({
      scopeType: 'repo',
      scopeId: 'acme/orders',
      task: 'fix the flaky retry test',
      channelType: 'discord',
      userId: 'u1',
      channelId: 'c1',
      messageId: 'interaction-123',
    });
    expect(c.commandName).toBe('trigger'); // routes to TriggerHandler
    expect(c.args).toEqual(['repo', 'acme/orders', 'fix the flaky retry test']);
    expect(c.flags.messageId).toBe('interaction-123'); // idempotency key
    expect(c.source.channelType).toBe('discord');
    expect(c.source.userId).toBe('u1');
    expect(c.source.platformChannelId).toBe('c1');
    expect(c.source.timestamp).toBeInstanceOf(Date);
  });

  it('preserves the task verbatim as a single arg (parseScopedTrigger rejoins args[2:])', () => {
    const c = buildTriggerCommand({
      scopeType: 'project',
      scopeId: 'payments',
      task: 'add   a  metrics   endpoint',
      channelType: 'slack',
      userId: 'u2',
      messageId: 'evt-9',
    });
    expect(c.args[2]).toBe('add   a  metrics   endpoint'); // internal spacing kept
    expect(c.args).toHaveLength(3);
  });

  it('defaults rawText when none is supplied', () => {
    const c = buildTriggerCommand({
      scopeType: 'repo',
      scopeId: 'a/b',
      task: 'do x',
      channelType: 'discord',
      userId: 'u',
      messageId: 'm',
    });
    expect(c.rawText).toContain('/autodev repo a/b do x');
  });
});
