# PRD-026: Data Governance, PII & Data Residency

Metadata: PRD-026 | v0.1.0 | 2026-04-18 | Patrick Watson | Draft | autonomous-dev

## 1. Problem
autonomous-dev handles user requests (may contain PII, customer data), codebase (proprietary), prompts (sensitive), embeddings (indirect data representation), state files, backups. No formal classification, no residency controls, no DSR (data subject rights) flows. GDPR Article 30 records, EU AI Act transparency, CCPA/CPRA, FedRAMP impact levels all require explicit governance. Without this we cannot operate in EU, EEA, UK, California, India sovereign clouds.

## 2. Goals (G-1..G-10)
G-1 Data classification framework (Public, Internal, Confidential, Restricted). G-2 PII detection + scrubbing pipeline applied to: prompts, embeddings (PRD-011), logs, traces (PRD-021), backups (PRD-019). G-3 Data residency enforcement (region pinning per tenant). G-4 Data subject rights (DSR): access, portability, erasure, rectification. G-5 Retention schedules per data class and regulatory context. G-6 GDPR Article 30 records-of-processing. G-7 Cross-border transfer controls (Standard Contractual Clauses, Adequacy Decisions). G-8 Customer-managed encryption keys (CMEK) option. G-9 Data-lineage tracking (where data came from, where it flowed). G-10 Pluggable PII detector (Presidio, AWS Comprehend, Cloud DLP).

## 3. Non-Goals (NG-1..NG-6)
Not a DLP product; not replacing cloud IAM; not blockchain audit; not jurisdiction-law interpretation (consult counsel); not GDPR certification body; not HIPAA/PCI certification scope.

## 4. Personas
Data Protection Officer, Compliance Auditor, Tenant Admin, Security Reviewer, EU/Regulated Customer, Legal Counsel.

## 5. User Stories (US-01..US-18)
DPO exports GDPR Article 30 records; customer issues DSR delete; autonomous-dev purges all records within 30d SLA; EU tenant's data never leaves eu-west-1 region; prompts containing PII auto-scrubbed before LLM call; backups encrypted with customer-managed key; audit shows full data lineage; cross-border transfer documented with SCCs; classification tag drives retention + encryption + access policy; FedRAMP Moderate customer uses us-gov-west-1; Indian sovereign-cloud customer uses asia-south-1; DLP scan flags credit card in code comment; prompt-injection attempts logged with redacted payload; PII exposure incident reporting within 72h (GDPR Article 33); child-safe zones enforced (COPPA); health data boundary (HIPAA-compatible but not certified); payments data boundary (PCI-compatible but not certified); right-to-rectification for user-submitted PRD.

## 6. FR
### 6.1 Classification (FR-100s)
FR-100 Classes: Public, Internal, Confidential, Restricted. FR-101 Every data object carries `data_classification` metadata. FR-102 Classification auto-applied by scanner or manual override. FR-103 Default: Confidential for new content.

### 6.2 PII Detection & Scrubbing (FR-200s)
FR-200 `PIIDetector` interface. FR-201 Adapters: Microsoft Presidio (default OSS), AWS Comprehend, Google Cloud DLP. FR-202 Applied to: prompts (pre-LLM, ref PRD-018), embeddings (pre-index, ref PRD-011), logs (pre-emit, ref PRD-021), backups (pre-write, ref PRD-019). FR-203 Fail-closed (block send on detected PII by default; configurable).

### 6.3 Residency (FR-300s)
FR-300 Tenant config specifies region (eu-west-1, us-east-1, asia-south-1, etc.). FR-301 All storage + compute stays within region. FR-302 LLM provider adapter honors region (PRD-018). FR-303 Cross-region pinned via policy gate.

### 6.4 DSR (FR-400s)
FR-400 `autonomous-dev dsr request --type access|delete|portability|rectify --subject <id>`. FR-401 Resolution SLA: 30d (GDPR) / 45d (CCPA). FR-402 Audit trail of DSR processing. FR-403 Cryptographic erasure supported.

### 6.5 Retention (FR-500s)
FR-500 Retention schedules per class: Public ∞; Internal 5y; Confidential 7y (SOX/SOC2); Restricted per regulation. FR-501 Automatic purge on schedule. FR-502 Legal-hold override (no auto-purge when set).

### 6.6 Records of Processing (FR-600s)
FR-600 GDPR Article 30 records auto-generated from tenant config + lineage graph. FR-601 Export CSV/JSON/PDF. FR-602 Updated on config change.

### 6.7 Cross-Border Transfers (FR-700s)
FR-700 Transfer matrix maintained (source region → destination region). FR-701 SCCs + adequacy mappings. FR-702 Block transfer if mapping missing.

### 6.8 CMEK (FR-800s)
FR-800 Customer-managed keys via cloud KMS (AWS KMS, GCP KMS, Azure Key Vault, HashiCorp Vault Transit). FR-801 Key rotation supported. FR-802 Key destruction = cryptographic erasure.

### 6.9 Data Lineage (FR-900s)
FR-900 Every record carries source + transformations applied. FR-901 Lineage graph queryable via CLI. FR-902 Enables DSR resolution + breach scope.

### 6.10 Incident Response (FR-1000s)
FR-1000 PII exposure auto-detected via scanner + honeypot. FR-1001 72h disclosure template (GDPR Article 33). FR-1002 Customer notification workflow (PRD-007 escalation).

### 6.11 CLI (FR-1100s)
FR-1100 `autonomous-dev data classify <path>`. FR-1101 `... data purge --tenant <id> --subject <id>`. FR-1102 `... data export --format gdpr-article-30`. FR-1103 `... data lineage <record-id>`.

## 7. NFR (NFR-01..NFR-10)
PII scan p95 <100ms per chunk; DSR resolution <30d (GDPR); <45d (CCPA); residency enforcement zero leaks; classification coverage ≥95%; lineage graph traversal <1s; retention purge zero-miss; CMEK rotation zero-downtime; GDPR export complete; backups honor classification; cross-border block decisive.

## 8. Architecture
ASCII: Input (prompt / code / embedding / log / backup) → Classifier → PII Detector (Presidio / Comprehend / Cloud DLP) → Scrubber/Blocker → Storage (region-pinned) → CMEK-encrypted → Retention scheduler → Lineage ledger. DSR flow: request → lineage traversal → purge/export → audit.

## 9. Testing
Planted-PII-in-prompt test (must block); residency violation test (must block); DSR end-to-end test; classification correctness on fixtures; lineage completeness under async writes; retention-purge dry-run; CMEK rotation test; incident-disclosure timing test.

## 10. Migration
Phase 1 (wks 1–3): classification framework + Presidio PII detector + prompt scrubbing (PRD-018 hook) + embedding gate (PRD-011 hook) + log scrubbing (PRD-021 hook). Phase 2 (wks 4–6): residency enforcement + DSR CLI + retention scheduler + GDPR Article 30 export + lineage graph v1. Phase 3 (wks 7–10): CMEK + AWS Comprehend + Cloud DLP adapters + cross-border transfer matrix + incident-response workflow + FedRAMP region support.

## 11. Risks (R-1..R-12)
PII detector false negatives (layered detectors); over-scrubbing reducing agent quality (tunable); region misconfiguration (validation on save); DSR deadline miss (automated SLA tracking); classification drift (re-scan jobs); CMEK key loss = data loss (KMS + backups); lineage graph size explosion (aggregation + retention); cross-border policy complexity (pre-approved matrices); legal-hold conflict with purge (override semantics); third-party LLM provider sub-processor list maintenance (auto-generate); GDPR scope creep (counsel review); nested structured data PII detection gaps (recursive scanners).

## 12. Success Metrics
Zero residency violations 12mo; DSR SLA compliance ≥99%; PII leak incidents ↓90% from baseline; GDPR Article 30 audit pass; customer-renewal from EU tenants increases; breach disclosure ≤72h.

## 13. Open Questions (OQ-1..OQ-6)
Presidio vs Comprehend vs Cloud DLP default? CMEK requirement for Phase 1 or 3? DSR SLA shortened to 14d for enterprise tier? Cross-border default: block or allow-with-SCCs? Lineage retention ≥7y? Residency per tenant or per request?

## 14. References
PRDs: PRD-007 (incident escalation), PRD-011 (embedding gate), PRD-015 (secrets+CMEK), PRD-017 (plugin gate), PRD-018 (prompt scrubbing), PRD-019 (backup encryption), PRD-020 (tenant region), PRD-021 (log scrubbing), PRD-022 (compliance).
URLs: https://microsoft.github.io/presidio/, https://aws.amazon.com/comprehend/, https://cloud.google.com/dlp, https://gdpr-info.eu, https://oag.ca.gov/privacy/ccpa, https://www.fedramp.gov.

**END PRD-026**
