// SPEC-015-2-03 §Error Classification
//
// Decides whether a fetch failure or HTTP response from the intake router
// should be retried (`'transient'`) or surfaced to the operator immediately
// (`'permanent'`). Used by IntakeRouterClient.retry().
//
// Rules of thumb:
//   - Network-level errors (TypeError 'fetch failed', AbortError/timeout) are
//     transient: the daemon may be restarting or briefly out of file
//     descriptors.
//   - HTTP 5xx, 408, 429, 503 are transient.
//   - 4xx other than 408/429 are permanent: retrying a 422 or 409 cannot
//     change the outcome and only delays the operator.

export type ErrorClass = "transient" | "permanent";

/**
 * Classify either a thrown error or an HTTP Response. When both are absent
 * the error is treated as permanent — there is nothing to retry against.
 */
export function classifyError(
    err: unknown,
    response?: Response,
): ErrorClass {
    // Network-level failures: transient. Bun surfaces fetch failures as a
    // TypeError whose message contains "fetch failed".
    if (err instanceof TypeError && err.message.includes("fetch failed")) {
        return "transient";
    }
    if (err instanceof DOMException && err.name === "AbortError") {
        return "transient";
    }
    if (err instanceof DOMException && err.name === "TimeoutError") {
        return "transient";
    }

    if (response !== undefined) {
        // 5xx: server-side temporary failure.
        if (response.status >= 500 && response.status < 600) {
            return "transient";
        }
        // 408 Request Timeout, 429 Too Many Requests: backoff-friendly.
        if (response.status === 408 || response.status === 429) {
            return "transient";
        }
    }

    // Everything else is permanent — caller should not retry.
    return "permanent";
}
