/**
 * Unit tests for DependencyGraph (SPEC-022-1-03 / SPEC-022-1-05).
 *
 * Covers graph construction, getProducers/getConsumers, edge generation
 * with semver-range matching, self-edge pruning, multi-edges, idempotency,
 * and the empty-graph case.
 *
 * @module tests/chains/test-dependency-graph
 */

import { DependencyGraph } from '../../intake/chains/dependency-graph';
import { buildManifest } from '../helpers/chain-fixtures';

describe('DependencyGraph', () => {
  it('empty graph: getEdges/getNodes/topologicalSort all empty', () => {
    const g = new DependencyGraph();
    expect(g.getEdges()).toEqual([]);
    expect(g.getNodes()).toEqual([]);
    expect(g.topologicalSort()).toEqual([]);
  });

  it('single plugin with no consumes: 1 node, 0 edges', () => {
    const g = new DependencyGraph();
    g.addPlugin(
      buildManifest({
        id: 'producer',
        produces: [
          { artifact_type: 'foo', schema_version: '1.0', format: 'json' },
        ],
      }),
    );
    expect(g.getNodes()).toEqual(['producer']);
    expect(g.getEdges()).toEqual([]);
  });

  it('producer + consumer: 1 edge with correct artifactType + schemaVersion', () => {
    const g = new DependencyGraph();
    g.addPlugin(
      buildManifest({
        id: 'p',
        produces: [
          { artifact_type: 'foo', schema_version: '1.0', format: 'json' },
        ],
      }),
    );
    g.addPlugin(
      buildManifest({
        id: 'c',
        consumes: [{ artifact_type: 'foo', schema_version: '^1.0' }],
      }),
    );
    const edges = g.getEdges();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      from: 'p',
      to: 'c',
      artifactType: 'foo',
      schemaVersion: '1.0',
    });
  });

  it('two producers + one consumer: 2 edges', () => {
    const g = new DependencyGraph();
    g.addPlugin(
      buildManifest({
        id: 'p1',
        produces: [
          { artifact_type: 'foo', schema_version: '1.0', format: 'json' },
        ],
      }),
    );
    g.addPlugin(
      buildManifest({
        id: 'p2',
        produces: [
          { artifact_type: 'foo', schema_version: '1.1', format: 'json' },
        ],
      }),
    );
    g.addPlugin(
      buildManifest({
        id: 'c',
        consumes: [{ artifact_type: 'foo', schema_version: '^1.0' }],
      }),
    );
    expect(g.getEdges()).toHaveLength(2);
  });

  it('one producer + two consumers: 2 edges', () => {
    const g = new DependencyGraph();
    g.addPlugin(
      buildManifest({
        id: 'p',
        produces: [
          { artifact_type: 'foo', schema_version: '1.0', format: 'json' },
        ],
      }),
    );
    g.addPlugin(
      buildManifest({
        id: 'c1',
        consumes: [{ artifact_type: 'foo', schema_version: '^1.0' }],
      }),
    );
    g.addPlugin(
      buildManifest({
        id: 'c2',
        consumes: [{ artifact_type: 'foo', schema_version: '1.0' }],
      }),
    );
    expect(g.getEdges()).toHaveLength(2);
  });

  it('self-edge prune: plugin produces and consumes same type → no edge', () => {
    const g = new DependencyGraph();
    g.addPlugin(
      buildManifest({
        id: 'p',
        produces: [
          { artifact_type: 'foo', schema_version: '1.0', format: 'json' },
        ],
        consumes: [{ artifact_type: 'foo', schema_version: '^1.0' }],
      }),
    );
    expect(g.getEdges()).toEqual([]);
    expect(g.getNodes()).toEqual(['p']);
  });

  it("consumer range '^2.0' against '1.0' producer: 0 edges", () => {
    const g = new DependencyGraph();
    g.addPlugin(
      buildManifest({
        id: 'p',
        produces: [
          { artifact_type: 'foo', schema_version: '1.0', format: 'json' },
        ],
      }),
    );
    g.addPlugin(
      buildManifest({
        id: 'c',
        consumes: [{ artifact_type: 'foo', schema_version: '^2.0' }],
      }),
    );
    expect(g.getEdges()).toEqual([]);
  });

  it('getProducers returns lex-sorted by pluginId', () => {
    const g = new DependencyGraph();
    g.addPlugin(
      buildManifest({
        id: 'zeta',
        produces: [
          { artifact_type: 'foo', schema_version: '1.0', format: 'json' },
        ],
      }),
    );
    g.addPlugin(
      buildManifest({
        id: 'alpha',
        produces: [
          { artifact_type: 'foo', schema_version: '1.0', format: 'json' },
        ],
      }),
    );
    const ids = g.getProducers('foo').map((p) => p.pluginId);
    expect(ids).toEqual(['alpha', 'zeta']);
  });

  it('getConsumers returns lex-sorted', () => {
    const g = new DependencyGraph();
    g.addPlugin(
      buildManifest({
        id: 'zz',
        consumes: [{ artifact_type: 'foo', schema_version: '^1.0' }],
      }),
    );
    g.addPlugin(
      buildManifest({
        id: 'aa',
        consumes: [{ artifact_type: 'foo', schema_version: '^1.0' }],
      }),
    );
    expect(g.getConsumers('foo')).toEqual(['aa', 'zz']);
  });

  it('multi-edge: same producer-consumer pair across two artifact types', () => {
    const g = new DependencyGraph();
    g.addPlugin(
      buildManifest({
        id: 'p',
        produces: [
          { artifact_type: 'foo', schema_version: '1.0', format: 'json' },
          { artifact_type: 'bar', schema_version: '1.0', format: 'json' },
        ],
      }),
    );
    g.addPlugin(
      buildManifest({
        id: 'c',
        consumes: [
          { artifact_type: 'foo', schema_version: '^1.0' },
          { artifact_type: 'bar', schema_version: '^1.0' },
        ],
      }),
    );
    const edges = g.getEdges();
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.artifactType).sort()).toEqual(['bar', 'foo']);
  });

  it('isolated plugin (no produces, no consumes) appears in getNodes() and topologicalSort()', () => {
    const g = new DependencyGraph();
    g.addPlugin(buildManifest({ id: 'isolated' }));
    expect(g.getNodes()).toEqual(['isolated']);
    expect(g.topologicalSort()).toEqual(['isolated']);
  });

  it('addPlugin idempotent on same plugin: edges/nodes unchanged on re-add', () => {
    const g = new DependencyGraph();
    const m = buildManifest({
      id: 'p',
      produces: [
        { artifact_type: 'foo', schema_version: '1.0', format: 'json' },
      ],
    });
    g.addPlugin(m);
    g.addPlugin(m);
    g.addPlugin(m);
    expect(g.getNodes()).toEqual(['p']);
    expect(g.getEdges()).toEqual([]);
  });
});
