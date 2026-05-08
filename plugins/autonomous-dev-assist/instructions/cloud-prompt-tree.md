# Phase-16 prompt tree

This document is the static content side of the setup-wizard phase-16 boundary
contract (TDD-027 §6). It is loaded at runtime by the setup-wizard phase-16
module owned by TDD-033 §5, which walks the operator through cloud-plugin
selection, credential-proxy bootstrap, firewall backend choice, and a dry-run
deploy.

## Branch A: Cloud plugin choice
Q: Which cloud do you intend to deploy to?
  → gcp:    autonomous-dev-deploy-gcp
  → aws:    autonomous-dev-deploy-aws
  → azure:  autonomous-dev-deploy-azure
  → k8s:    autonomous-dev-deploy-k8s
  → none:   abort phase 16, return to phase 11.

If the chosen cloud's plugin is NOT installed, surface the install command and EXIT phase 16 cleanly.

## Branch B: Cred-proxy bootstrap
If `cred-proxy doctor` reports unhealthy:
  → run `cred-proxy bootstrap --cloud <chosen>`
Else: skip Branch B.

## Branch C: Firewall backend
On Linux: backend = nftables (require sudo)
On macOS: backend = pfctl (require sudo)
On other / opt-out: backend = disabled (warn the operator)

## Branch D: Dry-run deploy
Run `deploy plan REQ-WIZARD-DRYRUN --env staging --dry-run`
Inspect output; if successful, phase 16 complete.

---

*This document is consumed at runtime by the setup-wizard phase-16 module owned by TDD-033 §5.*
