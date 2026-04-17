import yaml from 'js-yaml';
import { DirectoryManager } from './directory-manager';
import { atomicWrite } from './atomic-io';

export interface PipelineInitResult {
  pipelineId: string;
  pipelineDir: string;
  pipelineYamlPath: string;
  auditLogPath: string;
  traceabilityPath: string;
}

/**
 * Pipeline ID format: PIPE-{YYYY}-{MMDD}-{SEQ}
 * Example: PIPE-2026-0408-001
 *
 * @param date Current date (injectable for testing)
 * @param sequence Sequence number (zero-padded to 3 digits)
 */
export function generatePipelineId(date: Date, sequence: number): string {
  const yyyy = date.getFullYear().toString();
  const mmdd = String(date.getMonth() + 1).padStart(2, '0')
    + String(date.getDate()).padStart(2, '0');
  const seq = String(sequence).padStart(3, '0');
  return `PIPE-${yyyy}-${mmdd}-${seq}`;
}

/**
 * Initial pipeline.yaml content per TDD Section 3.9.2:
 */
function buildInitialPipelineYaml(pipelineId: string, title: string): string {
  const state = {
    pipeline_id: pipelineId,
    title: title,
    status: 'active',
    priority: 'normal',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    paused_at: null,
    document_states: {},
    active_cascades: [],
    metrics: {
      total_documents: 0,
      documents_by_status: {},
      total_versions: 0,
      total_reviews: 0,
    },
  };
  return yaml.dump(state, { lineWidth: 120, noRefs: true });
}

/**
 * Creates a new pipeline directory with all initial files.
 */
export async function initializePipeline(
  directoryManager: DirectoryManager,
  pipelineId: string,
  title: string,
): Promise<PipelineInitResult> {
  // 1. Create directory tree
  await directoryManager.createPipelineDirs(pipelineId);

  // 2. Write pipeline.yaml
  const pipelineYamlPath = directoryManager.getPipelineYamlPath(pipelineId);
  await atomicWrite(pipelineYamlPath, buildInitialPipelineYaml(pipelineId, title));

  // 3. Write empty audit.log
  const auditLogPath = directoryManager.getAuditLogPath(pipelineId);
  await atomicWrite(auditLogPath, '');

  // 4. Write empty traceability.yaml
  const traceabilityPath = directoryManager.getTraceabilityPath(pipelineId);
  await atomicWrite(traceabilityPath, yaml.dump({ links: [], chains: [], gaps: [], orphans: [] }));

  return {
    pipelineId,
    pipelineDir: directoryManager.getPipelineDir(pipelineId),
    pipelineYamlPath,
    auditLogPath,
    traceabilityPath,
  };
}
