# SPEC-016-2-02: lychee.toml Config and `markdown` Link-Check Job

## Metadata
- **Parent Plan**: PLAN-016-2
- **Tasks Covered**: Task 2 (Author `lychee.toml`), Task 5 (Add `markdown` job to ci.yml)
- **Estimated effort**: 2 hours

## Description

Land the repository-root `lychee.toml` configuration and add a `markdown` job to `.github/workflows/ci.yml` that runs `lycheeverse/lychee-action@v1` against documentation files. The job is gated by the `paths-filter` output `markdown` (delivered by PLAN-016-1) and uses the `GITHUB_TOKEN` secret to avoid GitHub API rate limits when the docs reference github.com URLs. Lychee caches results for 1 day so repeated CI runs on the same PR do not re-fetch unchanged links. The job key is exactly `markdown` so branch protection can target it as a stable required check.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `lychee.toml` | Create | Repository-root config; cache, accept codes, exclusions per TDD-016 §7 |
| `.github/workflows/ci.yml` | Modify | Insert `markdown` job after the `shell` job |

## Implementation Details

### `lychee.toml` (repo root)

Verbatim content (TOML, single trailing newline):

```toml
# lychee link-checker configuration for autonomous-dev documentation.
# Mirrors TDD-016 Section 7 baseline.

# Cache: results valid for 1 day so repeated CI runs reuse them.
cache = true
max_cache_age = "1d"
verbose = true

# Status codes that count as "link OK" (in addition to default 2xx).
accept = [200, 201, 204, 301, 302, 307, 308, 403, 429]

# Patterns we never want to fail a build over.
exclude = [
  # Local development URLs
  "http://localhost:*",
  "http://127.0.0.1:*",
  # Authenticated services that always 401/403 from CI
  "https://console.anthropic.com/*",
  "https://app.slack.com/*",
  "https://discord.com/channels/*",
  # Documentation placeholders
  "https://example.com",
  "http://example.org",
  # GitHub authenticated routes
  "https://github.com/*/settings/*"
]

# Per-request timeout in seconds (network + read).
timeout = 20

# Identify the bot for upstream sites that gate by user-agent.
user_agent = "lychee/autonomous-dev-ci"

# Resolve relative links from the repo root.
base = "."

# Validate fragment (#anchor) targets in markdown files.
include_fragments = true
```

### `markdown` job (`.github/workflows/ci.yml`)

Inserted as a top-level job. Must use the literal job key `markdown`.

```yaml
markdown:
  name: markdown
  needs: paths-filter
  if: needs.paths-filter.outputs.markdown == 'true'
  runs-on: ubuntu-latest
  steps:
    - name: Checkout
      uses: actions/checkout@v4

    - name: Link check
      uses: lycheeverse/lychee-action@v1
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      with:
        args: >-
          --verbose
          --cache
          --max-cache-age 1d
          --config lychee.toml
          "plugins/**/docs/**/*.md"
          "README.md"
        fail: true
```

Notes:
- `GITHUB_TOKEN` is passed via `env:` (not `with:`) because lychee picks it up from the environment. This is the rate-limit mitigation called out in PLAN-016-2 § Risks.
- The CLI flags `--cache --max-cache-age 1d` duplicate the `lychee.toml` settings but are required because some lychee-action versions ignore TOML cache settings unless echoed on the command line.
- `fail: true` ensures the action's exit code propagates as a non-zero step result. (Default is true on v1, but we set it explicitly to lock the contract.)
- The two glob patterns `plugins/**/docs/**/*.md` and `README.md` cover all canonical doc locations. Any future `docs/` outside `plugins/` needs an additive change to this glob.

## Acceptance Criteria

### Functional Requirements

- **FR-1**: A repository-root file `lychee.toml` exists with `cache = true`, `max_cache_age = "1d"`, `accept` containing all of `[200, 201, 204, 301, 302, 307, 308, 403, 429]`, `exclude` containing `http://localhost:*` and `https://example.com`, `timeout = 20`, `base = "."`.
  - **Given** the repo HEAD **When** I run `lychee --config lychee.toml --dump-inputs README.md` **Then** the command exits 0 and prints the resolved input set.
- **FR-2**: `.github/workflows/ci.yml` contains a job whose key is `markdown` with `name: markdown`, `needs: paths-filter`, `if: needs.paths-filter.outputs.markdown == 'true'`, `runs-on: ubuntu-latest`.
  - **Given** the merged ci.yml **When** I parse it with `yq '.jobs.markdown'` **Then** all four conditions hold.
- **FR-3**: The `markdown` job passes `GITHUB_TOKEN` via `env:` to the `lycheeverse/lychee-action@v1` step.
  - **Given** the merged ci.yml **When** I inspect `jobs.markdown.steps[].env.GITHUB_TOKEN` **Then** it equals `${{ secrets.GITHUB_TOKEN }}`.
- **FR-4**: The `markdown` job invokes lychee with `--config lychee.toml`, `--cache`, `--max-cache-age 1d` and globs `plugins/**/docs/**/*.md` and `README.md`.
  - **Given** the job log **When** the link-check step starts **Then** it shows the four CLI flags and both globs.
- **FR-5**: A markdown file containing a known-broken link fails the `markdown` job.
  - **Given** a PR that adds `plugins/autonomous-dev/docs/throwaway.md` containing `[broken](https://this-domain-definitely-does-not-exist.invalid)` **When** the `markdown` job runs **Then** the job exits non-zero and the step log identifies the broken URL.
- **FR-6**: A markdown file with only valid links passes.
  - **Given** a PR that adds `plugins/autonomous-dev/docs/throwaway.md` containing only links to `https://github.com` and `https://example.com` (the latter excluded) **When** the `markdown` job runs **Then** the job exits 0.
- **FR-7**: A PR that touches only shell files does not run the `markdown` job.
  - **Given** a PR modifying only `plugins/autonomous-dev/bin/supervisor-loop.sh` **When** CI dispatches **Then** the `markdown` job appears in the run as `Skipped`.
- **FR-8**: When the `markdown` job runs twice in succession on the same content within 24 hours, the second run's lychee step reports cache hits.
  - **Given** an unchanged PR re-run within 24 hours **When** the `markdown` job runs **Then** the lychee log line `Skipped (cached)` appears for previously-fetched URLs.

### Non-Functional Requirements

| Requirement | Target | Measurement |
|-------------|--------|-------------|
| `markdown` job wall-clock (cold cache) | < 120s | GitHub Actions run summary |
| `markdown` job wall-clock (warm cache, < 24h) | < 60s | GitHub Actions run summary |
| Status check name stability | Exactly `markdown` (case-sensitive) | Branch-protection UI shows the check |
| Rate-limit failures against github.com | 0 over a 7-day window | Manual review of failed runs |

## Dependencies

- **PLAN-016-1**: provides `paths-filter` job with output `markdown` (boolean string).
- **`lycheeverse/lychee-action@v1`**: GitHub Action; requires runner with internet egress (default on `ubuntu-latest`).
- **`secrets.GITHUB_TOKEN`**: available by default in the workflow context; no separate provisioning required.
- **TDD-016 Section 7**: source of truth for the rule set.

## Notes

- `markdownlint-cli2` rule enforcement is explicitly out of scope (PLAN-016-2 § Out of Scope) — lychee handles link validation only. A doc-cleanup pass is required before markdownlint can be turned on.
- The `https://example.com` exclusion lets technical writers use the canonical placeholder URL in examples without breaking CI.
- Risk: lychee occasionally hits transient network errors against valid URLs. Mitigation: the cache absorbs single-flake retries on PR re-runs; persistent flake against a real URL means the URL is genuinely broken and should be fixed.
- The `include_fragments = true` setting catches `[link](file.md#missing-anchor)` typos. If this surfaces too many legacy false positives, downgrade to `false` in a follow-up rather than land flaky CI.
