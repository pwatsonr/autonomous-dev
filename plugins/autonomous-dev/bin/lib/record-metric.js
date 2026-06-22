#!/usr/bin/env node
import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// bin/record-metric.ts
import * as fs3 from "fs";
import { join, resolve as resolve3 } from "path";
import { homedir } from "os";
import { randomUUID as randomUUID2, createHash } from "crypto";

// src/agent-factory/parser.ts
function parseAgentFile(filePath) {
  let content;
  try {
    const fs = __require("fs");
    content = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    return {
      success: false,
      errors: [
        {
          message: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`
        }
      ]
    };
  }
  return parseAgentString(content);
}
function parseAgentString(content) {
  const extraction = extractFrontmatter(content);
  if (!extraction.ok) {
    return { success: false, errors: extraction.errors };
  }
  let raw;
  try {
    raw = parseYaml(extraction.yaml);
  } catch (err) {
    if (err instanceof YamlParseError) {
      return {
        success: false,
        errors: [{ message: err.message, line: err.line }]
      };
    }
    return {
      success: false,
      errors: [
        {
          message: `YAML parse error: ${err instanceof Error ? err.message : String(err)}`
        }
      ]
    };
  }
  const agent = mapToParsedAgent(raw, extraction.body);
  return { success: true, agent, errors: [] };
}
function extractFrontmatter(content) {
  const DELIMITER = "---";
  const firstNewline = content.indexOf(`
`);
  if (firstNewline === -1) {
    if (content.replace(/\r$/, "") === DELIMITER) {
      return {
        ok: false,
        errors: [
          { message: "No YAML frontmatter found (opening delimiter but no closing delimiter)" }
        ]
      };
    }
    return {
      ok: false,
      errors: [{ message: "No YAML frontmatter found" }]
    };
  }
  const firstLine = content.substring(0, firstNewline).replace(/\r$/, "");
  if (firstLine !== DELIMITER) {
    return {
      ok: false,
      errors: [{ message: "No YAML frontmatter found" }]
    };
  }
  const afterFirstDelimiter = firstNewline + 1;
  let closingDelimStart = -1;
  let searchPos = afterFirstDelimiter;
  while (searchPos < content.length) {
    const lineEnd = content.indexOf(`
`, searchPos);
    const lineEndPos = lineEnd === -1 ? content.length : lineEnd;
    const line = content.substring(searchPos, lineEndPos).replace(/\r$/, "");
    if (line === DELIMITER) {
      closingDelimStart = searchPos;
      break;
    }
    if (lineEnd === -1)
      break;
    searchPos = lineEnd + 1;
  }
  if (closingDelimStart === -1) {
    return {
      ok: false,
      errors: [
        { message: "No YAML frontmatter found (opening delimiter but no closing delimiter)" }
      ]
    };
  }
  const yaml = content.substring(afterFirstDelimiter, closingDelimStart);
  const closingLineEnd = content.indexOf(`
`, closingDelimStart);
  const body = closingLineEnd === -1 ? "" : content.substring(closingLineEnd + 1);
  return { ok: true, yaml, body };
}

class YamlParseError extends Error {
  line;
  constructor(message, line) {
    super(message);
    this.name = "YamlParseError";
    this.line = line;
  }
}
function parseYaml(yamlStr) {
  const result = {};
  const lines = yamlStr.split(`
`);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].replace(/\r$/, "");
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      throw new YamlParseError(`Invalid YAML at line ${i + 1}: no key-value separator found`, i + 1);
    }
    const key = line.substring(0, colonIdx).trim();
    const rawValue = line.substring(colonIdx + 1).trim();
    if (key === "") {
      throw new YamlParseError(`Invalid YAML at line ${i + 1}: empty key`, i + 1);
    }
    if (rawValue === "" && i + 1 < lines.length) {
      const nextLine = lines[i + 1].replace(/\r$/, "");
      if (/^\s+-\s/.test(nextLine) || /^\s+-$/.test(nextLine)) {
        const items = parseBlockArray(lines, i + 1);
        result[key] = items.values;
        i = items.nextIndex;
        continue;
      }
    }
    if (/^[|>][+-]?$/.test(rawValue)) {
      const folded = rawValue[0] === ">";
      const body = [];
      let j = i + 1;
      while (j < lines.length) {
        const raw = lines[j].replace(/\r$/, "");
        if (raw.trim() === "") {
          body.push("");
          j++;
          continue;
        }
        if (!/^\s/.test(raw))
          break;
        body.push(raw);
        j++;
      }
      const indents = body.filter((l) => l !== "").map((l) => l.match(/^\s*/)[0].length);
      const minIndent = indents.length ? Math.min(...indents) : 0;
      const dedented = body.map((l) => l.slice(minIndent));
      while (dedented.length && dedented[dedented.length - 1] === "")
        dedented.pop();
      result[key] = (folded ? dedented.join(" ") : dedented.join(`
`)).trim();
      i = j;
      continue;
    }
    result[key] = parseScalarValue(rawValue);
    i++;
  }
  return result;
}
function parseBlockArray(lines, startLine) {
  const values = [];
  let i = startLine;
  while (i < lines.length) {
    const line = lines[i].replace(/\r$/, "");
    if (line.trim() !== "" && !line.startsWith(" ") && !line.startsWith("\t")) {
      break;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const dashMatch = line.match(/^(\s+)-\s*(.*)/);
    if (!dashMatch) {
      break;
    }
    const afterDash = dashMatch[2].trim();
    const objColonIdx = afterDash.indexOf(":");
    if (objColonIdx !== -1 && !afterDash.startsWith("[") && !afterDash.startsWith('"') && !afterDash.startsWith("'")) {
      const obj = {};
      const firstKey = afterDash.substring(0, objColonIdx).trim();
      const firstVal = afterDash.substring(objColonIdx + 1).trim();
      obj[firstKey] = parseScalarValue(firstVal);
      i++;
      const dashIndent = dashMatch[1].length + 2;
      while (i < lines.length) {
        const contLine = lines[i].replace(/\r$/, "");
        if (contLine.trim() === "") {
          i++;
          continue;
        }
        const contIndent = contLine.length - contLine.trimStart().length;
        if (contIndent < dashIndent) {
          break;
        }
        const contColonIdx = contLine.indexOf(":");
        if (contColonIdx === -1)
          break;
        const contKey = contLine.substring(0, contColonIdx).trim();
        const contVal = contLine.substring(contColonIdx + 1).trim();
        obj[contKey] = parseScalarValue(contVal);
        i++;
      }
      values.push(obj);
    } else {
      values.push(parseScalarValue(afterDash));
      i++;
    }
  }
  return { values, nextIndex: i };
}
function parseScalarValue(rawValue) {
  if (rawValue === "null" || rawValue === "~" || rawValue === "") {
    return null;
  }
  if (rawValue === "true")
    return true;
  if (rawValue === "false")
    return false;
  if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
    const inner = rawValue.slice(1, -1).trim();
    if (inner === "")
      return [];
    return inner.split(",").map((item) => parseScalarValue(item.trim()));
  }
  if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
    return rawValue.slice(1, -1);
  }
  if (rawValue.startsWith("'") && rawValue.endsWith("'")) {
    return rawValue.slice(1, -1);
  }
  if (/^-?\d+$/.test(rawValue)) {
    return parseInt(rawValue, 10);
  }
  if (/^-?\d+\.\d+$/.test(rawValue)) {
    return parseFloat(rawValue);
  }
  return rawValue;
}
function mapToParsedAgent(raw, body) {
  return {
    name: asString(raw.name),
    version: asString(raw.version),
    role: asString(raw.role),
    model: asString(raw.model),
    temperature: asNumber(raw.temperature),
    turn_limit: asInteger(raw.turn_limit),
    tools: asStringArray(raw.tools),
    expertise: asStringArray(raw.expertise),
    evaluation_rubric: asQualityDimensions(raw.evaluation_rubric),
    version_history: asVersionHistory(raw.version_history),
    risk_tier: raw.risk_tier !== undefined && raw.risk_tier !== null ? asString(raw.risk_tier) : undefined,
    frozen: raw.frozen !== undefined && raw.frozen !== null ? Boolean(raw.frozen) : undefined,
    description: asString(raw.description),
    system_prompt: body
  };
}
function asString(val) {
  if (val === undefined || val === null)
    return "";
  return String(val);
}
function asNumber(val) {
  if (val === undefined || val === null)
    return NaN;
  if (typeof val === "number")
    return val;
  const n = Number(val);
  return isNaN(n) ? NaN : n;
}
function asInteger(val) {
  const n = asNumber(val);
  return isNaN(n) ? NaN : Math.trunc(n);
}
function asStringArray(val) {
  if (!Array.isArray(val))
    return [];
  return val.map((v) => String(v));
}
function asQualityDimensions(val) {
  if (!Array.isArray(val))
    return [];
  return val.map((item) => {
    if (typeof item === "object" && item !== null) {
      const obj = item;
      return {
        name: asString(obj.name),
        weight: asNumber(obj.weight),
        description: asString(obj.description)
      };
    }
    return { name: "", weight: 0, description: "" };
  });
}
function asVersionHistory(val) {
  if (!Array.isArray(val))
    return [];
  return val.map((item) => {
    if (typeof item === "object" && item !== null) {
      const obj = item;
      return {
        version: asString(obj.version),
        date: asString(obj.date),
        change: asString(obj.change)
      };
    }
    return { version: "", date: "", change: "" };
  });
}

// src/agent-factory/metrics/jsonl-writer.ts
import * as fs from "fs";
import * as path from "path";
var defaultLogger = {
  warn: (msg) => console.warn(`[jsonl-writer] ${msg}`)
};

class JsonlWriter {
  filePath;
  logger;
  constructor(filePath, logger) {
    this.filePath = path.resolve(filePath);
    this.logger = logger ?? defaultLogger;
  }
  append(record) {
    this.ensureDirectory();
    const line = JSON.stringify(record) + `
`;
    fs.appendFileSync(this.filePath, line, { encoding: "utf-8" });
  }
  readAll() {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }
    const content = fs.readFileSync(this.filePath, "utf-8");
    const lines = content.split(`
`);
    const metrics = [];
    for (let i = 0;i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === "")
        continue;
      try {
        const parsed = JSON.parse(line);
        metrics.push(parsed);
      } catch {
        this.logger.warn(`Skipping malformed line ${i + 1} in ${this.filePath}: ${line.substring(0, 80)}...`);
      }
    }
    return metrics;
  }
  getFilePath() {
    return this.filePath;
  }
  ensureDirectory() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

// src/agent-factory/metrics/sqlite-store.ts
import * as fs2 from "fs";
import * as path2 from "path";
var BetterSqlite3 = null;
try {
  BetterSqlite3 = __require("better-sqlite3");
} catch {}
var CREATE_TABLES_SQL = `
-- Table 1: agent_invocations
CREATE TABLE IF NOT EXISTS agent_invocations (
  invocation_id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  pipeline_run_id TEXT,
  input_hash TEXT NOT NULL,
  input_domain TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_hash TEXT NOT NULL,
  output_tokens INTEGER NOT NULL,
  output_quality_score REAL NOT NULL,
  review_iteration_count INTEGER NOT NULL,
  review_outcome TEXT NOT NULL,
  reviewer_agent TEXT,
  wall_clock_ms INTEGER NOT NULL,
  turn_count INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'production'
);
CREATE INDEX IF NOT EXISTS idx_invocations_agent ON agent_invocations(agent_name);
CREATE INDEX IF NOT EXISTS idx_invocations_timestamp ON agent_invocations(timestamp);
CREATE INDEX IF NOT EXISTS idx_invocations_domain ON agent_invocations(input_domain);
CREATE INDEX IF NOT EXISTS idx_invocations_pipeline ON agent_invocations(pipeline_run_id);

-- Table 2: quality_dimensions
CREATE TABLE IF NOT EXISTS quality_dimensions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invocation_id TEXT NOT NULL REFERENCES agent_invocations(invocation_id),
  dimension TEXT NOT NULL,
  score REAL NOT NULL,
  weight REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dimensions_invocation ON quality_dimensions(invocation_id);

-- Table 3: tool_calls
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invocation_id TEXT NOT NULL REFERENCES agent_invocations(invocation_id),
  tool_name TEXT NOT NULL,
  invocation_count INTEGER NOT NULL,
  total_duration_ms INTEGER NOT NULL,
  blocked INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_tools_invocation ON tool_calls(invocation_id);

-- Table 4: agent_alerts
CREATE TABLE IF NOT EXISTS agent_alerts (
  alert_id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  evidence TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  acknowledged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alerts_agent ON agent_alerts(agent_name);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON agent_alerts(severity);
CREATE INDEX IF NOT EXISTS idx_alerts_active ON agent_alerts(resolved_at) WHERE resolved_at IS NULL;

-- Table 5: aggregate_snapshots
CREATE TABLE IF NOT EXISTS aggregate_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  window_days INTEGER NOT NULL,
  invocation_count INTEGER NOT NULL,
  approval_rate REAL NOT NULL,
  avg_quality_score REAL NOT NULL,
  median_quality_score REAL NOT NULL,
  stddev_quality_score REAL NOT NULL,
  avg_review_iterations REAL NOT NULL,
  avg_wall_clock_ms REAL NOT NULL,
  avg_turns REAL NOT NULL,
  total_tokens INTEGER NOT NULL,
  trend_direction TEXT NOT NULL,
  trend_slope REAL NOT NULL,
  trend_confidence REAL NOT NULL,
  domain_breakdown TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_agent ON aggregate_snapshots(agent_name);
CREATE INDEX IF NOT EXISTS idx_snapshots_computed ON aggregate_snapshots(computed_at);
`;

class SqliteStore {
  dbPath;
  db = null;
  constructor(dbPath) {
    this.dbPath = path2.resolve(dbPath);
  }
  initialize() {
    if (!BetterSqlite3) {
      throw new Error("better-sqlite3 is not installed. Install it to use SqliteStore.");
    }
    const dir = path2.dirname(this.dbPath);
    if (!fs2.existsSync(dir)) {
      fs2.mkdirSync(dir, { recursive: true });
    }
    this.db = new BetterSqlite3(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(CREATE_TABLES_SQL);
  }
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
  isAvailable() {
    if (!this.db)
      return false;
    try {
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }
  insertInvocation(metric) {
    this.requireDb();
    const insertMain = this.db.prepare(`
      INSERT INTO agent_invocations (
        invocation_id, agent_name, agent_version, pipeline_run_id,
        input_hash, input_domain, input_tokens,
        output_hash, output_tokens, output_quality_score,
        review_iteration_count, review_outcome, reviewer_agent,
        wall_clock_ms, turn_count, timestamp, environment
      ) VALUES (
        @invocation_id, @agent_name, @agent_version, @pipeline_run_id,
        @input_hash, @input_domain, @input_tokens,
        @output_hash, @output_tokens, @output_quality_score,
        @review_iteration_count, @review_outcome, @reviewer_agent,
        @wall_clock_ms, @turn_count, @timestamp, @environment
      )
    `);
    const insertDimension = this.db.prepare(`
      INSERT INTO quality_dimensions (invocation_id, dimension, score, weight)
      VALUES (@invocation_id, @dimension, @score, @weight)
    `);
    const insertToolCall = this.db.prepare(`
      INSERT INTO tool_calls (
        invocation_id, tool_name, invocation_count, total_duration_ms,
        blocked, blocked_reason
      ) VALUES (
        @invocation_id, @tool_name, @invocation_count, @total_duration_ms,
        @blocked, @blocked_reason
      )
    `);
    const transaction = this.db.transaction(() => {
      insertMain.run({
        invocation_id: metric.invocation_id,
        agent_name: metric.agent_name,
        agent_version: metric.agent_version,
        pipeline_run_id: metric.pipeline_run_id,
        input_hash: metric.input_hash,
        input_domain: metric.input_domain,
        input_tokens: metric.input_tokens,
        output_hash: metric.output_hash,
        output_tokens: metric.output_tokens,
        output_quality_score: metric.output_quality_score,
        review_iteration_count: metric.review_iteration_count,
        review_outcome: metric.review_outcome,
        reviewer_agent: metric.reviewer_agent,
        wall_clock_ms: metric.wall_clock_ms,
        turn_count: metric.turn_count,
        timestamp: metric.timestamp,
        environment: metric.environment
      });
      for (const dim of metric.quality_dimensions) {
        insertDimension.run({
          invocation_id: metric.invocation_id,
          dimension: dim.dimension,
          score: dim.score,
          weight: dim.weight
        });
      }
      for (const tc of metric.tool_calls) {
        insertToolCall.run({
          invocation_id: metric.invocation_id,
          tool_name: tc.tool_name,
          invocation_count: tc.invocation_count,
          total_duration_ms: tc.total_duration_ms,
          blocked: tc.blocked ? 1 : 0,
          blocked_reason: tc.blocked_reason ?? null
        });
      }
    });
    transaction();
  }
  getInvocations(agentName, opts) {
    this.requireDb();
    const clauses = ["agent_name = @agentName"];
    const params = { agentName };
    if (opts?.since) {
      clauses.push("timestamp >= @since");
      params.since = opts.since;
    }
    if (opts?.until) {
      clauses.push("timestamp <= @until");
      params.until = opts.until;
    }
    if (opts?.domain) {
      clauses.push("input_domain = @domain");
      params.domain = opts.domain;
    }
    const limit = opts?.limit ? `LIMIT ${Number(opts.limit)}` : "";
    const sql = `
      SELECT * FROM agent_invocations
      WHERE ${clauses.join(" AND ")}
      ORDER BY timestamp DESC
      ${limit}
    `;
    const rows = this.db.prepare(sql).all(params);
    return rows.map((row) => this.hydrateInvocation(row));
  }
  getInvocationsByPipeline(pipelineRunId) {
    this.requireDb();
    const rows = this.db.prepare("SELECT * FROM agent_invocations WHERE pipeline_run_id = ? ORDER BY timestamp ASC").all(pipelineRunId);
    return rows.map((row) => this.hydrateInvocation(row));
  }
  getInvocationCount(agentName, sinceVersion) {
    this.requireDb();
    if (sinceVersion) {
      const row2 = this.db.prepare(`SELECT COUNT(*) as cnt FROM agent_invocations
           WHERE agent_name = ? AND agent_version >= ?`).get(agentName, sinceVersion);
      return row2.cnt;
    }
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM agent_invocations WHERE agent_name = ?").get(agentName);
    return row.cnt;
  }
  insertAlert(alert) {
    this.requireDb();
    this.db.prepare(`
      INSERT INTO agent_alerts (
        alert_id, agent_name, rule_id, severity, message, evidence,
        created_at, resolved_at, acknowledged
      ) VALUES (
        @alert_id, @agent_name, @rule_id, @severity, @message, @evidence,
        @created_at, @resolved_at, @acknowledged
      )
    `).run({
      alert_id: alert.alert_id,
      agent_name: alert.agent_name,
      rule_id: alert.rule_id,
      severity: alert.severity,
      message: alert.message,
      evidence: JSON.stringify(alert.evidence),
      created_at: alert.created_at,
      resolved_at: alert.resolved_at,
      acknowledged: alert.acknowledged ? 1 : 0
    });
  }
  getAlerts(opts) {
    this.requireDb();
    const clauses = [];
    const params = {};
    if (opts?.agentName) {
      clauses.push("agent_name = @agentName");
      params.agentName = opts.agentName;
    }
    if (opts?.severity) {
      clauses.push("severity = @severity");
      params.severity = opts.severity;
    }
    if (opts?.activeOnly) {
      clauses.push("resolved_at IS NULL");
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const sql = `SELECT * FROM agent_alerts ${where} ORDER BY created_at DESC`;
    const rows = this.db.prepare(sql).all(params);
    return rows.map((row) => this.hydrateAlert(row));
  }
  resolveAlert(alertId) {
    this.requireDb();
    const now = new Date().toISOString();
    this.db.prepare("UPDATE agent_alerts SET resolved_at = ? WHERE alert_id = ?").run(now, alertId);
  }
  acknowledgeAlert(alertId) {
    this.requireDb();
    this.db.prepare("UPDATE agent_alerts SET acknowledged = 1 WHERE alert_id = ?").run(alertId);
  }
  findActiveAlert(agentName, ruleId) {
    this.requireDb();
    const row = this.db.prepare(`SELECT * FROM agent_alerts
         WHERE agent_name = ? AND rule_id = ? AND resolved_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`).get(agentName, ruleId);
    if (!row)
      return null;
    return this.hydrateAlert(row);
  }
  countConsecutiveGoodInvocations(agentName, sinceTimestamp, isGood) {
    this.requireDb();
    const rows = this.db.prepare(`SELECT * FROM agent_invocations
         WHERE agent_name = ? AND timestamp >= ?
         ORDER BY timestamp ASC`).all(agentName, sinceTimestamp);
    const metrics = rows.map((row) => this.hydrateInvocation(row));
    let consecutive = 0;
    for (const metric of metrics) {
      if (isGood(metric)) {
        consecutive++;
      } else {
        consecutive = 0;
      }
    }
    return consecutive;
  }
  insertSnapshot(snapshot) {
    this.requireDb();
    this.db.prepare(`
      INSERT INTO aggregate_snapshots (
        snapshot_id, agent_name, computed_at, window_days,
        invocation_count, approval_rate,
        avg_quality_score, median_quality_score, stddev_quality_score,
        avg_review_iterations, avg_wall_clock_ms, avg_turns,
        total_tokens, trend_direction, trend_slope, trend_confidence,
        domain_breakdown
      ) VALUES (
        @snapshot_id, @agent_name, @computed_at, @window_days,
        @invocation_count, @approval_rate,
        @avg_quality_score, @median_quality_score, @stddev_quality_score,
        @avg_review_iterations, @avg_wall_clock_ms, @avg_turns,
        @total_tokens, @trend_direction, @trend_slope, @trend_confidence,
        @domain_breakdown
      )
    `).run({
      snapshot_id: snapshot.snapshot_id,
      agent_name: snapshot.agent_name,
      computed_at: snapshot.computed_at,
      window_days: snapshot.window_days,
      invocation_count: snapshot.invocation_count,
      approval_rate: snapshot.approval_rate,
      avg_quality_score: snapshot.avg_quality_score,
      median_quality_score: snapshot.median_quality_score,
      stddev_quality_score: snapshot.stddev_quality_score,
      avg_review_iterations: snapshot.avg_review_iterations,
      avg_wall_clock_ms: snapshot.avg_wall_clock_ms,
      avg_turns: snapshot.avg_turns,
      total_tokens: snapshot.total_tokens,
      trend_direction: snapshot.trend_direction,
      trend_slope: snapshot.trend_slope,
      trend_confidence: snapshot.trend_confidence,
      domain_breakdown: JSON.stringify(snapshot.domain_breakdown)
    });
  }
  getLatestSnapshot(agentName) {
    this.requireDb();
    const row = this.db.prepare(`SELECT * FROM aggregate_snapshots
         WHERE agent_name = ?
         ORDER BY computed_at DESC
         LIMIT 1`).get(agentName);
    if (!row)
      return null;
    return this.hydrateSnapshot(row);
  }
  getLatestSnapshots(agentName, count) {
    this.requireDb();
    const rows = this.db.prepare(`SELECT * FROM aggregate_snapshots
         WHERE agent_name = ?
         ORDER BY computed_at DESC
         LIMIT ?`).all(agentName, count);
    return rows.map((row) => this.hydrateSnapshot(row));
  }
  deleteInvocationsBefore(cutoffDate) {
    this.requireDb();
    const transaction = this.db.transaction(() => {
      const ids = this.db.prepare("SELECT invocation_id FROM agent_invocations WHERE timestamp < ?").all(cutoffDate);
      if (ids.length === 0)
        return 0;
      const idList = ids.map((r) => r.invocation_id);
      for (const id of idList) {
        this.db.prepare("DELETE FROM quality_dimensions WHERE invocation_id = ?").run(id);
        this.db.prepare("DELETE FROM tool_calls WHERE invocation_id = ?").run(id);
      }
      const result = this.db.prepare("DELETE FROM agent_invocations WHERE timestamp < ?").run(cutoffDate);
      return result.changes;
    });
    return transaction();
  }
  requireDb() {
    if (!this.db) {
      throw new Error("SqliteStore not initialised. Call initialize() first.");
    }
  }
  hydrateInvocation(row) {
    const invocationId = row.invocation_id;
    const dimensions = this.db.prepare("SELECT * FROM quality_dimensions WHERE invocation_id = ?").all(invocationId);
    const toolCalls = this.db.prepare("SELECT * FROM tool_calls WHERE invocation_id = ?").all(invocationId);
    return {
      invocation_id: invocationId,
      agent_name: row.agent_name,
      agent_version: row.agent_version,
      pipeline_run_id: row.pipeline_run_id ?? null,
      input_hash: row.input_hash,
      input_domain: row.input_domain,
      input_tokens: row.input_tokens,
      output_hash: row.output_hash,
      output_tokens: row.output_tokens,
      output_quality_score: row.output_quality_score,
      review_iteration_count: row.review_iteration_count,
      review_outcome: row.review_outcome,
      reviewer_agent: row.reviewer_agent ?? null,
      wall_clock_ms: row.wall_clock_ms,
      turn_count: row.turn_count,
      timestamp: row.timestamp,
      environment: row.environment,
      quality_dimensions: dimensions.map((d) => ({
        dimension: d.dimension,
        score: d.score,
        weight: d.weight
      })),
      tool_calls: toolCalls.map((tc) => ({
        tool_name: tc.tool_name,
        invocation_count: tc.invocation_count,
        total_duration_ms: tc.total_duration_ms,
        blocked: tc.blocked === 1,
        ...tc.blocked_reason ? { blocked_reason: tc.blocked_reason } : {}
      }))
    };
  }
  hydrateAlert(row) {
    return {
      alert_id: row.alert_id,
      agent_name: row.agent_name,
      rule_id: row.rule_id,
      severity: row.severity,
      message: row.message,
      evidence: JSON.parse(row.evidence),
      created_at: row.created_at,
      resolved_at: row.resolved_at ?? null,
      acknowledged: row.acknowledged === 1
    };
  }
  hydrateSnapshot(row) {
    return {
      snapshot_id: row.snapshot_id,
      agent_name: row.agent_name,
      computed_at: row.computed_at,
      window_days: row.window_days,
      invocation_count: row.invocation_count,
      approval_rate: row.approval_rate,
      avg_quality_score: row.avg_quality_score,
      median_quality_score: row.median_quality_score,
      stddev_quality_score: row.stddev_quality_score,
      avg_review_iterations: row.avg_review_iterations,
      avg_wall_clock_ms: row.avg_wall_clock_ms,
      avg_turns: row.avg_turns,
      total_tokens: row.total_tokens,
      trend_direction: row.trend_direction,
      trend_slope: row.trend_slope,
      trend_confidence: row.trend_confidence,
      domain_breakdown: JSON.parse(row.domain_breakdown)
    };
  }
}

// src/agent-factory/metrics/engine.ts
import { randomUUID } from "crypto";

// src/agent-factory/metrics/aggregator.ts
function linearRegression(points) {
  const n = points.length;
  if (n < 2) {
    return {
      direction: "stable",
      slope: 0,
      confidence: 0,
      sample_size: n,
      low_confidence: true
    };
  }
  const lowConfidence = n < 5;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  for (let i = 0;i < n; i++) {
    sumX += i;
    sumY += points[i];
    sumXY += i * points[i];
    sumX2 += i * i;
  }
  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) {
    return {
      direction: "stable",
      slope: 0,
      confidence: 0,
      sample_size: n,
      low_confidence: lowConfidence
    };
  }
  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  const meanY = sumY / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0;i < n; i++) {
    const predicted = slope * i + intercept;
    ssRes += (points[i] - predicted) ** 2;
    ssTot += (points[i] - meanY) ** 2;
  }
  let rSquared;
  if (ssTot === 0) {
    rSquared = 0;
  } else {
    rSquared = 1 - ssRes / ssTot;
  }
  let direction;
  if (lowConfidence) {
    direction = "stable";
  } else if (slope > 0.05 && rSquared > 0.3) {
    direction = "improving";
  } else if (slope < -0.05 && rSquared > 0.3) {
    direction = "declining";
  } else {
    direction = "stable";
  }
  return {
    direction,
    slope,
    confidence: rSquared,
    sample_size: n,
    low_confidence: lowConfidence
  };
}
var DEFAULT_WINDOW_DAYS = 30;
var TREND_SAMPLE_SIZE = 20;

class MetricsAggregator {
  windowDays;
  constructor(windowDays = DEFAULT_WINDOW_DAYS) {
    this.windowDays = windowDays;
  }
  compute(agentName, allInvocations) {
    const windowStart = this.getWindowStart();
    const invocations = allInvocations.filter((m) => m.agent_name === agentName && m.timestamp >= windowStart);
    if (invocations.length === 0) {
      return null;
    }
    invocations.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const count = invocations.length;
    const approvedCount = invocations.filter((m) => m.review_outcome === "approved").length;
    const approvalRate = approvedCount / count;
    const qualityScores = invocations.map((m) => m.output_quality_score);
    const avgQualityScore = mean(qualityScores);
    const medianQualityScore = median(qualityScores);
    const stddevQualityScore = stddev(qualityScores);
    const avgReviewIterations = mean(invocations.map((m) => m.review_iteration_count));
    const avgWallClockMs = mean(invocations.map((m) => m.wall_clock_ms));
    const avgTurns = mean(invocations.map((m) => m.turn_count));
    const totalTokens = invocations.reduce((sum, m) => sum + m.input_tokens + m.output_tokens, 0);
    const trendInvocations = invocations.slice(-TREND_SAMPLE_SIZE);
    const trendScores = trendInvocations.map((m) => m.output_quality_score);
    const trend = linearRegression(trendScores);
    const domainBreakdown = this.computeDomainBreakdown(invocations);
    return {
      agent_name: agentName,
      window_days: this.windowDays,
      invocation_count: count,
      approval_rate: approvalRate,
      avg_quality_score: avgQualityScore,
      median_quality_score: medianQualityScore,
      stddev_quality_score: stddevQualityScore,
      avg_review_iterations: avgReviewIterations,
      avg_wall_clock_ms: avgWallClockMs,
      avg_turns: avgTurns,
      total_tokens: totalTokens,
      trend,
      domain_breakdown: domainBreakdown
    };
  }
  getWindowStart() {
    const now = new Date;
    now.setDate(now.getDate() - this.windowDays);
    return now.toISOString();
  }
  computeDomainBreakdown(invocations) {
    const groups = new Map;
    for (const m of invocations) {
      const existing = groups.get(m.input_domain);
      if (existing) {
        existing.push(m);
      } else {
        groups.set(m.input_domain, [m]);
      }
    }
    const breakdown = {};
    for (const [domain, metrics] of groups) {
      const count = metrics.length;
      const approved = metrics.filter((m) => m.review_outcome === "approved").length;
      breakdown[domain] = {
        invocation_count: count,
        approval_rate: approved / count,
        avg_quality_score: mean(metrics.map((m) => m.output_quality_score))
      };
    }
    return breakdown;
  }
}
function mean(values) {
  if (values.length === 0)
    return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
function median(values) {
  if (values.length === 0)
    return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}
function stddev(values) {
  if (values.length === 0)
    return 0;
  const avg = mean(values);
  const squaredDiffs = values.map((v) => (v - avg) ** 2);
  return Math.sqrt(mean(squaredDiffs));
}

// src/agent-factory/metrics/engine.ts
var defaultLogger2 = {
  warn: (msg) => console.warn(`[metrics-engine] ${msg}`),
  info: (msg) => console.info(`[metrics-engine] ${msg}`),
  error: (msg) => console.error(`[metrics-engine] ${msg}`)
};
var DEFAULT_BUFFER_MAX_SIZE = 1000;
var DEFAULT_HEALTH_CHECK_INTERVAL_MS = 60000;
var DEFAULT_HEALTH_CHECK_RECORD_INTERVAL = 10;

class MetricsEngine {
  jsonlWriter;
  sqliteStore;
  logger;
  aggregator;
  anomalyDetector;
  observationTrigger;
  eventListeners = new Map;
  sqliteAvailable = true;
  buffer;
  healthCheckIntervalMs;
  healthCheckRecordInterval;
  lastHealthCheckTime = Date.now();
  recordsSinceLastHealthCheck = 0;
  snapshotCache = new Map;
  constructor(opts) {
    this.jsonlWriter = opts.jsonlWriter;
    this.sqliteStore = opts.sqliteStore;
    this.logger = opts.logger ?? defaultLogger2;
    this.aggregator = opts.aggregator ?? new MetricsAggregator;
    this.anomalyDetector = opts.anomalyDetector ?? null;
    this.observationTrigger = opts.observationTrigger ?? null;
    const maxSize = opts.bufferMaxSize ?? DEFAULT_BUFFER_MAX_SIZE;
    this.buffer = {
      records: [],
      maxSize,
      droppedCount: 0,
      enteredDegradedAt: null
    };
    this.healthCheckIntervalMs = opts.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    this.healthCheckRecordInterval = opts.healthCheckRecordInterval ?? DEFAULT_HEALTH_CHECK_RECORD_INTERVAL;
    this.sqliteAvailable = this.checkSqliteHealth();
    if (!this.sqliteAvailable) {
      this.enterDegradedMode();
    }
  }
  record(metric) {
    this.jsonlWriter.append(metric);
    if (this.sqliteAvailable) {
      try {
        this.sqliteStore.insertInvocation(metric);
        if (this.buffer.records.length > 0) {
          this.replayBuffer();
        }
      } catch (err) {
        this.logger.warn(`SQLite write failed, metric buffered: ${err instanceof Error ? err.message : String(err)}`);
        this.bufferRecord(metric);
        this.enterDegradedMode();
      }
    } else {
      this.bufferRecord(metric);
      this.maybeRetryHealth();
    }
    if (this.sqliteAvailable) {
      this.runPostRecordHooks(metric.agent_name);
    } else {
      this.logger.warn("Anomaly detection and aggregation paused — SQLite unavailable");
    }
    if (this.observationTrigger) {
      try {
        const decision = this.observationTrigger.check(metric.agent_name, metric.agent_version);
        if (decision.triggered) {
          this.emit("analysis_triggered", {
            agentName: metric.agent_name,
            decision
          });
        }
      } catch (err) {
        this.logger.error(`Observation trigger failed for '${metric.agent_name}': ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  getInvocations(agentName, opts) {
    if (this.sqliteAvailable) {
      try {
        return this.sqliteStore.getInvocations(agentName, {
          since: opts?.since,
          until: opts?.until,
          domain: opts?.domain,
          limit: opts?.limit
        });
      } catch {
        this.logger.warn("SQLite query failed for getInvocations, falling back to JSONL");
      }
    }
    return this.getInvocationsFromJsonl(agentName, opts);
  }
  getAggregate(agentName) {
    if (this.sqliteAvailable) {
      try {
        const snapshot = this.sqliteStore.getLatestSnapshot(agentName);
        if (!snapshot)
          return null;
        const aggregate = this.snapshotToAggregate(snapshot);
        this.snapshotCache.set(agentName, aggregate);
        return aggregate;
      } catch {
        this.logger.warn("Failed to retrieve aggregate snapshot from SQLite");
      }
    }
    return this.snapshotCache.get(agentName) ?? null;
  }
  getAlerts(opts) {
    if (this.sqliteAvailable) {
      try {
        return this.sqliteStore.getAlerts({
          agentName: opts?.agentName,
          severity: opts?.severity,
          activeOnly: opts?.activeOnly
        });
      } catch {
        this.logger.warn("Failed to retrieve alerts from SQLite");
      }
    }
    this.logger.warn("Alert query unavailable — SQLite is in degraded mode");
    return [];
  }
  evaluateAnomalies(agentName) {
    if (!this.sqliteAvailable) {
      this.logger.warn(`Anomaly evaluation skipped for '${agentName}' — SQLite unavailable`);
      return [];
    }
    if (!this.anomalyDetector) {
      return [];
    }
    try {
      return this.anomalyDetector.evaluate(agentName);
    } catch (err) {
      this.logger.error(`Anomaly evaluation failed for '${agentName}': ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
  on(event, listener) {
    const listeners = this.eventListeners.get(event) ?? [];
    listeners.push(listener);
    this.eventListeners.set(event, listeners);
  }
  off(event, listener) {
    const listeners = this.eventListeners.get(event);
    if (!listeners)
      return;
    const index = listeners.indexOf(listener);
    if (index !== -1) {
      listeners.splice(index, 1);
    }
  }
  emit(event, payload) {
    const listeners = this.eventListeners.get(event);
    if (!listeners || listeners.length === 0)
      return;
    for (const listener of listeners) {
      try {
        listener(payload);
      } catch (err) {
        this.logger.error(`Event listener error for '${event}': ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  isDegraded() {
    return !this.sqliteAvailable;
  }
  getBufferState() {
    return { ...this.buffer, records: [...this.buffer.records] };
  }
  getPendingBufferSize() {
    return this.buffer.records.length;
  }
  isSqliteAvailable() {
    return this.sqliteAvailable;
  }
  attemptRecovery() {
    if (this.sqliteAvailable)
      return true;
    const available = this.checkSqliteHealth();
    if (available) {
      this.recoverFromDegraded();
      return true;
    }
    return false;
  }
  enterDegradedMode() {
    if (!this.sqliteAvailable)
      return;
    this.sqliteAvailable = false;
    this.buffer.enteredDegradedAt = new Date().toISOString();
    this.recordsSinceLastHealthCheck = 0;
    this.lastHealthCheckTime = Date.now();
    this.logger.warn(`Entered degraded mode at ${this.buffer.enteredDegradedAt}`);
  }
  recoverFromDegraded() {
    this.logger.info("SQLite recovered — replaying buffered records");
    this.sqliteAvailable = true;
    this.replayBuffer();
    this.buffer.enteredDegradedAt = null;
    this.logger.info("Exited degraded mode");
  }
  bufferRecord(metric) {
    if (this.buffer.records.length >= this.buffer.maxSize) {
      this.buffer.records.shift();
      this.buffer.droppedCount++;
      this.logger.warn(`Buffer full (${this.buffer.maxSize}): dropped oldest record ` + `(total dropped: ${this.buffer.droppedCount})`);
    }
    this.buffer.records.push(metric);
  }
  replayBuffer() {
    if (this.buffer.records.length === 0)
      return;
    const sorted = [...this.buffer.records].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    let replayed = 0;
    const failures = [];
    for (const record of sorted) {
      try {
        this.sqliteStore.insertInvocation(record);
        replayed++;
      } catch (err) {
        this.logger.warn(`Replay failed for ${record.invocation_id}: ${err instanceof Error ? err.message : String(err)}`);
        failures.push(record);
      }
    }
    this.logger.info(`Replayed ${replayed}/${sorted.length} buffered records to SQLite`);
    if (failures.length > 0) {
      this.buffer.records = failures;
      this.sqliteAvailable = false;
      this.logger.warn(`${failures.length} records failed replay — remaining in buffer`);
    } else {
      this.buffer.records = [];
      this.buffer.droppedCount = 0;
    }
  }
  checkSqliteHealth() {
    try {
      return this.sqliteStore.isAvailable();
    } catch {
      return false;
    }
  }
  maybeRetryHealth() {
    this.recordsSinceLastHealthCheck++;
    const elapsed = Date.now() - this.lastHealthCheckTime;
    if (elapsed >= this.healthCheckIntervalMs || this.recordsSinceLastHealthCheck >= this.healthCheckRecordInterval) {
      this.lastHealthCheckTime = Date.now();
      this.recordsSinceLastHealthCheck = 0;
      const available = this.checkSqliteHealth();
      if (available) {
        this.recoverFromDegraded();
      }
    }
  }
  runPostRecordHooks(agentName) {
    try {
      this.recomputeAggregate(agentName);
    } catch (err) {
      this.logger.error(`Post-record aggregate recomputation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.anomalyDetector) {
      try {
        this.anomalyDetector.autoResolve(agentName);
      } catch (err) {
        this.logger.error(`Post-record auto-resolution failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        this.anomalyDetector.evaluate(agentName);
      } catch (err) {
        this.logger.error(`Post-record anomaly evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  recomputeAggregate(agentName) {
    const invocations = this.getInvocations(agentName);
    const aggregate = this.aggregator.compute(agentName, invocations);
    if (!aggregate)
      return;
    const snapshot = {
      snapshot_id: randomUUID(),
      agent_name: aggregate.agent_name,
      computed_at: new Date().toISOString(),
      window_days: aggregate.window_days,
      invocation_count: aggregate.invocation_count,
      approval_rate: aggregate.approval_rate,
      avg_quality_score: aggregate.avg_quality_score,
      median_quality_score: aggregate.median_quality_score,
      stddev_quality_score: aggregate.stddev_quality_score,
      avg_review_iterations: aggregate.avg_review_iterations,
      avg_wall_clock_ms: aggregate.avg_wall_clock_ms,
      avg_turns: aggregate.avg_turns,
      total_tokens: aggregate.total_tokens,
      trend_direction: aggregate.trend.direction,
      trend_slope: aggregate.trend.slope,
      trend_confidence: aggregate.trend.confidence,
      domain_breakdown: aggregate.domain_breakdown
    };
    try {
      this.sqliteStore.insertSnapshot(snapshot);
      this.snapshotCache.set(agentName, aggregate);
    } catch (err) {
      this.logger.warn(`Failed to store aggregate snapshot: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  getInvocationsFromJsonl(agentName, opts) {
    const allMetrics = this.jsonlWriter.readAll();
    let filtered = allMetrics.filter((m) => m.agent_name === agentName);
    if (opts?.since) {
      filtered = filtered.filter((m) => m.timestamp >= opts.since);
    }
    if (opts?.until) {
      filtered = filtered.filter((m) => m.timestamp <= opts.until);
    }
    if (opts?.domain) {
      filtered = filtered.filter((m) => m.input_domain === opts.domain);
    }
    if (opts?.environment) {
      filtered = filtered.filter((m) => m.environment === opts.environment);
    }
    filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    if (opts?.limit && opts.limit > 0) {
      filtered = filtered.slice(0, opts.limit);
    }
    return filtered;
  }
  snapshotToAggregate(snapshot) {
    return {
      agent_name: snapshot.agent_name,
      window_days: snapshot.window_days,
      invocation_count: snapshot.invocation_count,
      approval_rate: snapshot.approval_rate,
      avg_quality_score: snapshot.avg_quality_score,
      median_quality_score: snapshot.median_quality_score,
      stddev_quality_score: snapshot.stddev_quality_score,
      avg_review_iterations: snapshot.avg_review_iterations,
      avg_wall_clock_ms: snapshot.avg_wall_clock_ms,
      avg_turns: snapshot.avg_turns,
      total_tokens: snapshot.total_tokens,
      trend: {
        direction: snapshot.trend_direction,
        slope: snapshot.trend_slope,
        confidence: snapshot.trend_confidence,
        sample_size: snapshot.invocation_count,
        low_confidence: snapshot.invocation_count < 5
      },
      domain_breakdown: snapshot.domain_breakdown
    };
  }
}

// bin/record-metric.ts
var __dirname = "/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/bin";
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function clamp(n, lo, hi) {
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
}
function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}
function defaultDataDir() {
  const override = process.env["AUTONOMOUS_DEV_AGENT_FACTORY_DATA_DIR"];
  if (override && override.length > 0)
    return override;
  const stateDir = process.env["AUTONOMOUS_DEV_STATE_DIR"];
  const base = stateDir && stateDir.length > 0 ? stateDir : join(homedir(), ".autonomous-dev");
  return join(base, "agent-factory");
}
var VALID_OUTCOMES = [
  "approved",
  "rejected",
  "revision_requested",
  "not_reviewed"
];
function main() {
  const agent = arg("agent");
  if (!agent) {
    console.error("record-metric: --agent is required");
    return 1;
  }
  const requestId = arg("request-id") ?? null;
  const outcomeRaw = arg("outcome", "approved") ?? "approved";
  const outcome = VALID_OUTCOMES.includes(outcomeRaw) ? outcomeRaw : "approved";
  const score = clamp(parseFloat(arg("score", "4")), 1, 5);
  const reviewer = arg("reviewer") || null;
  const domain = arg("domain", "general");
  const retries = Math.max(0, parseInt(arg("retries", "0"), 10) || 0);
  const wallClockMs = Math.max(0, parseInt(arg("wall-clock-ms", "0"), 10) || 0);
  const turns = Math.max(0, parseInt(arg("turns", "0"), 10) || 0);
  const agentsDir = arg("agents-dir", resolve3(__dirname, "..", "agents"));
  const dataDir = arg("data-dir", defaultDataDir());
  let version = "0.0.0";
  let rubric = [];
  try {
    const parsed = parseAgentFile(join(agentsDir, `${agent}.md`));
    if (parsed.success && parsed.agent) {
      version = parsed.agent.version || "0.0.0";
      rubric = parsed.agent.evaluation_rubric || [];
    }
  } catch {}
  const quality_dimensions = rubric.length > 0 ? rubric.map((r) => ({ dimension: r.name, score, weight: r.weight ?? 1 / rubric.length })) : [{ dimension: "overall", score, weight: 1 }];
  const now = new Date().toISOString();
  const id = randomUUID2();
  const metric = {
    invocation_id: id,
    agent_name: agent,
    agent_version: version,
    pipeline_run_id: requestId,
    input_hash: sha256(`${requestId}:${agent}:${now}:in`),
    input_domain: domain,
    input_tokens: 0,
    output_hash: sha256(`${requestId}:${agent}:${now}:out`),
    output_tokens: 0,
    output_quality_score: score,
    quality_dimensions,
    review_iteration_count: retries,
    review_outcome: outcome,
    reviewer_agent: reviewer,
    wall_clock_ms: wallClockMs,
    turn_count: turns,
    tool_calls: [],
    timestamp: now,
    environment: "production"
  };
  fs3.mkdirSync(dataDir, { recursive: true });
  const sqliteStore = new SqliteStore(join(dataDir, "agent-metrics.db"));
  try {
    sqliteStore.initialize();
  } catch (err) {
    console.error(`record-metric: sqlite unavailable (${err instanceof Error ? err.message : String(err)}); recording to JSONL only`);
  }
  const engine = new MetricsEngine({
    jsonlWriter: new JsonlWriter(join(dataDir, "agent-metrics.jsonl")),
    sqliteStore
  });
  engine.record(metric);
  sqliteStore.close();
  console.log(JSON.stringify({ recorded: true, invocation_id: id, agent, version, score, outcome, domain }));
  return 0;
}
try {
  process.exit(main());
} catch (err) {
  console.error(`record-metric: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
