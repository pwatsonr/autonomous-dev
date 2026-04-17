import yaml from 'js-yaml';
import * as fs from 'fs/promises';
import * as path from 'path';
import { VersionDiff } from './diff-engine';
import { DirectoryManager } from '../storage/directory-manager';
import { atomicWrite } from '../storage/atomic-io';
import { DocumentType } from '../types/document-type';

/**
 * Writes a VersionDiff to the document's diffs/ directory as YAML.
 *
 * File naming: v{FROM}-to-v{TO}.diff
 * Example: v1.0-to-v1.1.diff
 *
 * @param diff The computed VersionDiff
 * @param pipelineId Pipeline ID
 * @param type Document type
 * @param documentId Document ID
 * @param directoryManager Directory manager for path computation
 * @returns Absolute path to the written diff file
 */
export async function writeDiff(
  diff: VersionDiff,
  pipelineId: string,
  type: DocumentType,
  documentId: string,
  directoryManager: DirectoryManager,
): Promise<string> {
  const diffsDir = directoryManager.getDiffsDir(pipelineId, type, documentId);
  const filename = `v${diff.fromVersion}-to-v${diff.toVersion}.diff`;
  const filePath = path.join(diffsDir, filename);

  const yamlContent = yaml.dump(diff, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });

  await atomicWrite(filePath, yamlContent);
  return filePath;
}

/**
 * Reads and deserializes a diff file.
 *
 * @param pipelineId Pipeline ID
 * @param type Document type
 * @param documentId Document ID
 * @param fromVersion The "from" version
 * @param toVersion The "to" version
 * @param directoryManager Directory manager for path computation
 * @returns The deserialized VersionDiff
 */
export async function readDiff(
  pipelineId: string,
  type: DocumentType,
  documentId: string,
  fromVersion: string,
  toVersion: string,
  directoryManager: DirectoryManager,
): Promise<VersionDiff> {
  const diffsDir = directoryManager.getDiffsDir(pipelineId, type, documentId);
  const filename = `v${fromVersion}-to-v${toVersion}.diff`;
  const filePath = path.join(diffsDir, filename);
  const content = await fs.readFile(filePath, 'utf-8');
  return yaml.load(content) as VersionDiff;
}
