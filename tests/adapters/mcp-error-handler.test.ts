import {
  withMcpRetry,
  rejectAfter,
  delay,
  validateConnectivity,
  type McpErrorPolicy,
  type McpOperationContext,
  type DataSourceStatus,
  DEFAULT_MCP_ERROR_POLICY,
} from '../../src/adapters/mcp-error-handler';
import { AuditLogger } from '../../src/runner/audit-logger';

describe('mcp-error-handler', () => {
  let auditLog: AuditLogger;

  beforeEach(() => {
    auditLog = new AuditLogger('RUN-20260408-143000', '/tmp/test-logs');
  });

  const testPolicy: McpErrorPolicy = {
    max_retries: 1,
    retry_delay_ms: 100, // Short for testing
    timeout_ms: 500,
  };

  const testContext: McpOperationContext = {
    source: 'prometheus',
    query: 'up{job="api-gateway"}',
    service: 'api-gateway',
  };

  const noopDelay = async () => {};

  // --- TC-1-4-09: MCP retry success ---
  describe('TC-1-4-09: MCP retry success', () => {
    it('returns result from second call when first times out', async () => {
      let callCount = 0;
      const operation = async () => {
        callCount++;
        if (callCount === 1) {
          // First call hangs beyond timeout
          await new Promise((resolve) => setTimeout(resolve, 1000));
          return 'should not reach';
        }
        return 'success-on-retry';
      };

      const result = await withMcpRetry(
        operation,
        testPolicy,
        testContext,
        auditLog,
        noopDelay,
      );

      expect(result).toBe('success-on-retry');
      expect(callCount).toBe(2);

      // Should have a warning logged for the first failure
      const entries = auditLog.getEntries();
      expect(entries.some((e) => e.level === 'WARN')).toBe(true);
    });

    it('returns result immediately when first call succeeds', async () => {
      let callCount = 0;
      const operation = async () => {
        callCount++;
        return 'immediate-success';
      };

      const result = await withMcpRetry(
        operation,
        testPolicy,
        testContext,
        auditLog,
        noopDelay,
      );

      expect(result).toBe('immediate-success');
      expect(callCount).toBe(1);
      // No warnings or errors when first call succeeds
      const entries = auditLog.getEntries();
      expect(entries.filter((e) => e.level === 'WARN').length).toBe(0);
      expect(entries.filter((e) => e.level === 'ERROR').length).toBe(0);
    });
  });

  // --- TC-1-4-10: MCP retry exhaustion ---
  describe('TC-1-4-10: MCP retry exhaustion', () => {
    it('returns null when both attempts fail', async () => {
      let callCount = 0;
      const operation = async (): Promise<string> => {
        callCount++;
        throw new Error(`Attempt ${callCount} failed`);
      };

      const result = await withMcpRetry(
        operation,
        testPolicy,
        testContext,
        auditLog,
        noopDelay,
      );

      expect(result).toBeNull();
      expect(callCount).toBe(2);

      // Should have both a warning (first failure) and an error (retry failure)
      const entries = auditLog.getEntries();
      expect(entries.filter((e) => e.level === 'WARN').length).toBe(1);
      expect(entries.filter((e) => e.level === 'ERROR').length).toBe(1);
    });

    it('returns null when both attempts time out', async () => {
      const shortPolicy: McpErrorPolicy = {
        max_retries: 1,
        retry_delay_ms: 10,
        timeout_ms: 50,
      };

      const operation = async () => {
        // Hangs forever
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return 'should not reach';
      };

      const result = await withMcpRetry(
        operation,
        shortPolicy,
        testContext,
        auditLog,
        noopDelay,
      );

      expect(result).toBeNull();
    });
  });

  // --- TC-1-4-11: MCP error response ---
  describe('TC-1-4-11: MCP error response', () => {
    it('logs error and returns null for HTTP 500 error', async () => {
      const operation = async (): Promise<string> => {
        throw new Error('HTTP 500: Internal Server Error');
      };

      const result = await withMcpRetry(
        operation,
        testPolicy,
        testContext,
        auditLog,
        noopDelay,
      );

      expect(result).toBeNull();

      // The error log should reference the query
      const entries = auditLog.getEntries();
      const errorEntry = entries.find((e) => e.level === 'ERROR');
      expect(errorEntry).toBeDefined();
      expect(errorEntry!.message).toContain('Skipping query');
      expect(errorEntry!.message).toContain(testContext.query);
    });
  });

  // --- rejectAfter ---
  describe('rejectAfter', () => {
    it('rejects after the specified timeout', async () => {
      await expect(rejectAfter(50)).rejects.toThrow('Timeout after 50ms');
    });
  });

  // --- delay ---
  describe('delay', () => {
    it('resolves after the specified time', async () => {
      const start = Date.now();
      await delay(50);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40); // Allow some timing slack
    });
  });

  // --- DEFAULT_MCP_ERROR_POLICY ---
  describe('DEFAULT_MCP_ERROR_POLICY', () => {
    it('has expected default values', () => {
      expect(DEFAULT_MCP_ERROR_POLICY.max_retries).toBe(1);
      expect(DEFAULT_MCP_ERROR_POLICY.retry_delay_ms).toBe(10_000);
      expect(DEFAULT_MCP_ERROR_POLICY.timeout_ms).toBe(30_000);
    });
  });

  // --- validateConnectivity ---
  describe('validateConnectivity', () => {
    it('reports all sources as available when checks succeed', async () => {
      const healthChecks: Record<string, () => Promise<DataSourceStatus>> = {
        prometheus: async () => 'available',
        grafana: async () => 'available',
        opensearch: async () => 'available',
      };

      const result = await validateConnectivity(healthChecks);

      expect(result.results).toEqual({
        prometheus: 'available',
        grafana: 'available',
        opensearch: 'available',
      });
      expect(result.all_unreachable).toBe(false);
    });

    it('reports degraded source correctly', async () => {
      const healthChecks: Record<string, () => Promise<DataSourceStatus>> = {
        prometheus: async () => 'available',
        opensearch: async () => 'degraded',
      };

      const result = await validateConnectivity(healthChecks);

      expect(result.results.prometheus).toBe('available');
      expect(result.results.opensearch).toBe('degraded');
      expect(result.all_unreachable).toBe(false);
    });

    it('sets all_unreachable when every configured source is unreachable', async () => {
      const healthChecks: Record<string, () => Promise<DataSourceStatus>> = {
        prometheus: async () => 'unreachable',
        grafana: async () => {
          throw new Error('connection refused');
        },
      };

      const result = await validateConnectivity(healthChecks);

      expect(result.results.prometheus).toBe('unreachable');
      expect(result.results.grafana).toBe('unreachable');
      expect(result.all_unreachable).toBe(true);
    });

    it('does not count not_configured sources when evaluating all_unreachable', async () => {
      const healthChecks: Record<string, () => Promise<DataSourceStatus>> = {
        prometheus: async () => 'available',
        sentry: async () => 'not_configured',
      };

      const result = await validateConnectivity(healthChecks);

      expect(result.all_unreachable).toBe(false);
    });

    it('handles empty health checks', async () => {
      const result = await validateConnectivity({});

      expect(result.results).toEqual({});
      expect(result.all_unreachable).toBe(false);
    });
  });

  // --- withMcpRetry delay behavior ---
  describe('retry delay', () => {
    it('calls the delay function with the configured retry delay', async () => {
      let delayCalledWith: number | undefined;
      const customDelay = async (ms: number) => {
        delayCalledWith = ms;
      };

      const policy: McpErrorPolicy = {
        max_retries: 1,
        retry_delay_ms: 5000,
        timeout_ms: 500,
      };

      const operation = async (): Promise<string> => {
        throw new Error('always fails');
      };

      await withMcpRetry(operation, policy, testContext, auditLog, customDelay);

      expect(delayCalledWith).toBe(5000);
    });
  });
});
