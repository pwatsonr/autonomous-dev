/**
 * Operator Override Window Manager (SPEC-005-5-3, Task 6).
 *
 * Tracks post-promotion override periods for autonomously promoted agents.
 * After an autonomous patch-level promotion, a configurable window (default
 * 24 hours) opens during which the operator can roll back the promotion.
 *
 * Persistence: `data/override-windows.json`
 *
 * Behaviour:
 *   - Window opens immediately after autonomous promotion.
 *   - Duration: configurable via `config.autonomousPromotion.overrideHours` (default 24).
 *   - During the window, operator can run `agent rollback <name>` to undo.
 *   - If rollback occurs during window: status set to `used`.
 *   - When window expires: log `override_window_expired` event.
 *
 * Exports: `OverrideWindowManager`, `OverrideWindow`
 */

import * as fs from 'fs';
import * as path from 'path';

import type { AgentFactoryConfig } from '../config';
import type { AuditLogger } from '../audit';

// ---------------------------------------------------------------------------
// OverrideWindow
// ---------------------------------------------------------------------------

/** Represents a single override window for an agent. */
export interface OverrideWindow {
  agent_name: string;
  version: string;
  commit_hash: string;
  opened_at: string;                // ISO 8601
  expires_at: string;               // ISO 8601 (opened_at + override_hours)
  status: 'open' | 'expired' | 'used';
}

// ---------------------------------------------------------------------------
// Persistence schema
// ---------------------------------------------------------------------------

interface PersistedWindowState {
  windows: Record<string, OverrideWindow>;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logOverrideEvent(eventType: string, details: Record<string, unknown>): void {
  const event = {
    timestamp: new Date().toISOString(),
    eventType,
    ...details,
  };
  process.stderr.write(`[OVERRIDE_WINDOW] ${JSON.stringify(event)}\n`);
}

// ---------------------------------------------------------------------------
// OverrideWindowManager
// ---------------------------------------------------------------------------

/**
 * Manages post-promotion override windows for autonomously promoted agents.
 *
 * Usage:
 * ```ts
 * const manager = new OverrideWindowManager(config, auditLogger, 'data/override-windows.json');
 * const window = manager.openWindow('code-author', '1.0.2', 'abc123');
 * if (manager.isWindowOpen('code-author')) {
 *   // operator can still roll back
 * }
 * manager.checkExpiry(); // close expired windows
 * ```
 */
export class OverrideWindowManager {
  private readonly overrideHours: number;
  private readonly auditLogger: AuditLogger;
  private readonly statePath: string;

  /** In-memory window state keyed by agent name. */
  private readonly windows: Map<string, OverrideWindow> = new Map();

  constructor(
    config: AgentFactoryConfig,
    auditLogger: AuditLogger,
    statePath?: string,
  ) {
    this.overrideHours = config.autonomousPromotion?.overrideHours ?? 24;
    this.auditLogger = auditLogger;
    this.statePath = statePath
      ? path.resolve(statePath)
      : path.resolve('data/override-windows.json');

    this.loadState();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Open a new override window for an agent after autonomous promotion.
   *
   * If a previous window exists for this agent, it is replaced.
   *
   * @param agentName   The name of the promoted agent.
   * @param version     The newly promoted version.
   * @param commitHash  The git commit hash of the promotion.
   * @returns           The newly created OverrideWindow.
   */
  openWindow(agentName: string, version: string, commitHash: string): OverrideWindow {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.overrideHours * 60 * 60 * 1000);

    const window: OverrideWindow = {
      agent_name: agentName,
      version,
      commit_hash: commitHash,
      opened_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      status: 'open',
    };

    this.windows.set(agentName, window);
    this.persistState();

    this.auditLogger.log({
      timestamp: now.toISOString(),
      event_type: 'override_window_opened',
      agent_name: agentName,
      details: {
        version,
        commitHash,
        expiresAt: expiresAt.toISOString(),
        overrideHours: this.overrideHours,
      },
    });

    logOverrideEvent('override_window_opened', {
      agentName,
      version,
      commitHash,
      expiresAt: expiresAt.toISOString(),
    });

    return window;
  }

  /**
   * Get the active (open) override window for an agent, or null if none exists.
   *
   * Returns null if the window has already expired or been used.
   */
  getActiveWindow(agentName: string): OverrideWindow | null {
    const window = this.windows.get(agentName);
    if (!window) return null;
    if (window.status !== 'open') return null;

    // Check if expired
    if (new Date(window.expires_at) <= new Date()) {
      this.closeWindow(agentName, 'expired');
      return null;
    }

    return window;
  }

  /**
   * Check whether an override window is currently open for an agent.
   */
  isWindowOpen(agentName: string): boolean {
    return this.getActiveWindow(agentName) !== null;
  }

  /**
   * Close an override window with the specified reason.
   *
   * @param agentName  The agent whose window to close.
   * @param reason     Why the window is closing: 'expired' or 'used' (rollback).
   */
  closeWindow(agentName: string, reason: 'expired' | 'used'): void {
    const window = this.windows.get(agentName);
    if (!window) return;
    if (window.status !== 'open') return;

    window.status = reason;
    this.persistState();

    const eventType = reason === 'expired'
      ? 'override_window_expired'
      : 'override_window_used';

    this.auditLogger.log({
      timestamp: new Date().toISOString(),
      event_type: eventType,
      agent_name: agentName,
      details: {
        version: window.version,
        commitHash: window.commit_hash,
        openedAt: window.opened_at,
        closedReason: reason,
      },
    });

    logOverrideEvent(eventType, {
      agentName,
      version: window.version,
      reason,
    });
  }

  /**
   * Check all open windows for expiry and close any that have passed their
   * expiration time.
   *
   * Should be called periodically (e.g., on a timer or before promotion checks).
   */
  checkExpiry(): void {
    const now = new Date();

    for (const [agentName, window] of this.windows) {
      if (window.status !== 'open') continue;

      if (new Date(window.expires_at) <= now) {
        this.closeWindow(agentName, 'expired');
      }
    }
  }

  /**
   * Get all override windows (for diagnostics/CLI display).
   */
  getAllWindows(): OverrideWindow[] {
    return Array.from(this.windows.values());
  }

  /**
   * Get the window for an agent regardless of status (for diagnostics).
   */
  getWindow(agentName: string): OverrideWindow | null {
    return this.windows.get(agentName) ?? null;
  }

  // -------------------------------------------------------------------------
  // Private: persistence
  // -------------------------------------------------------------------------

  private loadState(): void {
    if (!fs.existsSync(this.statePath)) {
      return;
    }

    try {
      const raw = fs.readFileSync(this.statePath, 'utf-8');
      const persisted = JSON.parse(raw) as PersistedWindowState;

      if (persisted.windows && typeof persisted.windows === 'object') {
        for (const [name, window] of Object.entries(persisted.windows)) {
          this.windows.set(name, window);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logOverrideEvent('state_load_failed', { error: message });
    }
  }

  private persistState(): void {
    const dir = path.dirname(this.statePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const persisted: PersistedWindowState = { windows: {} };
    for (const [name, window] of this.windows) {
      persisted.windows[name] = window;
    }

    try {
      fs.writeFileSync(
        this.statePath,
        JSON.stringify(persisted, null, 2) + '\n',
        { encoding: 'utf-8' },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logOverrideEvent('state_persist_failed', { error: message });
    }
  }
}
