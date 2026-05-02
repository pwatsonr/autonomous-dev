/**
 * Channel-agnostic bug-modal field plan + payload builder
 * (SPEC-018-3-04 — multi-channel bug submission parity).
 *
 * Discord modals (text inputs + select), Slack Block Kit modals
 * (`plain_text_input` + `static_select`), and Claude App prompts all
 * collect the same field set in the same order. This module owns:
 *
 * 1. {@link BUG_MODAL_FIELDS} — declarative field list with per-channel
 *    rendering hints (paragraph vs single-line, optional vs required).
 * 2. {@link buildSubmitPayload} — builds the JSON body sent to the
 *    intake router. Asserts `bug_context` is present when
 *    `request_type === 'bug'` per the spec's local-validation rule.
 * 3. {@link parseModalSubmission} — converts the raw key/value object
 *    that Discord/Slack hand to their interaction handler into a
 *    {@link BugReport}. Handles `\n`-delimited multi-line fields
 *    (reproduction_steps, error_messages).
 *
 * The actual modal-opening + interaction-handler wiring lives in each
 * channel's own `*_interaction_handler.ts` (Discord) /
 * `*_command_handler.ts` (Slack). Those modules import from here.
 *
 * @module intake/adapters/bug_modal
 */

import type { BugReport, Severity } from '../types/bug-report';
import { SEVERITIES } from '../cli/bug-prompts';

/** Channel identifier appearing in the intake-router payload. */
export type SourceChannel = 'cli' | 'claude-app' | 'discord' | 'slack';

/** Priority sent to the intake router. */
export type Priority = 'high' | 'normal' | 'low';

/** Rendering hint used by channel-specific modal builders. */
export interface BugModalField {
  /** Dotted BugReport path (matches BUG_PROMPTS field in bug-prompts.ts). */
  field: string;
  /** Short label rendered in the modal (Discord/Slack-truncated to ~40 chars). */
  label: string;
  /** Single-line input vs multi-line/paragraph. */
  multiline: boolean;
  /** Required = modal blocks submission until populated. */
  required: boolean;
  /** When set, the channel-side renderer should present a select/dropdown. */
  choices?: readonly string[];
  /** Maximum length per the JSON schema. */
  maxLength?: number;
}

/**
 * Fields surfaced in modal-based bug submission. Order matches the CLI's
 * BUG_PROMPTS so the operator sees the same questions regardless of
 * channel. environment.os/runtime/version are NOT in modals — channels
 * default these to placeholder strings (per SPEC-018-3-04 Notes).
 */
export const BUG_MODAL_FIELDS: readonly BugModalField[] = [
  { field: 'title', label: 'Title', multiline: false, required: true, maxLength: 200 },
  { field: 'description', label: 'Description', multiline: true, required: true, maxLength: 4000 },
  { field: 'reproduction_steps', label: 'Reproduction steps (one per line)', multiline: true, required: true },
  { field: 'expected_behavior', label: 'Expected behavior', multiline: true, required: true, maxLength: 2000 },
  { field: 'actual_behavior', label: 'Actual behavior', multiline: true, required: true, maxLength: 2000 },
  { field: 'error_messages', label: 'Error messages (one per line)', multiline: true, required: false },
  { field: 'severity', label: 'Severity', multiline: false, required: false, choices: SEVERITIES },
];

/**
 * Default placeholder environment for channels that do not collect
 * environment.* via UI (Discord/Slack/Claude App). Operators refine
 * via a follow-up `/edit` command.
 */
export function placeholderEnvironment(channel: SourceChannel): {
  os: string;
  runtime: string;
  version: string;
} {
  return {
    os: `${channel}-submitter`,
    runtime: 'unknown',
    version: 'unknown',
  };
}

/** Raw field values harvested from a channel modal submission. */
export type ModalAnswers = Record<string, string | undefined>;

/**
 * Convert raw modal answers into a structured {@link BugReport}.
 *
 * - `reproduction_steps` and `error_messages` are split on `\n` and
 *   trimmed; empty lines dropped.
 * - Unknown fields are ignored.
 * - Missing fields surface later at AJV validation; this function does
 *   no validation itself.
 *
 * @param answers      Per-field values from the modal submission.
 * @param channel      Used to choose a placeholder environment block.
 * @param overrides    Per-channel forced values (e.g. severity for /hotfix).
 */
export function parseModalSubmission(
  answers: ModalAnswers,
  channel: SourceChannel,
  overrides: Partial<BugReport> = {},
): BugReport {
  const splitLines = (raw: string | undefined): string[] =>
    (raw ?? '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  const report: BugReport = {
    title: (answers.title ?? '').trim(),
    description: (answers.description ?? '').trim(),
    reproduction_steps: splitLines(answers.reproduction_steps),
    expected_behavior: (answers.expected_behavior ?? '').trim(),
    actual_behavior: (answers.actual_behavior ?? '').trim(),
    error_messages: splitLines(answers.error_messages),
    environment: placeholderEnvironment(channel),
  };

  if (answers.severity && SEVERITIES.includes(answers.severity as Severity)) {
    report.severity = answers.severity as Severity;
  }

  return { ...report, ...overrides };
}

/**
 * Payload posted to the intake-router HTTP endpoint by every channel
 * (CLI dispatches through its own router contract; Discord/Slack/Claude
 * App POST this body verbatim). Field set mirrors SPEC-018-3-04 §Shared
 * Contract.
 */
export interface SubmitPayload {
  request_type: 'feature' | 'bug' | 'infra' | 'refactor' | 'hotfix';
  description: string;
  bug_context?: BugReport;
  source_channel: SourceChannel;
  priority: Priority;
}

/**
 * Build a submit payload, enforcing the local pre-flight rule that
 * `bug_context` is mandatory whenever `request_type === 'bug'`. Throws
 * on violation with the spec's exact error message.
 */
export function buildSubmitPayload(args: {
  requestType: SubmitPayload['request_type'];
  description: string;
  bugContext?: BugReport;
  sourceChannel: SourceChannel;
  priority: Priority;
}): SubmitPayload {
  if (args.requestType === 'bug' && !args.bugContext) {
    throw new Error("bug_context required when request_type is 'bug'");
  }
  return {
    request_type: args.requestType,
    description: args.description,
    bug_context: args.bugContext,
    source_channel: args.sourceChannel,
    priority: args.priority,
  };
}
