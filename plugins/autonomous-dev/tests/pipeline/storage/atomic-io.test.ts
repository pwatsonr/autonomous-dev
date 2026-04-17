import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { atomicWrite, atomicSymlink, AtomicWriteError } from '../../../src/pipeline/storage/atomic-io';

describe('atomicWrite', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-io-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates file with correct content', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await atomicWrite(filePath, 'hello world');
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('hello world');
  });

  it('overwrites existing file', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await atomicWrite(filePath, 'original');
    await atomicWrite(filePath, 'updated');
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('updated');
  });

  it('cleans up temp file on write failure', async () => {
    // Write to a non-existent directory to trigger failure
    const filePath = path.join(tmpDir, 'no-such-dir', 'subdir', 'test.txt');
    await expect(atomicWrite(filePath, 'content')).rejects.toThrow(AtomicWriteError);

    // Verify no leftover .tmp files in tmpDir
    const files = await fs.readdir(tmpDir);
    const tmpFiles = files.filter(f => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('throws AtomicWriteError on permission denied', async () => {
    // Create a directory with no write permission
    const readOnlyDir = path.join(tmpDir, 'readonly');
    await fs.mkdir(readOnlyDir);
    await fs.chmod(readOnlyDir, 0o444);

    const filePath = path.join(readOnlyDir, 'test.txt');
    await expect(atomicWrite(filePath, 'content')).rejects.toThrow(AtomicWriteError);

    // Restore permissions for cleanup
    await fs.chmod(readOnlyDir, 0o755);
  });

  it('concurrent atomicWrite calls do not corrupt file', async () => {
    const filePath = path.join(tmpDir, 'concurrent.txt');
    const contentA = 'A'.repeat(10000);
    const contentB = 'B'.repeat(10000);

    // Run two writes concurrently
    await Promise.all([
      atomicWrite(filePath, contentA),
      atomicWrite(filePath, contentB),
    ]);

    const finalContent = await fs.readFile(filePath, 'utf-8');
    // Final content must be one of the two complete writes, never partial
    expect([contentA, contentB]).toContain(finalContent);
  });
});

describe('atomicSymlink', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-symlink-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates symlink pointing to target', async () => {
    // Create a target file
    const targetFile = path.join(tmpDir, 'v1.0.md');
    await fs.writeFile(targetFile, 'version 1.0');

    const linkPath = path.join(tmpDir, 'current.md');
    await atomicSymlink('v1.0.md', linkPath);

    const linkTarget = await fs.readlink(linkPath);
    expect(linkTarget).toBe('v1.0.md');

    // Verify content is accessible through symlink
    const content = await fs.readFile(linkPath, 'utf-8');
    expect(content).toBe('version 1.0');
  });

  it('swaps existing symlink to new target', async () => {
    // Create two target files
    const v1 = path.join(tmpDir, 'v1.0.md');
    const v2 = path.join(tmpDir, 'v1.1.md');
    await fs.writeFile(v1, 'version 1.0');
    await fs.writeFile(v2, 'version 1.1');

    const linkPath = path.join(tmpDir, 'current.md');

    // Create initial symlink
    await atomicSymlink('v1.0.md', linkPath);
    expect(await fs.readlink(linkPath)).toBe('v1.0.md');

    // Swap to new target
    await atomicSymlink('v1.1.md', linkPath);
    expect(await fs.readlink(linkPath)).toBe('v1.1.md');

    // Verify content through symlink
    const content = await fs.readFile(linkPath, 'utf-8');
    expect(content).toBe('version 1.1');
  });

  it('cleans up temp symlink on failure', async () => {
    // Attempt symlink in non-existent directory
    const linkPath = path.join(tmpDir, 'no-such-dir', 'current.md');
    await expect(atomicSymlink('v1.0.md', linkPath)).rejects.toThrow(AtomicWriteError);

    // Verify no leftover .tmp symlinks in tmpDir
    const files = await fs.readdir(tmpDir);
    const tmpFiles = files.filter(f => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });
});
