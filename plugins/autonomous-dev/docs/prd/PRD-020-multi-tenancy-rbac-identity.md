# PRD-020: Multi-Tenancy, RBAC & Identity Federation

Metadata: PRD-020 | v0.1.0 | 2026-04-18 | Patrick Watson | Draft | autonomous-dev

## 1. Problem
autonomous-dev is single-tenant; one config, one user, no team/org model. To serve multiple teams from one daemon, we need a tenant abstraction, role-based access, identity federation (OIDC for humans, SPIFFE for workloads, SCIM for provisioning). Without this, enterprises can't adopt at scale and sharing cost/state across teams is unsafe.

## 2. Goals (G-1..G-10)
G-1 `Tenant` first-class entity; every request, repo, cost ledger, audit record scoped to a tenant. G-2 RBAC with roles (viewer, contributor, reviewer, admin, security-admin) and fine-grained permissions. G-3 OIDC for human identity; SCIM 2.0 for provisioning from IdP (Okta, Azure AD, Google Workspace, JumpCloud). G-4 SPIFFE/SPIRE SVIDs for workload identity. G-5 Tenant isolation of state (per PRD-019 Postgres adapter with RLS). G-6 Per-tenant config overrides (layered on system defaults per PRD-001). G-7 Cross-tenant operations forbidden by default; explicit delegation flow. G-8 Audit trail scoped per tenant + org-wide superset. G-9 Backstage catalog entity format for tenant discovery. G-10 Zero-trust posture (no ambient trust between tenants).

## 3. Non-Goals (NG-1..NG-6)
Not an IdP product; not a SAML library; not per-user billing (PRD-023 does FinOps); not replacing cloud IAM; not a secrets manager (PRD-015); not multi-region replication.

## 4. Personas
Org Admin, Tenant Admin, Tenant Member, Security Admin, Compliance Auditor, External Integrator.

## 5. User Stories (US-01..US-18)
Org admin creates a tenant; SCIM auto-provisions members from Okta; tenant admin sets tenant-local config; member submits request only within their tenant; cross-tenant operation blocked; security admin audits all tenants; OIDC login via Google Workspace; MFA enforced; role-assignment events audited; SPIFFE SVID rotates automatically; tenant deletion (soft delete + 90-day retention); tenant storage quota enforced; shared repo across tenants requires explicit grant; compliance auditor queries per-tenant audit; Backstage catalog lists all tenants; per-tenant cost attribution (PRD-023); per-tenant feature-flag scoping; Zero-trust: workload-to-workload calls require SVID.

## 6. FR
### 6.1 Tenant Model (FR-100s)
FR-100 Tenant entity: id, slug, display_name, created_at, status (active/suspended/deleted). FR-101 Every domain entity carries `tenant_id`. FR-102 Soft delete (90d retention) then hard delete.

### 6.2 RBAC (FR-200s)
FR-200 Roles: viewer, contributor, reviewer, admin, security-admin, org-admin. FR-201 Permissions JSON: `{resource: action}` grid. FR-202 Role bindings: (user|group|service-account, tenant, role). FR-203 Policy engine: OPA/Rego or Cedar (pluggable `AuthorizationEngine` interface). FR-204 Deny-by-default.

### 6.3 OIDC Human Identity (FR-300s)
FR-300 OIDC provider interface; adapters: Okta, Azure AD, Google Workspace, Auth0, Keycloak. FR-301 PKCE flow; refresh tokens. FR-302 MFA required for admin roles. FR-303 Session timeout configurable.

### 6.4 SCIM Provisioning (FR-400s)
FR-400 SCIM 2.0 server endpoint (RFC 7643/7644). FR-401 User + Group provisioning. FR-402 Just-in-time provisioning fallback. FR-403 Deprovision on IdP signal.

### 6.5 SPIFFE Workloads (FR-500s)
FR-500 SPIRE server integration; workloads issued SVID on start. FR-501 Mutual TLS between workloads. FR-502 SVID rotation automatic; validity <24hr.

### 6.6 Tenant Isolation (FR-600s)
FR-600 Postgres Row-Level Security (RLS) policies per tenant. FR-601 Per-tenant S3/MinIO buckets via prefix + policy. FR-602 Per-tenant cost ledger. FR-603 Per-tenant secrets namespace in Vault.

### 6.7 Cross-Tenant Delegation (FR-700s)
FR-700 Explicit grant: tenant A admin + tenant B admin both approve. FR-701 Scoped to resource + ttl. FR-702 All grants audited.

### 6.8 Config Overrides (FR-800s)
FR-800 Per-tenant config layer stacked above system defaults (per PRD-001 layered config). FR-801 Admin UI via web portal (PRD-009). FR-802 Policy enforces that tenant config cannot exceed org caps (e.g., cost cap).

### 6.9 Audit (FR-900s)
FR-900 Every auth decision logged with {subject, resource, action, decision, policy_id}. FR-901 Org-wide audit trail. FR-902 Export via SIEM connector.

### 6.10 Backstage Integration (FR-1000s)
FR-1000 Tenants expose `catalog-info.yaml` compatible entity metadata. FR-1001 Backstage plugin reads tenant list.

## 7. NFR (NFR-01..NFR-10)
OIDC login p95 <500ms; SCIM sync p95 <5s per batch; authorization check p95 <20ms; zero cross-tenant data leaks (RLS enforced); SPIFFE rotation transparent; MFA-rate-limit configurable; compliance export includes per-tenant filter; all adapters vendor-neutral; 99.9% availability on auth path; graceful degradation on IdP outage.

## 8. Architecture
ASCII: IdP (OIDC) → OIDC adapter → session → tenant-scoped request → Authorization Engine (OPA/Cedar) → State Store (RLS) / Cost Ledger (tenant_id) / Audit Log. SPIRE server ↔ workloads (SVIDs) ↔ mTLS.

## 9. Testing
RLS cross-tenant-leak test; SCIM de-provision flow; OIDC login + MFA test; SPIFFE rotation test; policy-engine parity (OPA vs Cedar); tenant delete + 90d restore test; audit integrity.

## 10. Migration
Phase 1 (wks 1–3): Tenant model + RBAC + OIDC (Okta + Google Workspace + Azure AD) + audit. Phase 2 (wks 4–6): SCIM + per-tenant config + cross-tenant grant + Postgres RLS (via PRD-019). Phase 3 (wks 7–10): SPIFFE/SPIRE + Backstage entity export + SIEM connector + compliance features.

## 11. Risks (R-1..R-12)
RLS misconfiguration causes cross-tenant read (test-first + OPA policy gate); OIDC provider outage (emergency break-glass admin); SCIM race with manual role edits (last-write-wins + audit); SPIFFE operational complexity (gradual rollout); session fixation (secure cookies + SameSite); org-admin compromise (hardware MFA required); policy authoring burden (ships sensible defaults); cross-tenant delegation abused (ttl enforced); role creep (quarterly access review); IdP mapping drift (SCIM as source of truth); compliance scope expansion (retention knobs); performance of per-request policy checks (cache + denormalization).

## 12. Success Metrics
Zero cross-tenant data leaks 12mo; MFA coverage 100% admin roles; auth p95 <20ms; SCIM sync lag <5min; audit completeness 100%; org-admin break-glass tested quarterly.

## 13. Open Questions (OQ-1..OQ-6)
Policy engine default (OPA vs Cedar)? SPIFFE scope (all workloads or opt-in)? Backstage catalog publish cadence? Per-tenant cost cap layered or separate (PRD-023)? SCIM custom schema extensions? Tenant slug uniqueness (org-scoped or global)?

## 14. References
PRDs: PRD-001 (config), PRD-007 (audit), PRD-009 (portal), PRD-015 (secrets), PRD-019 (RLS via Postgres adapter), PRD-022 (compliance), PRD-023 (FinOps), PRD-026 (residency).
URLs: https://openid.net/connect/, https://datatracker.ietf.org/doc/html/rfc7643, https://spiffe.io, https://www.openpolicyagent.org, https://www.cedarpolicy.com, https://www.postgresql.org/docs/current/ddl-rowsecurity.html, https://backstage.io.

**END PRD-020**
