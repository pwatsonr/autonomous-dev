#!/usr/bin/env node
// scripts/ci/aggregate-spend.js
//
// Downloads recent spend-* artifacts from the GitHub Actions API,
// runs each through the HMAC verifier (in-process, sharing the same
// canonical-json helper used by the producer), filters to the current
// UTC month within a 32-day age cap, and emits aggregated outputs
// (`total_spend`, `budget_limit`, `percentage`) to $GITHUB_OUTPUT.
//
// SPEC-017-4-02 task 3.
//
// Exit codes:
//   0 — aggregation completed (downstream warn/fail/critical steps
//       decide the gate verdict from the percentage output)
//   2 — configuration error (missing env vars)
//
// HMAC verification failures are logged via ::warning:: and the
// failing artifact is excluded from the sum. The aggregator never
// fails the gate by itself; doing so would let a tamper attempt DoS
// the gate (see PLAN-017-4 risk row 5 / SPEC §Notes).
//
// Env (required unless noted):
//   GITHUB_TOKEN              GitHub API auth (provided by Actions runner)
//   GITHUB_REPOSITORY         "owner/repo" (provided by Actions runner)
//   BUDGET_HMAC_KEY           current HMAC secret
//   BUDGET_HMAC_KEY_PREVIOUS  optional rotation-overlap fallback
//   CLAUDE_MONTHLY_BUDGET_USD positive number; budget ceiling
//   GITHUB_OUTPUT             path to step-output file (provided by runner)
//   GITHUB_STEP_SUMMARY       optional path to step-summary markdown file

'use strict';

const fs = require('node:fs');
const https = require('node:https');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const zlib = require('node:zlib');
const { canonicalize } = require('./canonical-json');

const GITHUB_API_HOST = 'api.github.com';
const ARTIFACT_PREFIX = 'spend-';
const AGE_CAP_MS = 32 * 24 * 60 * 60 * 1000; // 32-day cap per TDD §22.1
const DOWNLOAD_BATCH = 8; // PLAN-017-4 risk row 5

// --------------------------------------------------------------------
// HTTP helpers (default implementation; tests inject a mock).
// --------------------------------------------------------------------

function defaultHttpJson(token, pathStr) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: GITHUB_API_HOST,
        path: pathStr,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'autonomous-dev-budget-gate',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`GitHub API ${pathStr} -> ${res.statusCode}: ${body}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`Invalid JSON from ${pathStr}: ${err.message}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function defaultHttpDownload(token, urlString) {
  // Follows up to 5 redirects (GitHub returns a 302 to the real
  // artifact storage URL). Returns a Buffer of the response body.
  return new Promise((resolve, reject) => {
    const fetch = (currentUrl, hops) => {
      if (hops > 5) {
        reject(new Error(`Too many redirects fetching ${urlString}`));
        return;
      }
      const u = new URL(currentUrl);
      const req = https.request(
        {
          host: u.host,
          path: u.pathname + u.search,
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'autonomous-dev-budget-gate',
          },
        },
        (res) => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            res.resume();
            fetch(res.headers.location, hops + 1);
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Download ${urlString} -> ${res.statusCode}`));
            return;
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        },
      );
      req.on('error', reject);
      req.end();
    };
    fetch(urlString, 0);
  });
}

// --------------------------------------------------------------------
// Pure helpers.
// --------------------------------------------------------------------

function verifyHmac(payloadObj, claimed, candidateKeys) {
  if (typeof claimed !== 'string' || claimed.length === 0) return false;
  let claimedBuf;
  try {
    claimedBuf = Buffer.from(claimed, 'hex');
  } catch (_err) {
    return false;
  }
  const canonical = canonicalize(payloadObj);
  for (const key of candidateKeys) {
    const computed = crypto
      .createHmac('sha256', key)
      .update(canonical)
      .digest();
    if (
      computed.length === claimedBuf.length &&
      crypto.timingSafeEqual(computed, claimedBuf)
    ) {
      return true;
    }
  }
  return false;
}

function extractZipFirstFile(buf) {
  // Minimal ZIP central-directory walker: finds the End-of-Central-
  // Directory record, then the first local file header, and inflates
  // the entry. Spend artifacts are uploaded as a single-file ZIP, so
  // we deliberately keep this code small instead of pulling in JSZip.
  const eocdSig = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === eocdSig) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('Not a ZIP archive (no EOCD)');
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  // Read first central-directory entry to find compression and offset.
  const cdSig = 0x02014b50;
  if (buf.readUInt32LE(cdOffset) !== cdSig) {
    throw new Error('Invalid ZIP central directory signature');
  }
  const compression = buf.readUInt16LE(cdOffset + 10);
  const compSize = buf.readUInt32LE(cdOffset + 20);
  const localHeaderOffset = buf.readUInt32LE(cdOffset + 42);

  // Walk the local file header to find the data start.
  const lfhSig = 0x04034b50;
  if (buf.readUInt32LE(localHeaderOffset) !== lfhSig) {
    throw new Error('Invalid ZIP local file header signature');
  }
  const fileNameLen = buf.readUInt16LE(localHeaderOffset + 26);
  const extraLen = buf.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + fileNameLen + extraLen;
  const compressed = buf.slice(dataStart, dataStart + compSize);

  if (compression === 0) return compressed;
  if (compression === 8) return zlib.inflateRawSync(compressed);
  throw new Error(`Unsupported ZIP compression method ${compression}`);
}

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size);
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(slice.map(fn));
    out.push(...results);
  }
  return out;
}

function currentMonthBucket(now) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function readCostUsd(payload) {
  // The producers (emit-spend-artifact.sh, emit-spend-estimate.sh)
  // emit `estimated_cost_usd` (sometimes string-typed via jq --arg).
  // The aggregator accepts both types and falls back to `cost_usd`
  // for forward compat with future emitters.
  const candidates = [payload.estimated_cost_usd, payload.cost_usd];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
    if (typeof c === 'string' && c.length > 0) {
      const n = Number(c);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// --------------------------------------------------------------------
// Main aggregation flow (importable for tests).
// --------------------------------------------------------------------

async function aggregate(opts) {
  const {
    token,
    repository,
    candidateKeys,
    budgetLimit,
    now = new Date(),
    httpJson = defaultHttpJson,
    httpDownload = defaultHttpDownload,
    log = console,
  } = opts;

  const monthBucket = currentMonthBucket(now);
  const ageCutoff = now.getTime() - AGE_CAP_MS;

  // 1. List artifacts (paginated; stop when the page is older than cutoff).
  const allArtifacts = [];
  for (let page = 1; page <= 20; page++) {
    // eslint-disable-next-line no-await-in-loop
    const resp = await httpJson(
      token,
      `/repos/${repository}/actions/artifacts?per_page=100&page=${page}`,
    );
    const arts = resp.artifacts || [];
    if (arts.length === 0) break;
    allArtifacts.push(...arts);
    // Heuristic stop: if the oldest item on this page is older than cutoff
    // by a wide margin, no point continuing.
    const oldest = arts[arts.length - 1];
    const oldestAt = oldest && oldest.created_at ? new Date(oldest.created_at).getTime() : Date.now();
    if (oldestAt < ageCutoff - AGE_CAP_MS) break;
    if (arts.length < 100) break;
  }

  const candidates = allArtifacts.filter(
    (a) => typeof a.name === 'string' && a.name.startsWith(ARTIFACT_PREFIX),
  );

  // 2. Download + verify in batches.
  const verified = await inBatches(candidates, DOWNLOAD_BATCH, async (art) => {
    try {
      const zipBuf = await httpDownload(token, art.archive_download_url);
      const jsonBuf = extractZipFirstFile(zipBuf);
      const raw = JSON.parse(jsonBuf.toString('utf8'));
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        log.log(`::warning::Malformed JSON in artifact ${art.name}`);
        return { art, status: 'malformed' };
      }
      const claimed = raw.hmac;
      const payload = { ...raw };
      delete payload.hmac;
      if (!verifyHmac(payload, claimed, candidateKeys)) {
        log.log(`::warning::HMAC verification failed for artifact ${art.name}`);
        return { art, status: 'hmac-failed' };
      }
      return { art, status: 'ok', payload };
    } catch (err) {
      log.log(`::warning::Failed to process artifact ${art.name}: ${err.message}`);
      return { art, status: 'error' };
    }
  });

  // 3. Filter by month and age cap.
  const dropped = { hmacFailed: 0, wrongMonth: 0, tooOld: 0, malformed: 0 };
  const surviving = [];
  for (const v of verified) {
    if (v.status !== 'ok') {
      if (v.status === 'hmac-failed') dropped.hmacFailed++;
      else if (v.status === 'malformed') dropped.malformed++;
      else dropped.malformed++;
      continue;
    }
    const ts = v.payload.timestamp ? new Date(v.payload.timestamp).getTime() : NaN;
    if (!Number.isFinite(ts)) {
      dropped.malformed++;
      continue;
    }
    if (ts < ageCutoff) {
      dropped.tooOld++;
      continue;
    }
    if (v.payload.month !== monthBucket) {
      dropped.wrongMonth++;
      continue;
    }
    surviving.push(v);
  }

  // 4. Sum + per-workflow breakdown.
  let total = 0;
  const perWorkflow = new Map();
  for (const s of surviving) {
    const cost = readCostUsd(s.payload);
    if (cost === null) {
      dropped.malformed++;
      continue;
    }
    total += cost;
    const wf = String(s.payload.workflow || 'unknown');
    perWorkflow.set(wf, (perWorkflow.get(wf) || 0) + cost);
  }

  const totalRounded = Math.round(total * 100) / 100;
  const percentage = budgetLimit > 0
    ? Math.round((total / budgetLimit) * 1000) / 10
    : 0;

  return {
    total_spend: totalRounded,
    budget_limit: budgetLimit,
    percentage,
    perWorkflow,
    dropped,
    survivingCount: surviving.length,
  };
}

function formatSummary(result) {
  const lines = [];
  lines.push('## Budget Gate — Aggregation');
  lines.push('');
  lines.push(`- Total spend (MTD): **$${result.total_spend.toFixed(2)}**`);
  lines.push(`- Budget limit: $${result.budget_limit.toFixed(2)}`);
  lines.push(`- Percentage: **${result.percentage}%**`);
  lines.push(`- Verified artifacts: ${result.survivingCount}`);
  lines.push(
    `- Dropped: ${result.dropped.hmacFailed} HMAC-failed, ` +
      `${result.dropped.wrongMonth} previous-month, ` +
      `${result.dropped.tooOld} >32 days old, ` +
      `${result.dropped.malformed} malformed`,
  );
  if (result.perWorkflow.size > 0) {
    lines.push('');
    lines.push('| Workflow | Spend (USD) |');
    lines.push('|----------|-------------|');
    for (const [wf, amount] of [...result.perWorkflow.entries()].sort()) {
      lines.push(`| \`${wf}\` | $${amount.toFixed(2)} |`);
    }
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const budgetRaw = process.env.CLAUDE_MONTHLY_BUDGET_USD;

  if (!token) {
    console.error('::error::GITHUB_TOKEN not set');
    return 2;
  }
  if (!repository) {
    console.error('::error::GITHUB_REPOSITORY not set');
    return 2;
  }
  const budgetLimit = Number(budgetRaw);
  if (!Number.isFinite(budgetLimit) || budgetLimit <= 0) {
    console.error('::error::CLAUDE_MONTHLY_BUDGET_USD not set or invalid');
    return 2;
  }

  const candidateKeys = [
    process.env.BUDGET_HMAC_KEY,
    process.env.BUDGET_HMAC_KEY_PREVIOUS,
  ].filter((k) => typeof k === 'string' && k.length > 0);
  if (candidateKeys.length === 0) {
    console.error('::error::BUDGET_HMAC_KEY not set');
    return 2;
  }

  const result = await aggregate({
    token,
    repository,
    candidateKeys,
    budgetLimit,
  });

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    fs.appendFileSync(
      out,
      `total_spend=${result.total_spend}\n` +
        `budget_limit=${result.budget_limit}\n` +
        `percentage=${result.percentage}\n`,
    );
  } else {
    console.log(`total_spend=${result.total_spend}`);
    console.log(`budget_limit=${result.budget_limit}`);
    console.log(`percentage=${result.percentage}`);
  }

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    fs.appendFileSync(summary, formatSummary(result));
  }

  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`::error::aggregate-spend.js: ${err.stack || err.message}`);
      process.exit(1);
    },
  );
}

module.exports = {
  aggregate,
  verifyHmac,
  extractZipFirstFile,
  inBatches,
  currentMonthBucket,
  readCostUsd,
  formatSummary,
  main,
  AGE_CAP_MS,
  DOWNLOAD_BATCH,
  ARTIFACT_PREFIX,
};

// Silence unused-import warnings for stream import (kept for tests that
// may stub artifact downloads via a stream-based fixture).
void Readable;
