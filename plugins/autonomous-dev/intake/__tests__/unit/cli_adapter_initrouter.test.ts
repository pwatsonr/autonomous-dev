/**
 * Unit tests for cli_adapter initRouter() function.
 * Tests TASK-001 acceptance criteria for graceful handling of undefined deps.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initRouter } from '../../adapters/cli_adapter';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('cli_adapter initRouter()', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-initrouter-'));

    // Create a temporary config directory structure
    const homeDir = path.join(tempDir, '.autonomous-dev');
    fs.mkdirSync(homeDir, { recursive: true });

    // Override HOME for the test
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  it('initRouter_with_undefined_deps - resolves without throwing when deps are undefined', async () => {
    // AC-038-01: initRouter() resolves without throwing when all three optional deps are undefined
    const router = await initRouter();

    expect(router).toBeDefined();
    expect(typeof router.route).toBe('function');
  });

  it('submit_skips_nlp - uses raw description as title when claudeClient undefined', async () => {
    // AC-038-02: Submit handler uses the raw description as the title when claudeClient is undefined
    const router = await initRouter();

    const testDescription = 'Add dark mode to dashboard';
    const command = {
      command: 'submit' as const,
      args: [testDescription],
      flags: {
        '--repo': tempDir,
        '--type': 'feature'
      },
      source: {
        channelType: 'cli' as const,
        userId: 'test-user'
      }
    };

    // Mock context
    const context = {
      userId: 'test-user',
      channelType: 'cli' as const,
      isAuthenticated: true,
      userRole: 'contributor' as const,
      permissions: {},
      rateLimitRemaining: 100
    };

    const result = await router.route(command, context);

    // Should succeed and the title should be derived from description
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requestId).toMatch(/^REQ-\d{6}$/);
    }
  });

  it('submit_skips_dedup - accepts duplicate descriptions when duplicateDetector undefined', async () => {
    // AC-038-03: Submit handler accepts duplicate descriptions when duplicateDetector is undefined
    const router = await initRouter();

    const testDescription = 'Add dark mode to dashboard';
    const command = {
      command: 'submit' as const,
      args: [testDescription],
      flags: {
        '--repo': tempDir,
        '--type': 'feature'
      },
      source: {
        channelType: 'cli' as const,
        userId: 'test-user'
      }
    };

    const context = {
      userId: 'test-user',
      channelType: 'cli' as const,
      isAuthenticated: true,
      userRole: 'contributor' as const,
      permissions: {},
      rateLimitRemaining: 100
    };

    // Submit the same description twice
    const result1 = await router.route(command, context);
    const result2 = await router.route(command, context);

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
    const router = await initRouter();

    const testDescription = 'Add [feature] with {complex} syntax (parentheses)';
    const command = {
      command: 'submit' as const,
      args: [testDescription],
      flags: {
        '--repo': tempDir,
        '--type': 'feature'
      },
      source: {
        channelType: 'cli' as const,
        userId: 'test-user'
      }
    };

    const context = {
      userId: 'test-user',
      channelType: 'cli' as const,
      isAuthenticated: true,
      userRole: 'contributor' as const,
      permissions: {},
      rateLimitRemaining: 100
    };

    const result = await router.route(command, context);

    // Should succeed because injection rule validation is skipped
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requestId).toMatch(/^REQ-\d{6}$/);
    }
  });
});