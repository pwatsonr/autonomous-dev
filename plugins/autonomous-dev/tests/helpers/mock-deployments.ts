/**
 * Factory functions for creating test deployment metadata (SPEC-007-5-6).
 *
 * Deployments represent fixes that were deployed in response to promoted
 * observations. They are used by the cooldown and effectiveness evaluators.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { FixDeployment, DeploymentInfo } from '../../src/governance/types';

// ---------------------------------------------------------------------------
// In-memory deployment store
// ---------------------------------------------------------------------------

/**
 * Simple in-memory deployment registry for tests.
 * Provides lookup by deployment ID.
 */
export class MockDeploymentStore {
  private deployments: Map<string, FixDeployment> = new Map();

  add(deployment: FixDeployment): void {
    this.deployments.set(deployment.id, deployment);
  }

  get(id: string): FixDeployment | null {
    return this.deployments.get(id) ?? null;
  }

  getDeploymentInfo(id: string): DeploymentInfo | null {
    const d = this.deployments.get(id);
    if (!d) return null;
    return { id: d.id, deployed_at: d.deployed_at };
  }

  clear(): void {
    this.deployments.clear();
  }
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * Create a mock FixDeployment with sensible defaults.
 */
export function mockDeployment(
  deployedAt: string,
  overrides: Partial<FixDeployment> = {},
): FixDeployment {
  return {
    id: overrides.id ?? `DEPLOY-${Date.now().toString(36)}`,
    deployed_at: deployedAt,
    observation_id: overrides.observation_id ?? 'OBS-mock',
    service: overrides.service ?? 'api-gateway',
    error_class: overrides.error_class ?? 'ConnectionPoolExhausted',
    ...overrides,
  };
}

/**
 * Create a mock DeploymentInfo (minimal deployment reference).
 */
export function mockDeploymentInfo(
  deployedAt: string,
  id?: string,
): DeploymentInfo {
  return {
    id: id ?? `DEPLOY-${Date.now().toString(36)}`,
    deployed_at: deployedAt,
  };
}

// ---------------------------------------------------------------------------
// File-based deployment metadata
// ---------------------------------------------------------------------------

/**
 * Write a mock deployment metadata file to disk.
 * Used by integration tests that scan the file system.
 */
export async function createMockDeployment(
  rootDir: string,
  deploymentId: string,
  deployedAt: string,
  overrides: Partial<FixDeployment> = {},
): Promise<FixDeployment> {
  const deployment: FixDeployment = {
    id: deploymentId,
    deployed_at: deployedAt,
    observation_id: overrides.observation_id ?? 'OBS-mock',
    service: overrides.service ?? 'api-gateway',
    error_class: overrides.error_class ?? 'ConnectionPoolExhausted',
    ...overrides,
  };

  const deployDir = path.join(rootDir, '.autonomous-dev', 'deployments');
  await fs.mkdir(deployDir, { recursive: true });

  const content = [
    '---',
    `id: ${deployment.id}`,
    `deployed_at: ${deployment.deployed_at}`,
    `observation_id: ${deployment.observation_id}`,
    `service: ${deployment.service}`,
    `error_class: ${deployment.error_class}`,
    '---',
    '',
    `# Deployment: ${deployment.id}`,
    '',
    'Mock deployment metadata for testing.',
    '',
  ].join('\n');

  const filePath = path.join(deployDir, `${deploymentId}.md`);
  await fs.writeFile(filePath, content, 'utf-8');

  return deployment;
}

/**
 * Read a mock deployment from disk by ID.
 */
export async function readMockDeployment(
  rootDir: string,
  deploymentId: string,
): Promise<FixDeployment | null> {
  const filePath = path.join(rootDir, '.autonomous-dev', 'deployments', `${deploymentId}.md`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;

    const result: Record<string, string> = {};
    for (const line of match[1].split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.substring(0, colonIdx).trim();
      const value = line.substring(colonIdx + 1).trim();
      result[key] = value;
    }

    return {
      id: result.id ?? deploymentId,
      deployed_at: result.deployed_at ?? '',
      observation_id: result.observation_id ?? '',
      service: result.service ?? '',
      error_class: result.error_class ?? '',
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Override scheduling helpers (for auto-promote override tests)
// ---------------------------------------------------------------------------

/**
 * Schedule a mock override check for an auto-promoted observation.
 * Creates a JSON file in the overrides directory.
 */
export async function scheduleMockOverride(
  rootDir: string,
  observationId: string,
  prdId: string,
  deadline: Date,
): Promise<void> {
  const overrideDir = path.join(rootDir, '.autonomous-dev', 'overrides');
  await fs.mkdir(overrideDir, { recursive: true });

  const override = {
    observation_id: observationId,
    prd_id: prdId,
    deadline: deadline.toISOString(),
    created_at: new Date().toISOString(),
    status: 'pending',
  };

  const filePath = path.join(overrideDir, `${observationId}.json`);
  await fs.writeFile(filePath, JSON.stringify(override, null, 2), 'utf-8');
}

/**
 * List pending override checks.
 */
export async function listPendingOverrides(
  rootDir: string,
): Promise<Array<{ observation_id: string; prd_id: string; deadline: string; status: string }>> {
  const overrideDir = path.join(rootDir, '.autonomous-dev', 'overrides');
  const results: any[] = [];

  try {
    const files = await fs.readdir(overrideDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const content = await fs.readFile(path.join(overrideDir, file), 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed.status === 'pending') {
        results.push(parsed);
      }
    }
  } catch {
    // Directory may not exist
  }

  return results;
}

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

export interface MockLogEntry {
  level: string;
  message: string;
}

/**
 * Create a mock logger that captures log messages.
 */
export function mockLogger(): {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  entries: MockLogEntry[];
} {
  const entries: MockLogEntry[] = [];
  return {
    info: (msg: string) => entries.push({ level: 'info', message: msg }),
    warn: (msg: string) => entries.push({ level: 'warn', message: msg }),
    error: (msg: string) => entries.push({ level: 'error', message: msg }),
    entries,
  };
}
