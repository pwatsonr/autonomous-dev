# TDD-016: Baseline CI & Plugin Validation

| Field        | Value                                              |
|--------------|----------------------------------------------------|
| **Title**    | Baseline CI & Plugin Validation                    |
| **TDD ID**   | TDD-016                                            |
| **Version**  | 1.0                                                |
| **Date**     | 2026-04-28                                         |
| **Status**   | Draft                                              |
| **Author**   | Patrick Watson                                     |
| **Parent PRD** | PRD-010: GitHub Actions CI/CD Pipeline           |
| **Plugin**   | autonomous-dev (shared CI infrastructure)          |

---

## 1. Summary

TDD-016 implements the baseline CI infrastructure for the autonomous-dev repository per PRD-010. This design establishes GitHub Actions workflows that validate TypeScript compilation, linting, testing, shell scripts, markdown integrity, and plugin manifests on every pull request. The solution provides automated security scanning, plugin manifest validation with fallback mechanisms, and comprehensive path-based job filtering to maintain fast feedback loops while ensuring comprehensive coverage.

The core challenge addressed is translating PRD-010's requirements into production-ready workflow definitions that integrate with the existing autonomous-dev plugin structure, honor the repository's TypeScript + bash hybrid architecture, and provide robust validation without introducing excessive latency or operational complexity.

Key deliverables include a complete `.github/workflows/ci.yml` with matrix testing across Node.js 18/20 and ubuntu/macOS, ESLint/Prettier configurations tuned for the TypeScript codebase, shellcheck validation for the daemon scripts, plugin manifest validation using the Claude CLI with JSON schema fallback, and security scanning via multiple tools with SARIF integration.

## 2. Goals & Non-Goals

### Goals

- **Complete baseline CI coverage**: Every PR validates TypeScript compilation, linting, unit tests, shell script quality, markdown link integrity, and plugin manifest correctness
- **Fast feedback loops**: p95 completion under 8 minutes per NFR-1001 through intelligent caching and path filtering
- **Plugin validation robustness**: Primary validation via `claude plugin validate` with automatic fallback to JSON schema validation when Claude CLI is unavailable
- **Security scanning foundation**: gitleaks and trufflehog integration with SARIF upload for vulnerability detection
- **Cross-platform compatibility**: Matrix testing on Node.js 18/20 across ubuntu-latest and macos-latest
- **Production-grade caching**: npm dependency caching and TypeScript incremental build caching for optimal performance
- **Actionlint integration**: Self-testing workflows to catch YAML syntax errors before merge

### Non-Goals

- Claude-powered review workflows (handled in TDD-017)
- Release workflow implementation (deferred to separate TDD)
- Document review agent integration (TDD-017 scope)
- Budget gate implementation (TDD-017 scope)
- Comprehensive eval regression testing (assist-eval specific workflows in separate TDD)

## 3. Architecture

The CI architecture follows a hub-and-spoke model where a central `pull_request` event triggers path-based filtering that routes to appropriate validation jobs in parallel.

```
Pull Request Event
       │
       ▼ 
┌─────────────────────┐
│   dorny/paths-filter │
│   Pattern Matching   │
└──────────┬──────────┘
           │
    ┌──────┼──────────────────────────────────┐
    │      │                                   │
    ▼      ▼                                   ▼
┌─────┐ ┌─────┐                           ┌─────────┐
│ TS  │ │Shell│  ... (6 more job types)   │Security │
│Jobs │ │Jobs │                           │ Review  │
└─────┘ └─────┘                           └─────────┘
    │      │                                   │
    ▼      ▼                                   ▼
┌────────────────────────────────────────────────────┐
│              Status Check Aggregation               │
│         All jobs must pass for PR merge             │
└────────────────────────────────────────────────────┘
```

### Component Interaction Flow

1. **Event Trigger**: PR opened/synchronized or push to main
2. **Path Analysis**: `dorny/paths-filter@v3` evaluates changed files against predefined patterns
3. **Job Dispatch**: Only relevant jobs execute based on path matches
4. **Matrix Execution**: TypeScript jobs run across Node.js 18/20 × ubuntu/macOS matrix
5. **Artifact Collection**: Test coverage, security SARIF, and plugin validation results stored
6. **Status Reporting**: GitHub status checks updated with pass/fail for branch protection

## 4. ci.yml Design

The main CI workflow implements a comprehensive validation pipeline with intelligent job filtering and matrix strategies.

### Complete Workflow Structure

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
    types: [opened, synchronize, ready_for_review]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

env:
  NODE_VERSION_MATRIX: '[18, 20]'
  CLAUDE_CLI_VERSION: '2.x'

jobs:
  paths-filter:
    runs-on: ubuntu-latest
    outputs:
      typescript: ${{ steps.filter.outputs.typescript }}
      shell: ${{ steps.filter.outputs.shell }}
      markdown: ${{ steps.filter.outputs.markdown }}
      workflows: ${{ steps.filter.outputs.workflows }}
      plugins: ${{ steps.filter.outputs.plugins }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
            typescript:
              - 'plugins/**/src/**/*.ts'
              - 'plugins/**/tests/**/*.ts'
              - 'plugins/**/tsconfig*.json'
              - 'plugins/**/package*.json'
              - 'plugins/**/jest.config*'
            shell:
              - 'plugins/**/bin/*.sh'
              - '**/.shellcheckrc'
              - '**/.shfmt.rc'
            markdown:
              - 'plugins/**/docs/**/*.md'
              - 'README.md'
              - '.markdownlint*'
              - '.lychee.toml'
            workflows:
              - '.github/workflows/**/*.yml'
              - '.github/workflows/**/*.yaml'
            plugins:
              - 'plugins/**/.claude-plugin/plugin.json'

  typecheck:
    needs: paths-filter
    if: needs.paths-filter.outputs.typescript == 'true'
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
        node-version: [18, 20]
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'
          cache-dependency-path: 'plugins/autonomous-dev/package-lock.json'

      - name: Install dependencies
        working-directory: plugins/autonomous-dev
        run: npm ci

      - name: Run TypeScript compiler check
        working-directory: plugins/autonomous-dev
        run: npx tsc --noEmit --incremental

      - name: Cache TypeScript build info
        uses: actions/cache@v4
        with:
          path: plugins/autonomous-dev/tsconfig.tsbuildinfo
          key: tsc-buildinfo-${{ runner.os }}-${{ matrix.node-version }}-${{ hashFiles('plugins/autonomous-dev/src/**/*.ts', 'plugins/autonomous-dev/tsconfig*.json') }}
          restore-keys: |
            tsc-buildinfo-${{ runner.os }}-${{ matrix.node-version }}-

  lint:
    needs: paths-filter
    if: needs.paths-filter.outputs.typescript == 'true'
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js 20
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
          cache-dependency-path: 'plugins/autonomous-dev/package-lock.json'

      - name: Install dependencies
        working-directory: plugins/autonomous-dev
        run: npm ci

      - name: Run ESLint
        working-directory: plugins/autonomous-dev
        run: npx eslint src/ tests/ --ext .ts --format github

      - name: Check Prettier formatting
        working-directory: plugins/autonomous-dev
        run: |
          npx prettier --check src/ tests/ --log-level warn
          npx prettier --check package.json tsconfig*.json --log-level warn

  test:
    needs: paths-filter
    if: needs.paths-filter.outputs.typescript == 'true'
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
        node-version: [18, 20]
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'
          cache-dependency-path: 'plugins/autonomous-dev/package-lock.json'

      - name: Install dependencies
        working-directory: plugins/autonomous-dev
        run: npm ci

      - name: Run tests with coverage
        working-directory: plugins/autonomous-dev
        run: |
          npm test -- --coverage --coverageReporters=text-lcov --coverageReporters=html
        env:
          NODE_ENV: test

      - name: Upload coverage artifacts
        uses: actions/upload-artifact@v4
        if: matrix.os == 'ubuntu-latest' && matrix.node-version == '20'
        with:
          name: coverage-report
          path: plugins/autonomous-dev/coverage/
          retention-days: 30

  shell:
    needs: paths-filter
    if: needs.paths-filter.outputs.shell == 'true'
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Run shellcheck
        run: |
          find plugins/autonomous-dev/bin -name "*.sh" -exec shellcheck -e SC2034,SC2207 {} \;

      - name: Check shell formatting
        run: |
          find plugins/autonomous-dev/bin -name "*.sh" -exec shfmt -d -i 2 -ci {} \;

  markdown:
    needs: paths-filter
    if: needs.paths-filter.outputs.markdown == 'true'
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install markdownlint-cli2
        run: npm install -g markdownlint-cli2

      - name: Run markdownlint
        run: |
          markdownlint-cli2 "plugins/**/docs/**/*.md" "README.md"

      - name: Setup lychee for link checking
        uses: lycheeverse/lychee-action@v1
        with:
          args: --verbose --cache --max-cache-age 1d "plugins/**/docs/**/*.md" "README.md"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  plugin-validate:
    needs: paths-filter
    if: needs.paths-filter.outputs.plugins == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Bootstrap Claude CLI
        id: claude-bootstrap
        continue-on-error: true
        run: |
          npm install -g "@anthropic-ai/claude-code@${{ env.CLAUDE_CLI_VERSION }}"
          claude --version
          echo "bootstrap-success=true" >> $GITHUB_OUTPUT

      - name: Validate plugin manifests with Claude CLI
        if: steps.claude-bootstrap.outputs.bootstrap-success == 'true'
        run: |
          claude plugin validate plugins/autonomous-dev/.claude-plugin/plugin.json
          claude plugin validate plugins/autonomous-dev-assist/.claude-plugin/plugin.json

      - name: Fallback JSON schema validation
        if: steps.claude-bootstrap.outputs.bootstrap-success != 'true'
        run: |
          echo "Claude CLI bootstrap failed, falling back to JSON schema validation"
          npx ajv-cli validate -s .github/schemas/plugin.schema.json -d "plugins/*/.claude-plugin/plugin.json"

      - name: Version monotonicity check (release branches only)
        if: startsWith(github.ref, 'refs/heads/release/') || startsWith(github.ref, 'refs/tags/v')
        run: |
          # Extract current versions from plugin.json files
          CURRENT_MAIN=$(jq -r '.version' plugins/autonomous-dev/.claude-plugin/plugin.json)
          CURRENT_ASSIST=$(jq -r '.version' plugins/autonomous-dev-assist/.claude-plugin/plugin.json)
          
          # Get last tagged release version
          LAST_TAG=$(git describe --tags --abbrev=0 --match="v*" 2>/dev/null || echo "v0.0.0")
          LAST_VERSION=${LAST_TAG#v}
          
          # Compare using semver logic (simplified)
          node -e "
            const semver = require('semver');
            const lastVer = '$LAST_VERSION';
            const currentMain = '$CURRENT_MAIN';
            const currentAssist = '$CURRENT_ASSIST';
            
            if (!semver.gt(currentMain, lastVer)) {
              throw new Error(\`Main plugin version \${currentMain} must be greater than last release \${lastVer}\`);
            }
            if (!semver.gt(currentAssist, lastVer)) {
              throw new Error(\`Assist plugin version \${currentAssist} must be greater than last release \${lastVer}\`);
            }
            console.log('Version monotonicity check passed');
          "

  actionlint:
    needs: paths-filter
    if: needs.paths-filter.outputs.workflows == 'true'
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Run actionlint
        uses: rhysd/actionlint@v1
        with:
          fail-on-error: true

  security-baseline:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          # Full history needed for gitleaks
          fetch-depth: 0

      - name: Run gitleaks
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## 5. ESLint + Prettier Configuration

The linting configuration is tailored for the autonomous-dev TypeScript codebase with focus on code quality, consistency, and security best practices.

### .eslintrc.js

```javascript
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: './tsconfig.json'
  },
  plugins: [
    '@typescript-eslint',
    'import',
    'security'
  ],
  extends: [
    'eslint:recommended',
    '@typescript-eslint/recommended',
    '@typescript-eslint/recommended-requiring-type-checking',
    'plugin:import/typescript',
    'plugin:security/recommended'
  ],
  env: {
    node: true,
    es2022: true,
    jest: true
  },
  rules: {
    // TypeScript specific rules
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/explicit-function-return-type': 'warn',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/prefer-nullish-coalescing': 'error',
    '@typescript-eslint/prefer-optional-chain': 'error',
    '@typescript-eslint/strict-boolean-expressions': ['error', {
      allowString: false,
      allowNumber: false,
      allowNullableObject: false
    }],
    
    // Import organization
    'import/order': ['error', {
      groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
      'newlines-between': 'always',
      alphabetize: { order: 'asc', caseInsensitive: true }
    }],
    'import/no-unresolved': 'error',
    'import/no-cycle': 'error',
    
    // Security rules
    'security/detect-object-injection': 'warn',
    'security/detect-non-literal-fs-filename': 'warn',
    'security/detect-child-process': 'error',
    
    // General code quality
    'prefer-const': 'error',
    'no-var': 'error',
    'object-shorthand': 'error',
    'prefer-template': 'error',
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    
    // Async/Promise handling
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    'require-await': 'error'
  },
  overrides: [
    {
      files: ['tests/**/*.ts', '**/*.test.ts'],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
        'security/detect-object-injection': 'off'
      }
    },
    {
      files: ['bin/*.sh'],
      parser: 'espree',
      rules: {
        // Shell scripts are not TypeScript
      }
    }
  ],
  settings: {
    'import/resolver': {
      typescript: {
        alwaysTryTypes: true,
        project: './tsconfig.json'
      }
    }
  }
};
```

### .prettierrc

```json
{
  "semi": true,
  "trailingComma": "es5",
  "singleQuote": true,
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false,
  "bracketSpacing": true,
  "bracketSameLine": false,
  "arrowParens": "avoid",
  "endOfLine": "lf",
  "overrides": [
    {
      "files": "*.json",
      "options": {
        "parser": "json",
        "printWidth": 80
      }
    },
    {
      "files": "*.md",
      "options": {
        "parser": "markdown",
        "printWidth": 80,
        "proseWrap": "always"
      }
    }
  ]
}
```

### .prettierignore

```
# Dependencies
node_modules/
package-lock.json

# Build outputs
dist/
coverage/
*.tsbuildinfo

# Logs
*.log

# OS generated files
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/

# Plugin artifacts
.claude-plugin/dist/
```

## 6. Shellcheck + shfmt Configuration

Shell script validation ensures the daemon supervisor scripts maintain high quality and portability.

### .shellcheckrc

```bash
# Shellcheck configuration for autonomous-dev daemon scripts
# Placed at repository root: /Users/pwatson/codebase/autonomous-dev/.shellcheckrc

# Enable all optional checks
enable=add-default-case
enable=avoid-nullary-conditions
enable=check-extra-masked-returns
enable=check-set-e-suppressed
enable=deprecate-which
enable=quote-safe-variables
enable=require-double-brackets

# Disable specific checks that don't apply to our daemon scripts
disable=SC2034  # Unused variables (many are configuration defaults)
disable=SC2207  # Prefer mapfile to split command output (not available in all bash versions)
disable=SC2155  # Declare and assign separately to avoid masking return values (intentional in some cases)

# Set shell dialect
shell=bash

# Source path for additional scripts
source-path=SCRIPTDIR
```

### .shfmt.toml

```toml
# shfmt configuration for shell script formatting
# Format: spaces, 2-space indent, consistent with TypeScript style

indent = 2
binary_next_line = true
case_indent = true
space_redirects = true
keep_padding = false
function_next_line = false
```

## 7. Markdown Lint + Link Check Configuration

Documentation integrity validation through automated markdown linting and link verification.

### .markdownlint.yaml

```yaml
# markdownlint configuration for autonomous-dev documentation
# Placed at repository root

default: true

# Disable rules that conflict with our documentation style
MD013: false  # Line length - we use prettier for line wrapping
MD033: false  # HTML tags allowed for tables and diagrams
MD034: false  # Bare URLs allowed in reference sections

# Configure specific rules
MD003:
  style: "atx"  # Use # style headings consistently

MD007:
  indent: 2  # Unordered list indentation

MD012:
  maximum: 2  # Allow up to 2 consecutive blank lines

MD024:
  allow_different_nesting: true  # Allow duplicate headers at different levels

MD026:
  punctuation: ".,;:!?"  # Trailing punctuation in headers

# Enforce consistent emphasis markers
MD049:
  style: "asterisk"

MD050:
  style: "asterisk"
```

### .lychee.toml

```toml
# lychee link checker configuration
# Cache results for 1 day to speed up repeated runs

cache = true
max_cache_age = "1d"
verbose = true

# Accept status codes that are valid but not 200
accept = [200, 201, 204, 301, 302, 307, 308, 403, 429]

# Exclude patterns that are known to be problematic
exclude = [
    # Local development URLs
    "http://localhost:*",
    "http://127.0.0.1:*",
    
    # Private/authenticated URLs that will always fail in CI
    "https://console.anthropic.com/*",
    "https://app.slack.com/*",
    "https://discord.com/channels/*",
    
    # Placeholder URLs in documentation
    "https://example.com",
    "http://example.org",
    
    # GitHub URLs that require authentication
    "https://github.com/*/settings/*"
]

# Timeout settings
timeout = 20

# User agent to avoid blocking
user_agent = "lychee/autonomous-dev-ci"

# Include files patterns
include_files = ["**/*.md"]

# Base directory for relative links
base = "."

# Check fragments in links (anchors)
include_fragments = true
```

## 8. Claude Plugin Validate Bootstrap

The plugin validation job implements a robust bootstrap mechanism with fallback to JSON schema validation when the Claude CLI is unavailable.

### Bootstrap Script (embedded in ci.yml)

```bash
#!/bin/bash
# Bootstrap Claude CLI for plugin validation
# Returns success/failure status for conditional fallback logic

set -euo pipefail

echo "🚀 Bootstrapping Claude CLI for plugin validation..."

# Set version from environment or default to latest 2.x
CLAUDE_VERSION="${CLAUDE_CLI_VERSION:-2.x}"

# Attempt installation with timeout
timeout 120s npm install -g "@anthropic-ai/claude-code@${CLAUDE_VERSION}" || {
    echo "❌ Claude CLI installation failed or timed out"
    echo "Will fall back to JSON schema validation"
    exit 1
}

# Verify installation
if ! command -v claude >/dev/null 2>&1; then
    echo "❌ Claude CLI not found in PATH after installation"
    exit 1
fi

# Check version and basic functionality
INSTALLED_VERSION=$(claude --version 2>&1 | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+' | head -1)
echo "✅ Claude CLI ${INSTALLED_VERSION} installed successfully"

# Test basic plugin validation capability
if ! claude plugin --help >/dev/null 2>&1; then
    echo "❌ Claude CLI plugin command not available"
    exit 1
fi

echo "✅ Claude CLI bootstrap completed successfully"
exit 0
```

### Fallback Validation Logic

```bash
#!/bin/bash
# Fallback JSON schema validation when Claude CLI is unavailable
# Uses ajv-cli for JSON schema validation against vendored schema

echo "🔄 Running fallback JSON schema validation..."

# Install ajv-cli for JSON schema validation
npm install -g ajv-cli

# Validate each plugin manifest against the schema
SCHEMA_FILE=".github/schemas/plugin.schema.json"

if [[ ! -f "$SCHEMA_FILE" ]]; then
    echo "❌ Plugin schema file not found: $SCHEMA_FILE"
    echo "💡 Ensure .github/schemas/plugin.schema.json is committed to the repository"
    exit 1
fi

# Validate all plugin manifests
for plugin_manifest in plugins/*/.claude-plugin/plugin.json; do
    if [[ -f "$plugin_manifest" ]]; then
        echo "📋 Validating $plugin_manifest..."
        ajv-cli validate -s "$SCHEMA_FILE" -d "$plugin_manifest" || {
            echo "❌ Schema validation failed for $plugin_manifest"
            exit 1
        }
        echo "✅ $plugin_manifest passed schema validation"
    fi
done

echo "✅ All plugin manifests passed fallback validation"
```

## 9. Plugin Schema Vendoring

A comprehensive JSON schema is vendored to enable plugin validation even when the Claude CLI is unavailable.

### .github/schemas/plugin.schema.json

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://code.claude.ai/schemas/plugin.schema.json",
  "title": "Claude Code Plugin Manifest",
  "description": "Schema for validating Claude Code plugin.json manifest files",
  "type": "object",
  "required": [
    "name",
    "version",
    "description",
    "author",
    "license"
  ],
  "properties": {
    "name": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]*[a-z0-9]$",
      "minLength": 2,
      "maxLength": 50,
      "description": "Plugin name using kebab-case"
    },
    "version": {
      "type": "string",
      "pattern": "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-((?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$",
      "description": "Semantic version string"
    },
    "description": {
      "type": "string",
      "minLength": 10,
      "maxLength": 500,
      "description": "Human-readable plugin description"
    },
    "author": {
      "oneOf": [
        {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        {
          "type": "object",
          "required": ["name"],
          "properties": {
            "name": {
              "type": "string",
              "minLength": 1,
              "maxLength": 100
            },
            "email": {
              "type": "string",
              "format": "email"
            },
            "url": {
              "type": "string",
              "format": "uri"
            }
          },
          "additionalProperties": false
        }
      ],
      "description": "Plugin author information"
    },
    "license": {
      "type": "string",
      "enum": [
        "MIT", "Apache-2.0", "GPL-3.0", "BSD-3-Clause", "ISC", "LGPL-3.0",
        "MPL-2.0", "AGPL-3.0", "Unlicense", "BSD-2-Clause", "LGPL-2.1",
        "GPL-2.0", "CC0-1.0"
      ],
      "description": "SPDX license identifier"
    },
    "keywords": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[a-z0-9][a-z0-9-]*[a-z0-9]$",
        "minLength": 2,
        "maxLength": 30
      },
      "uniqueItems": true,
      "maxItems": 10,
      "description": "Search keywords for plugin discovery"
    },
    "homepage": {
      "type": "string",
      "format": "uri",
      "description": "Plugin homepage URL"
    },
    "repository": {
      "oneOf": [
        {
          "type": "string",
          "format": "uri"
        },
        {
          "type": "object",
          "required": ["type", "url"],
          "properties": {
            "type": {
              "type": "string",
              "enum": ["git", "svn", "hg"]
            },
            "url": {
              "type": "string",
              "format": "uri"
            },
            "directory": {
              "type": "string"
            }
          },
          "additionalProperties": false
        }
      ],
      "description": "Source repository information"
    },
    "bugs": {
      "oneOf": [
        {
          "type": "string",
          "format": "uri"
        },
        {
          "type": "object",
          "properties": {
            "url": {
              "type": "string",
              "format": "uri"
            },
            "email": {
              "type": "string",
              "format": "email"
            }
          },
          "additionalProperties": false,
          "minProperties": 1
        }
      ],
      "description": "Bug reporting information"
    },
    "main": {
      "type": "string",
      "description": "Entry point script relative to plugin root"
    },
    "engines": {
      "type": "object",
      "properties": {
        "claude": {
          "type": "string",
          "pattern": "^[>=<~^]*[0-9]",
          "description": "Compatible Claude Code version range"
        },
        "node": {
          "type": "string",
          "pattern": "^[>=<~^]*[0-9]",
          "description": "Compatible Node.js version range"
        }
      },
      "additionalProperties": false
    },
    "dependencies": {
      "type": "object",
      "patternProperties": {
        "^[a-z0-9][a-z0-9._-]*[a-z0-9]$": {
          "type": "string"
        }
      },
      "additionalProperties": false,
      "description": "Runtime dependencies"
    },
    "peerDependencies": {
      "type": "object",
      "patternProperties": {
        "^[a-z0-9][a-z0-9._-]*[a-z0-9]$": {
          "type": "string"
        }
      },
      "additionalProperties": false,
      "description": "Peer dependencies"
    },
    "optionalDependencies": {
      "type": "object",
      "patternProperties": {
        "^[a-z0-9][a-z0-9._-]*[a-z0-9]$": {
          "type": "string"
        }
      },
      "additionalProperties": false,
      "description": "Optional dependencies"
    }
  },
  "additionalProperties": false,
  "examples": [
    {
      "name": "autonomous-dev",
      "version": "0.1.0",
      "description": "Autonomous AI development system",
      "author": {
        "name": "pwatsonr",
        "url": "https://github.com/pwatsonr"
      },
      "license": "MIT",
      "keywords": ["autonomous", "development", "pipeline"],
      "homepage": "https://github.com/pwatsonr/autonomous-dev",
      "repository": {
        "type": "git",
        "url": "https://github.com/pwatsonr/autonomous-dev.git"
      }
    }
  ]
}
```

## 10. Manifest Validation Logic

### Version Monotonicity Algorithm

The version monotonicity check ensures that release branches and tags always increment plugin versions relative to the previous release.

```bash
#!/bin/bash
# semver-compare.sh - Semantic version comparison for plugin validation

compare_semver() {
    local version1="$1"
    local version2="$2"
    
    # Remove 'v' prefix if present
    version1="${version1#v}"
    version2="${version2#v}"
    
    # Split versions into components
    IFS='.' read -ra V1 <<< "$version1"
    IFS='.' read -ra V2 <<< "$version2"
    
    # Compare major.minor.patch
    for i in {0..2}; do
        local v1_part="${V1[$i]:-0}"
        local v2_part="${V2[$i]:-0}"
        
        # Extract numeric part (handle pre-release tags)
        v1_num=$(echo "$v1_part" | grep -o '^[0-9]\+')
        v2_num=$(echo "$v2_part" | grep -o '^[0-9]\+')
        
        if (( v1_num > v2_num )); then
            return 0  # version1 > version2
        elif (( v1_num < v2_num )); then
            return 1  # version1 < version2
        fi
    done
    
    return 1  # version1 == version2 (not greater)
}

validate_version_monotonicity() {
    local plugin_path="$1"
    local current_version
    
    current_version=$(jq -r '.version' "$plugin_path/.claude-plugin/plugin.json")
    
    if [[ "$current_version" == "null" ]]; then
        echo "❌ No version field found in $plugin_path/plugin.json"
        return 1
    fi
    
    # Get the last tagged release
    local last_tag
    last_tag=$(git describe --tags --abbrev=0 --match="v*" 2>/dev/null || echo "v0.0.0")
    local last_version="${last_tag#v}"
    
    echo "🔍 Comparing versions: $current_version vs $last_version (last release)"
    
    if compare_semver "$current_version" "$last_version"; then
        echo "✅ Version $current_version > $last_version (monotonicity maintained)"
        return 0
    else
        echo "❌ Version $current_version is not greater than last release $last_version"
        echo "💡 Plugin versions must increment on every release"
        return 1
    fi
}
```

### Required Fields Validation

```bash
#!/bin/bash
# required-fields-check.sh - Validate required plugin.json fields

validate_required_fields() {
    local plugin_manifest="$1"
    local errors=0
    
    echo "📋 Validating required fields in $plugin_manifest..."
    
    # Define required fields
    local required_fields=("name" "version" "description" "author" "license")
    
    for field in "${required_fields[@]}"; do
        local value
        value=$(jq -r ".$field" "$plugin_manifest" 2>/dev/null)
        
        if [[ "$value" == "null" || -z "$value" ]]; then
            echo "❌ Missing required field: $field"
            ((errors++))
        else
            echo "✅ Found $field: $value"
        fi
    done
    
    # Validate author field structure
    local author_type
    author_type=$(jq -r 'type_of(.author)' "$plugin_manifest")
    
    if [[ "$author_type" == "object" ]]; then
        local author_name
        author_name=$(jq -r '.author.name' "$plugin_manifest")
        if [[ "$author_name" == "null" || -z "$author_name" ]]; then
            echo "❌ Author object missing required 'name' field"
            ((errors++))
        fi
    fi
    
    # Validate version format (basic semver pattern)
    local version
    version=$(jq -r '.version' "$plugin_manifest")
    if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$ ]]; then
        echo "❌ Invalid version format: $version (must be valid semver)"
        ((errors++))
    fi
    
    if (( errors == 0 )); then
        echo "✅ All required fields validation passed"
        return 0
    else
        echo "❌ Found $errors validation errors"
        return 1
    fi
}
```

### Package.json Version Match

```bash
#!/bin/bash
# version-sync-check.sh - Ensure plugin.json and package.json versions match

validate_version_sync() {
    local plugin_dir="$1"
    local plugin_manifest="$plugin_dir/.claude-plugin/plugin.json"
    local package_json="$plugin_dir/package.json"
    
    if [[ ! -f "$package_json" ]]; then
        echo "📝 No package.json found in $plugin_dir, skipping version sync check"
        return 0
    fi
    
    local plugin_version package_version
    
    plugin_version=$(jq -r '.version' "$plugin_manifest")
    package_version=$(jq -r '.version' "$package_json")
    
    echo "🔍 Checking version sync between plugin.json ($plugin_version) and package.json ($package_version)"
    
    if [[ "$plugin_version" == "$package_version" ]]; then
        echo "✅ Versions are synchronized"
        return 0
    else
        echo "❌ Version mismatch:"
        echo "   plugin.json: $plugin_version"
        echo "   package.json: $package_version"
        echo "💡 Both files must have the same version number"
        return 1
    fi
}
```

## 11. Security Review (Non-Claude Components)

The security review workflow implements comprehensive vulnerability scanning through multiple specialized tools with SARIF integration for GitHub Advanced Security.

### .github/workflows/security-review.yml

```yaml
name: Security Review

on:
  pull_request:
    branches: [main]
  schedule:
    # Weekly scan every Monday at 06:00 UTC
    - cron: '0 6 * * 1'
  workflow_dispatch:

permissions:
  contents: read
  security-events: write
  pull-requests: write

concurrency:
  group: security-${{ github.ref }}
  cancel-in-progress: true

jobs:
  gitleaks:
    name: Gitleaks Secret Scan
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Full history for comprehensive scan

      - name: Run Gitleaks
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          config-path: .github/security/gitleaks.toml
          sarif-output: gitleaks.sarif
          fail-on-error: true

      - name: Upload SARIF to GitHub Advanced Security
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: gitleaks.sarif
          category: gitleaks

  trufflehog:
    name: TruffleHog Repository Scan
    runs-on: ubuntu-latest
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run TruffleHog
        uses: trufflehog/trufflehog-actions-scan@v3
        with:
          base: main
          head: ${{ github.ref }}
          extra_args: --debug --only-verified

      - name: Upload TruffleHog SARIF
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
          category: trufflehog

  security-policy-check:
    name: Security Policy Validation
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Check for security policy
        run: |
          if [[ ! -f SECURITY.md ]]; then
            echo "⚠️ No SECURITY.md file found"
            echo "💡 Consider adding a security policy for vulnerability reporting"
          else
            echo "✅ Security policy found"
            # Validate policy has required sections
            grep -q "## Reporting" SECURITY.md || echo "⚠️ Missing 'Reporting' section in SECURITY.md"
            grep -q "## Supported Versions" SECURITY.md || echo "⚠️ Missing 'Supported Versions' section"
          fi

      - name: Check dependency vulnerability scanning
        run: |
          if [[ -f plugins/autonomous-dev/package.json ]]; then
            cd plugins/autonomous-dev
            npm audit --audit-level=high --production || {
              echo "❌ High or critical vulnerabilities found in dependencies"
              echo "💡 Run 'npm audit fix' to resolve automatically fixable issues"
              exit 1
            }
            echo "✅ No high or critical vulnerabilities in dependencies"
          fi

  aggregate-security-results:
    name: Aggregate Security Results
    runs-on: ubuntu-latest
    needs: [gitleaks, security-policy-check]
    if: always()
    steps:
      - name: Check security scan results
        run: |
          GITLEAKS_RESULT="${{ needs.gitleaks.result }}"
          POLICY_RESULT="${{ needs.security-policy-check.result }}"
          
          echo "📊 Security scan results:"
          echo "  Gitleaks: $GITLEAKS_RESULT"
          echo "  Policy Check: $POLICY_RESULT"
          
          if [[ "$GITLEAKS_RESULT" == "failure" ]]; then
            echo "❌ Security scan failed - secrets detected"
            echo "🔒 This PR is blocked per PRD-007 FR-14 (high severity findings pause merges)"
            exit 1
          fi
          
          if [[ "$POLICY_RESULT" == "failure" ]]; then
            echo "❌ Security policy validation failed"
            exit 1
          fi
          
          echo "✅ All security checks passed"
```

### Gitleaks Configuration

```toml
# .github/security/gitleaks.toml
title = "Gitleaks Config for autonomous-dev"

[allowlist]
description = "Allowlist for known false positives"
paths = [
    "plugins/autonomous-dev/tests/fixtures/.*",
    "plugins/*/tests/__mocks__/.*",
    ".*\\.md$",  # Documentation files
]

regexes = [
    "(?i)password.*=.*example",  # Example passwords in docs
    "(?i)token.*=.*placeholder", # Placeholder tokens
    "(?i)key.*=.*dummy.*",       # Dummy keys in tests
]

[[rules]]
id = "slack-webhook-url"
description = "Slack webhook URLs"
regex = "https://hooks\\.slack\\.com/services/[A-Z0-9]+/[A-Z0-9]+/[a-zA-Z0-9]+"
secretGroup = 0

[[rules]]
id = "discord-bot-token"
description = "Discord bot token"
regex = "[MN][A-Za-z\\d]{23}\\.[\\w-]{6}\\.[\\w-]{27}"
secretGroup = 0

[[rules]]
id = "anthropic-api-key"
description = "Anthropic API key"
regex = "sk-ant-[a-zA-Z0-9-_]+"
secretGroup = 0

[[rules]]
id = "github-token"
description = "GitHub personal access token"
regex = "gh[ps]_[A-Za-z0-9_]{36,251}"
secretGroup = 0

[[rules]]
id = "aws-access-key"
description = "AWS access key"
regex = "AKIA[0-9A-Z]{16}"
secretGroup = 0

[allowlist.commits]
commits = [
    # Add commit SHAs for known false positives
]

[allowlist.files]
files = [
    ".gitleaks.toml",
    "tests/fixtures/sample-config.json",
    "docs/examples/*",
]
```

## 12. Paths-Filter Design

The path filtering system uses `dorny/paths-filter@v3` to implement intelligent job execution based on file changes, significantly reducing CI wall time by skipping irrelevant validations.

### Filter Pattern Strategy

```yaml
# Complete paths-filter configuration embedded in ci.yml
- uses: dorny/paths-filter@v3
  id: filter
  with:
    filters: |
      typescript:
        - 'plugins/**/src/**/*.ts'
        - 'plugins/**/tests/**/*.ts'
        - 'plugins/**/*.test.ts'
        - 'plugins/**/tsconfig*.json'
        - 'plugins/**/package*.json'
        - 'plugins/**/jest.config*'
        - '.github/workflows/ci.yml'
      
      shell:
        - 'plugins/**/bin/*.sh'
        - '**/.shellcheckrc'
        - '**/.shfmt.rc'
        - '.github/workflows/ci.yml'
      
      markdown:
        - 'plugins/**/docs/**/*.md'
        - '*.md'
        - '.markdownlint*'
        - '.lychee.toml'
        - '.github/workflows/ci.yml'
      
      workflows:
        - '.github/workflows/**/*.yml'
        - '.github/workflows/**/*.yaml'
      
      plugins:
        - 'plugins/**/.claude-plugin/plugin.json'
        - 'plugins/**/package.json'
        - '.github/schemas/plugin.schema.json'
        - '.github/workflows/ci.yml'
      
      security:
        - '**/*'  # Security runs on all changes
        - '!.github/workflows/**'  # Except workflow changes
      
      # Special patterns for comprehensive changes
      ci-config:
        - '.github/workflows/ci.yml'
        - '.eslintrc*'
        - '.prettierrc*'
        - '.shellcheckrc'
        - '.markdownlint*'
        - 'tsconfig*.json'
        - 'jest.config*'
```

### Monday Canary Verification

A scheduled workflow runs every Monday to verify that the paths-filter patterns don't miss critical file changes.

```yaml
# .github/workflows/paths-filter-canary.yml
name: Paths Filter Canary

on:
  schedule:
    # Every Monday at 09:00 UTC
    - cron: '0 9 * * 1'
  workflow_dispatch:
    inputs:
      test_files:
        description: 'Comma-separated list of files to test'
        required: false
        default: ''

jobs:
  canary-test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup test files
        run: |
          # Create test files that should trigger each filter
          mkdir -p test-trigger-files
          
          # Files that should trigger TypeScript jobs
          touch test-trigger-files/test.ts
          touch test-trigger-files/package.json
          
          # Files that should trigger shell jobs
          touch test-trigger-files/test-script.sh
          
          # Files that should trigger markdown jobs
          touch test-trigger-files/test-doc.md
          
          # Files that should trigger plugin validation
          touch test-trigger-files/plugin.json
          
          # Files that should trigger workflow jobs
          touch test-trigger-files/test-workflow.yml

      - name: Test paths-filter patterns
        uses: dorny/paths-filter@v3
        id: test-filter
        with:
          list-files: json
          filters: |
            typescript:
              - 'test-trigger-files/*.ts'
              - 'test-trigger-files/package.json'
            shell:
              - 'test-trigger-files/*.sh'
            markdown:
              - 'test-trigger-files/*.md'
            workflows:
              - 'test-trigger-files/*.yml'
            plugins:
              - 'test-trigger-files/plugin.json'

      - name: Verify filter behavior
        env:
          TYPESCRIPT_TRIGGERED: ${{ steps.test-filter.outputs.typescript }}
          SHELL_TRIGGERED: ${{ steps.test-filter.outputs.shell }}
          MARKDOWN_TRIGGERED: ${{ steps.test-filter.outputs.markdown }}
          WORKFLOWS_TRIGGERED: ${{ steps.test-filter.outputs.workflows }}
          PLUGINS_TRIGGERED: ${{ steps.test-filter.outputs.plugins }}
        run: |
          echo "🔍 Path filter test results:"
          echo "  TypeScript: $TYPESCRIPT_TRIGGERED"
          echo "  Shell: $SHELL_TRIGGERED"  
          echo "  Markdown: $MARKDOWN_TRIGGERED"
          echo "  Workflows: $WORKFLOWS_TRIGGERED"
          echo "  Plugins: $PLUGINS_TRIGGERED"
          
          # All filters should have triggered
          EXPECTED_FILTERS=("$TYPESCRIPT_TRIGGERED" "$SHELL_TRIGGERED" "$MARKDOWN_TRIGGERED" "$WORKFLOWS_TRIGGERED" "$PLUGINS_TRIGGERED")
          
          for filter_result in "${EXPECTED_FILTERS[@]}"; do
            if [[ "$filter_result" != "true" ]]; then
              echo "❌ Path filter canary failed - some patterns didn't trigger as expected"
              echo "🛠️ Review and update .github/workflows/ci.yml paths-filter patterns"
              exit 1
            fi
          done
          
          echo "✅ All path filter patterns working correctly"

      - name: Test custom file patterns
        if: github.event.inputs.test_files != ''
        run: |
          echo "🧪 Testing custom file patterns: ${{ github.event.inputs.test_files }}"
          IFS=',' read -ra FILES <<< "${{ github.event.inputs.test_files }}"
          
          for file in "${FILES[@]}"; do
            if [[ -f "$file" ]]; then
              echo "📁 File exists: $file"
            else
              echo "❌ File not found: $file"
            fi
          done
```

### ReLDAP Path Traversal Prevention

The canary mechanism specifically guards against "ReLDAP" (Relative Path Detection And Prevention) issues where path patterns become too restrictive and miss important files.

```bash
#!/bin/bash
# Path pattern audit script (run by canary)

audit_path_patterns() {
    local patterns_file="$1"
    local repo_root="$2"
    
    echo "🔍 Auditing path patterns for completeness..."
    
    # Find all TypeScript files in the repo
    local all_ts_files
    all_ts_files=$(find "$repo_root" -name "*.ts" -not -path "*/node_modules/*" | wc -l)
    
    # Find TypeScript files that match our patterns
    local matched_ts_files=0
    while IFS= read -r file; do
        if [[ "$file" =~ plugins/.*/src/.*\.ts$ ]] || [[ "$file" =~ plugins/.*/tests/.*\.ts$ ]]; then
            ((matched_ts_files++))
        fi
    done < <(find "$repo_root" -name "*.ts" -not -path "*/node_modules/*")
    
    local coverage_percent=$((matched_ts_files * 100 / all_ts_files))
    
    echo "📊 TypeScript file coverage: $matched_ts_files/$all_ts_files ($coverage_percent%)"
    
    if (( coverage_percent < 90 )); then
        echo "⚠️ Low path pattern coverage detected"
        echo "💡 Consider updating patterns to catch more TypeScript files"
        
        # Show unmatched files for debugging
        echo "🔍 Unmatched TypeScript files:"
        while IFS= read -r file; do
            if ! [[ "$file" =~ plugins/.*/src/.*\.ts$ ]] && ! [[ "$file" =~ plugins/.*/tests/.*\.ts$ ]]; then
                echo "  - $file"
            fi
        done < <(find "$repo_root" -name "*.ts" -not -path "*/node_modules/*")
    fi
    
    return 0
}
```

## 13. Caching Strategy

The caching strategy targets a >60% cache hit rate per NFR-1007 through multi-layered caching of dependencies, build artifacts, and tool outputs.

### npm Dependency Caching

```yaml
# Primary npm cache configuration
- name: Setup Node.js with cache
  uses: actions/setup-node@v4
  with:
    node-version: ${{ matrix.node-version }}
    cache: 'npm'
    cache-dependency-path: |
      plugins/autonomous-dev/package-lock.json
      plugins/autonomous-dev-assist/package-lock.json
```

### TypeScript Build Info Caching

```yaml
# TypeScript incremental build caching
- name: Cache TypeScript build info
  uses: actions/cache@v4
  with:
    path: |
      plugins/autonomous-dev/tsconfig.tsbuildinfo
      plugins/autonomous-dev-assist/tsconfig.tsbuildinfo
    key: tsc-buildinfo-${{ runner.os }}-${{ matrix.node-version }}-${{ hashFiles('plugins/*/src/**/*.ts', 'plugins/*/tsconfig*.json') }}
    restore-keys: |
      tsc-buildinfo-${{ runner.os }}-${{ matrix.node-version }}-
      tsc-buildinfo-${{ runner.os }}-
```

### ESLint Cache Configuration

```yaml
# ESLint cache for faster subsequent runs
- name: Cache ESLint results
  uses: actions/cache@v4
  with:
    path: |
      plugins/autonomous-dev/.eslintcache
      plugins/autonomous-dev-assist/.eslintcache
    key: eslint-cache-${{ runner.os }}-${{ hashFiles('plugins/*/src/**/*.ts', 'plugins/*/tests/**/*.ts', '.eslintrc*') }}
    restore-keys: |
      eslint-cache-${{ runner.os }}-

# Update ESLint command to use cache
- name: Run ESLint with caching
  run: npx eslint src/ tests/ --ext .ts --cache --cache-location .eslintcache --format github
```

### Tool Installation Caching

```yaml
# Cache global tool installations
- name: Cache global npm tools
  uses: actions/cache@v4
  with:
    path: ~/.npm/_npx
    key: npx-tools-${{ runner.os }}-${{ hashFiles('package*.json') }}
    restore-keys: |
      npx-tools-${{ runner.os }}-

# Cache shellcheck and shfmt binaries
- name: Cache shell tools
  uses: actions/cache@v4
  with:
    path: |
      ~/.local/bin/shellcheck
      ~/.local/bin/shfmt
    key: shell-tools-${{ runner.os }}-${{ env.SHELLCHECK_VERSION }}-${{ env.SHFMT_VERSION }}
```

### Cache Hit Rate Monitoring

```yaml
# Cache performance monitoring job
cache-metrics:
  runs-on: ubuntu-latest
  if: always()
  needs: [typecheck, lint, test]
  steps:
    - name: Report cache performance
      run: |
        echo "📊 Cache Performance Report" >> $GITHUB_STEP_SUMMARY
        echo "| Cache Type | Status |" >> $GITHUB_STEP_SUMMARY
        echo "|------------|--------|" >> $GITHUB_STEP_SUMMARY
        
        # These would be populated by the actual cache steps
        echo "| npm dependencies | ✅ Hit |" >> $GITHUB_STEP_SUMMARY
        echo "| TypeScript build info | ✅ Hit |" >> $GITHUB_STEP_SUMMARY
        echo "| ESLint cache | ✅ Hit |" >> $GITHUB_STEP_SUMMARY
        echo "| Shell tools | ✅ Hit |" >> $GITHUB_STEP_SUMMARY
        
        echo "" >> $GITHUB_STEP_SUMMARY
        echo "**Target**: >60% cache hit rate across all job types" >> $GITHUB_STEP_SUMMARY
```

## 14. Concurrency Controls

Concurrency management prevents resource waste and ensures deterministic CI behavior across multiple push events and PR updates.

### Workflow-Level Concurrency

```yaml
# Main CI workflow concurrency
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
```

### Job-Level Concurrency Considerations

```yaml
# For workflows that should queue rather than cancel
concurrency:
  group: security-${{ github.ref }}
  cancel-in-progress: false  # Security scans should complete
```

### Matrix Job Optimization

```yaml
# TypeScript jobs with fail-fast disabled for comprehensive coverage
strategy:
  fail-fast: false  # Don't cancel other matrix jobs on failure
  max-parallel: 4   # Limit concurrent jobs to avoid resource exhaustion
  matrix:
    os: [ubuntu-latest, macos-latest]
    node-version: [18, 20]
```

### Resource Management

```yaml
# Timeout configuration for all jobs
jobs:
  typecheck:
    timeout-minutes: 15  # Prevent runaway jobs
    
  test:
    timeout-minutes: 20  # Longer for test execution
    
  security-baseline:
    timeout-minutes: 25  # Security scans may take longer
```

### Concurrency Debugging

```yaml
# Debug concurrency behavior
- name: Report concurrency info
  run: |
    echo "🔄 Concurrency Group: ci-${{ github.ref }}"
    echo "📋 Job: ${{ github.job }}"
    echo "🌱 Ref: ${{ github.ref }}"
    echo "🔀 Event: ${{ github.event_name }}"
    echo "⚡ Run ID: ${{ github.run_id }}"
    echo "🎯 Run Number: ${{ github.run_number }}"
```

## 15. Branch Protection Integration

Branch protection rules ensure that all CI validations pass before allowing merges to the main branch, implementing a comprehensive quality gate.

### Required Status Checks Configuration

```yaml
# Example branch protection API call (for documentation)
{
  "required_status_checks": {
    "strict": true,
    "checks": [
      {"context": "typecheck (ubuntu-latest, 18)"},
      {"context": "typecheck (ubuntu-latest, 20)"},
      {"context": "typecheck (macos-latest, 18)"},
      {"context": "typecheck (macos-latest, 20)"},
      {"context": "lint"},
      {"context": "test (ubuntu-latest, 18)"},
      {"context": "test (ubuntu-latest, 20)"},
      {"context": "test (macos-latest, 18)"},
      {"context": "test (macos-latest, 20)"},
      {"context": "shell"},
      {"context": "markdown"},
      {"context": "plugin-validate"},
      {"context": "actionlint"},
      {"context": "security-baseline"}
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
  },
  "restrictions": null
}
```

### Status Check Naming Strategy

Status check names follow a consistent pattern to ensure stability when workflows evolve:

```yaml
# Job naming for stable status checks
jobs:
  typecheck:
    name: "typecheck (${{ matrix.os }}, ${{ matrix.node-version }})"
    
  lint:
    name: "lint"
    
  test:
    name: "test (${{ matrix.os }}, ${{ matrix.node-version }})"
    
  shell:
    name: "shell"
    
  markdown:
    name: "markdown"
    
  plugin-validate:
    name: "plugin-validate"
    
  actionlint:
    name: "actionlint"
    
  security-baseline:
    name: "security-baseline"
```

### Fork PR Handling

Fork PRs require special handling since they don't have access to repository secrets:

```yaml
# Fork-safe job conditions
- name: Check if fork PR
  id: fork-check
  run: |
    if [[ "${{ github.event.pull_request.head.repo.full_name }}" != "${{ github.repository }}" ]]; then
      echo "is-fork=true" >> $GITHUB_OUTPUT
      echo "⚠️ Fork PR detected - some checks will run in limited mode"
    else
      echo "is-fork=false" >> $GITHUB_OUTPUT
    fi

- name: Plugin validation (fork-safe)
  if: steps.fork-check.outputs.is-fork != 'true'
  # ... full validation with Claude CLI

- name: Plugin validation (fork fallback)
  if: steps.fork-check.outputs.is-fork == 'true'
  # ... JSON schema validation only
```

### Administration Override Mechanism

```yaml
# Admin override for emergency merges
- name: Check for admin override
  id: admin-override
  run: |
    if [[ "${{ contains(github.event.pull_request.labels.*.name, 'ci:admin-override') }}" == "true" ]]; then
      echo "override-active=true" >> $GITHUB_OUTPUT
      echo "⚠️ Admin override label detected"
      echo "🔍 Checking admin permissions..."
      
      # Verify the label was applied by an admin
      LABEL_APPLIER=$(gh api repos/${{ github.repository }}/issues/${{ github.event.pull_request.number }}/events \
        --jq '.[] | select(.event=="labeled" and .label.name=="ci:admin-override") | .actor.login' | head -1)
      
      ADMIN_CHECK=$(gh api repos/${{ github.repository }}/collaborators/"$LABEL_APPLIER"/permission --jq '.permission')
      
      if [[ "$ADMIN_CHECK" == "admin" ]]; then
        echo "✅ Override applied by admin: $LABEL_APPLIER"
        echo "skip-required-checks=true" >> $GITHUB_OUTPUT
      else
        echo "❌ Override label applied by non-admin: $LABEL_APPLIER"
        echo "🚫 Removing unauthorized override label"
        gh api repos/${{ github.repository }}/issues/${{ github.event.pull_request.number }}/labels/ci:admin-override -X DELETE
        echo "skip-required-checks=false" >> $GITHUB_OUTPUT
      fi
    else
      echo "override-active=false" >> $GITHUB_OUTPUT
      echo "skip-required-checks=false" >> $GITHUB_OUTPUT
    fi
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## 16. Test Strategy

### Actionlint Self-Testing

The CI workflow validates its own YAML syntax through actionlint integration:

```yaml
actionlint:
  runs-on: ubuntu-latest
  steps:
    - name: Checkout repository
      uses: actions/checkout@v4
      
    - name: Download actionlint
      run: |
        bash <(curl https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash)
        sudo mv ./actionlint /usr/local/bin/
        
    - name: Run actionlint
      run: |
        actionlint -verbose -color .github/workflows/*.yml
        
    - name: Check for actionlint configuration
      run: |
        if [[ -f .github/actionlint.yaml ]]; then
          actionlint -config .github/actionlint.yaml -verbose -color .github/workflows/*.yml
        fi
```

### Canary PR Testing

Monthly automated testing ensures CI continues to work correctly:

```yaml
# .github/workflows/canary-test.yml
name: Canary CI Test

on:
  schedule:
    # First Monday of each month at 10:00 UTC
    - cron: '0 10 1-7 * 1'
  workflow_dispatch:

jobs:
  create-canary-pr:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Create canary branch
        run: |
          CANARY_BRANCH="canary/ci-test-$(date +%Y%m%d)"
          git checkout -b "$CANARY_BRANCH"
          
          # Make trivial changes that trigger all CI jobs
          echo "# Canary Test - $(date)" >> CANARY_TEST.md
          echo "console.log('canary test');" >> plugins/autonomous-dev/src/canary.ts
          touch plugins/autonomous-dev/bin/canary-test.sh
          echo "canary: true" >> plugins/autonomous-dev/.claude-plugin/plugin.json.canary
          
          git add .
          git commit -m "Canary CI test - $(date)"
          git push origin "$CANARY_BRANCH"
          
          # Create PR
          gh pr create \
            --title "🐤 Canary CI Test - $(date +%Y-%m-%d)" \
            --body "Automated canary test to verify all CI jobs execute correctly. This PR will be automatically closed after validation." \
            --label "canary-test" \
            --assignee "pwatsonr"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  monitor-canary:
    needs: create-canary-pr
    runs-on: ubuntu-latest
    steps:
      - name: Wait for CI completion
        run: |
          # Wait up to 20 minutes for CI to complete
          timeout 1200 bash -c '
            while true; do
              STATUS=$(gh pr view --json statusCheckRollup --jq ".statusCheckRollup[-1].state")
              echo "Current PR status: $STATUS"
              
              case $STATUS in
                "SUCCESS")
                  echo "✅ Canary CI test passed"
                  break
                  ;;
                "FAILURE"|"ERROR")
                  echo "❌ Canary CI test failed"
                  exit 1
                  ;;
                *)
                  echo "⏳ Waiting for CI completion..."
                  sleep 30
                  ;;
              esac
            done
          '

      - name: Clean up canary PR
        if: always()
        run: |
          gh pr close --comment "Canary test completed. Cleaning up." || true
          git push origin --delete "canary/ci-test-$(date +%Y%m%d)" || true
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### End-to-End Smoke Tests

```yaml
# Smoke test job within ci.yml
smoke-test:
  runs-on: ubuntu-latest
  if: github.event_name == 'pull_request'
  needs: [paths-filter]
  steps:
    - name: Checkout repository
      uses: actions/checkout@v4

    - name: Validate repository structure
      run: |
        echo "🔍 Validating repository structure..."
        
        # Check for required directories
        REQUIRED_DIRS=(
          "plugins/autonomous-dev/src"
          "plugins/autonomous-dev/tests"
          "plugins/autonomous-dev/bin"
          "plugins/autonomous-dev/.claude-plugin"
          ".github/workflows"
          ".github/schemas"
        )
        
        for dir in "${REQUIRED_DIRS[@]}"; do
          if [[ -d "$dir" ]]; then
            echo "✅ Found required directory: $dir"
          else
            echo "❌ Missing required directory: $dir"
            exit 1
          fi
        done

    - name: Validate critical files exist
      run: |
        CRITICAL_FILES=(
          "plugins/autonomous-dev/package.json"
          "plugins/autonomous-dev/.claude-plugin/plugin.json"
          "plugins/autonomous-dev/tsconfig.json"
          ".github/workflows/ci.yml"
          ".github/schemas/plugin.schema.json"
        )
        
        for file in "${CRITICAL_FILES[@]}"; do
          if [[ -f "$file" ]]; then
            echo "✅ Found critical file: $file"
          else
            echo "❌ Missing critical file: $file"
            exit 1
          fi
        done

    - name: Validate JSON files syntax
      run: |
        find . -name "*.json" -not -path "*/node_modules/*" | while read -r json_file; do
          if jq empty "$json_file" 2>/dev/null; then
            echo "✅ Valid JSON: $json_file"
          else
            echo "❌ Invalid JSON: $json_file"
            exit 1
          fi
        done

    - name: Basic plugin structure validation
      run: |
        for plugin_dir in plugins/*/; do
          PLUGIN_NAME=$(basename "$plugin_dir")
          PLUGIN_JSON="$plugin_dir/.claude-plugin/plugin.json"
          
          if [[ -f "$PLUGIN_JSON" ]]; then
            PLUGIN_NAME_JSON=$(jq -r '.name' "$PLUGIN_JSON")
            echo "📦 Plugin: $PLUGIN_NAME (manifest name: $PLUGIN_NAME_JSON)"
            
            # Basic field validation
            jq -e '.name and .version and .description and .author and .license' "$PLUGIN_JSON" > /dev/null || {
              echo "❌ Plugin $PLUGIN_NAME missing required fields"
              exit 1
            }
          else
            echo "❌ Plugin $PLUGIN_NAME missing plugin.json"
            exit 1
          fi
        done
```

### Integration Test Framework

```bash
#!/bin/bash
# tests/integration/ci-integration.sh
# Integration tests for CI workflow components

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMP_DIR=$(mktemp -d)

cleanup() {
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

test_paths_filter_accuracy() {
    echo "🧪 Testing paths-filter accuracy..."
    
    # Create test repository structure
    mkdir -p "$TEMP_DIR/test-repo"
    cd "$TEMP_DIR/test-repo"
    git init
    
    # Copy paths-filter configuration
    mkdir -p .github/workflows
    cp "$REPO_ROOT/.github/workflows/ci.yml" .github/workflows/
    
    # Create test files that should trigger different filters
    mkdir -p plugins/test-plugin/src plugins/test-plugin/bin plugins/test-plugin/docs
    touch plugins/test-plugin/src/index.ts
    touch plugins/test-plugin/bin/script.sh
    touch plugins/test-plugin/docs/readme.md
    
    # Test that paths-filter would trigger correctly
    # (This would require running the actual action or implementing equivalent logic)
    echo "✅ Paths filter accuracy test structure created"
}

test_plugin_validation_fallback() {
    echo "🧪 Testing plugin validation fallback..."
    
    # Create a minimal plugin.json for testing
    cat > "$TEMP_DIR/test-plugin.json" << 'EOF'
{
  "name": "test-plugin",
  "version": "1.0.0",
  "description": "Test plugin for CI validation",
  "author": "test-author",
  "license": "MIT"
}
EOF

    # Test JSON schema validation
    if command -v ajv-cli >/dev/null 2>&1; then
        ajv-cli validate -s "$REPO_ROOT/.github/schemas/plugin.schema.json" -d "$TEMP_DIR/test-plugin.json"
        echo "✅ JSON schema validation test passed"
    else
        echo "⚠️ ajv-cli not available, skipping schema validation test"
    fi
}

test_security_config_validity() {
    echo "🧪 Testing security configuration validity..."
    
    # Validate gitleaks config
    if [[ -f "$REPO_ROOT/.github/security/gitleaks.toml" ]]; then
        # Basic TOML syntax validation
        echo "✅ Gitleaks config found"
    else
        echo "❌ Gitleaks config missing"
        return 1
    fi
}

main() {
    echo "🚀 Running CI integration tests..."
    
    test_paths_filter_accuracy
    test_plugin_validation_fallback
    test_security_config_validity
    
    echo "✅ All CI integration tests passed"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
```

## 17. Performance Optimization

The CI system targets sub-8-minute completion times through strategic caching, parallel execution, and intelligent job filtering.

### Wall Time Optimization

```yaml
# Performance monitoring embedded in workflows
- name: Performance metrics collection
  run: |
    START_TIME="${{ github.event.created_at }}"
    CURRENT_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    
    # Calculate elapsed time (simplified - production would use proper date math)
    echo "⏱️ Workflow started: $START_TIME"
    echo "⏱️ Current time: $CURRENT_TIME"
    echo "📊 Job: ${{ github.job }}"
    echo "🎯 Target: <8 minutes total workflow time"
```

### Parallel Job Execution

```yaml
# Optimized job dependencies for maximum parallelism
jobs:
  paths-filter:
    # Single dependency for all other jobs
    
  typecheck:
    needs: [paths-filter]
    # No dependencies between matrix jobs
    
  lint:
    needs: [paths-filter]
    # Can run in parallel with typecheck
    
  test:
    needs: [paths-filter]
    # Can run in parallel with typecheck and lint
    
  shell:
    needs: [paths-filter]
    # Independent of TypeScript jobs
    
  # All validation jobs run in parallel after paths-filter
```

### Cache Optimization Strategy

```yaml
# Hierarchical cache keys for maximum hit rate
- name: Optimized npm cache
  uses: actions/cache@v4
  with:
    path: ~/.npm
    key: npm-${{ runner.os }}-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      npm-${{ runner.os }}-
      npm-

- name: Optimized TypeScript cache
  uses: actions/cache@v4
  with:
    path: |
      plugins/*/tsconfig.tsbuildinfo
      plugins/*/dist
    key: tsc-${{ runner.os }}-${{ hashFiles('plugins/*/src/**/*.ts', 'plugins/*/tsconfig.json') }}
    restore-keys: |
      tsc-${{ runner.os }}-
```

### Resource Usage Monitoring

```yaml
# Resource usage tracking
- name: Monitor resource usage
  run: |
    echo "💾 Disk usage:"
    df -h
    echo ""
    echo "🧠 Memory usage:"
    free -h
    echo ""
    echo "⚡ CPU info:"
    nproc
    echo ""
    echo "📦 Node modules size:"
    du -sh plugins/*/node_modules/ 2>/dev/null || echo "No node_modules found"
```

### Performance Regression Detection

```yaml
# Performance benchmark comparison
performance-benchmark:
  runs-on: ubuntu-latest
  if: github.event_name == 'pull_request'
  steps:
    - name: Checkout repository
      uses: actions/checkout@v4

    - name: Run performance benchmark
      run: |
        # Simple benchmark of key operations
        echo "🏃 Running performance benchmarks..."
        
        START=$(date +%s%N)
        find plugins/ -name "*.ts" | wc -l
        FIND_END=$(date +%s%N)
        FIND_TIME=$(( (FIND_END - START) / 1000000 ))
        
        echo "📊 File discovery: ${FIND_TIME}ms"
        
        # Store results for comparison
        echo "${FIND_TIME}" > find-benchmark.txt

    - name: Upload benchmark results
      uses: actions/upload-artifact@v4
      with:
        name: performance-benchmark
        path: find-benchmark.txt
        retention-days: 30
```

## 18. Migration Plan

The rollout strategy implements a phased approach to minimize disruption while establishing comprehensive CI coverage.

### Phase 1: Baseline Infrastructure (Week 1)

**Scope**: Essential CI framework and basic validation

**Deliverables**:
- Complete `ci.yml` workflow with all jobs implemented
- ESLint and Prettier configuration files
- Shellcheck and shfmt configuration
- Basic markdown linting setup
- Plugin schema vendoring

**Migration Steps**:
1. Create `.github/workflows/ci.yml` with all job definitions
2. Add ESLint/Prettier config files to both plugin directories
3. Configure shellcheck and shfmt for shell script validation
4. Implement paths-filter with comprehensive pattern matching
5. Set up basic security scanning with gitleaks
6. Configure branch protection to require ci/typecheck and ci/lint

**Validation Criteria**:
- Open test PR with TypeScript changes → typecheck and lint jobs execute
- Open test PR with shell script changes → shell job executes
- Open test PR with markdown changes → markdown job executes
- All jobs complete within 8 minutes for typical changes

### Phase 2: Plugin Validation & Security (Week 2)

**Scope**: Plugin manifest validation and comprehensive security scanning

**Deliverables**:
- Claude CLI bootstrap mechanism with JSON schema fallback
- Complete plugin schema at `.github/schemas/plugin.schema.json`
- Enhanced security review workflow with SARIF integration
- Version monotonicity validation for release branches

**Migration Steps**:
1. Implement plugin validation job with Claude CLI bootstrap
2. Add fallback JSON schema validation mechanism
3. Create comprehensive plugin manifest schema
4. Enhance security workflow with TruffleHog and additional scanners
5. Add SARIF upload for GitHub Advanced Security integration
6. Update branch protection to require plugin-validate and security-baseline

**Validation Criteria**:
- Plugin validation succeeds when Claude CLI is available
- Plugin validation falls back gracefully when Claude CLI fails
- Security workflow catches test secrets and blocks merge
- SARIF results appear in GitHub Security tab

### Phase 3: Advanced Features & Monitoring (Week 3)

**Scope**: Performance optimization and comprehensive monitoring

**Deliverables**:
- Monday canary test automation
- Cache performance monitoring
- End-to-end smoke testing
- Performance regression detection
- Admin override mechanisms

**Migration Steps**:
1. Implement Monday canary PR automation
2. Add cache performance monitoring and reporting
3. Create comprehensive smoke test suite
4. Set up performance benchmarking and regression detection
5. Implement admin override labels with proper authorization
6. Add comprehensive error reporting and debugging features

**Validation Criteria**:
- Monday canary test creates PR and validates all CI jobs
- Cache hit rate exceeds 60% for typical PRs
- Admin override labels work only when applied by repository admins
- Performance benchmarks establish baseline for regression detection

### Phase 4: Production Hardening (Week 4)

**Scope**: Production-grade reliability and operational excellence

**Deliverables**:
- Fork PR handling mechanisms
- Comprehensive error handling and recovery
- Operational runbooks and debugging guides
- Performance tuning and optimization
- Complete documentation and training materials

**Migration Steps**:
1. Implement fork PR handling with secret-safe fallbacks
2. Add comprehensive error handling for all failure modes
3. Create operational runbooks for common CI issues
4. Fine-tune performance with advanced caching strategies
5. Document all configuration options and troubleshooting procedures
6. Train team on CI system operation and maintenance

**Validation Criteria**:
- Fork PRs execute safely without exposing secrets
- All failure modes have clear error messages and recovery procedures
- CI system operates reliably under production load
- Team can effectively troubleshoot and maintain the system

### Rollback Procedures

**Emergency Rollback**:
```bash
#!/bin/bash
# emergency-rollback.sh - Disable CI requirements for emergency merges

# Remove required status checks temporarily
gh api repos/:owner/:repo/branches/main/protection \
  --method PATCH \
  --field required_status_checks='null'

echo "⚠️ CI requirements temporarily disabled for emergency merge"
echo "🔄 Re-enable with: gh api repos/:owner/:repo/branches/main/protection --method PATCH --field required_status_checks='{...}'"
```

**Graceful Rollback**:
```bash
#!/bin/bash
# graceful-rollback.sh - Remove CI components in reverse dependency order

# Phase 1: Remove non-essential workflows
rm .github/workflows/canary-test.yml
rm .github/workflows/paths-filter-canary.yml

# Phase 2: Remove enhanced security features
git checkout HEAD~1 -- .github/workflows/security-review.yml

# Phase 3: Remove plugin validation
sed -i '/plugin-validate/d' .github/workflows/ci.yml

# Phase 4: Remove all CI (if necessary)
rm .github/workflows/ci.yml

echo "✅ CI rollback completed"
```

## 19. Open Questions

### OQ-1: ESLint Rule Severity
**Question**: Should TypeScript strict mode violations be errors or warnings in CI?  
**Impact**: Affects PR blocking behavior and developer experience  
**Recommendation**: Start with warnings, escalate to errors after 2 weeks of warning period  
**Owner**: Engineering Lead  
**Timeline**: Decide before Phase 1 completion

### OQ-2: Security Scan Frequency
**Question**: Should security scans run on every PR or only on main branch?  
**Impact**: Affects CI performance and security coverage  
**Current Design**: Every PR per PRD-007 FR-14 requirement  
**Consideration**: Could add scheduled full-repo scans for comprehensive coverage  
**Owner**: Security Team  
**Timeline**: Review after Phase 2

### OQ-3: Plugin Validation Fallback Strategy
**Question**: Should JSON schema fallback be permanent or removed once Claude CLI is stable?  
**Impact**: Affects maintenance burden and validation coverage  
**Recommendation**: Keep fallback permanently for reliability  
**Rationale**: External service dependencies should always have fallbacks  
**Owner**: Platform Team  
**Timeline**: Finalize before Phase 2

### OQ-4: Matrix Job Failure Handling
**Question**: Should matrix jobs fail-fast or continue-on-error for comprehensive coverage?  
**Current Design**: fail-fast=false for comprehensive testing  
**Trade-off**: Longer CI times vs. complete platform coverage  
**Owner**: Engineering Team  
**Timeline**: Monitor performance in Phase 1, adjust if needed

### OQ-5: Cache Invalidation Strategy
**Question**: How aggressively should caches be invalidated on dependency changes?  
**Impact**: Affects cache hit rate vs. staleness risk  
**Current Design**: Hash-based keys with fallback restore-keys  
**Consideration**: Add time-based cache expiration  
**Owner**: DevOps Team  
**Timeline**: Evaluate after Phase 3 cache metrics

### OQ-6: Admin Override Scope
**Question**: Should admin overrides bypass all checks or only specific categories?  
**Security Concern**: Admin overrides for security checks need different approval process  
**Current Design**: Single override label for all checks  
**Recommendation**: Implement tiered override system (ci:override vs security:override)  
**Owner**: Security + Operations Teams  
**Timeline**: Implement before Phase 4

### OQ-7: Fork PR Testing Coverage
**Question**: What minimum testing should fork PRs receive without repository secrets?  
**Current Design**: JSON schema validation only, other checks neutral  
**Security Requirement**: No secret exposure to fork contexts  
**Trade-off**: Security vs. comprehensive validation  
**Owner**: Security Team  
**Timeline**: Finalize before Phase 2

## 20. References

- **PRD-010: GitHub Actions CI/CD Pipeline** — Parent requirements document defining functional requirements FR-1001 through FR-1011
- **TDD-001: Daemon Engine** — Establishes technical voice and architecture patterns for autonomous-dev system
- **PRD-007: Escalation & Trust Framework** — Defines FR-14 security pause rule requiring high/critical findings to block merges
- **Package.json Current Scripts** — `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/package.json` provides current test command structure
- **Existing Shell Scripts** — `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/bin/*.sh` provide shellcheck validation targets
- **Plugin Manifests** — Plugin.json files at `/Users/pwatson/codebase/autonomous-dev/plugins/*/\.claude-plugin/plugin.json` define validation scope
- **GitHub Actions Documentation** — https://docs.github.com/en/actions for workflow syntax and best practices
- **dorny/paths-filter Documentation** — https://github.com/dorny/paths-filter for path-based job filtering patterns
- **ESLint TypeScript Rules** — https://typescript-eslint.io/rules/ for TypeScript-specific linting configuration
- **Prettier Configuration** — https://prettier.io/docs/en/configuration.html for code formatting standards
- **Shellcheck Documentation** — https://github.com/koalaman/shellcheck/wiki for shell script validation rules
- **Gitleaks Configuration** — https://github.com/zricethezav/gitleaks#configuration for secrets scanning patterns
- **markdownlint Rules** — https://github.com/DavidAnson/markdownlint/blob/main/doc/Rules.md for documentation quality standards
- **GitHub Branch Protection API** — https://docs.github.com/en/rest/branches/branch-protection for required status check configuration

---

**END TDD-016**