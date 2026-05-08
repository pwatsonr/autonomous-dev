'use strict';
// Minimal fixture plugin entry for SPEC-030-3-03 integration test.
// `getVersion()` re-reads the manifest on each call so the integration
// test can rewrite manifest.json mid-run and observe the new version
// without having to evict any module cache.
const path = require('node:path');
const fs = require('node:fs');

module.exports = {
  getVersion() {
    const raw = fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf-8');
    return JSON.parse(raw).version;
  },
};
