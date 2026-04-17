# PLAN-007-2: Data Safety -- Scrubbing & Security

## Metadata
- **Parent TDD**: TDD-007-production-intelligence
- **Estimated effort**: 6 days
- **Dependencies**: [PLAN-007-1]
- **Blocked by**: [PLAN-007-1] (requires raw data from MCP adapters to scrub)
- **Priority**: P0

## Objective

Implement the two-stage PII/secret scrubbing pipeline that sits between raw production data collection and all downstream processing. This is the safety-critical component: no raw production data may reach the LLM context window, be written to disk, or enter any analysis module without passing through this pipeline. The plan also covers scrub audit logging, post-scrub validation, weekly audit scans, and the security controls from TDD section 7.

## Scope

### In Scope
- Two-stage scrubbing pipeline architecture: PII scrubber then secret detector (section 3.4.1)
- Full PII pattern library: email, phone (US/intl), SSN, credit card (Visa/MC/Amex), IPv4, IPv6, IPv6 compressed, JWT, context-aware UUID (section 3.4.2)
- Full secret pattern library: AWS keys, Stripe keys, GitHub tokens, GitLab PAT, GCP keys, Slack tokens/webhooks, generic bearer/basic auth, private key blocks, generic high-entropy detector, env var pattern (section 3.4.3)
- Scrubbing implementation with ordered regex execution and replacement (section 3.4.4)
- Post-scrub validation pass (defense-in-depth re-scrub) (section 3.4.4)
- Scrub failure handling: malformed patterns, timeout, residual detection (section 6.2)
- Scrubbing audit log with per-invocation redaction counts (section 3.4.5)
- Custom pattern support from `intelligence.yaml` (appended, not replacing defaults)
- Weekly audit scan of observation reports for unscrubbed PII/secrets (section 7.1)
- Read-only MCP access enforcement documentation/validation (section 7.2)
- Observation report access control guidance (section 7.4)
- Dedicated PII/secret scrubbing test suite with 10K-line corpus (section 8.3)
- Security tests: PII leak audit, secret leak audit, credential scan (section 8.5)

### Out of Scope
- MCP server connectivity and query execution (PLAN-007-1)
- Error detection, classification, and analytics (PLAN-007-3)
- Report generation and triage (PLAN-007-4)
- Governance engine (PLAN-007-5)
- NER/ML-based scrubbing (rejected alternative per TDD section 9.1)
- Microsoft Presidio integration (deferred per OQ-7; may revisit for weekly audit)

## Tasks

1. **Implement PII scrubber stage** -- Build the first-stage regex-based scrubber covering all 11 PII patterns from TDD section 3.4.2.
   - Files to create/modify: `src/safety/pii-scrubber.ts` (or equivalent module)
   - Acceptance criteria: Each of the 11 patterns (email, phone US, phone intl, SSN, credit card, credit card Amex, IPv4, IPv6 full, IPv6 compressed, JWT, context-aware UUID) is implemented with the exact regex from the TDD. Replacement strings match the TDD (`[REDACTED:email]`, `[REDACTED:phone]`, etc.). IPv6 compressed pattern includes false-positive validation against timestamps. Context-aware UUID only applies to fields named `user_id`, `customer_id`, `account_id`.
   - Estimated effort: 8 hours

2. **Implement secret detector stage** -- Build the second-stage regex-based detector covering all 15 secret patterns from TDD section 3.4.3.
   - Files to create/modify: `src/safety/secret-detector.ts` (or equivalent module)
   - Acceptance criteria: Each of the 15 patterns (AWS access/secret keys, Stripe secret/publishable, GitHub PAT/app/OAuth, GitLab PAT, GCP service account/API key, Slack bot/webhook, generic bearer, basic auth, private key block, generic high-entropy, env var pattern) is implemented. High-entropy detector correctly computes Shannon entropy >4.5 bits/char for strings >20 chars in `password=`/`secret=`/`token=`/`key=` contexts. Env var pattern preserves the key name while replacing the value.
   - Estimated effort: 8 hours

3. **Build the scrubbing pipeline orchestrator** -- Wire stages together in the correct order (PII first, then secrets) with the `scrub()` function signature from TDD section 3.4.4.
   - Files to create/modify: `src/safety/scrub-pipeline.ts`
   - Acceptance criteria: Function accepts raw text and a `DataSafetyConfig`. Returns `ScrubResult` with cleaned text, redaction count, and redaction metadata (type, position, original length -- never the original value). PII runs before secrets so email-like patterns in API keys are not double-tagged. Custom patterns from config are appended to the default list.
   - Estimated effort: 4 hours

4. **Implement post-scrub validation pass** -- Add a second full-pattern scan after the initial scrub to catch any residuals (defense-in-depth).
   - Files to create/modify: `src/safety/scrub-pipeline.ts`
   - Acceptance criteria: After the initial scrub, the full pattern list is run again. If residuals are found, they are scrubbed. If residuals persist after the second pass, the entire field is replaced with `[SCRUB_FAILED:field_name]` and a security warning is logged.
   - Estimated effort: 3 hours

5. **Implement scrubbing audit log** -- Write a JSON log entry for every scrub invocation recording run ID, service, source, lines processed, per-type redaction counts, and processing time.
   - Files to create/modify: `src/safety/scrub-audit.ts`, audit log writer
   - Acceptance criteria: Log format matches TDD section 3.4.5 exactly. Logs are written to the run's audit log file. Processing time is measured and recorded in milliseconds.
   - Estimated effort: 3 hours

6. **Implement scrub failure handling** -- Handle the three failure modes from TDD section 6.2: malformed custom regex, timeout >30s, residual detection.
   - Files to create/modify: `src/safety/scrub-pipeline.ts`, error handling module
   - Acceptance criteria: Malformed regex is caught, logged, and skipped without crashing. If scrubbing exceeds 30s, the batch is truncated and unscrubbed data is NOT passed forward. Residual detection triggers the `[SCRUB_FAILED:field_name]` replacement. All failure modes are logged with appropriate severity (warning for skip, error for timeout/residual).
   - Estimated effort: 4 hours

7. **Integrate scrubbing into the data collection pipeline** -- Wire the scrub pipeline into the runner between the query phase and the analyze phase so that all text from OpenSearch and all string fields from other sources pass through scrubbing.
   - Files to create/modify: Observation runner module (from PLAN-007-1), data pipeline integration
   - Acceptance criteria: No raw production text reaches the LLM context or is written to any file without passing through the scrub pipeline. OpenSearch log messages and stack traces are scrubbed. String fields from Prometheus and Grafana responses are scrubbed. The scrub step is not bypassable via configuration.
   - Estimated effort: 4 hours

8. **Build the weekly audit scan** -- Implement an automated scan that runs weekly over all observation reports, searching for patterns that should have been caught by the real-time scrubber.
   - Files to create/modify: `src/safety/weekly-audit.ts`, schedule configuration
   - Acceptance criteria: Scan reads all `.md` files in `.autonomous-dev/observations/`. Runs the full PII + secret pattern library against file contents. Reports any matches with file path, line number, and pattern type. Target: zero matches (success metric from TDD section 7.1). Can optionally use broader/slower detection methods (e.g., expanded entropy analysis).
   - Estimated effort: 4 hours

9. **Document security controls and access guidance** -- Write inline documentation covering read-only MCP enforcement (section 7.2), credential management (section 7.3), and observation report access control recommendations (section 7.4).
   - Files to create/modify: Security documentation within the plugin, `.gitignore` update for public repos
   - Acceptance criteria: Documentation covers least-privilege MCP permissions for all four servers. Credential storage requirements (env vars only) are documented. `.autonomous-dev/observations/` is added to `.gitignore` template for public repos.
   - Estimated effort: 2 hours

10. **Build the scrubbing test suite** -- Create the dedicated test corpus and test suite from TDD section 8.3 and 8.5.
    - Files to create/modify: Test files for PII scrubber, secret detector, pipeline, weekly audit
    - Acceptance criteria: Test corpus contains 10,000 log lines with the exact distribution from TDD section 8.3 (500 emails, 200 phones, 50 SSNs, 100 credit cards, 150 IPs, 50 AWS keys, 30 GitHub tokens, 20 Stripe keys, 100 Bearer tokens, 50 JWTs, 200 high-entropy strings). Recall >99% on known patterns (NFR-009). False positive rate <5%. Performance <2s for full 10K-line corpus (NFR-002). PII leak audit test: after a mock observation run, scan all generated files for known patterns -- zero matches. Secret leak audit test: same, zero matches. Credential scan test: verify `intelligence.yaml` and observation reports contain no hardcoded credentials.
    - Estimated effort: 10 hours

## Dependencies & Integration Points
- **Upstream**: PLAN-007-1 provides raw data from MCP adapters that this pipeline scrubs.
- **Downstream**: PLAN-007-3 (analytics) receives only scrubbed data. PLAN-007-4 (reports) writes only scrubbed content to observation files. PLAN-007-5 (governance) reads scrubbed observation data.
- **Contract**: The `scrub()` function is the single entry point. All downstream consumers call it or receive already-scrubbed data. The function signature and `ScrubResult` type are the integration interface.
- **Configuration**: Custom PII/secret patterns are loaded from `intelligence.yaml` (defined in PLAN-007-1).

## Testing Strategy
- **Unit tests**: Each PII pattern tested with positive matches (true PII), negative matches (similar but not PII), and edge cases (partial matches, overlapping patterns). Each secret pattern tested similarly. High-entropy detector tested with known high/low entropy strings in correct contexts.
- **Integration tests**: Full pipeline test with mixed content containing multiple PII and secret types. Post-scrub validation test confirming defense-in-depth catches intentionally leaked patterns. Failure handling tests for malformed regex, timeout, and residual scenarios.
- **Corpus tests**: 10K-line corpus test measuring recall, precision, and performance per NFR-002 and NFR-009.
- **Security tests**: End-to-end leak audit after mock observation runs. Credential scan of config files.
- **Regression tests**: Any PII/secret discovered by the weekly audit is added to the test corpus as a regression test case.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| IPv6 compressed regex produces false positives on timestamp-like strings | Medium | Low | Validate matches against known timestamp formats before redacting. Test corpus includes timestamp strings. |
| High-entropy detector flags legitimate base64 content in log messages | Medium | Low | Context-aware: only trigger when preceded by `password=`, `secret=`, `token=`, `key=`. Configurable exclusion patterns. |
| Novel PII format not covered by regex patterns | Medium | High | Weekly audit scan catches misses. New patterns are added immediately upon discovery. OQ-7 tracks potential Presidio integration for broader coverage. |
| Scrubbing adds measurable latency to each run | Low | Medium | NFR-002 requires <2s per 10K lines. Regex-based approach is far under this. Monitor processing time in audit log. |
| Custom patterns in `intelligence.yaml` conflict with defaults | Low | Medium | Custom patterns are appended, never replace defaults. Malformed patterns are caught and skipped. |

## Definition of Done
- [ ] PII scrubber implements all 11 patterns from TDD section 3.4.2 with correct replacement strings
- [ ] Secret detector implements all 15 patterns from TDD section 3.4.3
- [ ] Scrubbing pipeline runs PII before secrets and returns `ScrubResult` with redaction metadata
- [ ] Post-scrub validation catches residuals and falls back to `[SCRUB_FAILED:field_name]`
- [ ] Scrub audit log records per-invocation metrics in the format from TDD section 3.4.5
- [ ] All three failure modes from TDD section 6.2 are handled without crashing or leaking data
- [ ] Scrubbing is integrated into the runner pipeline between query and analyze phases with no bypass path
- [ ] Weekly audit scan detects unscrubbed PII/secrets in observation files
- [ ] Test corpus achieves >99% recall, <5% false positive rate, and <2s for 10K lines
- [ ] Security tests confirm zero PII/secret leaks in generated observation files
- [ ] No hardcoded credentials in `intelligence.yaml` or observation reports
