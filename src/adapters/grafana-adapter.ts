/**
 * Grafana MCP data collection adapter (SPEC-007-1-3, Task 8).
 *
 * Retrieves alert states and deploy annotations from Grafana dashboards
 * via MCP tool calls. Respects query budgets and handles unreachable
 * sources gracefully.
 */

import type {
  McpToolCaller,
  QueryBudgetTracker,
  GrafanaAlertResult,
  GrafanaAlertState,
  GrafanaAlert,
  GrafanaAnnotationResult,
  GrafanaAnnotation,
  DataSourceName,
  ConnectivityReport,
} from './types';
import { AdapterTimeoutError } from './types';

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, queryName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AdapterTimeoutError('grafana', queryName, ms)),
      ms,
    );
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ---------------------------------------------------------------------------
// Response parsing helpers
// ---------------------------------------------------------------------------

/** Valid alert state values for runtime validation. */
const VALID_ALERT_STATES: readonly string[] = ['alerting', 'pending', 'ok', 'no_data'];

function isValidAlertState(state: string): state is GrafanaAlertState {
  return VALID_ALERT_STATES.includes(state);
}

/**
 * Parses a Grafana list_alerts response into structured alert results.
 *
 * Grafana alert list responses vary by version but generally contain
 * an array of alert objects with name, state, dashboardUID, and
 * newStateDate fields.
 */
function parseAlertResponse(
  raw: unknown,
  dashboardUid: string,
): GrafanaAlertResult {
  const items = Array.isArray(raw) ? raw : [];

  const alerts: GrafanaAlert[] = items
    .filter((item: Record<string, unknown>) => {
      const state = String(item.state ?? '').toLowerCase();
      return isValidAlertState(state);
    })
    .map((item: Record<string, unknown>) => ({
      name: String(item.name ?? (item.labels as Record<string, unknown> | undefined)?.alertname ?? ''),
      state: String(item.state ?? '').toLowerCase() as GrafanaAlertState,
      dashboard_uid: String(item.dashboardUID ?? item.dashboard_uid ?? dashboardUid),
      since: String(item.newStateDate ?? item.activeAt ?? item.since ?? ''),
      annotations: item.annotations as Record<string, string> | undefined,
    }));

  return { alerts };
}

/**
 * Parses a Grafana get_annotations response into structured annotation results.
 *
 * Grafana annotation responses contain an array of objects with id, time,
 * text, tags, and dashboardUID fields.
 */
function parseAnnotationResponse(
  raw: unknown,
  dashboardUid: string,
): GrafanaAnnotationResult {
  const items = Array.isArray(raw) ? raw : [];

  const annotations: GrafanaAnnotation[] = items.map(
    (item: Record<string, unknown>) => ({
      id: Number(item.id ?? 0),
      time: typeof item.time === 'number'
        ? new Date(item.time).toISOString()
        : String(item.time ?? item.created ?? ''),
      text: String(item.text ?? ''),
      tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
      dashboard_uid: String(item.dashboardUID ?? item.dashboard_uid ?? dashboardUid),
    }),
  );

  return { annotations };
}

// ---------------------------------------------------------------------------
// GrafanaAdapter
// ---------------------------------------------------------------------------

export class GrafanaAdapter {
  private readonly source: DataSourceName = 'grafana';

  constructor(
    private readonly mcp: McpToolCaller,
    private readonly budget: QueryBudgetTracker,
    private readonly connectivity?: ConnectivityReport,
  ) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Lists active alerts for a Grafana dashboard, filtered by state.
   *
   * Returns empty results if the source is unreachable or the budget is
   * exhausted.
   *
   * @param dashboardUid  The Grafana dashboard UID to query
   * @param states        Alert states to filter for (default: alerting, pending)
   * @param serviceName   Service name for budget tracking
   * @returns GrafanaAlertResult with matching alerts
   */
  async listAlerts(
    dashboardUid: string,
    states: string[] = ['alerting', 'pending'],
    serviceName: string = dashboardUid,
  ): Promise<GrafanaAlertResult> {
    if (this.isUnreachable()) {
      return { alerts: [] };
    }

    if (!this.budget.canQuery(this.source, serviceName)) {
      return { alerts: [] };
    }

    const timeoutMs = this.budget.getTimeoutMs(this.source);
    const raw = await withTimeout(
      this.mcp.callTool('grafana_list_alerts', {
        dashboard_uid: dashboardUid,
        state: states.join(','),
      }),
      timeoutMs,
      'list_alerts',
    );
    this.budget.recordQuery(this.source, serviceName);

    const result = parseAlertResponse(raw, dashboardUid);

    // Filter to only the requested states
    result.alerts = result.alerts.filter((a) =>
      states.includes(a.state),
    );

    return result;
  }

  /**
   * Retrieves deploy annotations for a Grafana dashboard within a time
   * window.
   *
   * Queries annotations with the specified tags (default: "deploy") from
   * the last N hours.
   *
   * @param dashboardUid  The Grafana dashboard UID to query
   * @param windowHours   Lookback window in hours (default 4)
   * @param tags          Annotation tags to filter for (default: ["deploy"])
   * @param serviceName   Service name for budget tracking
   * @returns GrafanaAnnotationResult with matching annotations
   */
  async getAnnotations(
    dashboardUid: string,
    windowHours: number = 4,
    tags: string[] = ['deploy'],
    serviceName: string = dashboardUid,
  ): Promise<GrafanaAnnotationResult> {
    if (this.isUnreachable()) {
      return { annotations: [] };
    }

    if (!this.budget.canQuery(this.source, serviceName)) {
      return { annotations: [] };
    }

    const now = new Date();
    const from = new Date(now.getTime() - windowHours * 60 * 60 * 1000);

    const timeoutMs = this.budget.getTimeoutMs(this.source);
    const raw = await withTimeout(
      this.mcp.callTool('grafana_get_annotations', {
        dashboard_uid: dashboardUid,
        from: from.toISOString(),
        to: now.toISOString(),
        tags,
      }),
      timeoutMs,
      'get_annotations',
    );
    this.budget.recordQuery(this.source, serviceName);

    return parseAnnotationResponse(raw, dashboardUid);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Checks whether Grafana was classified as unreachable during
   * connectivity validation.
   */
  private isUnreachable(): boolean {
    if (!this.connectivity) return false;
    const grafanaResult = this.connectivity.results.find(
      (r) => r.source === 'grafana',
    );
    return grafanaResult?.status === 'unreachable';
  }
}
