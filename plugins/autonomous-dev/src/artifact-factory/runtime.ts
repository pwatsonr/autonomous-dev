/**
 * Artifact-factory model runtime (ONBOARD Phase 2 — #590, P2.5).
 *
 * A tiny injected interface so generation + meta-review are unit-testable with a
 * fake (no live model). The real adapter reuses the agent-factory's headless
 * `claude` CLI invoker (`claudeInvoke`) — the same wiring the analyzer/proposer/
 * meta-reviewer use — so there is one model-invocation path, configured by the
 * same env vars.
 */

import { claudeInvoke } from '../agent-factory/improvement/claude-runtime';

export interface ArtifactRuntime {
  /** Invoke the model with a user prompt + optional system prompt; returns raw text. */
  generate(userPrompt: string, systemPrompt?: string): Promise<string>;
}

/** Real runtime: drives the model via the headless `claude` CLI. */
export function claudeArtifactRuntime(model?: string): ArtifactRuntime {
  return {
    async generate(userPrompt: string, systemPrompt?: string): Promise<string> {
      return claudeInvoke(systemPrompt, userPrompt, model);
    },
  };
}
