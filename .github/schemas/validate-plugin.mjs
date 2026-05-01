#!/usr/bin/env node
/**
 * .github/schemas/validate-plugin.mjs
 *
 * Plugin manifest validator (Ajv 8 + 2020-12 vocab + ajv-formats).
 *
 * Usage:
 *   node .github/schemas/validate-plugin.mjs <manifest.json> [<manifest.json> ...]
 *
 * Exits 0 if every manifest validates against `.github/schemas/plugin.schema.json`,
 * non-zero otherwise. Prints per-manifest pass/fail with full Ajv error objects.
 *
 * Why this exists instead of a bare `npx ajv-cli@8 validate ...` invocation:
 *   - SPEC-016-3-03 specified `ajv-cli@8`, but that major has not been
 *     published to npm (latest is 5.0.0). ajv-cli@5 lacks `--spec=draft2020`
 *     and does not auto-load `ajv-formats`, so the schema's `$schema` and
 *     its `format: email|uri` keywords cause it to error before validation.
 *   - This script wraps the Ajv 8 library directly, configured with the
 *     2020-12 vocabulary (`ajv/dist/2020`) and `ajv-formats`, matching the
 *     schema's declared draft and format usage exactly.
 *
 * Pinned dependencies (see `npm install` invocation in the CI fallback step):
 *   - ajv@8.x
 *   - ajv-formats@2.x
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = resolve(__dirname, "plugin.schema.json");

// Use createRequire so we honor NODE_PATH (and the resolver's CommonJS
// lookup chain), letting callers point at any `node_modules` install of
// ajv/ajv-formats — the bats harness installs them into a per-checkout
// cache dir and exports NODE_PATH; the CI fallback step uses a local
// `npm install --no-save` in the workflow workspace.
const requireFromCwd = createRequire(`${process.cwd()}/`);
function loadDep(name) {
  // Prefer NODE_PATH-aware lookup via the runner's cwd; fall back to the
  // script's own directory (useful when the validator is bundled with its
  // node_modules under .github/schemas/).
  try {
    return requireFromCwd(name);
  } catch (_) {
    return createRequire(`${__dirname}/`)(name);
  }
}
const Ajv2020 = loadDep("ajv/dist/2020.js");
const addFormats = loadDep("ajv-formats");

const manifests = process.argv.slice(2);
if (manifests.length === 0) {
  console.error("usage: validate-plugin.mjs <manifest.json> [<manifest.json> ...]");
  process.exit(2);
}

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const ajv = new Ajv2020({ strict: true, allErrors: true });
// ajv-formats exposes its registration helper as the default export.
addFormats.default ? addFormats.default(ajv) : addFormats(ajv);
const validate = ajv.compile(schema);

let failed = 0;
for (const file of manifests) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`::error file=${file}::Cannot parse JSON: ${err.message}`);
    failed += 1;
    continue;
  }
  const ok = validate(data);
  if (ok) {
    console.log(`OK  ${file}`);
  } else {
    failed += 1;
    for (const err of validate.errors ?? []) {
      const where = err.instancePath || "(root)";
      const params = JSON.stringify(err.params);
      console.error(`::error file=${file}::${where} ${err.keyword} ${err.message} params=${params}`);
    }
  }
}

process.exit(failed === 0 ? 0 : 1);
