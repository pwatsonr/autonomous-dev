import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { changePriority, InvalidPriorityError } from '../../../src/pipeline/flow/priority-handler';
import { createInitialPipelineState } from '../../../src/pipeline/flow/pipeline-state';
import { writePipelineState, readPipelineState } from '../../../src/pipeline/flow/pipeline-state-io';
import { DirectoryManager } from '../../../src/pipeline/storage/directory-manager';
import { Priority } from '../../../src/pipeline/types/frontmatter';

describe('priority-handler', () => {
  let tmpDir: string;
  let directoryManager: DirectoryManager;
  const pipelineId = 'PIPE-2026-0408-001';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'priority-test-'));
    directoryManager = new DirectoryManager(tmpDir);
    await directoryManager.createPipelineDirs(pipelineId);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('changePriority updates pipeline priority', async () => {
    const state = createInitialPipelineState(pipelineId, 'Feature X', 'normal');
    await writePipelineState(state, directoryManager);

    const result = await changePriority(pipelineId, 'high', directoryManager, 'user-1');

    expect(result.priority).toBe('high');

    const readState = await readPipelineState(pipelineId, directoryManager);
    expect(readState!.priority).toBe('high');
  });

  it.each<Priority>(['critical', 'high', 'normal', 'low'])(
    'changePriority: %s is valid',
    async (priority) => {
      const state = createInitialPipelineState(pipelineId, 'Feature X');
      await writePipelineState(state, directoryManager);

      const result = await changePriority(pipelineId, priority, directoryManager, 'user-1');
      expect(result.priority).toBe(priority);
    },
  );

  it('changePriority throws InvalidPriorityError for invalid value', async () => {
    const state = createInitialPipelineState(pipelineId, 'Feature X');
    await writePipelineState(state, directoryManager);

    await expect(
      changePriority(pipelineId, 'urgent' as Priority, directoryManager, 'user-1'),
    ).rejects.toThrow(InvalidPriorityError);

    await expect(
      changePriority(pipelineId, 'urgent' as Priority, directoryManager, 'user-1'),
    ).rejects.toThrow('Invalid priority: urgent');
  });

  it('changePriority writes pipeline.yaml', async () => {
    const state = createInitialPipelineState(pipelineId, 'Feature X', 'low');
    await writePipelineState(state, directoryManager);

    await changePriority(pipelineId, 'critical', directoryManager, 'user-1');

    // Verify by reading the file directly
    const readState = await readPipelineState(pipelineId, directoryManager);
    expect(readState).not.toBeNull();
    expect(readState!.priority).toBe('critical');
  });

  it('throws for non-existent pipeline', async () => {
    await expect(
      changePriority('NON-EXISTENT', 'high', directoryManager, 'user-1'),
    ).rejects.toThrow('Pipeline NON-EXISTENT not found');
  });

  it('InvalidPriorityError has correct name and priority property', () => {
    const err = new InvalidPriorityError('bogus');
    expect(err.name).toBe('InvalidPriorityError');
    expect(err.priority).toBe('bogus');
    expect(err.message).toContain('bogus');
    expect(err.message).toContain('critical');
    expect(err.message).toContain('high');
    expect(err.message).toContain('normal');
    expect(err.message).toContain('low');
  });
});
