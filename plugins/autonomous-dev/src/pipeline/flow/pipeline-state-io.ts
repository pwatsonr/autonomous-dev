import * as fs from 'fs/promises';
import yaml from 'js-yaml';
import { PipelineState, PipelineMetrics, DocumentState } from './pipeline-state';
import { DirectoryManager } from '../storage/directory-manager';
import { atomicWrite } from '../storage/atomic-io';
import { DocumentType } from '../types/document-type';
import { DocumentStatus, Priority } from '../types/frontmatter';

/**
 * Reads pipeline.yaml and deserializes to PipelineState.
 *
 * @returns PipelineState, or null if pipeline.yaml does not exist
 */
export async function readPipelineState(
  pipelineId: string,
  directoryManager: DirectoryManager,
): Promise<PipelineState | null> {
  const statePath = directoryManager.getPipelineYamlPath(pipelineId);

  try {
    const content = await fs.readFile(statePath, 'utf-8');
    const raw = yaml.load(content) as Record<string, unknown>;

    // Map YAML snake_case keys to TypeScript camelCase
    return mapYamlToPipelineState(raw);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Serializes PipelineState to YAML and writes pipeline.yaml atomically.
 *
 * Pipeline.yaml format (snake_case for YAML convention):
 * ```yaml
 * pipeline_id: PIPE-2026-0408-001
 * title: "Feature X"
 * status: ACTIVE
 * priority: normal
 * created_at: "2026-04-08T12:00:00.000Z"
 * updated_at: "2026-04-08T12:00:00.000Z"
 * paused_at: null
 * document_states:
 *   PRD-001:
 *     document_id: PRD-001
 *     type: PRD
 *     status: draft
 *     version: "1.0"
 *     review_iteration: 0
 *     last_review_score: null
 *     assigned_agent: null
 *     parent_id: null
 *     children: []
 *     blocked_by: []
 *     blocking: []
 * active_cascades: []
 * metrics:
 *   total_documents: 1
 *   documents_by_status:
 *     draft: 1
 *   total_versions: 1
 *   total_reviews: 0
 * ```
 */
export async function writePipelineState(
  state: PipelineState,
  directoryManager: DirectoryManager,
): Promise<void> {
  const statePath = directoryManager.getPipelineYamlPath(state.pipelineId);

  // Update timestamp
  state.updatedAt = new Date().toISOString();

  // Map TypeScript camelCase to YAML snake_case
  const yamlObj = mapPipelineStateToYaml(state);

  const content = yaml.dump(yamlObj, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });

  await atomicWrite(statePath, content);
}

/**
 * Maps raw YAML (snake_case) to PipelineState (camelCase).
 */
function mapYamlToPipelineState(raw: Record<string, unknown>): PipelineState {
  const rawDocStates = (raw['document_states'] ?? {}) as Record<string, Record<string, unknown>>;
  const documentStates: Record<string, DocumentState> = {};

  for (const [docId, docRaw] of Object.entries(rawDocStates)) {
    documentStates[docId] = mapYamlToDocumentState(docRaw);
  }

  const rawMetrics = (raw['metrics'] ?? {}) as Record<string, unknown>;

  return {
    pipelineId: raw['pipeline_id'] as string,
    title: raw['title'] as string,
    status: raw['status'] as PipelineState['status'],
    priority: raw['priority'] as Priority,
    createdAt: raw['created_at'] as string,
    updatedAt: raw['updated_at'] as string,
    pausedAt: (raw['paused_at'] as string | null) ?? null,
    documentStates,
    activeCascades: (raw['active_cascades'] as string[]) ?? [],
    metrics: mapYamlToMetrics(rawMetrics),
  };
}

/**
 * Maps a raw YAML document state object to DocumentState.
 */
function mapYamlToDocumentState(raw: Record<string, unknown>): DocumentState {
  return {
    documentId: raw['document_id'] as string,
    type: raw['type'] as DocumentType,
    status: raw['status'] as DocumentStatus,
    version: raw['version'] as string,
    reviewIteration: raw['review_iteration'] as number,
    lastReviewScore: (raw['last_review_score'] as number | null) ?? null,
    assignedAgent: (raw['assigned_agent'] as string | null) ?? null,
    parentId: (raw['parent_id'] as string | null) ?? null,
    children: (raw['children'] as string[]) ?? [],
    blockedBy: (raw['blocked_by'] as string[]) ?? [],
    blocking: (raw['blocking'] as string[]) ?? [],
  };
}

/**
 * Maps raw YAML metrics to PipelineMetrics.
 */
function mapYamlToMetrics(raw: Record<string, unknown>): PipelineState['metrics'] {
  return {
    totalDocuments: (raw['total_documents'] as number) ?? 0,
    documentsByStatus: (raw['documents_by_status'] as Record<string, number>) ?? {},
    totalVersions: (raw['total_versions'] as number) ?? 0,
    totalReviews: (raw['total_reviews'] as number) ?? 0,
  };
}

/**
 * Maps PipelineState (camelCase) to YAML-friendly (snake_case) object.
 */
function mapPipelineStateToYaml(state: PipelineState): Record<string, unknown> {
  const documentStates: Record<string, Record<string, unknown>> = {};

  for (const [docId, docState] of Object.entries(state.documentStates)) {
    documentStates[docId] = mapDocumentStateToYaml(docState);
  }

  return {
    pipeline_id: state.pipelineId,
    title: state.title,
    status: state.status,
    priority: state.priority,
    created_at: state.createdAt,
    updated_at: state.updatedAt,
    paused_at: state.pausedAt,
    document_states: documentStates,
    active_cascades: state.activeCascades,
    metrics: mapMetricsToYaml(state.metrics),
  };
}

/**
 * Maps DocumentState to YAML-friendly snake_case object.
 */
function mapDocumentStateToYaml(docState: DocumentState): Record<string, unknown> {
  return {
    document_id: docState.documentId,
    type: docState.type,
    status: docState.status,
    version: docState.version,
    review_iteration: docState.reviewIteration,
    last_review_score: docState.lastReviewScore,
    assigned_agent: docState.assignedAgent,
    parent_id: docState.parentId,
    children: docState.children,
    blocked_by: docState.blockedBy,
    blocking: docState.blocking,
  };
}

/**
 * Maps PipelineMetrics to YAML-friendly snake_case object.
 */
function mapMetricsToYaml(metrics: PipelineMetrics): Record<string, unknown> {
  return {
    total_documents: metrics.totalDocuments,
    documents_by_status: metrics.documentsByStatus,
    total_versions: metrics.totalVersions,
    total_reviews: metrics.totalReviews,
  };
}
