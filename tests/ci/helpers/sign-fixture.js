#!/usr/bin/env node
// tests/ci/helpers/sign-fixture.js
//
// Helper used by the budget-gate bats tests to (re)generate the
// signed-artifact fixtures under tests/ci/fixtures/spend-artifacts/.
// Reads a JSON object on stdin (the unsigned envelope), computes an
// HMAC over the canonical JSON of every field, and writes the same
// envelope plus an `hmac` field to stdout.
//
// Usage:
//   BUDGET_HMAC_KEY=<hex> node tests/ci/helpers/sign-fixture.js < unsigned.json > signed.json
//
// Used by `make ci-fixtures` and inside the bats setup() functions.
// Lives next to the bats suite so a contributor can regenerate signed
// fixtures without leaving the tests/ci/ directory.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;
const repoRoot = path.resolve(here, '..', '..', '..');
const { canonicalize } = require(path.join(repoRoot, 'scripts', 'ci', 'canonical-json.js'));

const key = process.env.BUDGET_HMAC_KEY;
if (!key) {
  console.error('BUDGET_HMAC_KEY required');
  process.exit(2);
}

let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const payload = JSON.parse(input);
  const canonical = canonicalize(payload);
  const hmac = crypto
    .createHmac('sha256', key)
    .update(canonical)
    .digest('hex');
  process.stdout.write(JSON.stringify({ ...payload, hmac }, null, 2) + '\n');
});
