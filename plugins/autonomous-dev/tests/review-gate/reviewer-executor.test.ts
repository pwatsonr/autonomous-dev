import {
  ReviewerExecutor,
  DEFAULT_EXECUTOR_CONFIG,
  type LLMAdapter,
  type ReviewerAgentPool,
  type AgentInstance,
  type AssembledPrompt,
  type ReviewerExecutorConfig,
} from '../../src/review-gate/reviewer-executor';
import { ReviewerOutputValidator } from '../../src/review-gate/reviewer-output-validator';
import type { ReviewerAssignment } from '../../src/review-gate/panel-assembly-service';
import type { Rubric, ReviewOutput } from '../../src/review-gate/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal rubric for testing.
 */
function makeRubric(): Rubric {
  return {
    document_type: 'PRD',
    version: '1.0.0',
    approval_threshold: 85,
    total_weight: 100,
    categories: [
      {
        id: 'clarity',
        name: 'Clarity',
        weight: 50,
        description: 'Measures clarity',
        min_threshold: 60,
        calibration: { score_0: 'Poor', score_50: 'Average', score_100: 'Excellent' },
      },
      {
        id: 'completeness',
        name: 'Completeness',
        weight: 50,
        description: 'Measures completeness',
        min_threshold: 60,
        calibration: { score_0: 'Poor', score_50: 'Average', score_100: 'Excellent' },
      },
    ],
  };
}

/**
 * Creates a ReviewerAssignment.
 */
function makeAssignment(reviewerId: string, seed = 1000): ReviewerAssignment {
  return {
    reviewer_id: reviewerId,
    role_id: 'product-analyst',
    role_name: 'Product Analyst',
    agent_seed: seed,
    specialization: 'primary',
    prompt_identity: 'You are a senior product analyst.',
  };
}

/**
 * Creates a valid JSON response string that the output validator will accept.
 */
function makeValidResponse(reviewerId: string): string {
  return JSON.stringify({
    reviewer_id: reviewerId,
    reviewer_role: 'product-analyst',
    document_id: 'doc-001',
    document_version: '1.0.0',
    timestamp: '2026-01-15T10:00:00Z',
    scoring_mode: 'document_level',
    category_scores: [
      {
        category_id: 'clarity',
        score: 85,
        section_scores: null,
        justification: 'Clear and well-written.',
      },
      {
        category_id: 'completeness',
        score: 78,
        section_scores: null,
        justification: 'Mostly complete.',
      },
    ],
    findings: [],
    summary: 'Overall good quality.',
  });
}

/**
 * Creates a mock LLMAdapter.
 */
function createMockAdapter(
  behavior: (prompt: AssembledPrompt, agentSeed: number, timeoutMs: number) => Promise<string>,
): LLMAdapter {
  return { invoke: jest.fn(behavior) };
}

/**
 * Creates a mock ReviewerAgentPool that tracks instance status.
 */
function createMockPool(): ReviewerAgentPool & {
  instances: Map<string, AgentInstance>;
} {
  const instances = new Map<string, AgentInstance>();
  let counter = 0;

  return {
    instances,
    createInstance(assignment: ReviewerAssignment): AgentInstance {
      counter++;
      const instance: AgentInstance = {
        instance_id: `inst-${counter}`,
        reviewer_id: assignment.reviewer_id,
        agent_seed: assignment.agent_seed,
        status: 'active',
      };
      instances.set(instance.instance_id, instance);
      return instance;
    },
    markCompleted(instanceId: string): void {
      const inst = instances.get(instanceId);
      if (inst) inst.status = 'completed';
    },
    markFailed(instanceId: string): void {
      const inst = instances.get(instanceId);
      if (inst) inst.status = 'failed';
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReviewerExecutor', () => {
  const rubric = makeRubric();
  const outputValidator = new ReviewerOutputValidator();

  // 1. Successful parallel execution
  test('successful parallel execution: 2 reviewers both succeed', async () => {
    const adapter = createMockAdapter(async () => makeValidResponse('r'));
    const pool = createMockPool();
    const executor = new ReviewerExecutor(adapter, outputValidator, pool);

    const assignments = [makeAssignment('reviewer-a', 100), makeAssignment('reviewer-b', 200)];
    const prompts = new Map<string, AssembledPrompt>([
      ['reviewer-a', { text: 'prompt-a' }],
      ['reviewer-b', { text: 'prompt-b' }],
    ]);

    const result = await executor.executePanel(assignments, prompts, rubric);

    expect(result.review_outputs).toHaveLength(2);
    expect(result.failures).toHaveLength(0);
    expect(result.partial_panel).toBe(false);
    expect(result.escalation_required).toBe(false);
  });

  // 2. One reviewer times out, one succeeds
  test('partial panel when one reviewer times out', async () => {
    let callCount = 0;
    const adapter = createMockAdapter(async (_prompt, agentSeed) => {
      if (agentSeed === 100) {
        callCount++;
        throw new Error('Request timed out');
      }
      return makeValidResponse('reviewer-b');
    });
    const pool = createMockPool();
    const executor = new ReviewerExecutor(adapter, outputValidator, pool);

    const assignments = [makeAssignment('reviewer-a', 100), makeAssignment('reviewer-b', 200)];
    const prompts = new Map<string, AssembledPrompt>([
      ['reviewer-a', { text: 'prompt-a' }],
      ['reviewer-b', { text: 'prompt-b' }],
    ]);

    const result = await executor.executePanel(assignments, prompts, rubric);

    expect(result.review_outputs).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.partial_panel).toBe(true);
    expect(result.failures[0].reviewer_id).toBe('reviewer-a');
    expect(result.failures[0].error_type).toBe('timeout');
  });

  // 3. Retry succeeds on second attempt
  test('retry succeeds on second attempt', async () => {
    const callsByReviewer = new Map<number, number>();
    const adapter = createMockAdapter(async (_prompt, agentSeed) => {
      const count = (callsByReviewer.get(agentSeed) ?? 0) + 1;
      callsByReviewer.set(agentSeed, count);

      if (agentSeed === 100 && count === 1) {
        throw new Error('Transient crash');
      }
      return makeValidResponse('reviewer-a');
    });
    const pool = createMockPool();
    const executor = new ReviewerExecutor(adapter, outputValidator, pool);

    const assignments = [makeAssignment('reviewer-a', 100)];
    const prompts = new Map<string, AssembledPrompt>([
      ['reviewer-a', { text: 'prompt-a' }],
    ]);

    const result = await executor.executePanel(assignments, prompts, rubric);

    expect(result.review_outputs).toHaveLength(1);
    expect(result.failures).toHaveLength(0);
    expect(result.review_outputs[0].reviewer_id).toBe('reviewer-a');
  });

  // 4. Sole reviewer fails twice, fresh instance succeeds
  test('sole reviewer fails twice, fresh instance with new seed succeeds', async () => {
    const callLog: number[] = [];
    const adapter = createMockAdapter(async (_prompt, agentSeed) => {
      callLog.push(agentSeed);
      // Original seed (100) always fails; seed+1 (101) succeeds
      if (agentSeed === 100) {
        throw new Error('Request timed out');
      }
      return makeValidResponse('reviewer-a');
    });
    const pool = createMockPool();
    const executor = new ReviewerExecutor(adapter, outputValidator, pool);

    const assignments = [makeAssignment('reviewer-a', 100)];
    const prompts = new Map<string, AssembledPrompt>([
      ['reviewer-a', { text: 'prompt-a' }],
    ]);

    const result = await executor.executePanel(assignments, prompts, rubric);

    expect(result.review_outputs).toHaveLength(1);
    expect(result.failures).toHaveLength(0);
    // Should have been called with original seed twice (initial + retry) then fresh seed
    expect(callLog).toContain(100);
    expect(callLog).toContain(101);
  });

  // 5. Sole reviewer fails 3 times -- escalation
  test('sole reviewer fails 3 times triggers escalation', async () => {
    const adapter = createMockAdapter(async () => {
      throw new Error('Request timed out');
    });
    const pool = createMockPool();
    const executor = new ReviewerExecutor(adapter, outputValidator, pool);

    const assignments = [makeAssignment('reviewer-a', 100)];
    const prompts = new Map<string, AssembledPrompt>([
      ['reviewer-a', { text: 'prompt-a' }],
    ]);

    const result = await executor.executePanel(assignments, prompts, rubric);

    expect(result.review_outputs).toHaveLength(0);
    expect(result.escalation_required).toBe(true);
    expect(result.failures).toHaveLength(1);
  });

  // 6. Malformed output triggers retry
  test('malformed output triggers retry, retry succeeds', async () => {
    const callsByReviewer = new Map<number, number>();
    const adapter = createMockAdapter(async (_prompt, agentSeed) => {
      const count = (callsByReviewer.get(agentSeed) ?? 0) + 1;
      callsByReviewer.set(agentSeed, count);

      if (count === 1) {
        return 'This is not valid JSON at all.';
      }
      return makeValidResponse('reviewer-a');
    });
    const pool = createMockPool();
    const executor = new ReviewerExecutor(adapter, outputValidator, pool);

    const assignments = [makeAssignment('reviewer-a', 100)];
    const prompts = new Map<string, AssembledPrompt>([
      ['reviewer-a', { text: 'prompt-a' }],
    ]);

    const result = await executor.executePanel(assignments, prompts, rubric);

    expect(result.review_outputs).toHaveLength(1);
    expect(result.failures).toHaveLength(0);
  });

  // 7. All reviewers fail -- escalation
  test('all reviewers fail triggers escalation', async () => {
    const adapter = createMockAdapter(async () => {
      throw new Error('Request timed out');
    });
    const pool = createMockPool();
    const executor = new ReviewerExecutor(adapter, outputValidator, pool);

    const assignments = [makeAssignment('reviewer-a', 100), makeAssignment('reviewer-b', 200)];
    const prompts = new Map<string, AssembledPrompt>([
      ['reviewer-a', { text: 'prompt-a' }],
      ['reviewer-b', { text: 'prompt-b' }],
    ]);

    const result = await executor.executePanel(assignments, prompts, rubric);

    expect(result.review_outputs).toHaveLength(0);
    expect(result.escalation_required).toBe(true);
    expect(result.failures).toHaveLength(2);
  });

  // 8. Execution timing (parallel, not sequential)
  test('execution timing is approximately the longest reviewer, not sum', async () => {
    const DELAY_MS = 50;
    const adapter = createMockAdapter(async (_prompt, _agentSeed) => {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
      return makeValidResponse('r');
    });
    const pool = createMockPool();
    const executor = new ReviewerExecutor(adapter, outputValidator, pool);

    const assignments = [makeAssignment('reviewer-a', 100), makeAssignment('reviewer-b', 200)];
    const prompts = new Map<string, AssembledPrompt>([
      ['reviewer-a', { text: 'prompt-a' }],
      ['reviewer-b', { text: 'prompt-b' }],
    ]);

    const result = await executor.executePanel(assignments, prompts, rubric);

    expect(result.review_outputs).toHaveLength(2);
    // Parallel execution: time should be ~DELAY_MS, not ~2*DELAY_MS
    // Use generous tolerance for CI variability
    expect(result.execution_time_ms).toBeLessThan(DELAY_MS * 3);
    expect(result.execution_time_ms).toBeGreaterThanOrEqual(DELAY_MS - 10);
  });

  // 9. Agent pool status tracking
  test('agent pool status is correctly tracked after execution', async () => {
    let callCount = 0;
    const adapter = createMockAdapter(async (_prompt, agentSeed) => {
      if (agentSeed === 200) {
        callCount++;
        throw new Error('Crash');
      }
      return makeValidResponse('reviewer-a');
    });
    const pool = createMockPool();
    const executor = new ReviewerExecutor(adapter, outputValidator, pool);

    const assignments = [makeAssignment('reviewer-a', 100), makeAssignment('reviewer-b', 200)];
    const prompts = new Map<string, AssembledPrompt>([
      ['reviewer-a', { text: 'prompt-a' }],
      ['reviewer-b', { text: 'prompt-b' }],
    ]);

    await executor.executePanel(assignments, prompts, rubric);

    const instances = Array.from(pool.instances.values());
    const completedInstances = instances.filter(i => i.status === 'completed');
    const failedInstances = instances.filter(i => i.status === 'failed');

    expect(completedInstances.length).toBeGreaterThanOrEqual(1);
    expect(failedInstances.length).toBeGreaterThanOrEqual(1);

    // The successful reviewer should be completed
    const successInst = instances.find(i => i.agent_seed === 100);
    expect(successInst?.status).toBe('completed');

    // The failed reviewer should be failed
    const failedInst = instances.find(i => i.agent_seed === 200);
    expect(failedInst?.status).toBe('failed');
  });

  // 10. Timeout configuration
  test('custom timeout is passed to LLM adapter', async () => {
    const invokedTimeouts: number[] = [];
    const adapter = createMockAdapter(async (_prompt, _agentSeed, timeoutMs) => {
      invokedTimeouts.push(timeoutMs);
      return makeValidResponse('r');
    });
    const pool = createMockPool();
    const config: ReviewerExecutorConfig = {
      ...DEFAULT_EXECUTOR_CONFIG,
      timeout_ms: 5000,
    };
    const executor = new ReviewerExecutor(adapter, outputValidator, pool, config);

    const assignments = [makeAssignment('reviewer-a', 100)];
    const prompts = new Map<string, AssembledPrompt>([
      ['reviewer-a', { text: 'prompt-a' }],
    ]);

    await executor.executePanel(assignments, prompts, rubric);

    expect(invokedTimeouts).toContain(5000);
    // All invocations should use the custom timeout
    for (const t of invokedTimeouts) {
      expect(t).toBe(5000);
    }
  });
});
