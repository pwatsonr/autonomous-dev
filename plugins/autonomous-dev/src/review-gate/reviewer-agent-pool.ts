import { ReviewerAssignment } from './panel-assembly-service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A running instance of a reviewer agent, created from a ReviewerAssignment.
 */
export interface ReviewerAgentInstance {
  /** Globally unique instance identifier (UUID). */
  instance_id: string;
  /** From ReviewerAssignment. */
  reviewer_id: string;
  /** From ReviewerAssignment. */
  role_id: string;
  /** Human-readable role name. */
  role_name: string;
  /** Distinct seed for perspective variation. */
  agent_seed: number;
  /** Prompt identity text for the reviewer persona. */
  prompt_identity: string;
  /** Current lifecycle status of this instance. */
  status: 'idle' | 'active' | 'completed' | 'failed';
  /** ISO 8601 timestamp when this instance was created. */
  created_at: string;
}

// ---------------------------------------------------------------------------
// UUID generator (simple v4-style)
// ---------------------------------------------------------------------------

/**
 * Generates a v4-style UUID using crypto.randomUUID when available,
 * falling back to a manual implementation.
 */
function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ---------------------------------------------------------------------------
// ReviewerAgentPool
// ---------------------------------------------------------------------------

/**
 * Manages reviewer agent instances with status tracking.
 *
 * Creates instances from ReviewerAssignment objects, tracks their lifecycle
 * (idle -> active -> completed/failed), and prevents duplicate assignment.
 */
export class ReviewerAgentPool {
  private instances: Map<string, ReviewerAgentInstance> = new Map();

  /**
   * Creates a new agent instance from a ReviewerAssignment.
   *
   * Generates a UUID for `instance_id`, sets `status` to "idle",
   * and records `created_at` as an ISO 8601 timestamp.
   */
  createInstance(assignment: ReviewerAssignment): ReviewerAgentInstance {
    const instance: ReviewerAgentInstance = {
      instance_id: generateUUID(),
      reviewer_id: assignment.reviewer_id,
      role_id: assignment.role_id,
      role_name: assignment.role_name,
      agent_seed: assignment.agent_seed,
      prompt_identity: assignment.prompt_identity,
      status: 'idle',
      created_at: new Date().toISOString(),
    };

    this.instances.set(instance.instance_id, instance);
    return instance;
  }

  /**
   * Sets an instance's status to "active".
   * @throws Error if the instance does not exist or is already active.
   */
  markActive(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }
    if (instance.status === 'active') {
      throw new Error(`Instance is already active: ${instanceId}`);
    }
    instance.status = 'active';
  }

  /**
   * Sets an instance's status to "completed".
   * @throws Error if the instance does not exist.
   */
  markCompleted(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }
    instance.status = 'completed';
  }

  /**
   * Sets an instance's status to "failed".
   * @throws Error if the instance does not exist.
   */
  markFailed(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }
    instance.status = 'failed';
  }

  /**
   * Returns all instances with status "active".
   */
  getActiveInstances(): ReviewerAgentInstance[] {
    return Array.from(this.instances.values()).filter(
      (instance) => instance.status === 'active',
    );
  }

  /**
   * Returns true if any active instance has the given reviewer_id.
   * Used by PanelAssemblyService to avoid duplicate assignment.
   */
  isActive(reviewerId: string): boolean {
    return Array.from(this.instances.values()).some(
      (instance) => instance.reviewer_id === reviewerId && instance.status === 'active',
    );
  }

  /**
   * Clears all instances. Used between gate executions.
   */
  reset(): void {
    this.instances.clear();
  }
}
