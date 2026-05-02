/**
 * SPEC-023-1-04 deploy backends CLI tests.
 *
 * @module tests/cli/deploy-backends.test
 */

import { Writable } from 'node:stream';

import { LocalBackend } from '../../intake/deploy/backends/local';
import { StaticBackend } from '../../intake/deploy/backends/static';
import {
  runDeployBackendsDescribe,
  runDeployBackendsList,
} from '../../intake/cli/deploy_backends_command';
import { BackendRegistry } from '../../intake/deploy/registry';
import { registerBundledBackendsSync } from '../../intake/deploy/registry-bootstrap';

class StringWritable extends Writable {
  buf = '';
  override _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    this.buf += chunk.toString();
    cb();
  }
}

describe('SPEC-023-1-04 deploy backends list', () => {
  beforeEach(() => BackendRegistry.clear());
  afterEach(() => BackendRegistry.clear());

  it('text mode prints a table with NAME/VERSION/AVAILABLE/TARGETS/CAPABILITIES', () => {
    BackendRegistry.registerSync(new LocalBackend());
    BackendRegistry.registerSync(new StaticBackend());
    const out = new StringWritable();
    const code = runDeployBackendsList({}, { stdout: out });
    expect(code).toBe(0);
    expect(out.buf).toMatch(/NAME/);
    expect(out.buf).toMatch(/VERSION/);
    expect(out.buf).toMatch(/AVAILABLE/);
    expect(out.buf).toMatch(/TARGETS/);
    expect(out.buf).toMatch(/CAPABILITIES/);
    expect(out.buf).toMatch(/\blocal\b/);
    expect(out.buf).toMatch(/\bstatic\b/);
  });

  it('--json mode emits valid JSON with the documented schema', () => {
    registerBundledBackendsSync();
    const out = new StringWritable();
    const code = runDeployBackendsList({ json: true }, { stdout: out });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.buf) as {
      backends: Array<{
        name: string;
        version: string;
        available: boolean;
        supportedTargets: string[];
        capabilities: string[];
        requiredTools: string[];
      }>;
    };
    expect(parsed.backends).toHaveLength(4);
    const names = parsed.backends.map((b) => b.name).sort();
    expect(names).toEqual(['docker-local', 'github-pages', 'local', 'static']);
    for (const entry of parsed.backends) {
      expect(typeof entry.version).toBe('string');
      expect(typeof entry.available).toBe('boolean');
      expect(Array.isArray(entry.supportedTargets)).toBe(true);
      expect(Array.isArray(entry.requiredTools)).toBe(true);
    }
  });
});

describe('SPEC-023-1-04 deploy backends describe', () => {
  beforeEach(() => BackendRegistry.clear());
  afterEach(() => BackendRegistry.clear());

  it('text mode prints sections including parameter schema', () => {
    BackendRegistry.registerSync(new LocalBackend());
    const out = new StringWritable();
    const code = runDeployBackendsDescribe('local', {}, { stdout: out });
    expect(code).toBe(0);
    expect(out.buf).toMatch(/Metadata/);
    expect(out.buf).toMatch(/Required tools/);
    expect(out.buf).toMatch(/Parameter schema/);
    expect(out.buf).toMatch(/Capabilities/);
    expect(out.buf).toMatch(/pr_title/);
    expect(out.buf).toMatch(/pr_body/);
    expect(out.buf).toMatch(/base_branch/);
  });

  it('--json mode emits the parameterSchema map', () => {
    BackendRegistry.registerSync(new LocalBackend());
    const out = new StringWritable();
    const code = runDeployBackendsDescribe('local', { json: true }, { stdout: out });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.buf) as {
      name: string;
      parameterSchema: Record<string, { type: string }>;
    };
    expect(parsed.name).toBe('local');
    expect(parsed.parameterSchema).toBeDefined();
    expect(parsed.parameterSchema.pr_title.type).toBe('string');
  });

  it('exits 1 with stderr when the backend is missing', () => {
    const out = new StringWritable();
    const err = new StringWritable();
    const code = runDeployBackendsDescribe('nope', {}, { stdout: out, stderr: err });
    expect(code).toBe(1);
    expect(err.buf).toMatch(/backend not registered: nope/);
  });
});
