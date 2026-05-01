// SPEC-013-2-02 §Task 5 — Error message sanitizer.
//
// Pure function: redacts user home paths and credential-shaped key/value
// pairs from a string before it is exposed to the client. The full message
// is still logged server-side so operators can debug; only the
// client-facing copy is sanitized.

export function sanitizeErrorMessage(input: string): string {
    return input
        .replace(/\/Users\/[^/\s]+/g, "~")
        .replace(/\/home\/[^/\s]+/g, "~")
        .replace(/(password|token|secret|api[_-]?key)\s*[=:]\s*\S+/gi, "$1=***");
}
