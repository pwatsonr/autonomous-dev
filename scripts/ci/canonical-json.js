// scripts/ci/canonical-json.js
//
// Deterministic JSON serializer used by the spend-artifact emitter
// (SPEC-017-1-04) and the budget-gate verifier (PLAN-017-4 task 2).
// Producer and consumer import the SAME file so the canonical form
// cannot drift across versions/runners.
//
// Rules:
//   1. Object keys are sorted lexicographically (recursively).
//   2. JSON.stringify is used for primitives (numbers use JS default
//      representation; strings are JSON-escaped).
//   3. No whitespace, no trailing newline.

'use strict';

function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + canonicalize(value[k]))
      .join(',') +
    '}'
  );
}

module.exports = { canonicalize };

if (require.main === module) {
  let input = '';
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    const obj = JSON.parse(input);
    process.stdout.write(canonicalize(obj));
  });
}
