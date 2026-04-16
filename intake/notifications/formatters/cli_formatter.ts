/**
 * CLI Notification Formatter.
 *
 * Renders status information using ANSI escape codes with box-drawing
 * characters, color-coded phases, and progress bars. Returns both
 * ANSI-formatted and plain-text fallback versions of every message.
 *
 * Implements SPEC-008-2-03, Task 5.
 *
 * @module cli_formatter
 */

import type { RequestEntity } from '../../db/repository';
import type {
  FormattedMessage,
  ErrorResponse,
  Priority,
  RequestStatus,
} from '../../adapters/adapter_interface';

// ---------------------------------------------------------------------------
// ANSI escape codes
// ---------------------------------------------------------------------------

export const ANSI = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  green:   '\x1b[32m',
  blue:    '\x1b[34m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  gray:    '\x1b[90m',
};

// ---------------------------------------------------------------------------
// Pipeline phase type and color mapping
// ---------------------------------------------------------------------------

/** Pipeline phases traversed by a request. */
export type PipelinePhase =
  | 'queued'
  | 'prd_generation'
  | 'prd_review'
  | 'tdd_generation'
  | 'tdd_review'
  | 'planning'
  | 'spec'
  | 'execution'
  | 'code_review'
  | 'done'
  | 'merged'
  | 'paused'
  | 'cancelled'
  | 'failed';

/** Ordered list of pipeline phases for progress computation. */
const PHASE_ORDER: PipelinePhase[] = [
  'queued',
  'prd_generation',
  'prd_review',
  'tdd_generation',
  'tdd_review',
  'planning',
  'spec',
  'execution',
];

/**
 * Map pipeline phases to their ANSI color codes.
 */
export const PHASE_COLORS: Record<PipelinePhase, string> = {
  queued:         ANSI.gray,
  prd_generation: ANSI.blue,
  prd_review:     ANSI.yellow,
  tdd_generation: ANSI.blue,
  tdd_review:     ANSI.yellow,
  planning:       ANSI.magenta,
  spec:           ANSI.magenta,
  execution:      ANSI.green,
  code_review:    ANSI.yellow,
  done:           ANSI.green,
  merged:         ANSI.green,
  paused:         ANSI.yellow,
  cancelled:      ANSI.red,
  failed:         ANSI.red,
};

// ---------------------------------------------------------------------------
// Phase transition event interface
// ---------------------------------------------------------------------------

/**
 * Metadata attached to a phase transition event.
 */
export interface PhaseTransitionMetadata {
  progress?: { current: number; total: number };
  artifactUrl?: string;
  blocker?: string;
  agentReasoning?: string;
}

/**
 * Event emitted when a request transitions between pipeline phases.
 */
export interface PhaseTransitionEvent {
  requestId: string;
  fromPhase: string;
  toPhase: string;
  timestamp: Date;
  metadata: PhaseTransitionMetadata;
}

// ---------------------------------------------------------------------------
// Digest data interface (intake-layer variant)
// ---------------------------------------------------------------------------

/**
 * Aggregated digest data for the daily pipeline summary.
 */
export interface DigestData {
  generatedAt: Date;
  activeByState: Record<RequestStatus, number>;
  blockedRequests: RequestEntity[];
  completedLast24h: RequestEntity[];
  queueDepth: number;
  queueDepthByPriority: Record<Priority, number>;
}

// ---------------------------------------------------------------------------
// NotificationFormatter interface
// ---------------------------------------------------------------------------

/**
 * Formatter contract for rendering notification content.
 */
export interface NotificationFormatter {
  formatStatusCard(request: RequestEntity): FormattedMessage;
  formatPhaseTransition(request: RequestEntity, event: PhaseTransitionEvent): FormattedMessage;
  formatDigest(digest: DigestData): FormattedMessage;
  formatError(error: ErrorResponse): FormattedMessage;
}

// ---------------------------------------------------------------------------
// Helper: progress bar rendering
// ---------------------------------------------------------------------------

/**
 * Render a text-based progress bar using block characters.
 *
 * @param current - Current step (0-based or 1-based, depending on caller).
 * @param total   - Total number of steps.
 * @param width   - Character width of the bar (default 16).
 * @returns A string like "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591 50%".
 */
export function renderProgressBar(current: number, total: number, width: number = 16): string {
  const fraction = total > 0 ? current / total : 0;
  const filled = Math.round(fraction * width);
  const empty = width - filled;
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
  const pct = Math.round(fraction * 100);
  return `${bar} ${pct}%`;
}

// ---------------------------------------------------------------------------
// Helper: duration formatting
// ---------------------------------------------------------------------------

/**
 * Format a millisecond duration into a human-readable string.
 *
 * @param ms - Duration in milliseconds.
 * @returns Formatted string, e.g. "2h 14m", "0m", "1d 3h".
 */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${remainMinutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

// ---------------------------------------------------------------------------
// Helper: strip ANSI escape codes
// ---------------------------------------------------------------------------

/**
 * Remove all ANSI escape sequences from a string.
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

// ---------------------------------------------------------------------------
// Helper: phase index for progress
// ---------------------------------------------------------------------------

/**
 * Return the 1-based index of a phase in the ordered pipeline,
 * and the total number of phases.
 */
function phaseProgress(phase: string): { current: number; total: number } {
  const total = PHASE_ORDER.length;
  const idx = PHASE_ORDER.indexOf(phase as PipelinePhase);
  if (idx === -1) {
    // Terminal or unknown phase -- show as complete
    return { current: total, total };
  }
  return { current: idx + 1, total };
}

// ---------------------------------------------------------------------------
// Helper: human-readable phase label
// ---------------------------------------------------------------------------

/**
 * Convert a snake_case phase name to a Title Case label.
 */
function phaseLabel(phase: string): string {
  return phase
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Helper: build a box-drawing card
// ---------------------------------------------------------------------------

const BOX_WIDTH = 45; // inner content width (between the vertical bars)

/**
 * Pad or truncate a line to exactly `BOX_WIDTH` characters.
 */
function padLine(text: string, width: number = BOX_WIDTH): string {
  const plainLen = stripAnsi(text).length;
  if (plainLen >= width) return text;
  return text + ' '.repeat(width - plainLen);
}

/**
 * Build a box-drawing card from an array of content lines.
 *
 * @param headerLines - Lines for the header section (above the separator).
 * @param bodyLines   - Lines for the body section (below the separator).
 * @returns The complete box as a single string.
 */
function buildBox(headerLines: string[], bodyLines: string[]): string {
  const top    = '\u250c' + '\u2500'.repeat(BOX_WIDTH) + '\u2510';
  const sep    = '\u251c' + '\u2500'.repeat(BOX_WIDTH) + '\u2524';
  const bottom = '\u2514' + '\u2500'.repeat(BOX_WIDTH) + '\u2518';

  const lines: string[] = [top];

  for (const line of headerLines) {
    lines.push('\u2502' + padLine(line) + '\u2502');
  }

  lines.push(sep);

  for (const line of bodyLines) {
    lines.push('\u2502' + padLine(line) + '\u2502');
  }

  lines.push(bottom);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helper: parse phase_progress JSON
// ---------------------------------------------------------------------------

interface PhaseProgressData {
  current: number;
  total: number;
}

function parsePhaseProgress(phaseProgress: string | null): PhaseProgressData | null {
  if (!phaseProgress) return null;
  try {
    const parsed = JSON.parse(phaseProgress);
    if (typeof parsed.current === 'number' && typeof parsed.total === 'number') {
      return parsed as PhaseProgressData;
    }
  } catch {
    // Not valid JSON -- ignore
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helper: compute artifact links from request
// ---------------------------------------------------------------------------

interface ArtifactInfo {
  prdPr?: string;
  tddPr?: string;
  codePr?: string;
}

function extractArtifacts(request: RequestEntity): ArtifactInfo {
  // Artifacts may be stored in the notification_config or elsewhere.
  // For now, try to parse from notification_config which may contain artifact URLs.
  try {
    const config = JSON.parse(request.notification_config);
    return {
      prdPr: config.prdPr,
      tddPr: config.tddPr,
      codePr: config.codePr,
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// CLIFormatter
// ---------------------------------------------------------------------------

/**
 * CLI notification formatter that produces ANSI-colored, box-drawn
 * terminal output alongside plain-text fallbacks.
 *
 * Implements the {@link NotificationFormatter} interface for the
 * `claude_app` channel type.
 */
export class CLIFormatter implements NotificationFormatter {
  // -----------------------------------------------------------------------
  // formatStatusCard
  // -----------------------------------------------------------------------

  /**
   * Render a full status card for a request.
   *
   * Produces a box-drawing card with the request ID, title, phase,
   * progress bar, priority, age, blocker status, and artifact links.
   */
  formatStatusCard(request: RequestEntity): FormattedMessage {
    const phase = request.current_phase;
    const phaseColor = PHASE_COLORS[phase as PipelinePhase] ?? ANSI.gray;

    // Phase progress
    const progressData = parsePhaseProgress(request.phase_progress);
    const { current: phaseCurrent, total: phaseTotal } = progressData
      ? { current: progressData.current, total: progressData.total }
      : phaseProgress(phase);

    // Age
    const ageMs = Date.now() - new Date(request.created_at).getTime();
    const ageStr = formatDuration(ageMs);

    // Blocker
    const blockerStr = request.blocker ?? 'None';

    // Artifacts
    const artifacts = extractArtifacts(request);

    // Header
    const headerLines = [
      `  ${ANSI.bold}${request.request_id}${ANSI.reset}  ${request.title}`,
    ];

    // Body
    const bodyLines = [
      `  Phase:    ${phaseColor}${phaseLabel(phase)} (${phaseCurrent}/${phaseTotal})${ANSI.reset}`,
      `  Progress: ${renderProgressBar(phaseCurrent, phaseTotal)}`,
      `  Priority: ${request.priority}`,
      `  Age:      ${ageStr}`,
      `  Blocker:  ${blockerStr}`,
      `  Artifacts:`,
    ];

    if (artifacts.prdPr) {
      bodyLines.push(`    PRD PR: ${artifacts.prdPr}`);
    } else {
      const prdPhaseIdx = PHASE_ORDER.indexOf('prd_generation');
      const currentIdx = PHASE_ORDER.indexOf(phase as PipelinePhase);
      if (currentIdx > prdPhaseIdx && prdPhaseIdx !== -1) {
        bodyLines.push(`    PRD PR: (completed)`);
      } else {
        bodyLines.push(`    PRD PR: (pending)`);
      }
    }

    if (artifacts.tddPr) {
      bodyLines.push(`    TDD PR: ${artifacts.tddPr}`);
    } else {
      const tddPhaseIdx = PHASE_ORDER.indexOf('tdd_generation');
      const currentIdx = PHASE_ORDER.indexOf(phase as PipelinePhase);
      if (currentIdx > tddPhaseIdx && tddPhaseIdx !== -1) {
        bodyLines.push(`    TDD PR: (completed)`);
      } else if (phase === 'tdd_generation') {
        bodyLines.push(`    TDD PR: (in progress)`);
      } else {
        bodyLines.push(`    TDD PR: (pending)`);
      }
    }

    if (artifacts.codePr) {
      bodyLines.push(`    Code PR: ${artifacts.codePr}`);
    }

    const ansiOutput = buildBox(headerLines, bodyLines);
    const fallbackText = stripAnsi(ansiOutput);

    return {
      channelType: 'claude_app',
      payload: ansiOutput,
      fallbackText,
    };
  }

  // -----------------------------------------------------------------------
  // formatPhaseTransition
  // -----------------------------------------------------------------------

  /**
   * Render a compact phase-transition notification.
   */
  formatPhaseTransition(
    request: RequestEntity,
    event: PhaseTransitionEvent,
  ): FormattedMessage {
    const fromColor = PHASE_COLORS[event.fromPhase as PipelinePhase] ?? ANSI.gray;
    const toColor = PHASE_COLORS[event.toPhase as PipelinePhase] ?? ANSI.gray;

    const progressInfo = event.metadata.progress
      ? ` (${event.metadata.progress.current}/${event.metadata.progress.total})`
      : '';

    const blockerInfo = event.metadata.blocker
      ? `\n  Blocker: ${ANSI.red}${event.metadata.blocker}${ANSI.reset}`
      : '';

    const artifactInfo = event.metadata.artifactUrl
      ? `\n  Artifact: ${event.metadata.artifactUrl}`
      : '';

    const ansiOutput = [
      `${ANSI.bold}[${request.request_id}]${ANSI.reset} Phase transition:`,
      `  ${fromColor}${phaseLabel(event.fromPhase)}${ANSI.reset} \u2192 ${toColor}${phaseLabel(event.toPhase)}${ANSI.reset}${progressInfo}`,
      `  ${request.title}${blockerInfo}${artifactInfo}`,
    ].join('\n');

    const fallbackText = stripAnsi(ansiOutput);

    return {
      channelType: 'claude_app',
      payload: ansiOutput,
      fallbackText,
    };
  }

  // -----------------------------------------------------------------------
  // formatDigest
  // -----------------------------------------------------------------------

  /**
   * Render a daily pipeline digest summary.
   */
  formatDigest(digest: DigestData): FormattedMessage {
    const dateStr = digest.generatedAt.toISOString().replace('T', ' ').slice(0, 16);
    const lines: string[] = [];

    lines.push(`=== Daily Pipeline Digest (${dateStr}) ===`);
    lines.push('');

    // Active Requests
    const totalActive =
      (digest.activeByState.queued ?? 0) +
      (digest.activeByState.active ?? 0) +
      (digest.activeByState.paused ?? 0);

    lines.push('Active Requests:');
    lines.push(
      `  Queued:    ${digest.activeByState.queued ?? 0}  ` +
        `(high: ${digest.queueDepthByPriority.high ?? 0}, ` +
        `normal: ${digest.queueDepthByPriority.normal ?? 0}, ` +
        `low: ${digest.queueDepthByPriority.low ?? 0})`,
    );
    lines.push(`  Active:    ${digest.activeByState.active ?? 0}`);
    lines.push(`  Paused:    ${digest.activeByState.paused ?? 0}`);
    lines.push(`  Total:     ${totalActive}`);

    // Blocked Requests
    if (digest.blockedRequests.length > 0) {
      lines.push('');
      lines.push('Blocked Requests:');
      for (const req of digest.blockedRequests) {
        const ageMs = Date.now() - new Date(req.created_at).getTime();
        lines.push(
          `  ${req.request_id}: ${req.blocker ?? 'Unknown blocker'} (${req.status}, ${formatDuration(ageMs)})`,
        );
      }
    }

    // Completed (last 24h)
    if (digest.completedLast24h.length > 0) {
      lines.push('');
      lines.push('Completed (last 24h):');
      for (const req of digest.completedLast24h) {
        const durationMs =
          new Date(req.updated_at).getTime() - new Date(req.created_at).getTime();
        lines.push(
          `  ${req.request_id}: ${req.title} (${req.status}, ${formatDuration(durationMs)} total)`,
        );
      }
    }

    // Queue Depth
    lines.push('');
    lines.push(`Queue Depth: ${digest.queueDepth}`);

    const text = lines.join('\n');

    return {
      channelType: 'claude_app',
      payload: text,
      fallbackText: text,
    };
  }

  // -----------------------------------------------------------------------
  // formatError
  // -----------------------------------------------------------------------

  /**
   * Render an error notification.
   */
  formatError(error: ErrorResponse): FormattedMessage {
    const ansiOutput = [
      `${ANSI.red}${ANSI.bold}Error [${error.errorCode}]${ANSI.reset}`,
      `${ANSI.red}${error.error}${ANSI.reset}`,
    ];

    if (error.retryAfterMs !== undefined) {
      ansiOutput.push(
        `${ANSI.dim}Retry after: ${formatDuration(error.retryAfterMs)}${ANSI.reset}`,
      );
    }

    if (error.details) {
      ansiOutput.push(
        `${ANSI.dim}Details: ${JSON.stringify(error.details)}${ANSI.reset}`,
      );
    }

    const payload = ansiOutput.join('\n');
    const fallbackText = stripAnsi(payload);

    return {
      channelType: 'claude_app',
      payload,
      fallbackText,
    };
  }
}
