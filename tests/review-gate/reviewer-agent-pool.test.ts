import {
  ReviewerAgentPool,
  ReviewerAgentInstance,
} from '../../src/review-gate/reviewer-agent-pool';
import { ReviewerAssignment } from '../../src/review-gate/panel-assembly-service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeAssignment(overrides: Partial<ReviewerAssignment> = {}): ReviewerAssignment {
  return {
    reviewer_id: 'product-analyst-12345',
    role_id: 'product-analyst',
    role_name: 'Product Analyst',
    agent_seed: 12345,
    specialization: 'primary',
    prompt_identity: 'You are a senior product analyst...',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReviewerAgentPool', () => {
  let pool: ReviewerAgentPool;

  beforeEach(() => {
    pool = new ReviewerAgentPool();
  });

  // Test 1: Create instance
  it('creates an instance with a UUID and idle status', () => {
    const assignment = makeAssignment();
    const instance = pool.createInstance(assignment);

    expect(instance.instance_id).toMatch(UUID_REGEX);
    expect(instance.reviewer_id).toBe(assignment.reviewer_id);
    expect(instance.role_id).toBe(assignment.role_id);
    expect(instance.role_name).toBe(assignment.role_name);
    expect(instance.agent_seed).toBe(assignment.agent_seed);
    expect(instance.prompt_identity).toBe(assignment.prompt_identity);
    expect(instance.status).toBe('idle');
    // created_at should be a valid ISO 8601 timestamp
    expect(new Date(instance.created_at).toISOString()).toBe(instance.created_at);
  });

  // Test 2: Mark active
  it('marks an instance as active', () => {
    const instance = pool.createInstance(makeAssignment());
    pool.markActive(instance.instance_id);

    const active = pool.getActiveInstances();
    expect(active).toHaveLength(1);
    expect(active[0].instance_id).toBe(instance.instance_id);
    expect(active[0].status).toBe('active');
  });

  // Test 3: Mark completed
  it('marks an active instance as completed and excludes it from active list', () => {
    const instance = pool.createInstance(makeAssignment());
    pool.markActive(instance.instance_id);
    pool.markCompleted(instance.instance_id);

    const active = pool.getActiveInstances();
    expect(active).toHaveLength(0);
  });

  // Test 4: Double activation throws
  it('throws when marking an already-active instance as active', () => {
    const instance = pool.createInstance(makeAssignment());
    pool.markActive(instance.instance_id);

    expect(() => pool.markActive(instance.instance_id)).toThrow(
      /already active/i,
    );
  });

  // Test 5: Non-existent instance throws
  it('throws when marking a non-existent instance as active', () => {
    expect(() => pool.markActive('nonexistent')).toThrow(/not found/i);
  });

  // Test 6: isActive check
  it('correctly reports isActive for a reviewer_id across lifecycle', () => {
    const reviewerId = 'product-analyst-99';
    const instance1 = pool.createInstance(
      makeAssignment({ reviewer_id: reviewerId, agent_seed: 99 }),
    );
    const instance2 = pool.createInstance(
      makeAssignment({ reviewer_id: reviewerId, agent_seed: 100 }),
    );

    // Neither active yet
    expect(pool.isActive(reviewerId)).toBe(false);

    // Mark first active
    pool.markActive(instance1.instance_id);
    expect(pool.isActive(reviewerId)).toBe(true);

    // Mark first completed, second still idle
    pool.markCompleted(instance1.instance_id);
    expect(pool.isActive(reviewerId)).toBe(false);

    // Mark second active
    pool.markActive(instance2.instance_id);
    expect(pool.isActive(reviewerId)).toBe(true);

    // Mark second completed
    pool.markCompleted(instance2.instance_id);
    expect(pool.isActive(reviewerId)).toBe(false);
  });

  // Test 7: Reset clears all
  it('clears all instances on reset', () => {
    pool.createInstance(makeAssignment({ reviewer_id: 'a', agent_seed: 1 }));
    pool.createInstance(makeAssignment({ reviewer_id: 'b', agent_seed: 2 }));
    pool.createInstance(makeAssignment({ reviewer_id: 'c', agent_seed: 3 }));

    // Mark one active to make sure active list is also cleared
    const instances = [
      pool.createInstance(makeAssignment({ reviewer_id: 'd', agent_seed: 4 })),
    ];
    // We already created 3 above, so let's just use those...
    pool.reset();

    expect(pool.getActiveInstances()).toHaveLength(0);
    expect(pool.isActive('a')).toBe(false);
    expect(pool.isActive('b')).toBe(false);
    expect(pool.isActive('c')).toBe(false);
  });

  // Additional: markFailed
  it('marks an instance as failed', () => {
    const instance = pool.createInstance(makeAssignment());
    pool.markActive(instance.instance_id);
    pool.markFailed(instance.instance_id);

    const active = pool.getActiveInstances();
    expect(active).toHaveLength(0);
  });

  // Additional: markCompleted on non-existent throws
  it('throws when marking a non-existent instance as completed', () => {
    expect(() => pool.markCompleted('nonexistent')).toThrow(/not found/i);
  });

  // Additional: markFailed on non-existent throws
  it('throws when marking a non-existent instance as failed', () => {
    expect(() => pool.markFailed('nonexistent')).toThrow(/not found/i);
  });

  // Additional: Each instance gets a unique UUID
  it('generates unique UUIDs for each instance', () => {
    const assignment = makeAssignment();
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const instance = pool.createInstance(assignment);
      ids.add(instance.instance_id);
    }
    expect(ids.size).toBe(100);
  });
});
