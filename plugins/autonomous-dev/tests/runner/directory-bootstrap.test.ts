import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { bootstrapDirectories, REQUIRED_DIRS } from '../../src/runner/directory-bootstrap';

describe('directory-bootstrap', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Helper: check that a directory exists */
  async function dirExists(dirPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(dirPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  // --- TC-1-1-08: Bootstrap on clean directory ---
  describe('TC-1-1-08: bootstrap on clean directory', () => {
    it('creates all required directories on a clean filesystem', async () => {
      await bootstrapDirectories(tmpDir);

      for (const dir of REQUIRED_DIRS) {
        const fullPath = path.join(tmpDir, dir);
        const exists = await dirExists(fullPath);
        expect(exists).toBe(true);
      }
    });

    it('creates at least 8 required directories', async () => {
      expect(REQUIRED_DIRS.length).toBeGreaterThanOrEqual(8);
    });
  });

  // --- TC-1-1-09: Bootstrap on existing directory ---
  describe('TC-1-1-09: bootstrap on existing directory', () => {
    it('succeeds without error when all directories already exist', async () => {
      // First run creates everything
      await bootstrapDirectories(tmpDir);

      // Second run should be a no-op -- no errors, no overwrites
      await expect(bootstrapDirectories(tmpDir)).resolves.toBeUndefined();

      // Directories still exist
      for (const dir of REQUIRED_DIRS) {
        const fullPath = path.join(tmpDir, dir);
        const exists = await dirExists(fullPath);
        expect(exists).toBe(true);
      }
    });

    it('does not remove files that exist in the directories', async () => {
      await bootstrapDirectories(tmpDir);

      // Place a file in an existing directory
      const sentinelPath = path.join(tmpDir, '.autonomous-dev/config', 'sentinel.txt');
      await fs.writeFile(sentinelPath, 'do not delete', 'utf-8');

      // Re-bootstrap
      await bootstrapDirectories(tmpDir);

      // Sentinel file should still exist
      const content = await fs.readFile(sentinelPath, 'utf-8');
      expect(content).toBe('do not delete');
    });
  });

  // --- TC-1-1-10: Bootstrap creates current month dir ---
  describe('TC-1-1-10: bootstrap creates current month dir', () => {
    it('creates YYYY/MM directory for 2026-04-08', async () => {
      const testDate = new Date('2026-04-08T12:00:00Z');
      await bootstrapDirectories(tmpDir, testDate);

      const monthDir = path.join(tmpDir, '.autonomous-dev/observations/2026/04');
      const exists = await dirExists(monthDir);
      expect(exists).toBe(true);
    });

    it('creates YYYY/MM directory for January (zero-padded)', async () => {
      const testDate = new Date('2026-01-15T12:00:00Z');
      await bootstrapDirectories(tmpDir, testDate);

      const monthDir = path.join(tmpDir, '.autonomous-dev/observations/2026/01');
      const exists = await dirExists(monthDir);
      expect(exists).toBe(true);
    });

    it('creates YYYY/MM directory for December', async () => {
      const testDate = new Date('2025-12-31T23:59:59Z');
      await bootstrapDirectories(tmpDir, testDate);

      const monthDir = path.join(tmpDir, '.autonomous-dev/observations/2025/12');
      const exists = await dirExists(monthDir);
      expect(exists).toBe(true);
    });

    it('uses current date by default', async () => {
      await bootstrapDirectories(tmpDir);

      const now = new Date();
      const year = now.getFullYear().toString();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const monthDir = path.join(tmpDir, '.autonomous-dev/observations', year, month);
      const exists = await dirExists(monthDir);
      expect(exists).toBe(true);
    });
  });

  // --- Directory structure verification ---
  describe('complete directory tree', () => {
    it('creates the config directory', async () => {
      await bootstrapDirectories(tmpDir);
      expect(await dirExists(path.join(tmpDir, '.autonomous-dev/config'))).toBe(true);
    });

    it('creates the observations directory', async () => {
      await bootstrapDirectories(tmpDir);
      expect(await dirExists(path.join(tmpDir, '.autonomous-dev/observations'))).toBe(true);
    });

    it('creates the observations/archive directory', async () => {
      await bootstrapDirectories(tmpDir);
      expect(await dirExists(path.join(tmpDir, '.autonomous-dev/observations/archive'))).toBe(true);
    });

    it('creates the observations/digests directory', async () => {
      await bootstrapDirectories(tmpDir);
      expect(await dirExists(path.join(tmpDir, '.autonomous-dev/observations/digests'))).toBe(true);
    });

    it('creates the baselines directory', async () => {
      await bootstrapDirectories(tmpDir);
      expect(await dirExists(path.join(tmpDir, '.autonomous-dev/baselines'))).toBe(true);
    });

    it('creates the fingerprints directory', async () => {
      await bootstrapDirectories(tmpDir);
      expect(await dirExists(path.join(tmpDir, '.autonomous-dev/fingerprints'))).toBe(true);
    });

    it('creates the logs/intelligence directory', async () => {
      await bootstrapDirectories(tmpDir);
      expect(await dirExists(path.join(tmpDir, '.autonomous-dev/logs/intelligence'))).toBe(true);
    });

    it('creates the prd directory', async () => {
      await bootstrapDirectories(tmpDir);
      expect(await dirExists(path.join(tmpDir, '.autonomous-dev/prd'))).toBe(true);
    });
  });
});
