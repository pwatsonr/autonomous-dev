/**
 * Mock MCP server responses for Prometheus, Grafana, OpenSearch, Sentry
 * (SPEC-007-5-6).
 *
 * Tracks call counts for budget enforcement tests.
 */

import type { PrometheusClient } from '../../src/governance/types';

// ---------------------------------------------------------------------------
// Generic MCP mock
// ---------------------------------------------------------------------------

/**
 * Mock MCP client that returns predefined responses.
 * Tracks call counts for budget enforcement tests.
 */
export class MockMcpClient {
  private responses: Map<string, any[]> = new Map();
  private callCounts: Map<string, number> = new Map();

  addResponse(server: string, tool: string, response: any): void {
    const key = `${server}:${tool}`;
    const existing = this.responses.get(key) ?? [];
    existing.push(response);
    this.responses.set(key, existing);
  }

  async callTool(server: string, tool: string, _params?: any, _options?: any): Promise<any> {
    const key = `${server}:${tool}`;
    const count = (this.callCounts.get(key) ?? 0) + 1;
    this.callCounts.set(key, count);

    const responses = this.responses.get(key);
    if (!responses || responses.length === 0) {
      throw new Error(`No mock response for ${key}`);
    }

    // Return responses in order; cycle if more calls than responses
    return responses[(count - 1) % responses.length];
  }

  getCallCount(server: string, tool: string): number {
    return this.callCounts.get(`${server}:${tool}`) ?? 0;
  }

  reset(): void {
    this.callCounts.clear();
  }
}

// ---------------------------------------------------------------------------
// Mock Prometheus client
// ---------------------------------------------------------------------------

/**
 * Mock Prometheus client for effectiveness tests.
 * Stores responses keyed by query+windowKey (e.g., "pre" / "post").
 */
export class MockPrometheusClient implements PrometheusClient {
  private responses: Map<string, number | null> = new Map();
  private callLog: Array<{ query: string; start: Date; end: Date; step: number }> = [];
  private callIndex = 0;
  private orderedResponses: Array<number | null> = [];

  /**
   * Set a response keyed by a query fragment + window key.
   * For simple tests, use setQueryResponse('pre', value) / setQueryResponse('post', value).
   */
  setResponse(query: string, windowKey: string, value: number | null): void {
    this.responses.set(`${query}:${windowKey}`, value);
  }

  /**
   * Set a response by call order: first call returns first value, second call returns second, etc.
   */
  setQueryResponse(windowKey: 'pre' | 'post', value: number | null): void {
    if (windowKey === 'pre') {
      this.orderedResponses[0] = value;
    } else {
      this.orderedResponses[1] = value;
    }
  }

  /**
   * Set the error rate for a specific service in the mock Prometheus.
   * Used by E2E tests that simulate different error rates at different times.
   */
  setErrorRate(service: string, rate: number): void {
    this.responses.set(`error_rate:${service}`, rate);
  }

  getErrorRate(service: string): number | null {
    return this.responses.get(`error_rate:${service}`) ?? null;
  }

  async queryRangeAverage(
    query: string,
    start: Date,
    end: Date,
    stepSeconds: number,
  ): Promise<number | null> {
    this.callLog.push({ query, start, end, step: stepSeconds });

    // Try ordered responses first
    if (this.orderedResponses.length > 0) {
      const idx = this.callIndex++;
      if (idx < this.orderedResponses.length) {
        return this.orderedResponses[idx];
      }
    }

    // Then try keyed responses
    for (const [key, value] of this.responses) {
      if (key.startsWith(query)) {
        return value;
      }
    }

    return null;
  }

  getCallLog(): ReadonlyArray<{ query: string; start: Date; end: Date; step: number }> {
    return this.callLog;
  }

  resetCallIndex(): void {
    this.callIndex = 0;
    this.callLog = [];
  }
}

// ---------------------------------------------------------------------------
// Mock OpenSearch client
// ---------------------------------------------------------------------------

export interface MockLogEntry {
  message: string;
  timestamp: string;
  level?: string;
}

export class MockOpenSearchClient {
  private logs: Map<string, MockLogEntry[]> = new Map();

  setErrorLogs(service: string, entries: MockLogEntry[]): void {
    this.logs.set(service, entries);
  }

  getErrorLogs(service: string): MockLogEntry[] {
    return this.logs.get(service) ?? [];
  }
}

// ---------------------------------------------------------------------------
// Mock webhook server
// ---------------------------------------------------------------------------

/**
 * In-memory mock webhook for notification tests.
 * Collects posted messages and can simulate failures.
 */
export class MockWebhookServer {
  readonly url: string = 'http://mock-webhook.test/hook';
  messages: string[] = [];
  private failNext = false;
  private rateLimited = false;
  private retryAfter = 0;

  post(message: string): { status: number; retryAfter?: number } {
    if (this.rateLimited) {
      this.rateLimited = false;
      return { status: 429, retryAfter: this.retryAfter };
    }
    if (this.failNext) {
      this.failNext = false;
      return { status: 500 };
    }
    this.messages.push(message);
    return { status: 200 };
  }

  simulateFailure(): void {
    this.failNext = true;
  }

  simulateRateLimit(retryAfterSeconds: number): void {
    this.rateLimited = true;
    this.retryAfter = retryAfterSeconds;
  }

  reset(): void {
    this.messages = [];
    this.failNext = false;
    this.rateLimited = false;
    this.retryAfter = 0;
  }
}

// ---------------------------------------------------------------------------
// Composite mock MCP setup
// ---------------------------------------------------------------------------

export interface MockMcpServers {
  prometheus: MockPrometheusClient;
  opensearch: MockOpenSearchClient;
  mcp: MockMcpClient;
  webhook: MockWebhookServer;
}

/**
 * Set up a complete suite of mock MCP servers for E2E tests.
 */
export function setupMockMcpServers(): MockMcpServers {
  return {
    prometheus: new MockPrometheusClient(),
    opensearch: new MockOpenSearchClient(),
    mcp: new MockMcpClient(),
    webhook: new MockWebhookServer(),
  };
}
