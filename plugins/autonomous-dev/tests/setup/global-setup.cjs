// Jest globalSetup — ensures known fixture directories exist before any tests run.
// Tests reference hardcoded /tmp paths; create them once per run instead of per test.
const fs = require('fs');
const path = require('path');

module.exports = async function globalSetup() {
  for (const dir of [
    '/tmp/worktrees',
    '/tmp/agent-fixtures',
    path.join(require('os').tmpdir(), 'autonomous-dev-tests'),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
};
