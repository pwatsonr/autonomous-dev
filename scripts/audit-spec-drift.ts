#!/usr/bin/env ts-node
/* eslint-disable no-console */
// Single-use audit aid for PLAN-032-3 / SPEC-032-3-01.
// DELETED IN THE SAME COMMIT as the spec edits.
// Per TDD-032 §5.4.1 / NG-02: this is not shippable tooling.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const SPECS_DIR = join(REPO_ROOT, 'plugins/autonomous-dev/docs/specs');

interface DriftRow {
  spec_id: string;
  original_path: string;
  candidate_path: string;
  exists_after_remap: boolean;
  is_test_path: boolean;
}

function walkSpecs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkSpecs(full));
    } else if (entry.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function specIdFromFilename(file: string): string {
  const base = file.split('/').pop()!;
  const match = base.match(/^(SPEC-\d+-\d+(?:-\d+)?)/);
  return match ? match[1] : base.replace(/\.md$/, '');
}

function extractFileRows(body: string): string[] {
  // Locate `## ... Files to (Create|Modify) ...` heading; capture the
  // following markdown table rows. Returns the path-column cell from
  // each table row (skipping the header and the `|---|---|` separator).
  const rows: string[] = [];
  const headingRegex = /^##.*Files to (Create|Modify).*$/im;
  const sections = body.split(/(?=^## )/m);
  for (const section of sections) {
    if (!headingRegex.test(section)) continue;
    const lines = section.split('\n');
    let inTable = false;
    let sawHeader = false;
    for (const line of lines) {
      if (/^\|.*\|/.test(line)) {
        if (!inTable) {
          inTable = true;
          sawHeader = true;
          continue; // header row
        }
        if (/^\|\s*-{3,}/.test(line)) continue; // separator
        const cells = line.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
        if (cells.length === 0) continue;
        // The path is typically the FIRST cell.
        let first = cells[0];
        // Strip leading/trailing backticks (possibly multiple)
        first = first.replace(/^`+|`+$/g, '').trim();
        // Skip rows whose first cell is empty or clearly not a path.
        if (!first) continue;
        // Skip glob/wildcard rows (we cannot fs.existsSync them) and
        // placeholder text rows.
        if (first.includes('*')) continue;
        if (first.startsWith('_') && first.endsWith('_')) continue; // italic placeholder like _none yet_
        if (first.startsWith('(')) continue;
        // Heuristic: a real path either contains a slash or has an
        // extension we recognize.
        const looksLikePath =
          first.includes('/') ||
          /\.(ts|tsx|js|jsx|md|json|ya?ml|sh|bash|cjs|mjs|css|html|toml|ini|conf)$/.test(first);
        if (!looksLikePath) continue;
        rows.push(first);
      } else if (inTable && line.trim() === '') {
        // Table ends at first blank line after rows
        inTable = false;
        sawHeader = false;
      }
    }
  }
  return rows;
}

function applyHeuristicRemap(p: string): string {
  // src/portal/ → plugins/autonomous-dev-portal/server/ (TDD-031 sweep)
  if (p.startsWith('src/portal/')) {
    return p.replace(/^src\/portal\//, 'plugins/autonomous-dev-portal/server/');
  }
  // SPEC-024-1's plugin scaffolding shifted some references.
  // The existing reconciliation work (TDD-031) handled the bulk; this
  // catches stragglers.
  return p;
}

function isTestPath(p: string): boolean {
  return /(?:^|\/)(?:tests?|__tests__|spec)\//.test(p);
}

function main() {
  const specs = walkSpecs(SPECS_DIR);
  const out: DriftRow[] = [];
  for (const file of specs) {
    const body = readFileSync(file, 'utf8');
    const paths = extractFileRows(body);
    for (const p of paths) {
      const abs = join(REPO_ROOT, p);
      if (existsSync(abs)) continue; // not drifted
      const candidate = applyHeuristicRemap(p);
      const candidateAbs = join(REPO_ROOT, candidate);
      out.push({
        spec_id: specIdFromFilename(file),
        original_path: p,
        candidate_path: candidate === p ? '' : candidate,
        exists_after_remap: candidate !== p && existsSync(candidateAbs),
        is_test_path: isTestPath(p),
      });
    }
  }
  // CSV emit (six columns; `notes` is empty at emit time and filled by hand-edit step).
  console.log('spec_id,original_path,candidate_path,exists_after_remap,is_test_path,notes');
  for (const r of out) {
    console.log(
      [r.spec_id, r.original_path, r.candidate_path, r.exists_after_remap, r.is_test_path, '']
        .map((v) => String(v))
        .join(','),
    );
  }
}

main();
