// SPEC-015-2-02 §Form Field → Config Path Mapping
//
// Convert URL-encoded form data (string keys with dotted paths and `[]`
// suffixes) into the nested object shape the settings validator and the
// intake-router config-set command expect. Three concerns:
//
//   1. Dotted keys (`costCaps.daily`) walk into nested objects, creating
//      intermediate objects on demand.
//   2. Array keys (`allowlist[]`) collapse repeated values into an ordered
//      array under the base key.
//   3. Schema enforcement: keys NOT in the registry are silently dropped.
//      This is defense in depth — a tampered client cannot smuggle
//      arbitrary keys through to the intake router via the portal.
//
// Numeric coercion is deliberately limited to the registered numeric
// fields (NUMERIC_FIELDS). Other fields stay as strings; the validator
// decides what is acceptable for each. Empty numeric strings become null
// so the validator can reject them with a clear "must be a positive
// number" message rather than silently coercing to 0.

/** Whitelisted form keys. Anything not here is dropped. */
export const SETTINGS_SCHEMA_KEYS: readonly string[] = Object.freeze([
    "costCaps.daily",
    "costCaps.monthly",
    "allowlist[]",
    "notifications.slack.webhook",
    "notifications.email.to",
    "circuitBreaker.enabled",
    "killSwitch.engaged",
]);

/** Trust-level keys are dynamic per repo (`trustLevels.<repoSlug>`). They
 *  are matched by prefix rather than exact key. */
export const SETTINGS_SCHEMA_PREFIXES: readonly string[] = Object.freeze([
    "trustLevels.",
]);

/** Fields whose values should be coerced to `number`. */
export const NUMERIC_FIELDS: ReadonlySet<string> = new Set([
    "costCaps.daily",
    "costCaps.monthly",
]);

/** Fields whose values should be coerced to `boolean`. */
export const BOOLEAN_FIELDS: ReadonlySet<string> = new Set([
    "circuitBreaker.enabled",
    "killSwitch.engaged",
]);

export interface FormSource {
    /** All values for the given key, in insertion order. */
    getAll(key: string): string[];
    /** Iterable of unique keys present in the form. */
    keys(): IterableIterator<string>;
}

/** Returns true if the bare form key (with `[]` retained) is in the schema. */
function keyAllowed(key: string): boolean {
    if (SETTINGS_SCHEMA_KEYS.includes(key)) return true;
    return SETTINGS_SCHEMA_PREFIXES.some((p) => key.startsWith(p));
}

function coerce(rawKey: string, value: string): unknown {
    const baseKey = rawKey.endsWith("[]") ? rawKey.slice(0, -2) : rawKey;
    if (NUMERIC_FIELDS.has(baseKey)) {
        const trimmed = value.trim();
        if (trimmed === "") return null;
        const n = Number(trimmed);
        return Number.isFinite(n) ? n : null;
    }
    if (BOOLEAN_FIELDS.has(baseKey)) {
        return value === "true" || value === "on" || value === "1";
    }
    return value;
}

/** Walks the dotted key path and assigns `value` at the leaf. */
function setNested(
    target: Record<string, unknown>,
    path: string[],
    value: unknown,
): void {
    let cursor: Record<string, unknown> = target;
    for (let i = 0; i < path.length - 1; i++) {
        const seg = path[i] as string;
        const next = cursor[seg];
        if (
            next === undefined ||
            next === null ||
            typeof next !== "object" ||
            Array.isArray(next)
        ) {
            const fresh: Record<string, unknown> = {};
            cursor[seg] = fresh;
            cursor = fresh;
        } else {
            cursor = next as Record<string, unknown>;
        }
    }
    cursor[path[path.length - 1] as string] = value;
}

/** Pushes onto the array at the dotted key path, creating it on demand. */
function pushNested(
    target: Record<string, unknown>,
    path: string[],
    value: unknown,
): void {
    let cursor: Record<string, unknown> = target;
    for (let i = 0; i < path.length - 1; i++) {
        const seg = path[i] as string;
        const next = cursor[seg];
        if (
            next === undefined ||
            next === null ||
            typeof next !== "object" ||
            Array.isArray(next)
        ) {
            const fresh: Record<string, unknown> = {};
            cursor[seg] = fresh;
            cursor = fresh;
        } else {
            cursor = next as Record<string, unknown>;
        }
    }
    const leaf = path[path.length - 1] as string;
    const existing = cursor[leaf];
    if (Array.isArray(existing)) {
        existing.push(value);
    } else {
        cursor[leaf] = [value];
    }
}

/**
 * Convert a FormData (or URLSearchParams; both implement the same surface)
 * into a nested config object. Unknown keys are dropped silently.
 */
export function parseFormDataToConfig(
    form: FormSource,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (const rawKey of form.keys()) {
        if (seen.has(rawKey)) continue;
        seen.add(rawKey);
        if (!keyAllowed(rawKey)) continue;
        const values = form.getAll(rawKey);
        const isArrayKey = rawKey.endsWith("[]");
        const baseKey = isArrayKey ? rawKey.slice(0, -2) : rawKey;
        const path = baseKey.split(".");
        if (isArrayKey) {
            for (const v of values) {
                pushNested(out, path, coerce(rawKey, v));
            }
        } else {
            // Take the last value when a non-array key appears multiple times.
            const v = values[values.length - 1] ?? "";
            setNested(out, path, coerce(rawKey, v));
        }
    }
    return out;
}

/**
 * Flatten a nested config object into dotted leaf paths. Arrays are leaves
 * (we report `allowlist`, not `allowlist[0]`). This matches the daemon-
 * reload trigger semantics in SPEC-015-2-03 and the audit log format in
 * SPEC-015-2-02 (key paths only, no values).
 */
export function flattenKeys(
    obj: Record<string, unknown>,
    prefix = "",
): string[] {
    const out: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
        const path = prefix === "" ? k : `${prefix}.${k}`;
        if (v !== null && typeof v === "object" && !Array.isArray(v)) {
            out.push(...flattenKeys(v as Record<string, unknown>, path));
        } else {
            out.push(path);
        }
    }
    return out;
}
