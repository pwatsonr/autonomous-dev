/**
 * Command parsing and triage writeback tests (SPEC-007-5-6).
 *
 * Tests the notification receiver that processes incoming triage commands
 * from webhook responses and writes decisions back to observation files.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  setupTestDir,
  createMockObservation,
  readObservation,
} from '../helpers/mock-observations';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TriageCommand {
  observation_id: string;
  decision: 'promote' | 'dismiss' | 'defer' | 'investigate';
  actor: string;
  reason: string;
  defer_until?: string;
}

interface ParseResult {
  valid: boolean;
  command?: TriageCommand;
  error?: string;
}

// ---------------------------------------------------------------------------
// Command parser
// ---------------------------------------------------------------------------

/**
 * Parse a triage command from a notification callback.
 *
 * Expected format:
 *   /triage <observation_id> <decision> [reason]
 *
 * Example:
 *   /triage OBS-20260408-143022-a7f3 dismiss False positive from deploy
 */
function parseTriageCommand(
  text: string,
  actor: string,
): ParseResult {
  const trimmed = text.trim();

  // Match /triage command
  const match = trimmed.match(
    /^\/triage\s+(OBS-[\w-]+)\s+(promote|dismiss|defer|investigate)(?:\s+(.+))?$/i,
  );

  if (!match) {
    return {
      valid: false,
      error: 'Invalid triage command format. Expected: /triage <OBS-ID> <decision> [reason]',
    };
  }

  const [, observationId, decision, reason] = match;

  if (!reason || reason.trim().length === 0) {
    return {
      valid: false,
      error: 'Triage reason is required',
    };
  }

  return {
    valid: true,
    command: {
      observation_id: observationId,
      decision: decision.toLowerCase() as TriageCommand['decision'],
      actor,
      reason: reason.trim(),
    },
  };
}

/**
 * Process a triage decision by writing it back to the observation file.
 */
async function processTriageDecision(
  filePath: string,
  decision: {
    decision: string;
    actor: string;
    reason: string;
    timestamp?: string;
  },
): Promise<{ success: boolean; error?: string }> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) {
      return { success: false, error: 'No frontmatter found' };
    }

    const [, fmRaw, body] = match;
    const lines = fmRaw.split('\n');
    const updatedLines: string[] = [];
    const fieldsToUpdate: Record<string, string> = {
      triage_status: decision.decision === 'promote' ? 'promoted' :
                     decision.decision === 'dismiss' ? 'dismissed' :
                     decision.decision === 'defer' ? 'deferred' :
                     decision.decision === 'investigate' ? 'investigating' :
                     decision.decision,
      triage_decision: decision.decision,
      triage_by: decision.actor,
      triage_at: decision.timestamp ?? new Date().toISOString(),
      triage_reason: decision.reason,
    };
    const updatedKeys = new Set<string>();

    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const key = line.substring(0, colonIdx).trim();
        if (key in fieldsToUpdate) {
          const value = fieldsToUpdate[key];
          if (value.includes(':') || value.includes('#')) {
            updatedLines.push(`${key}: "${value}"`);
          } else {
            updatedLines.push(`${key}: ${value}`);
          }
          updatedKeys.add(key);
          continue;
        }
      }
      updatedLines.push(line);
    }

    // Add any fields not present in original frontmatter
    for (const [key, value] of Object.entries(fieldsToUpdate)) {
      if (!updatedKeys.has(key)) {
        if (value.includes(':') || value.includes('#')) {
          updatedLines.push(`${key}: "${value}"`);
        } else {
          updatedLines.push(`${key}: ${value}`);
        }
      }
    }

    const newContent = `---\n${updatedLines.join('\n')}\n---\n${body}`;
    await fs.writeFile(filePath, newContent, 'utf-8');

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseTriageCommand', () => {
  test('parses valid dismiss command', () => {
    const result = parseTriageCommand(
      '/triage OBS-20260408-143022-a7f3 dismiss False positive from deploy artifact',
      'pm-lead',
    );
    expect(result.valid).toBe(true);
    expect(result.command!.observation_id).toBe('OBS-20260408-143022-a7f3');
    expect(result.command!.decision).toBe('dismiss');
    expect(result.command!.actor).toBe('pm-lead');
    expect(result.command!.reason).toBe('False positive from deploy artifact');
  });

  test('parses valid promote command', () => {
    const result = parseTriageCommand(
      '/triage OBS-20260408-143022-a7f3 promote Connection pool issue confirmed',
      'eng-lead',
    );
    expect(result.valid).toBe(true);
    expect(result.command!.decision).toBe('promote');
  });

  test('parses valid defer command', () => {
    const result = parseTriageCommand(
      '/triage OBS-20260408-143022-a7f3 defer Waiting for next sprint',
      'pm-lead',
    );
    expect(result.valid).toBe(true);
    expect(result.command!.decision).toBe('defer');
  });

  test('parses valid investigate command', () => {
    const result = parseTriageCommand(
      '/triage OBS-20260408-143022-a7f3 investigate Need more data',
      'sre',
    );
    expect(result.valid).toBe(true);
    expect(result.command!.decision).toBe('investigate');
  });

  test('rejects invalid command format', () => {
    const result = parseTriageCommand('hello world', 'pm-lead');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid triage command format');
  });

  test('rejects missing reason', () => {
    const result = parseTriageCommand('/triage OBS-123 dismiss', 'pm-lead');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('reason is required');
  });

  test('rejects invalid decision', () => {
    const result = parseTriageCommand(
      '/triage OBS-123 yolo Some reason',
      'pm-lead',
    );
    expect(result.valid).toBe(false);
  });

  test('is case-insensitive for decision', () => {
    const result = parseTriageCommand(
      '/triage OBS-20260408-143022-a7f3 DISMISS Noise',
      'pm-lead',
    );
    expect(result.valid).toBe(true);
    expect(result.command!.decision).toBe('dismiss');
  });
});

describe('processTriageDecision', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await setupTestDir();
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  test('writes triage decision to observation frontmatter', async () => {
    const obs = await createMockObservation(rootDir, {
      id: 'OBS-20260408-143000-tr01',
      triage_status: 'pending',
      triage_decision: null,
    });

    const result = await processTriageDecision(obs.filePath, {
      decision: 'promote',
      actor: 'pm-lead',
      reason: 'Connection pool issue confirmed',
      timestamp: '2026-04-08T15:00:00Z',
    });

    expect(result.success).toBe(true);

    const updated = await readObservation(rootDir, obs.id);
    expect(updated.triage_decision).toBe('promote');
    expect(updated.triage_by).toBe('pm-lead');
    expect(updated.triage_status).toBe('promoted');
  });

  test('writes dismiss decision correctly', async () => {
    const obs = await createMockObservation(rootDir, {
      id: 'OBS-20260408-143000-tr02',
      triage_status: 'promoted',
      triage_decision: 'promote',
      triage_by: 'auto-promote-engine',
    });

    const result = await processTriageDecision(obs.filePath, {
      decision: 'dismiss',
      actor: 'pm-lead',
      reason: 'False positive, metric spike was a deploy artifact',
      timestamp: '2026-04-08T16:00:00Z',
    });

    expect(result.success).toBe(true);

    const updated = await readObservation(rootDir, obs.id);
    expect(updated.triage_decision).toBe('dismiss');
    expect(updated.triage_by).toBe('pm-lead');
    expect(updated.triage_status).toBe('dismissed');
  });

  test('preserves other frontmatter fields', async () => {
    const obs = await createMockObservation(rootDir, {
      id: 'OBS-20260408-143000-tr03',
      service: 'api-gateway',
      severity: 'P0',
      confidence: 0.95,
    });

    await processTriageDecision(obs.filePath, {
      decision: 'promote',
      actor: 'pm-lead',
      reason: 'Confirmed',
      timestamp: '2026-04-08T15:00:00Z',
    });

    const updated = await readObservation(rootDir, obs.id);
    expect(updated.service).toBe('api-gateway');
    expect(updated.severity).toBe('P0');
  });
});
