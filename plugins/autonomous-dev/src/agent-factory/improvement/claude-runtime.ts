/**
 * Real Claude-backed runtime + LLM invoker for the agent-factory improvement
 * subsystem (issue #576).
 *
 * Production previously had NO live model wiring for self-improvement:
 * `AgentRuntime.invoke()` (runtime.ts) is a hooks / tool-access enforcement
 * shell that returns `output: undefined`, and no `LLMInvoker` implementation
 * existed outside tests. As a result `PerformanceAnalyzer` (analyst),
 * `ProposalGenerator` (proposer), and `MetaReviewOrchestrator` (meta-reviewer)
 * could only run against mocked runtimes.
 *
 * This module supplies the missing layer by driving the agent through the
 * `claude` CLI in headless print mode (`claude -p`), reading the prompt from
 * stdin and applying the agent's own system prompt via
 * `--append-system-prompt-file`. The binary, model mapping, and timeout are
 * configurable via env vars so the same wiring works from the daemon, the
 * portal, or an operator shell.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { AgentRecord, RuntimeContext, RuntimeResult } from '../types';
import type { AgentRuntime } from '../runtime';
import type { LLMInvoker } from './proposer';

const CLAUDE_BIN = process.env.AUTONOMOUS_DEV_CLAUDE_BIN || 'claude';
const CLAUDE_TIMEOUT_MS = Number(process.env.AUTONOMOUS_DEV_CLAUDE_TIMEOUT_MS || 240_000);

/** Map a stored model id (e.g. `claude-opus-4-7`) to a CLI alias. */
function mapModel(model?: string): string | undefined {
  if (!model) return undefined;
  const s = model.toLowerCase();
  if (s.includes('opus')) return 'opus';
  if (s.includes('sonnet')) return 'sonnet';
  if (s.includes('haiku')) return 'haiku';
  return undefined;
}

/**
 * Invoke the `claude` CLI in headless print mode and return its stdout text.
 * The user prompt is passed on stdin (no ARG_MAX limit); the optional system
 * prompt is written to a temp file and applied with `--append-system-prompt-file`.
 */
export function claudeInvoke(
  systemPrompt: string | undefined,
  userPrompt: string,
  model?: string,
): string {
  const args = ['-p'];
  let sysFile: string | undefined;
  if (systemPrompt && systemPrompt.trim().length > 0) {
    sysFile = path.join(os.tmpdir(), `adf-sys-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(sysFile, systemPrompt, 'utf-8');
    args.push('--append-system-prompt-file', sysFile);
  }
  const alias = mapModel(model);
  if (alias) args.push('--model', alias);
  try {
    return execFileSync(CLAUDE_BIN, args, {
      input: userPrompt,
      encoding: 'utf-8',
      timeout: CLAUDE_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
  } finally {
    if (sysFile) {
      try {
        fs.unlinkSync(sysFile);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

/** A real agent runtime that drives the agent via the headless `claude` CLI. */
class ClaudeAgentRuntime {
  constructor(private readonly record: AgentRecord) {}

  async invoke(input: string, _ctx: RuntimeContext): Promise<RuntimeResult> {
    const start = Date.now();
    try {
      const output = claudeInvoke(
        input ? this.record.agent.system_prompt : undefined,
        input,
        this.record.agent.model,
      );
      return {
        success: output.trim().length > 0,
        output,
        toolCallsBlocked: 0,
        toolCallsAllowed: 0,
        duration_ms: Date.now() - start,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: message,
        toolCallsBlocked: 0,
        toolCallsAllowed: 0,
        duration_ms: Date.now() - start,
      };
    }
  }
}

/**
 * `createRuntime` factory for `PerformanceAnalyzer` and
 * `MetaReviewOrchestrator`. Returns a runtime whose `invoke()` actually calls
 * the model (unlike the stub `AgentRuntime.invoke()`).
 */
export function createClaudeRuntime(agent: AgentRecord): AgentRuntime {
  return new ClaudeAgentRuntime(agent) as unknown as AgentRuntime;
}

/** Real `LLMInvoker` for `ProposalGenerator`. */
export class ClaudeLLMInvoker implements LLMInvoker {
  async invoke(prompt: string, model: string): Promise<string> {
    return claudeInvoke(undefined, prompt, model);
  }
}
