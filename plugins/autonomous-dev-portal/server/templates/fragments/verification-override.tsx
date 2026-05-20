// PLAN-042 Phase D — Verification override fragment.
//
// Renders an inline form on the request-detail page when the request is
// gated on a `VERIFICATION_FAILED` envelope. The form POSTs to
// `/repo/:repo/request/:id/override` with the operator's reason. The
// global CSRF middleware (PR #312) protects the route; PORTAL_TEST_MODE +
// `X-Cypress-Test: 1` bypasses CSRF for Cypress runs (existing pattern).
//
// When an override is already recorded (`flags.verificationOverrideApplied`),
// the form is replaced by a one-line audit confirmation so operators see
// the override is active without an action to take.

import type { FC } from "hono/jsx";

export interface VerificationOverrideProps {
    requestId: string;
    repo: string;
    csrfToken: string;
    /** True when an override has already been recorded for this request. */
    applied?: boolean;
}

export const VerificationOverride: FC<VerificationOverrideProps> = ({
    requestId,
    repo,
    csrfToken,
    applied,
}) => {
    if (applied === true) {
        return (
            <section
                class="rd-verification-override applied"
                data-testid="verification-override-applied"
            >
                <h3>Verification override</h3>
                <p class="dim">
                    An operator authorized this run despite the verification
                    failure. The override is per-request and audited.
                </p>
            </section>
        );
    }
    return (
        <section
            class="rd-verification-override"
            data-testid="verification-override"
        >
            <h3>Override verification</h3>
            <p class="dim">
                The verifier flagged this phase's evidence as
                <code>VERIFICATION_FAILED</code>. If the failure is
                environmental, you can authorize this one run to advance.
                The override is per-request, audited, and does not weaken the
                gate for future runs.
            </p>
            <form
                method="post"
                action={`/repo/${repo}/request/${requestId}/override`}
                hx-post={`/repo/${repo}/request/${requestId}/override`}
                hx-swap="outerHTML"
            >
                <input type="hidden" name="csrf_token" value={csrfToken} />
                <label>
                    Reason (required):
                    <textarea
                        name="reason"
                        required
                        rows={3}
                        minlength={1}
                        maxlength={2048}
                        placeholder="Why is this override safe? (e.g., flaky network test)"
                    ></textarea>
                </label>
                <button type="submit" class="btn-destructive">
                    Authorize this run
                </button>
            </form>
        </section>
    );
};
