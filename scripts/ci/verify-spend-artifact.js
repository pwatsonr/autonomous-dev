#!/usr/bin/env node
// scripts/ci/verify-spend-artifact.js
//
// Reads an HMAC-signed spend-artifact JSON file (produced by
// scripts/ci/emit-spend-artifact.sh and emit-spend-estimate.sh),
// recomputes HMAC-SHA256 over the canonical JSON of every field
// EXCEPT `hmac`, and compares against the embedded value with a
// constant-time comparison.
//
// SPEC-017-4-01 task 2.
//
// Exit codes:
//   0 — verification succeeded
//   1 — verification failed (tamper, unsigned, malformed, key mismatch)
//   2 — configuration error (missing CLI arg or env vars)
//
// Env:
//   BUDGET_HMAC_KEY            (required)  — current shared secret
//   BUDGET_HMAC_KEY_PREVIOUS   (optional)  — fallback for the
//                                            32-day rotation overlap
//                                            window (PLAN-017-4 risk row 1)

'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { canonicalize } = require('./canonical-json');

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: verify-spend-artifact.js <artifact-path>');
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

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    console.log(`::warning::Malformed JSON in artifact ${path}: ${err.message}`);
    return 1;
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    console.log(`::warning::Malformed JSON in artifact ${path}: not an object`);
    return 1;
  }

  const claimed = raw.hmac;
  if (typeof claimed !== 'string' || claimed.length === 0) {
    console.log(`::warning::Unsigned artifact ${path}`);
    return 1;
  }

  // Strip hmac before canonicalizing the body the producer signed.
  const payload = { ...raw };
  delete payload.hmac;
  const canonical = canonicalize(payload);

  let claimedBuf;
  try {
    claimedBuf = Buffer.from(claimed, 'hex');
  } catch (_err) {
    console.log(`::warning::HMAC verification failed for artifact ${path}`);
    return 1;
  }

  for (const key of candidateKeys) {
    const computed = crypto
      .createHmac('sha256', key)
      .update(canonical)
      .digest();
    // crypto.timingSafeEqual throws on length mismatch; check first
    // to keep timing characteristics independent of length.
    if (
      computed.length === claimedBuf.length &&
      crypto.timingSafeEqual(computed, claimedBuf)
    ) {
      console.log(`::notice::Verified artifact ${path}`);
      return 0;
    }
  }

  console.log(`::warning::HMAC verification failed for artifact ${path}`);
  return 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main };
