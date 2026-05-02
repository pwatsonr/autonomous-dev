/**
 * Configurable backend used by SPEC-023-3-04 integration tests.
 *
 * @module tests/deploy/helpers/fake-backend
 */

import type {
  BuildArtifact,
  BuildContext,
  DeployParameters,
  DeploymentBackend,
  DeploymentRecord,
  HealthStatus,
  RollbackResult,
} from '../../../intake/deploy/types';

export interface FakeBackendOptions {
  name?: string;
  /** Sequence of healthy/unhealthy results returned by healthCheck. */
  healthSequence?: boolean[];
  /** When true, rollback() throws an Error (used for the failure variant). */
  rollbackThrows?: Error;
}

export class FakeBackend implements DeploymentBackend {
  readonly metadata: DeploymentBackend['metadata'];
  private healthSeq: boolean[];
  private healthIdx = 0;
  private rollbackErr: Error | undefined;
  public rollbackCallCount = 0;

  constructor(opts: FakeBackendOptions = {}) {
    this.metadata = {
      name: opts.name ?? 'fake',
      version: '0.0.1',
      supportedTargets: [],
      capabilities: [],
      requiredTools: [],
    };
    this.healthSeq = opts.healthSequence ?? [];
    this.rollbackErr = opts.rollbackThrows;
  }

  setHealthSequence(seq: boolean[]): void {
    this.healthSeq = seq;
    this.healthIdx = 0;
  }

  async build(_ctx: BuildContext): Promise<BuildArtifact> {
    return {
      artifactId: 'art-1',
      type: 'directory',
      location: '/tmp/fake',
      checksum: 'a'.repeat(64),
      sizeBytes: 0,
      metadata: {},
    };
  }

  async deploy(
    artifact: BuildArtifact,
    environment: string,
    _params: DeployParameters,
  ): Promise<DeploymentRecord> {
    return {
      deployId: `dep-${environment}-${artifact.artifactId}`,
      backend: this.metadata.name,
      environment,
      artifactId: artifact.artifactId,
      deployedAt: '2026-05-02T12:00:00.000Z',
      status: 'deployed',
      details: {},
      hmac: '',
    };
  }

  async healthCheck(_record: DeploymentRecord): Promise<HealthStatus> {
    const next =
      this.healthIdx < this.healthSeq.length
        ? this.healthSeq[this.healthIdx]
        : true;
    this.healthIdx += 1;
    return { healthy: next, checks: [] };
  }

  async rollback(_record: DeploymentRecord): Promise<RollbackResult> {
    this.rollbackCallCount += 1;
    if (this.rollbackErr) throw this.rollbackErr;
    return { success: true, restoredArtifactId: 'art-prev', errors: [] };
  }
}
