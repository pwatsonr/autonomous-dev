import { createInitialPipelineState, PipelineState } from '../../../src/pipeline/flow/pipeline-state';

describe('createInitialPipelineState', () => {
  it('creates state with ACTIVE status', () => {
    const state = createInitialPipelineState('PIPE-2026-0408-001', 'Feature X');
    expect(state.status).toBe('ACTIVE');
  });

  it('has empty documentStates', () => {
    const state = createInitialPipelineState('PIPE-2026-0408-001', 'Feature X');
    expect(state.documentStates).toEqual({});
  });

  it('has correct timestamps', () => {
    const before = new Date().toISOString();
    const state = createInitialPipelineState('PIPE-2026-0408-001', 'Feature X');
    const after = new Date().toISOString();

    expect(state.createdAt).toBeTruthy();
    expect(state.updatedAt).toBeTruthy();
    expect(state.createdAt).toBe(state.updatedAt);
    // Timestamps should be within the test window
    expect(state.createdAt >= before).toBe(true);
    expect(state.createdAt <= after).toBe(true);
  });

  it('PipelineMetrics initial values are all zero', () => {
    const state = createInitialPipelineState('PIPE-2026-0408-001', 'Feature X');
    expect(state.metrics.totalDocuments).toBe(0);
    expect(state.metrics.documentsByStatus).toEqual({});
    expect(state.metrics.totalVersions).toBe(0);
    expect(state.metrics.totalReviews).toBe(0);
  });

  it('sets pipelineId and title correctly', () => {
    const state = createInitialPipelineState('PIPE-2026-0408-001', 'Feature X');
    expect(state.pipelineId).toBe('PIPE-2026-0408-001');
    expect(state.title).toBe('Feature X');
  });

  it('defaults priority to normal', () => {
    const state = createInitialPipelineState('PIPE-2026-0408-001', 'Feature X');
    expect(state.priority).toBe('normal');
  });

  it('accepts custom priority', () => {
    const state = createInitialPipelineState('PIPE-2026-0408-001', 'Feature X', 'critical');
    expect(state.priority).toBe('critical');
  });

  it('has null pausedAt', () => {
    const state = createInitialPipelineState('PIPE-2026-0408-001', 'Feature X');
    expect(state.pausedAt).toBeNull();
  });

  it('has empty activeCascades', () => {
    const state = createInitialPipelineState('PIPE-2026-0408-001', 'Feature X');
    expect(state.activeCascades).toEqual([]);
  });
});
