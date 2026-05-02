/**
 * Pure renderers for chain dependency graphs (SPEC-022-1-04).
 *
 * Two output formats:
 *   - DOT (Graphviz): `rankdir=LR`, rounded boxes, one labeled edge per
 *     ChainEdge (multi-edges between the same pair show as multiple lines).
 *   - Mermaid: `graph TB`, bracketed node labels for kebab-case ids,
 *     pipe-quoted edge labels.
 *
 * Empty graphs emit a valid empty document (no node, no edge). Both
 * functions are pure: same input → same output across calls.
 *
 * @module intake/chains/render
 */

import type { DependencyGraph, ChainEdge } from './dependency-graph';

export type ChainGraphFormat = 'dot' | 'mermaid';

export function renderGraph(
  graph: DependencyGraph,
  format: ChainGraphFormat,
): string {
  if (format === 'dot') return renderDot(graph);
  if (format === 'mermaid') return renderMermaid(graph);
  // Unknown format: caller should validate before calling, but be defensive.
  throw new Error(`unsupported format '${format}' (use dot or mermaid)`);
}

function renderDot(graph: DependencyGraph): string {
  const nodes = graph.getNodes();
  const edges = graph.getEdges();
  const lines: string[] = ['digraph chains {'];
  if (nodes.length === 0 && edges.length === 0) {
    lines.push('}');
    return lines.join('\n') + '\n';
  }
  lines.push('  rankdir=LR;');
  lines.push('  node [shape=box, style=rounded];');
  for (const n of nodes) {
    lines.push(`  "${escapeDot(n)}";`);
  }
  for (const e of edges) {
    lines.push(
      `  "${escapeDot(e.from)}" -> "${escapeDot(e.to)}" [label="${escapeDot(e.artifactType)}@${escapeDot(e.schemaVersion)}"];`,
    );
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

function renderMermaid(graph: DependencyGraph): string {
  const nodes = graph.getNodes();
  const edges = graph.getEdges();
  const lines: string[] = ['graph TB'];
  if (nodes.length === 0 && edges.length === 0) {
    return lines.join('\n') + '\n';
  }
  for (const n of nodes) {
    lines.push(`  ${mermaidId(n)}["${escapeMermaidLabel(n)}"]`);
  }
  for (const e of edges) {
    const label = `${e.artifactType}@${e.schemaVersion}`;
    lines.push(
      `  ${mermaidId(e.from)} -- "${escapeMermaidLabel(label)}" --> ${mermaidId(e.to)}`,
    );
  }
  return lines.join('\n') + '\n';
}

function escapeDot(s: string): string {
  return s.replace(/"/g, '\\"');
}

function escapeMermaidLabel(s: string): string {
  return s.replace(/"/g, '\\"');
}

/** Mermaid node identifiers must be alphanumeric. Replace dashes with
 *  underscores. */
function mermaidId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** Re-export ChainEdge so callers don't need to deep-import the graph. */
export type { ChainEdge };
