/**
 * Unit tests for the real bot-post notifier (ONBOARD Phase 6, #583).
 * Fake fetch; no network.
 *
 * @module intake/triggers/bot_notifier.test
 */

import { botNotifier, type FetchLike } from '../bot_notifier';
import type { TriggerOrigin } from '../trigger_store';

interface Captured {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

function fakeFetch(result: { ok: boolean; status?: number; body?: string }): {
  fetchFn: FetchLike;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: result.ok,
      status: result.status ?? (result.ok ? 200 : 500),
      text: async () => result.body ?? '',
    };
  };
  return { fetchFn, calls };
}

const discordOrigin: TriggerOrigin = { platform: 'discord', channelId: 'chan-1', userId: 'u1' };
const slackOrigin: TriggerOrigin = { platform: 'slack', channelId: 'C123', userId: 'u1' };
const msg = { title: 'Done', body: 'PR opened' };

describe('botNotifier', () => {
  it('posts to the Discord channel REST API with the bot token', async () => {
    const { fetchFn, calls } = fakeFetch({ ok: true });
    const r = await botNotifier({ discordToken: 'dtok', fetchFn }).send(discordOrigin, msg);
    expect(r.ok).toBe(true);
    expect(calls[0].url).toContain('/channels/chan-1/messages');
    expect(calls[0].init.headers.Authorization).toBe('Bot dtok');
    expect(JSON.parse(calls[0].init.body).content).toContain('Done');
  });

  it('posts to Slack chat.postMessage and honours the logical ok flag', async () => {
    const ok = fakeFetch({ ok: true, body: JSON.stringify({ ok: true }) });
    expect((await botNotifier({ slackToken: 's', fetchFn: ok.fetchFn }).send(slackOrigin, msg)).ok).toBe(true);
    expect(ok.calls[0].url).toContain('chat.postMessage');
    expect(ok.calls[0].init.headers.Authorization).toBe('Bearer s');
    expect(JSON.parse(ok.calls[0].init.body).channel).toBe('C123');

    // HTTP 200 but a Slack logical error → not ok.
    const bad = fakeFetch({ ok: true, body: JSON.stringify({ ok: false, error: 'channel_not_found' }) });
    const r = await botNotifier({ slackToken: 's', fetchFn: bad.fetchFn }).send(slackOrigin, msg);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('channel_not_found');
  });

  it('returns ok:false (no throw) when the token is missing', async () => {
    const { fetchFn, calls } = fakeFetch({ ok: true });
    const r = await botNotifier({ fetchFn }).send(discordOrigin, msg);
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0); // never hits the network without a token
  });

  it('returns ok:false when there is no channel id', async () => {
    const { fetchFn } = fakeFetch({ ok: true });
    const r = await botNotifier({ discordToken: 'd', fetchFn }).send(
      { platform: 'discord', userId: 'u1' },
      msg,
    );
    expect(r.ok).toBe(false);
  });

  it('never throws when fetch rejects', async () => {
    const fetchFn: FetchLike = async () => {
      throw new Error('network down');
    };
    const r = await botNotifier({ discordToken: 'd', fetchFn }).send(discordOrigin, msg);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('network down');
  });

  it('returns ok:false for an unsupported platform (e.g. cli)', async () => {
    const { fetchFn } = fakeFetch({ ok: true });
    const r = await botNotifier({ discordToken: 'd', slackToken: 's', fetchFn }).send(
      { platform: 'cli', channelId: 'x' },
      msg,
    );
    expect(r.ok).toBe(false);
  });

  it('maps a non-2xx Discord response to ok:false', async () => {
    const { fetchFn } = fakeFetch({ ok: false, status: 403 });
    const r = await botNotifier({ discordToken: 'd', fetchFn }).send(discordOrigin, msg);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('403');
  });
});
