// SPEC-014-2-03 §Escape Helpers — pure HTML / attribute / JS / URL escapers.
//
// Stateless functions; safe to call from anywhere in the codebase. The
// markdown pipeline uses them directly; templates should prefer them
// over Handlebars-style triple-mustache when raw interpolation is needed.

const ALLOWED_URL_SCHEMES = new Set(["http", "https", "mailto"]);

/**
 * Escape the five HTML metacharacters. Suitable for textContent-equivalent
 * interpolation into HTML.
 */
export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/**
 * Escape for use inside a double-quoted HTML attribute value. Adds
 * backtick (IE quirk: backticks can break attribute boundaries) and
 * equals (defense against attribute splitting in poorly-quoted contexts).
 */
export function escapeAttr(s: string): string {
    return escapeHtml(s).replace(/`/g, "&#096;").replace(/=/g, "&#061;");
}

/**
 * Hex-encode any character outside the safe ASCII set for use inside a
 * JavaScript string literal. Conservative — mangles too aggressively
 * rather than missing a character.
 */
export function escapeJsString(s: string): string {
    return s.replace(/[^a-zA-Z0-9,._]/g, (c) => {
        const code = c.charCodeAt(0);
        if (code <= 0xff) return `\\x${code.toString(16).padStart(2, "0")}`;
        return `\\u${code.toString(16).padStart(4, "0")}`;
    });
}

/**
 * Validate-and-encode a URL. Returns `null` when the scheme is not
 * `http`, `https`, `mailto`, or absent (relative). Otherwise applies
 * `encodeURI` so malformed query strings can't smuggle metacharacters
 * past attribute quoting.
 */
export function escapeUrl(url: string): string | null {
    const trimmed = url.trim();
    if (trimmed.length === 0) return null;
    const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):/i);
    if (schemeMatch !== null) {
        const scheme = (schemeMatch[1] ?? "").toLowerCase();
        if (!ALLOWED_URL_SCHEMES.has(scheme)) return null;
    }
    try {
        return encodeURI(trimmed);
    } catch {
        return null;
    }
}
