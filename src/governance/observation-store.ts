import * as fs from 'fs';
import * as path from 'path';
import { ObservationSummary, FixDeployment } from './types';

/**
 * Scan observation directories for files matching service+errorClass
 * criteria. Parses YAML frontmatter from each file.
 *
 * Scans only year/month directories that fall within the requested
 * time range to avoid reading the entire archive.
 */
export function findObservationsByServiceAndError(
  rootDir: string,
  service: string,
  errorClass: string,
  afterDate: Date
): ObservationSummary[] {
  const obsDir = path.join(rootDir, '.autonomous-dev', 'observations');
  const candidates: ObservationSummary[] = [];

  // Determine which YYYY/MM directories to scan
  const directories = getRelevantDirectories(obsDir, afterDate);

  for (const dir of directories) {
    const files = listMarkdownFiles(dir);
    for (const file of files) {
      const frontmatter = parseFrontmatterFromFile(file);
      if (!frontmatter) continue;

      if (
        frontmatter.service === service &&
        matchesErrorClass(frontmatter, errorClass) &&
        new Date(frontmatter.timestamp) >= afterDate
      ) {
        candidates.push({
          id: frontmatter.id,
          triage_status: frontmatter.triage_status,
          effectiveness: frontmatter.effectiveness ?? null,
          is_current: false,
        });
      }
    }
  }

  // Sort chronologically (oldest first)
  candidates.sort((a, b) => a.id.localeCompare(b.id));
  return candidates;
}

/**
 * Find the most recent fix deployment for a service+error class.
 * Scans promoted observations with linked_deployment set.
 */
export function findRecentFixDeployment(
  rootDir: string,
  service: string,
  errorClass: string,
  readDeploymentMetadata: (deploymentId: string) => FixDeployment | null
): FixDeployment | null {
  // Scan all observations for this service+errorClass that were promoted
  // and have a linked_deployment.
  const obsDir = path.join(rootDir, '.autonomous-dev', 'observations');
  let mostRecent: FixDeployment | null = null;

  const directories = getAllDirectories(obsDir);
  for (const dir of directories) {
    const files = listMarkdownFiles(dir);
    for (const file of files) {
      const fm = parseFrontmatterFromFile(file);
      if (!fm) continue;
      if (
        fm.service === service &&
        matchesErrorClass(fm, errorClass) &&
        fm.triage_decision === 'promote' &&
        fm.linked_deployment
      ) {
        const deploy = readDeploymentMetadata(fm.linked_deployment);
        if (deploy && (!mostRecent || deploy.deployed_at > mostRecent.deployed_at)) {
          mostRecent = deploy;
        }
      }
    }
  }

  return mostRecent;
}

/**
 * Match error class from observation fingerprint or type metadata.
 * Error class is derived from the observation's fingerprint components
 * (error type + endpoint combination stored during fingerprinting in PLAN-007-3).
 */
function matchesErrorClass(frontmatter: any, errorClass: string): boolean {
  // Primary: check fingerprint-derived error_class field
  if (frontmatter.error_class === errorClass) return true;
  // Fallback: match on type + fingerprint prefix (first 8 chars = error class hash)
  if (frontmatter.fingerprint?.startsWith(errorClass.substring(0, 8))) return true;
  return false;
}

/**
 * Return YYYY/MM directory paths that could contain observations
 * created after `afterDate`.
 */
function getRelevantDirectories(obsDir: string, afterDate: Date): string[] {
  const now = new Date();
  const dirs: string[] = [];
  const cursor = new Date(afterDate.getFullYear(), afterDate.getMonth(), 1);
  while (cursor <= now) {
    const year = cursor.getFullYear().toString();
    const month = (cursor.getMonth() + 1).toString().padStart(2, '0');
    const dirPath = path.join(obsDir, year, month);
    if (fs.existsSync(dirPath)) {
      dirs.push(dirPath);
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return dirs;
}

/**
 * Return all YYYY/MM directory paths in the observations directory.
 */
function getAllDirectories(obsDir: string): string[] {
  const dirs: string[] = [];
  if (!fs.existsSync(obsDir)) return dirs;

  try {
    const years = fs.readdirSync(obsDir).filter(entry => {
      const fullPath = path.join(obsDir, entry);
      return fs.statSync(fullPath).isDirectory() && /^\d{4}$/.test(entry);
    });

    for (const year of years) {
      const yearPath = path.join(obsDir, year);
      const months = fs.readdirSync(yearPath).filter(entry => {
        const fullPath = path.join(yearPath, entry);
        return fs.statSync(fullPath).isDirectory() && /^\d{2}$/.test(entry);
      });
      for (const month of months) {
        dirs.push(path.join(yearPath, month));
      }
    }
  } catch {
    // If directory structure is unreadable, return empty
  }

  return dirs;
}

/**
 * List all Markdown files in a directory.
 */
function listMarkdownFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Parse YAML frontmatter from a Markdown file.
 * Returns null if the file cannot be read or has no frontmatter.
 */
function parseFrontmatterFromFile(filePath: string): Record<string, any> | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content.startsWith('---')) return null;

    const endIndex = content.indexOf('\n---', 3);
    if (endIndex === -1) return null;

    const yamlBlock = content.substring(4, endIndex);
    const result: Record<string, any> = {};

    for (const line of yamlBlock.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const colonIndex = trimmed.indexOf(':');
      if (colonIndex === -1) continue;

      const key = trimmed.substring(0, colonIndex).trim();
      let value: any = trimmed.substring(colonIndex + 1).trim();

      // Handle null
      if (value === 'null' || value === '~' || value === '') {
        value = null;
      }
      // Handle booleans
      else if (value === 'true') {
        value = true;
      } else if (value === 'false') {
        value = false;
      }
      // Handle arrays
      else if (value.startsWith('[') && value.endsWith(']')) {
        const inner = value.substring(1, value.length - 1).trim();
        value = inner ? inner.split(',').map((s: string) => s.trim()) : [];
      }
      // Handle quoted strings
      else if ((value.startsWith('"') && value.endsWith('"')) ||
               (value.startsWith("'") && value.endsWith("'"))) {
        value = value.substring(1, value.length - 1);
      }

      result[key] = value;
    }

    return result;
  } catch {
    return null;
  }
}
