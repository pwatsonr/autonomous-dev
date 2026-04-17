import yaml from 'js-yaml';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DocumentType } from '../types/document-type';
import { ExecutionMode } from '../types/frontmatter';
import { DirectoryManager } from '../storage/directory-manager';
import { atomicWrite } from '../storage/atomic-io';

/**
 * Decomposition record schema per TDD Section 3.6.3.
 */
export interface ProposedChild {
  /** Generated document ID */
  id: string;
  /** Title of the child document */
  title: string;
  /** Parent sections this child addresses */
  tracesFrom: string[];
  /** Execution mode for this child */
  executionMode: ExecutionMode;
  /** Sibling IDs this child depends on */
  dependsOn: string[];
}

export interface CoverageMatrixEntry {
  /** Parent section ID */
  parentSection: string;
  /** Child document IDs that trace to this section */
  coveredBy: string[];
}

export interface SmokeTestResult {
  passed: boolean;
  coverageComplete: boolean;
  uncoveredParentSections: string[];
  scopeCreep: boolean;
  scopeCreepDetails: string[];
  contradictions: boolean;
  contradictionDetails: string[];
}

export interface DecompositionRecord {
  /** Parent document ID */
  parentId: string;
  /** Parent document type */
  parentType: DocumentType;
  /** Parent version at time of decomposition */
  parentVersion: string;
  /** Child document type produced */
  childType: DocumentType;
  /** Strategy used */
  strategy: string;
  /** Proposed/created children */
  children: ProposedChild[];
  /** Coverage matrix: which parent sections are covered by which children */
  coverageMatrix: CoverageMatrixEntry[];
  /** Smoke test result (null if not run) */
  smokeTestResult: SmokeTestResult | null;
  /** ISO 8601 timestamp */
  createdAt: string;
  /** Agent that performed the decomposition */
  decompositionAgent: string;
}

/**
 * Writes a decomposition record to the pipeline's decomposition/ directory.
 *
 * File naming: {PARENT_ID}-decomposition.yaml
 * Example: PRD-001-decomposition.yaml
 */
export async function writeDecompositionRecord(
  record: DecompositionRecord,
  pipelineId: string,
  directoryManager: DirectoryManager,
): Promise<string> {
  const decompDir = directoryManager.getDecompositionDir(pipelineId);
  const filename = `${record.parentId}-decomposition.yaml`;
  const filePath = path.join(decompDir, filename);

  const yamlContent = yaml.dump(record, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });

  await atomicWrite(filePath, yamlContent);
  return filePath;
}

/**
 * Reads a decomposition record for a specific parent document.
 * Returns null if no decomposition record exists.
 */
export async function readDecompositionRecord(
  parentId: string,
  pipelineId: string,
  directoryManager: DirectoryManager,
): Promise<DecompositionRecord | null> {
  const decompDir = directoryManager.getDecompositionDir(pipelineId);
  const filename = `${parentId}-decomposition.yaml`;
  const filePath = path.join(decompDir, filename);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return yaml.load(content) as DecompositionRecord;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Reads all decomposition records for a pipeline.
 */
export async function readAllDecompositionRecords(
  pipelineId: string,
  directoryManager: DirectoryManager,
): Promise<DecompositionRecord[]> {
  const decompDir = directoryManager.getDecompositionDir(pipelineId);
  let files: string[];
  try {
    files = await fs.readdir(decompDir);
  } catch {
    return [];
  }

  const records: DecompositionRecord[] = [];
  for (const file of files) {
    if (file.endsWith('-decomposition.yaml')) {
      const content = await fs.readFile(path.join(decompDir, file), 'utf-8');
      records.push(yaml.load(content) as DecompositionRecord);
    }
  }
  return records;
}
