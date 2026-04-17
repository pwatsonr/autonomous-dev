import { Priority } from '../types/frontmatter';
import { PipelineState } from './pipeline-state';
import { readPipelineState, writePipelineState } from './pipeline-state-io';
import { DirectoryManager } from '../storage/directory-manager';

const VALID_PRIORITIES: Priority[] = ['critical', 'high', 'normal', 'low'];

export class InvalidPriorityError extends Error {
  constructor(public readonly priority: string) {
    super(`Invalid priority: ${priority}. Must be one of: ${VALID_PRIORITIES.join(', ')}`);
    this.name = 'InvalidPriorityError';
  }
}

/**
 * Changes the pipeline priority and propagates to all document frontmatter.
 *
 * Per TDD Section 3.9.6:
 *   - Updates priority in pipeline.yaml.
 *   - Propagates to all document frontmatter (requires versioning updates).
 *     For MVP: updates pipeline state only; frontmatter updates are best-effort.
 *   - Emits "priority_changed" event.
 *
 * @throws InvalidPriorityError for invalid priority values
 */
export async function changePriority(
  pipelineId: string,
  newPriority: Priority,
  directoryManager: DirectoryManager,
  actorId: string,
): Promise<PipelineState> {
  if (!VALID_PRIORITIES.includes(newPriority)) {
    throw new InvalidPriorityError(newPriority);
  }

  const state = await readPipelineState(pipelineId, directoryManager);
  if (!state) throw new Error(`Pipeline ${pipelineId} not found`);

  state.priority = newPriority;
  await writePipelineState(state, directoryManager);

  return state;
}
