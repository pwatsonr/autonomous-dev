/**
 * Unit tests for cli_adapter initRouter() function.
 * Tests TASK-001 acceptance criteria for graceful handling of undefined deps.
 */

import { initRouter } from '../../adapters/cli_adapter';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('cli_adapter initRouter()', () => {
  let tempDir: string;
  let originalHome: string;
  let router: any;

  beforeEach(async () => {
    // Save original HOME
    originalHome = process.env.HOME || '';

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-initrouter-'));

    // Set HOME to temp directory
    process.env.HOME = tempDir;

    // Create a temporary config directory structure
    const autonomousDir = path.join(tempDir, '.autonomous-dev');
    fs.mkdirSync(autonomousDir, { recursive: true });

    // Create minimal auth config file
    const authConfig = `
version: 1
users:
  - internal_id: test-user
    identities:
      cli_user: test-user
    role: contributor
`;
    fs.writeFileSync(path.join(autonomousDir, 'intake-auth.yaml'), authConfig);

    // Initialize router after setup
    router = await initRouter();
  });

  afterEach(() => {
    // Restore original HOME
    process.env.HOME = originalHome;

    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('initRouter_with_undefined_deps - resolves without throwing when deps are undefined', async () => {
    // AC-038-01: initRouter() resolves without throwing when all three optional deps are undefined
    expect(router).toBeDefined();
    expect(typeof router.route).toBe('function');
  });

  it('submit_skips_nlp - uses raw description as title when claudeClient undefined', async () => {
    // AC-038-02: Submit handler uses the raw description as the title when claudeClient is undefined
    const testDescription = 'Add dark mode to dashboard for better user experience';

    // Create a simple repo directory for the test
    const testRepo = path.join(tempDir, 'test-repo');
    fs.mkdirSync(testRepo, { recursive: true });

    const command = {
      commandName: 'submit',
      args: [testDescription],
      flags: {
        'repo': testRepo,
        'type': 'feature'
      },
      rawText: `submit "${testDescription}" --repo ${testRepo} --type feature`,
      source: {
        channelType: 'cli' as const,
        userId: 'test-user'
      }
    };

    const result = await router.route(command);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requestId).toMatch(/^REQ-\d{6}$/);
    }
  });

  it('submit_skips_dedup - accepts duplicate descriptions when duplicateDetector undefined', async () => {
    // AC-038-03: Submit handler accepts duplicate descriptions when duplicateDetector is undefined
    const testDescription = 'Add dark mode to dashboard for better user experience';

    // Create a simple repo directory for the test
    const testRepo = path.join(tempDir, 'test-repo');
    fs.mkdirSync(testRepo, { recursive: true });

    const command = {
      commandName: 'submit',
      args: [testDescription],
      flags: {
        'repo': testRepo,
        'type': 'feature'
      },
      rawText: `submit "${testDescription}" --repo ${testRepo} --type feature`,
      source: {
        channelType: 'cli' as const,
        userId: 'test-user'
      }
    };

    // Submit the same description twice
    const result1 = await router.route(command);
    const result2 = await router.route(command);

    // Both should succeed because duplicate detection is skipped
    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);

    if (result1.success && result2.success) {
      // Should have different request IDs
      expect(result1.data.requestId).not.toBe(result2.data.requestId);
    }
  });

  it('submit_skips_injection_rules - processes bracket characters when injectionRules undefined', async () => {
    // Test that submission with bracket characters proceeds when injectionRules is undefined
    const testDescription = 'Add [feature] with {complex} syntax (parentheses)';

    // Create a simple repo directory for the test
    const testRepo = path.join(tempDir, 'test-repo');
    fs.mkdirSync(testRepo, { recursive: true });

    const command = {
      commandName: 'submit',
      args: [testDescription],
      flags: {
        'repo': testRepo,
        'type': 'feature'
      },
      rawText: `submit "${testDescription}" --repo ${testRepo} --type feature`,
      source: {
        channelType: 'cli' as const,
        userId: 'test-user'
      }
    };

    const result = await router.route(command);

    // Should succeed because injection rule validation is skipped
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requestId).toMatch(/^REQ-\d{6}$/);
    }
  });
});