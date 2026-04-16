import * as fs from 'fs/promises';
import * as path from 'path';
import { DocumentType } from '../types/document-type';
import { DirectoryManager } from './directory-manager';
import { VersionRecord } from './version-writer';
import { parseFrontmatter } from '../frontmatter/parser';

/** Regex matching version file names: v{MAJOR}.{MINOR}.md */
const VERSION_FILE_REGEX = /^v(\d+)\.(\d+)\.md$/;

/**
 * Parses a version string "MAJOR.MINOR" into a sortable tuple.
 */
function parseVersion(version: string): [number, number] {
  const [major, minor] = version.split('.').map(Number);
  return [major, minor];
}

/**
 * Compares two version tuples for sorting.
 * 1.0 < 1.1 < 1.10 < 2.0
 */
function compareVersions(a: [number, number], b: [number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] - b[1];
}

/**
 * Lists all versions for a document, sorted by version number (ascending).
 *
 * Algorithm:
 *   1. Read directory entries for the document directory
 *   2. Filter entries matching VERSION_FILE_REGEX
 *   3. For each matching file: read frontmatter to extract metadata
 *   4. Build VersionRecord for each
 *   5. Sort by version (semantic ordering: 1.0 < 1.1 < 1.10 < 2.0)
 *   6. Return sorted array
 */
export async function listVersions(
  pipelineId: string,
  type: DocumentType,
  documentId: string,
  directoryManager: DirectoryManager,
): Promise<VersionRecord[]> {
  const docDir = directoryManager.getDocumentDir(pipelineId, type, documentId);
  const entries = await fs.readdir(docDir);

  const versions: VersionRecord[] = [];
  for (const entry of entries) {
    const match = entry.match(VERSION_FILE_REGEX);
    if (!match) continue;

    const version = `${match[1]}.${match[2]}`;
    const filePath = path.join(docDir, entry);
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseFrontmatter(content);

    versions.push({
      version,
      reason: (parsed.frontmatter as any).version_reason ?? 'INITIAL',
      timestamp: parsed.frontmatter.updated_at ?? '',
      author: parsed.frontmatter.author_agent ?? '',
      contentHash: '', // computed lazily or by versioning engine
      filePath,
    });
  }

  // Sort by semantic version
  versions.sort((a, b) => {
    const va = parseVersion(a.version);
    const vb = parseVersion(b.version);
    return compareVersions(va, vb);
  });

  return versions;
}
