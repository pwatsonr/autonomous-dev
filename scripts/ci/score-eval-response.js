#!/usr/bin/env node
// scripts/ci/score-eval-response.js
//
// Deterministic scorer for assist-eval scenarios (SPEC-017-3-03).
// No Claude calls, no network, no randomness.
//
// Inputs (CLI args):
//   --scenario <path>    Scenario JSON file (must conform to schema below).
//   --response <path>    File containing the assist plugin's response text.
//
// Exit codes:
//   0 — pass (all keywords present, no forbidden phrases, length in range).
//   1 — fail (writes "SCORE FAIL: <reason>" to stderr).
//
// Scenario schema:
//   {
//     "description": string,
//     "skill": "help" | "troubleshoot",
//     "input": string,
//     "expected_keywords": string[],
//     "forbidden_phrases": string[],
//     "min_response_length": number,
//     "max_response_length": number
//   }

'use strict';

const fs = require('fs');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--scenario') out.scenario = argv[++i];
    else if (argv[i] === '--response') out.response = argv[++i];
  }
  return out;
}

function fail(reason) {
  process.stderr.write(`SCORE FAIL: ${reason}\n`);
  process.exit(1);
}

const args = parseArgs(process.argv);
if (!args.scenario || !args.response) {
  fail('Usage: score-eval-response.js --scenario <file> --response <file>');
}

let scenario;
try {
  scenario = JSON.parse(fs.readFileSync(args.scenario, 'utf8'));
} catch (e) {
  fail(`Cannot parse scenario JSON: ${e.message}`);
}

const response = fs.readFileSync(args.response, 'utf8');
const lower = response.toLowerCase();

// 1. Required keywords (case-insensitive substring match).
for (const kw of scenario.expected_keywords || []) {
  if (!lower.includes(String(kw).toLowerCase())) {
    fail(`Missing expected keyword: "${kw}"`);
  }
}

// 2. Forbidden phrases.
for (const phrase of scenario.forbidden_phrases || []) {
  if (lower.includes(String(phrase).toLowerCase())) {
    fail(`Contains forbidden phrase: "${phrase}"`);
  }
}

// 3. Length bounds. Default min=0, max=Infinity if omitted.
const len = response.length;
const minLen = scenario.min_response_length ?? 0;
const maxLen = scenario.max_response_length ?? Infinity;
if (len < minLen) fail(`Response too short: ${len} < ${minLen}`);
if (len > maxLen) fail(`Response too long: ${len} > ${maxLen}`);

process.exit(0);
