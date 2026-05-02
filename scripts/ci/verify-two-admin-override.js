#!/usr/bin/env node
// scripts/ci/verify-two-admin-override.js
//
// Validates that a PR's `cost:override-critical` label was applied
// by TWO DISTINCT org admins, each holding a DISTINCT non-null
// verified email.
//
// SPEC-017-4-03 task 6.
//
// Defends three threats (TDD §22.4):
//   1. Single rogue admin self-approving a >110% Claude run.
//   2. Admin + alt-account they control both labelling.
//   3. Admin + colleague compromised via shared mailbox both labelling.
//
// (1)/(2) addressed by counting distinct admin logins.
// (3) addressed by requiring distinct non-null verified emails.
//
// None of this is bulletproof against a determined insider with
// cooperating accomplices, but it raises the cost of accidental or
// unilateral over-budget approvals significantly.
//
// Exit codes:
//   0 — invariants satisfied, override accepted
//   1 — invariant violated (insufficient admins, same email, etc.)
//   2 — configuration error (missing env vars)
//
// Env (required unless noted):
//   GITHUB_TOKEN          GitHub API auth
//   GITHUB_REPOSITORY     "owner/repo"
//   PR_NUMBER             pull-request number whose labels are checked
//   CRITICAL_LABEL        optional; default `cost:override-critical`

'use strict';

const https = require('node:https');

const GITHUB_API_HOST = 'api.github.com';
const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 10000;

// --------------------------------------------------------------------
// HTTP helpers (injectable for tests).
// --------------------------------------------------------------------

function defaultRequest(token, pathStr) {
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
          if (res.statusCode >= 500) {
            reject(new Error(`status=${res.statusCode}`));
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`status=${res.statusCode} body=${body}`));
            return;
          }
          try {
            resolve({ status: res.statusCode, body: JSON.parse(body) });
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

async function withRetry(fn, attempts = DEFAULT_RETRIES, backoffMs = DEFAULT_BACKOFF_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await fn();
      // Treat empty arrays from a list endpoint as transient (per spec).
      if (Array.isArray(result) && result.length === 0 && i < attempts - 1) {
        await sleep(backoffMs);
        continue;
      }
      return result;
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) throw err;
      await sleep(backoffMs);
    }
  }
  throw lastErr || new Error('Retry exhausted');
}

// --------------------------------------------------------------------
// Pure helpers.
// --------------------------------------------------------------------

async function listAdmins(httpRequest, token, org, retryOpts = {}) {
  const admins = new Set();
  for (let page = 1; page <= 20; page++) {
    const resp = await withRetry(
      () => httpRequest(token, `/orgs/${org}/members?role=admin&per_page=100&page=${page}`),
      retryOpts.attempts,
      retryOpts.backoffMs,
      retryOpts.sleep,
    );
    const members = (resp && resp.body) || [];
    for (const m of members) {
      if (m && typeof m.login === 'string') admins.add(m.login.toLowerCase());
    }
    if (members.length < 100) break;
  }
  return admins;
}

async function listLabelers(httpRequest, token, owner, repo, prNumber, criticalLabel) {
  const labelers = []; // ordered list of unique logins
  const seen = new Set();
  for (let page = 1; page <= 20; page++) {
    const resp = await httpRequest(
      token,
      `/repos/${owner}/${repo}/issues/${prNumber}/events?per_page=100&page=${page}`,
    );
    const events = (resp && resp.body) || [];
    for (const ev of events) {
      if (
        ev &&
        ev.event === 'labeled' &&
        ev.label &&
        ev.label.name === criticalLabel &&
        ev.actor &&
        typeof ev.actor.login === 'string'
      ) {
        const login = ev.actor.login.toLowerCase();
        if (!seen.has(login)) {
          seen.add(login);
          labelers.push(login);
        }
      }
    }
    if (events.length < 100) break;
  }
  return labelers;
}

async function lookupEmail(httpRequest, token, login) {
  const resp = await httpRequest(token, `/users/${login}`);
  const email = resp && resp.body ? resp.body.email : null;
  return typeof email === 'string' && email.length > 0 ? email : null;
}

// --------------------------------------------------------------------
// Validator (importable for tests).
// --------------------------------------------------------------------

async function verify(opts) {
  const {
    token,
    repository,
    prNumber,
    criticalLabel,
    httpRequest = defaultRequest,
    retryOpts = {},
    log = console,
  } = opts;

  const [owner, repo] = String(repository).split('/');
  const org = owner;

  const admins = await listAdmins(httpRequest, token, org, retryOpts);
  const labelers = await listLabelers(
    httpRequest,
    token,
    owner,
    repo,
    prNumber,
    criticalLabel,
  );

  if (labelers.length < 2 || labelers.some((l) => !admins.has(l))) {
    log.error(
      `::error::Critical override requires two distinct org admin approvals (got: ${labelers.join(', ') || '<none>'})`,
    );
    return 1;
  }

  const pair = labelers.slice(0, 2);
  const emails = [];
  for (const login of pair) {
    const email = await lookupEmail(httpRequest, token, login);
    if (email === null) {
      log.error(
        `::error::Admin ${login} has no verified public email; cannot satisfy critical override invariant`,
      );
      return 1;
    }
    emails.push({ login, email });
  }

  const a = emails[0].email.toLowerCase();
  const b = emails[1].email.toLowerCase();
  if (a === b) {
    log.error(
      `::error::Same-email accounts not permitted for critical override (admin ${emails[0].login} and ${emails[1].login} share ${emails[0].email})`,
    );
    return 1;
  }

  // Append audit pairs to step summary if configured.
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const fs = require('node:fs');
    const lines = [
      '## Critical Override — Approvers',
      '',
      '| Admin | Email |',
      '|-------|-------|',
      ...emails.map((e) => `| \`${e.login}\` | ${e.email} |`),
      '',
    ];
    fs.appendFileSync(summaryPath, lines.join('\n'));
  }

  log.log(
    `::notice::Critical override accepted: ${emails.map((e) => e.login).join(', ')}`,
  );
  return 0;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const prNumber = process.env.PR_NUMBER;
  const criticalLabel = process.env.CRITICAL_LABEL || 'cost:override-critical';

  if (!token) {
    console.error('::error::GITHUB_TOKEN not set');
    return 2;
  }
  if (!repository || !repository.includes('/')) {
    console.error('::error::GITHUB_REPOSITORY not set or invalid');
    return 2;
  }
  if (!prNumber) {
    console.error('::error::PR_NUMBER not set');
    return 2;
  }

  return verify({ token, repository, prNumber, criticalLabel });
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`::error::verify-two-admin-override.js: ${err.stack || err.message}`);
      process.exit(1);
    },
  );
}

module.exports = {
  verify,
  withRetry,
  listAdmins,
  listLabelers,
  lookupEmail,
  main,
  DEFAULT_RETRIES,
  DEFAULT_BACKOFF_MS,
};
