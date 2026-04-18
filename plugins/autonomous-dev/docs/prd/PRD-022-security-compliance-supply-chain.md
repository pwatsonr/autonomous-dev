# PRD-022: Security, Compliance & Supply-Chain

Metadata: PRD-022 | v0.1.0 | 2026-04-18 | Patrick Watson | Draft | autonomous-dev

## 1. Problem
autonomous-dev has no formal threat model, no SBOM on its own releases, no SLSA provenance, no AI-BOM for agent-generated code, no compliance framework. 2026 is post-xz-utils (2024), post-EU AI Act enforcement (Feb 2025). FAANG targets SLSA L3+; enterprises block tools without SBOM/SLSA/signed provenance. Without this we cannot enter regulated markets (FedRAMP, SOC2, ISO 27001, EU AI Act).

## 2. Goals (G-1..G-12)
G-1 Publish threat model (STRIDE) covering plugin surface, agent guardrails, secrets, state. G-2 SLSA L3 on our own build pipeline (Phase 2 target L2, Phase 3 L3). G-3 CycloneDX SBOM emitted on every release. G-4 CycloneDX ML-BOM / AI-BOM for AI-generated artifacts (agent outputs, prompts, models used). G-5 Sigstore cosign signing + rekor logging for all released artifacts. G-6 in-toto attestations on build steps. G-7 CodeQL + Semgrep + Socket (supply-chain intelligence) in CI. G-8 SPIFFE/SPIRE identity (dovetails PRD-020) for workloads. G-9 Compliance-ready controls mapped to SOC2, ISO 27001, NIST SSDF, FedRAMP Moderate. G-10 OSV / Dependency-Track pipeline. G-11 Secret-scanning gate (Secretlint + gitleaks + trufflehog) across code, prompts, embeddings (PRD-011), backups (PRD-019). G-12 Provenance commit trailer on AI-authored commits.

## 3. Non-Goals (NG-1..NG-6)
Not a standalone security product; not a GRC platform; not replacing SIEM; not PenTest-as-a-Service; no certification-body sponsorship; not HIPAA/PCI certification (in scope only as compliance mappings).

## 4. Personas
Security Reviewer, Compliance Auditor, Platform Operator, Release Engineer, Legal/Counsel, External Auditor.

## 5. User Stories (US-01..US-18)
Security reviewer inspects CycloneDX SBOM before release; compliance auditor exports SOC2 evidence; release is blocked if SLSA attestation missing; AI-BOM lists every model + prompt version used in commit X; cosign verification fails on tampered artifact; org-admin enables prod tier only after security review sign-off (PRD-017 gate); Socket flags typosquatted dep; CodeQL finds SSRF; trufflehog runs weekly over repo; provenance trailer on every agent commit; EU AI Act documentation bundle exported; FedRAMP Moderate control mapping; secret in prompt detected before LLM call (per PRD-018 hash-only logging); third-party audit succeeds; breach-disclosure workflow; Dependabot + auto-PR for critical CVEs.

## 6. FR
### 6.1 Threat Model (FR-100s)
FR-100 STRIDE threat model doc at `docs/security/threat-model.md`. FR-101 Updated on major version bumps. FR-102 Cross-linked to risk register.

### 6.2 SBOM (FR-200s)
FR-200 CycloneDX 1.6+ emitted in CI for every plugin package. FR-201 Published as release artifact. FR-202 Dependency-Track or OSS alternative consumes SBOM.

### 6.3 AI-BOM / Provenance (FR-300s)
FR-300 CycloneDX ML-BOM segment lists models, prompt versions, agent identities, training sources if applicable. FR-301 Commit trailer `AI-Provenance:` on AI-authored commits with model + prompt hash. FR-302 In-toto attestation links build step to inputs.

### 6.4 Signing (FR-400s)
FR-400 Sigstore cosign signs all released artifacts. FR-401 Rekor transparency log. FR-402 Fulcio OIDC issuance. FR-403 Verification script shipped.

### 6.5 SLSA (FR-500s)
FR-500 SLSA L2 in Phase 2 (hosted CI + build provenance). FR-501 SLSA L3 in Phase 3 (isolated + reproducible). FR-502 Provenance published alongside release.

### 6.6 Static Analysis (FR-600s)
FR-600 CodeQL default ruleset. FR-601 Semgrep OSS + custom rules. FR-602 Socket.dev for npm supply-chain intelligence. FR-603 Trivy or Grype for image scanning.

### 6.7 Secrets Scanning (FR-700s)
FR-700 Secretlint pre-commit + CI. FR-701 Gitleaks CI. FR-702 Trufflehog weekly full-repo. FR-703 Extensions: prompt scrubbing before LLM call (PRD-018); embedding gate (PRD-011); backup gate (PRD-019).

### 6.8 Compliance Mappings (FR-800s)
FR-800 Controls mapped to SOC2 CC-series, ISO 27001 Annex A, NIST SSDF SP 800-218, FedRAMP Moderate. FR-801 Evidence bundle generator (`autonomous-dev compliance export --framework soc2`).

### 6.9 Vulnerability Response (FR-900s)
FR-900 security.txt + PGP contact. FR-901 CVE embargo 7-90 days. FR-902 Dependabot + OSV-Scanner + auto-PR for critical severity.

### 6.10 Identity & Zero-Trust (FR-1000s)
FR-1000 SPIFFE SVIDs for workloads (ref PRD-020). FR-1001 mTLS for all internal comms. FR-1002 BeyondCorp posture documented.

### 6.11 AI-Act Compliance (FR-1100s)
FR-1100 EU AI Act risk classification self-assessment; autonomous-dev is general-purpose AI system. FR-1101 Incident reporting within 15 days per Article 73. FR-1102 Transparency documentation per Annex IV.

## 7. NFR (NFR-01..NFR-10)
SBOM generation <30s; cosign verification <5s; compliance export <2min; zero unsigned releases; secret-scanner false-positive rate <5%; patch cadence for criticals ≤7 days; vulnerability triage SLA per severity; compliance framework mappings ≥95% coverage; all third-party deps inventoried; AI-BOM coverage 100% of AI-authored commits.

## 8. Architecture
ASCII: Source → CI (CodeQL + Semgrep + Socket + Secret scanners) → Build → SBOM (CycloneDX) + AI-BOM → cosign sign + rekor log → Release artifact. Parallel: Dependency-Track + OSV + Dependabot → CVE PRs. Compliance export: control mappings → evidence bundle.

## 9. Testing
SBOM-schema validation; cosign verify on CI; planted-secret tests (must block release); supply-chain-attack fixture (typosquat dep); SLSA attestation verification; AI-BOM completeness test; compliance export schema test.

## 10. Migration
Phase 1 (wks 1–3): threat model + CycloneDX SBOM + Secretlint/gitleaks/trufflehog + CodeQL + Semgrep + security.txt + Dependabot. Phase 2 (wks 4–6): Sigstore cosign + rekor + in-toto attestations + SLSA L2 + Socket + SOC2 mapping + AI-BOM v1. Phase 3 (wks 7–10): SLSA L3 + FedRAMP Moderate mapping + EU AI Act compliance bundle + SPIFFE + evidence export CLI.

## 11. Risks (R-1..R-12)
Supply-chain attack via unsigned dep (cosign verify gate); secret leak via prompt to LLM (hash-only logging + scrub); SBOM drift vs actual deps (CI verify); SLSA L3 infra cost (hosted GH Runners + workflow attestation); AI-BOM privacy concerns (minimal metadata, no training data); compliance-framework churn (modular mappings); Fulcio outage (cosign offline-verify); EU AI Act misclassification (legal review); cosign key theft (KMS + short-lived Fulcio certs); Dependabot noise (auto-merge only lows); third-party audit surprises (pre-audit checklist); AI-authored trailer forgery (git-sign integration).

## 12. Success Metrics
100% releases signed + SBOM'd; zero critical CVEs >30d open; compliance audit pass rate 100%; AI-BOM coverage 100%; MTTR on disclosed vuln ≤7d critical; zero unauthorized prod tier enables (PRD-017 + this gate).

## 13. Open Questions (OQ-1..OQ-6)
SLSA L3 target quarter? SOC2 Type I vs Type II timeline? AI-BOM format (CycloneDX ML-BOM vs SPDX AI extensions)? FedRAMP Low vs Moderate first? cosign keyless vs key-based? Compliance-export framework priority (SOC2 vs ISO 27001 first)?

## 14. References
PRDs: PRD-010 (CI gates), PRD-011 (embedding secrets), PRD-017 (plugin tier gate), PRD-018 (prompt safety), PRD-019 (backup encryption), PRD-020 (identity), PRD-026 (residency).
URLs: https://slsa.dev, https://www.sigstore.dev, https://cyclonedx.org, https://spdx.dev, https://in-toto.io, https://codeql.github.com, https://semgrep.dev, https://socket.dev, https://dependencytrack.org, https://osv.dev, https://spiffe.io, https://cloud.google.com/docs/security/beyondprod, https://csrc.nist.gov/Projects/ssdf, https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai.

**END PRD-022**
