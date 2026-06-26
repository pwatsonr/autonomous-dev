/**
 * ONBOARD Phase 6 (#583) — the real Discord/Slack bot-post TriggerNotifier.
 *
 * Replaces the logging stub: posts a trigger's status messages back to its
 * origin channel via the platform bot token. Fetch-based — no SDK and no
 * Gateway connection (the watch-tick runs as a short-lived process), with an
 * injected fetch seam so it is unit-testable offline. Best-effort: any failure
 * (missing token, no channel, network, non-2xx, Slack logical error) returns
 * `{ ok:false }` and never throws — the reporter still audits the outcome.
 *
 * @module intake/triggers/bot_notifier
 */

import type { TriggerMessage, TriggerNotifier } from './trigger_reporter';
import type { TriggerOrigin } from './trigger_store';

/** Minimal fetch surface (Node 18+ / bun global `fetch` satisfies this). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface BotNotifierConfig {
  discordToken?: string;
  slackToken?: string;
  /** Injected fetch (tests); defaults to the global `fetch`. */
  fetchFn?: FetchLike;
}

/** Plain-text body (no per-platform markdown so it renders identically). */
function compose(message: TriggerMessage): string {
  const title = message.title.trim();
  const body = message.body.trim();
  return body ? `${title}\n${body}` : title;
}

/**
 * Build a TriggerNotifier that posts to a trigger's origin channel via the
 * platform bot REST API (`POST /channels/:id/messages` for Discord,
 * `chat.postMessage` for Slack). Unknown platform / missing token / no channel
 * → `{ ok:false }`.
 */
export function botNotifier(config: BotNotifierConfig = {}): TriggerNotifier {
  const fetchFn = config.fetchFn ?? (globalThis.fetch as unknown as FetchLike | undefined);
  return {
    async send(
      origin: TriggerOrigin,
      message: TriggerMessage,
    ): Promise<{ ok: boolean; error?: string }> {
      if (!fetchFn) return { ok: false, error: 'no fetch available' };
      const channelId = origin.channelId;
      if (!channelId) return { ok: false, error: 'no channel id' };
      const content = compose(message);
      try {
        if (origin.platform === 'discord') {
          if (!config.discordToken) return { ok: false, error: 'no discord token' };
          const res = await fetchFn(
            `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bot ${config.discordToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ content }),
            },
          );
          return res.ok ? { ok: true } : { ok: false, error: `discord ${res.status}` };
        }
        if (origin.platform === 'slack') {
          if (!config.slackToken) return { ok: false, error: 'no slack token' };
          const res = await fetchFn('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${config.slackToken}`,
              'Content-Type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify({ channel: channelId, text: content }),
          });
          // Slack returns HTTP 200 with `{ ok:false, error }` on logical errors.
          if (!res.ok) return { ok: false, error: `slack ${res.status}` };
          try {
            const parsed = JSON.parse(await res.text()) as { ok?: boolean; error?: string };
            return parsed.ok ? { ok: true } : { ok: false, error: `slack: ${parsed.error ?? 'error'}` };
          } catch {
            return { ok: true }; // 2xx but unparseable body — treat as delivered
          }
        }
        return { ok: false, error: `unsupported platform: ${origin.platform}` };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
