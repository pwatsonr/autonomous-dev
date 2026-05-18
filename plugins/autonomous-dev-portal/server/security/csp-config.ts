// SPEC-014-2-04 §csp-config — Environment-keyed Content Security Policy
// directive defaults and a `buildCustomCSP` helper.
//
// Production policy is strict: no `'unsafe-inline'` on `script-src`, no
// `'unsafe-eval'` anywhere, `frame-ancestors 'none'`, `object-src 'none'`.
// Development inherits the production base and only relaxes `connect-src`
// so HMR / live-reload websockets keep working. The trade-off documented in
// the spec — `'unsafe-inline'` is retained on `style-src` because HTMX swap
// dynamics emit inline styles in some legacy templates — is encoded here
// (and is overridable via {@link buildCustomCSP} or the
// `allowUnsafeInlineStyles: false` config flag).

export type CSPEnvironment = "development" | "production" | "test";

/**
 * Full directive map. Optional directives are omitted (rather than empty)
 * so {@link directivesToString} drops them from the header entirely. Adding
 * a directive is intentional — the operator must opt in by extending the
 * base via `customDirectives`.
 */
export interface CSPDirectives {
    "default-src": string[];
    "script-src": string[];
    "style-src": string[];
    "img-src": string[];
    "font-src": string[];
    "connect-src": string[];
    "object-src": string[];
    "frame-ancestors": string[];
    "base-uri": string[];
    "form-action": string[];
    "media-src"?: string[];
    "worker-src"?: string[];
}

/**
 * CSP behaviour knobs. `reportOnly` flips the response header from
 * `Content-Security-Policy` to `Content-Security-Policy-Report-Only`;
 * production defaults to enforcing, development to report-only so we can
 * iterate on the policy without breaking the running app.
 */
export interface CSPConfig {
    environment: CSPEnvironment;
    reportOnly: boolean;
    /** When set, appended as `report-uri <reportUri>` to the header. */
    reportUri?: string;
    /**
     * Enables per-request nonce generation and appends `'nonce-<value>'` to
     * `script-src`. Off → only `'self'` scripts allowed. On is the default.
     */
    enableNonce: boolean;
    /**
     * Documented trade-off (spec §Notes). When `false`, `'unsafe-inline'`
     * is removed from `style-src`. Templates relying on inline styles will
     * be blocked — operators should migrate to nonce or external sheets
     * before flipping this off.
     */
    allowUnsafeInlineStyles: boolean;
    /** Direct-replacement overrides applied AFTER nonce/inline-style logic. */
    customDirectives?: Partial<CSPDirectives>;
}

/**
 * Production base. Frozen so accidental mutation in a hot path doesn't leak
 * across requests. Callers MUST clone (see `cloneDirectives`) before
 * mutating.
 */
export const PRODUCTION_DIRECTIVES_BASE: Readonly<CSPDirectives> = Object.freeze({
    "default-src": ["'self'"],
    "script-src": ["'self'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:"],
    "font-src": ["'self'"],
    "connect-src": ["'self'"],
    "object-src": ["'none'"],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
});

/**
 * Development base. Adds localhost / loopback / websocket origins to
 * `connect-src` so dev tooling (HMR, websocket reload) still functions.
 * Crucially: NO `'unsafe-eval'` even in dev — break early, fix at source.
 */
export const DEVELOPMENT_DIRECTIVES_BASE: Readonly<CSPDirectives> = Object.freeze({
    ...PRODUCTION_DIRECTIVES_BASE,
    "connect-src": [
        "'self'",
        "localhost:*",
        "127.0.0.1:*",
        "ws:",
        "wss:",
    ],
});

/**
 * Default config keyed off `NODE_ENV`. Tests pass `environment: 'test'`
 * and inherit production rules so any test-only policy drift is loud.
 */
export function defaultCSPConfig(env: CSPEnvironment): CSPConfig {
    return {
        environment: env,
        reportOnly: env === "development",
        enableNonce: true,
        allowUnsafeInlineStyles: true,
        reportUri: undefined,
        customDirectives: undefined,
    };
}

/**
 * PLAN-041 §Follow-ups F-041-01 — "tight" CSP variant used for
 * report-only telemetry alongside the lenient (`defaultCSPConfig`)
 * baseline. It drops `'unsafe-inline'` from `style-src` so violations
 * surface in browser CSP reports; once the design-system route (the last
 * known offender — uses many `style="..."` attributes) is migrated to
 * external stylesheets or nonced `<style>` blocks, an operator can flip
 * this config's `reportOnly` to `false` and retire the lenient baseline.
 *
 * Always returns `reportOnly: true`; the flip-to-enforce decision is
 * deliberately out of code's reach.
 *
 * Threat-model note (PRD-023): the portal binds to loopback by default;
 * the strict report-only header is defense-in-depth for the rare
 * misconfigured non-loopback bind.
 */
export function strictReportOnlyCSPConfig(env: CSPEnvironment): CSPConfig {
    return {
        environment: env,
        reportOnly: true,
        enableNonce: true,
        allowUnsafeInlineStyles: false,
        reportUri: undefined,
        customDirectives: undefined,
    };
}

/**
 * Deep-clone a directives map. The base maps are frozen at module scope; we
 * MUST clone before mutating to avoid trampling other requests on the same
 * process.
 */
function cloneDirectives(src: Readonly<CSPDirectives>): CSPDirectives {
    const out: CSPDirectives = {
        "default-src": [...src["default-src"]],
        "script-src": [...src["script-src"]],
        "style-src": [...src["style-src"]],
        "img-src": [...src["img-src"]],
        "font-src": [...src["font-src"]],
        "connect-src": [...src["connect-src"]],
        "object-src": [...src["object-src"]],
        "frame-ancestors": [...src["frame-ancestors"]],
        "base-uri": [...src["base-uri"]],
        "form-action": [...src["form-action"]],
    };
    if (src["media-src"] !== undefined) out["media-src"] = [...src["media-src"]];
    if (src["worker-src"] !== undefined) out["worker-src"] = [...src["worker-src"]];
    return out;
}

/**
 * Build the final directive map for a request. Order:
 *
 *   1. Pick the environment base (production vs development).
 *   2. Append `'nonce-<value>'` to `script-src` when `enableNonce`.
 *   3. Strip `'unsafe-inline'` from `style-src` when `!allowUnsafeInlineStyles`.
 *   4. Direct-replace any directives present in `customDirectives`.
 *
 * Custom overrides REPLACE the directive entirely — there is intentionally
 * no array merge so an operator who wants `script-src 'self' https://cdn`
 * gets exactly that, not the union with the base.
 */
export function buildDirectives(
    config: CSPConfig,
    nonce: string | null,
): CSPDirectives {
    const base =
        config.environment === "production"
            ? PRODUCTION_DIRECTIVES_BASE
            : DEVELOPMENT_DIRECTIVES_BASE;
    const directives = cloneDirectives(base);

    if (config.enableNonce && nonce !== null && nonce.length > 0) {
        directives["script-src"] = [
            ...directives["script-src"],
            `'nonce-${nonce}'`,
        ];
    }
    if (!config.allowUnsafeInlineStyles) {
        directives["style-src"] = directives["style-src"].filter(
            (s) => s !== "'unsafe-inline'",
        );
        // PLAN-041 §Follow-ups F-041-01 — when `'unsafe-inline'` is
        // dropped, attach the per-request nonce to `style-src` so
        // nonce-bearing `<style nonce="...">` blocks (and inline `style`
        // attributes via CSS-Hash-Source in a future migration) keep
        // rendering under the tight policy. The lenient baseline does
        // NOT take this branch — it keeps `'unsafe-inline'` and skips
        // the nonce attachment, preserving CSP3 §6.6.3 semantics
        // (browsers ignore `'unsafe-inline'` whenever a nonce-source is
        // also present, which would otherwise tighten dev unexpectedly).
        if (config.enableNonce && nonce !== null && nonce.length > 0) {
            directives["style-src"] = [
                ...directives["style-src"],
                `'nonce-${nonce}'`,
            ];
        }
    }

    const overrides = config.customDirectives;
    if (overrides !== undefined) {
        for (const key of Object.keys(overrides) as Array<keyof CSPDirectives>) {
            const v = overrides[key];
            if (v === undefined) continue;
            // TS can't track that the directive name maps to the same array
            // shape; the cast is safe — every key in CSPDirectives is
            // optional or required string[].
            (directives as unknown as Record<string, string[]>)[key as string] =
                [...v];
        }
    }
    return directives;
}

/**
 * Serialise a directives map to the wire format expected by the CSP
 * header: `name v1 v2 v3; name v1 v2; ...`. Directives with empty arrays
 * are dropped (treating them as "not set").
 */
export function directivesToString(directives: CSPDirectives): string {
    const parts: string[] = [];
    for (const [name, values] of Object.entries(directives)) {
        if (values === undefined) continue;
        if (!Array.isArray(values) || values.length === 0) continue;
        parts.push(`${name} ${values.join(" ")}`);
    }
    return parts.join("; ");
}

/**
 * Public helper for callers building a one-off custom CSP — e.g. an admin
 * override surface that wants to add `https://cdn.example.com` to
 * `script-src`. Pure: no IO, no module-state mutation.
 */
export function buildCustomCSP(
    base: CSPConfig,
    overrides: Partial<CSPDirectives>,
    nonce: string | null = null,
): string {
    const directives = buildDirectives(
        { ...base, customDirectives: { ...base.customDirectives, ...overrides } },
        nonce,
    );
    return directivesToString(directives);
}
