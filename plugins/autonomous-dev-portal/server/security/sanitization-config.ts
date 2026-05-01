// SPEC-014-2-03 §Sanitization Config — allowlists, denylists, and limits
// for the markdown -> sanitized HTML pipeline.
//
// Every list is exported as a top-level constant so the security suite
// can assert exact contents (defense against silent allowlist drift).

/** Tags allowed through DOMPurify after the marked render pass. */
export const ALLOWED_TAGS: readonly string[] = Object.freeze([
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "br",
    "hr",
    "strong",
    "em",
    "del",
    "s",
    "sup",
    "sub",
    "ul",
    "ol",
    "li",
    "blockquote",
    "code",
    "pre",
    "kbd",
    "a",
    "img",
    "table",
    "thead",
    "tbody",
    "tr",
    "td",
    "th",
    "span",
    "div",
]);

/**
 * Per-tag attribute allowlist (also intersected with the global
 * `*` set). DOMPurify config is the union of all tag entries so
 * we flatten this map into a single ALLOWED_ATTR list at runtime.
 */
export const ALLOWED_ATTRIBUTES: Readonly<Record<string, string[]>> =
    Object.freeze({
        a: ["href", "title", "rel", "target"],
        img: ["src", "alt", "title", "width", "height", "loading"],
        code: ["class"],
        pre: ["class"],
        span: ["class"],
        div: ["class"],
        th: ["scope", "colspan", "rowspan"],
        td: ["colspan", "rowspan"],
        "*": ["id", "class"],
    });

/** URL schemes accepted by the link / image renderers. */
export const ALLOWED_URL_SCHEMES: readonly string[] = Object.freeze([
    "http",
    "https",
    "mailto",
]);

/**
 * Tags that DOMPurify must FORBID even if a future allowlist edit adds
 * them. Defense-in-depth against accidental loosening.
 */
export const FORBIDDEN_TAGS: readonly string[] = Object.freeze([
    "script",
    "style",
    "object",
    "embed",
    "form",
    "input",
    "button",
    "textarea",
    "select",
    "iframe",
    "frame",
    "frameset",
    "applet",
    "meta",
    "link",
    "base",
]);

/** Attributes that must never round-trip even when the tag is allowed. */
export const FORBIDDEN_ATTRIBUTES: readonly string[] = Object.freeze([
    "style",
    "srcdoc",
    "formaction",
    "xlink:href",
]);

/**
 * Class allowlist regex. Class attributes are stripped after DOMPurify
 * runs and reassembled to retain ONLY tokens matching this pattern.
 * Defense against CSS-class-driven attacks (e.g., reusing host app
 * classes to mask UI controls).
 */
export const ALLOWED_CLASS_PATTERN =
    /^(language-[a-z0-9-]{1,30}|tok-[a-z]{1,30}(-[a-z]{1,30})?|inline-code|code-block|blocked-link|blocked-image|md-[a-z]{1,30}|diff-block|diff-line|diff-truncated)$/;

/**
 * Patterns that, if present in the post-DOMPurify output, force a
 * refusal. Defense against hypothetical DOMPurify CVE bypass.
 */
export const POST_SANITIZATION_BAD_PATTERNS: readonly RegExp[] = Object.freeze(
    [
        /<script\b/i,
        /javascript:/i,
        /vbscript:/i,
        /data:text\/html/i,
        /data:application\/javascript/i,
    ],
);

export interface SanitizationConfig {
    allowedTags: readonly string[];
    allowedAttributes: Readonly<Record<string, string[]>>;
    allowedUrlSchemes: readonly string[];
    /** bytes; markdown larger than this is rejected with `entire-content`. */
    maxContentLength: number;
    /** bytes; data: image URLs larger than this are rejected. */
    maxDataUrlSize: number;
    enableCaching: boolean;
    /** LRU cap on the SHA-256 hash -> sanitized result cache. */
    cacheMaxEntries: number;
}

export const DEFAULT_SANITIZATION_CONFIG: SanitizationConfig = Object.freeze({
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedUrlSchemes: ALLOWED_URL_SCHEMES,
    maxContentLength: 100_000,
    maxDataUrlSize: 10_000,
    enableCaching: true,
    cacheMaxEntries: 1_000,
});

/** Flatten the per-tag allowlist into the union list DOMPurify expects. */
export function flattenAllowedAttrs(
    map: Readonly<Record<string, string[]>>,
): string[] {
    const seen = new Set<string>();
    for (const list of Object.values(map)) {
        for (const attr of list) seen.add(attr);
    }
    return Array.from(seen);
}
