// SPEC-014-2-03 §MarkdownSanitizationPipeline — multi-layer XSS defense
// for any user-influenced content.
//
// Pipeline:
//   1. length guard         (refuse >maxContentLength)
//   2. cache lookup         (SHA-256 hash key, LRU map)
//   3. marked render        (custom renderers for link/image/code/html)
//   4. DOMPurify sanitize   (JSDOM-backed; tag + attr + URL-scheme allowlist)
//   5. class allowlist      (post-purify pass; strict regex)
//   6. post-scan            (forbidden patterns -> refuse)
//   7. extract + diff       (record blocked elements / warnings)
//   8. cache write          (LRU)
//
// `sanitizeMarkdown` is the only public entry point. Sync wrapper avoids
// async-helper churn in templates that don't have native async support.

import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { Marked, Renderer } from "marked";
import createDOMPurifyImpl from "dompurify";

import { escapeAttr, escapeHtml, escapeUrl } from "./escape-helpers";
import {
    ALLOWED_CLASS_PATTERN,
    DEFAULT_SANITIZATION_CONFIG,
    FORBIDDEN_ATTRIBUTES,
    FORBIDDEN_TAGS,
    POST_SANITIZATION_BAD_PATTERNS,
    flattenAllowedAttrs,
} from "./sanitization-config";
import type { SanitizationConfig } from "./sanitization-config";

export interface SanitizationResult {
    sanitized: string;
    warnings: string[];
    blocked: string[];
    safe: boolean;
}

/**
 * Pre-built JSDOM window + DOMPurify instance.
 *
 * JSDOM allocates ~3MB; reusing the same window across the process
 * (single-threaded, single-instance) is safe and avoids the per-call cost.
 * The DOMPurify factory in v3 takes the window as its argument and returns
 * the sanitizer with `sanitize`, `setConfig`, `addHook`, etc.
 */
type DOMPurifyHookEvent = "uponSanitizeAttribute" | "uponSanitizeElement";
type DOMPurifyHookCallback = (
    node: Element,
    data: { attrName?: string; attrValue?: string; allowedAttributes?: Record<string, boolean> },
) => void;
interface DOMPurifyInstance {
    sanitize: (input: string, config?: Record<string, unknown>) => string;
    setConfig: (cfg: Record<string, unknown>) => void;
    addHook: (event: DOMPurifyHookEvent, cb: DOMPurifyHookCallback) => void;
    removeAllHooks: () => void;
}

let cachedPurify: DOMPurifyInstance | null = null;

function getPurify(): DOMPurifyInstance {
    if (cachedPurify !== null) return cachedPurify;
    const window = new JSDOM("").window;
    // dompurify v3 factory: createDOMPurify(window) -> instance.
    // We type the factory loosely because its TS signature changes between
    // bundlers; the runtime contract is stable.
    const factory = createDOMPurifyImpl as unknown as (
        w: typeof window,
    ) => DOMPurifyInstance;
    cachedPurify = factory(window);
    return cachedPurify;
}

const VALID_LANGUAGE = /^[a-zA-Z0-9-]{1,30}$/;

/**
 * Build the marked Renderer with the security overrides documented in
 * SPEC-014-2-03 §Sanitization Pipeline.
 *
 * marked@5.1.x renderer signatures take positional args. Type-loose
 * declarations because the upstream `Renderer` types differ between
 * v5 minors; the runtime contract is the contract.
 */
function buildSecurityRenderer(config: SanitizationConfig): Renderer {
    const renderer = new Renderer();

    renderer.link = ((href: string | null, title: string | null, text: string): string => {
        const safeText = escapeHtml(text);
        const safeUrl = href === null ? null : escapeUrl(href);
        if (safeUrl === null) {
            return `<span class="blocked-link" title="Blocked unsafe URL">${safeText}</span>`;
        }
        // External links → noopener / noreferrer; same-origin links pass
        // unchanged. Without a request-bound origin we treat every absolute
        // URL as external (defensive default).
        const titleAttr =
            title !== null && title.length > 0
                ? ` title="${escapeAttr(title)}"`
                : "";
        const isAbsolute = /^https?:\/\//i.test(safeUrl);
        const relTarget = isAbsolute
            ? ' target="_blank" rel="noopener noreferrer"'
            : "";
        return `<a href="${escapeAttr(safeUrl)}"${titleAttr}${relTarget}>${safeText}</a>`;
    }) as Renderer["link"];

    renderer.image = ((src: string | null, title: string | null, text: string): string => {
        const safeAlt = escapeHtml(text);
        if (src === null) return `<span class="blocked-image">${safeAlt}</span>`;
        // data: URLs allowed only for images and only under maxDataUrlSize.
        const lower = src.trim().toLowerCase();
        if (lower.startsWith("data:")) {
            // Calculate size in bytes for base64 data: URLs.
            // For text/html this is rejected outright.
            if (lower.startsWith("data:text/html") ||
                lower.startsWith("data:application/javascript")) {
                return `<span class="blocked-image" title="Blocked unsafe data URL">${safeAlt}</span>`;
            }
            if (src.length > config.maxDataUrlSize) {
                return `<span class="blocked-image" title="Image exceeds size limit">${safeAlt}</span>`;
            }
            const titleAttr =
                title !== null && title.length > 0
                    ? ` title="${escapeAttr(title)}"`
                    : "";
            return `<img src="${escapeAttr(src)}" alt="${safeAlt}"${titleAttr} loading="lazy">`;
        }
        const safeUrl = escapeUrl(src);
        if (safeUrl === null) {
            return `<span class="blocked-image" title="Blocked unsafe URL">${safeAlt}</span>`;
        }
        const titleAttr =
            title !== null && title.length > 0
                ? ` title="${escapeAttr(title)}"`
                : "";
        return `<img src="${escapeAttr(safeUrl)}" alt="${safeAlt}"${titleAttr} loading="lazy">`;
    }) as Renderer["image"];

    renderer.code = ((code: string, language: string | undefined): string => {
        const safeCode = escapeHtml(code);
        const lang = typeof language === "string" && VALID_LANGUAGE.test(language)
            ? language
            : null;
        const cls = lang === null ? "code-block" : `code-block language-${lang}`;
        return `<pre class="${cls}"><code>${safeCode}</code></pre>`;
    }) as Renderer["code"];

    renderer.codespan = ((code: string): string => {
        return `<code class="inline-code">${escapeHtml(code)}</code>`;
    }) as Renderer["codespan"];

    renderer.html = ((html: string): string => {
        // Reject ALL raw HTML in markdown — replace with an escaped placeholder.
        // Even if marked is permissive in a future version, the user cannot
        // smuggle HTML through.
        return escapeHtml(html);
    }) as Renderer["html"];

    return renderer;
}

function buildMarked(config: SanitizationConfig): Marked {
    const renderer = buildSecurityRenderer(config);
    // mangle / headerIds are deprecated marked@5 options; disable explicitly
    // so we don't emit warnings on every render and so heading slugs don't
    // appear in user-visible output (we don't expose anchor links).
    const m = new Marked({
        renderer,
        breaks: true,
        gfm: true,
        pedantic: false,
        silent: false,
        mangle: false,
        headerIds: false,
    } as ConstructorParameters<typeof Marked>[0]);
    return m;
}

/**
 * Apply the post-purify class allowlist. DOMPurify keeps the `class`
 * attribute when the tag allows it; this hook trims unknown class tokens
 * so attackers can't reuse host-app class names to mask UI.
 */
function configurePurify(purify: DOMPurifyInstance, config: SanitizationConfig): void {
    purify.removeAllHooks();
    purify.setConfig({
        ALLOWED_TAGS: [...config.allowedTags],
        ALLOWED_ATTR: flattenAllowedAttrs(config.allowedAttributes),
        ALLOWED_URI_REGEXP: new RegExp(
            `^(?:${config.allowedUrlSchemes.join("|")}):`,
            "i",
        ),
        ALLOW_DATA_ATTR: false,
        ALLOW_UNKNOWN_PROTOCOLS: false,
        SANITIZE_DOM: true,
        FORBID_TAGS: [...FORBIDDEN_TAGS],
        FORBID_ATTR: [...FORBIDDEN_ATTRIBUTES],
        KEEP_CONTENT: true,
        FORCE_BODY: false,
        WHOLE_DOCUMENT: false,
        RETURN_DOM_FRAGMENT: false,
    });

    purify.addHook("uponSanitizeAttribute", (_node, data) => {
        const name = data.attrName?.toLowerCase() ?? "";
        if (name.startsWith("on")) {
            // strip event handlers — defense against marked allowing them
            data.allowedAttributes = { [name]: false };
        }
        if (name.startsWith("data-")) {
            data.allowedAttributes = { [name]: false };
        }
        if (name === "class" && typeof data.attrValue === "string") {
            const filtered = data.attrValue
                .split(/\s+/)
                .filter((cls) => cls.length > 0 && ALLOWED_CLASS_PATTERN.test(cls))
                .join(" ");
            data.attrValue = filtered;
        }
    });
}

const TAG_RE = /<([a-z][a-z0-9-]*)\b/gi;
function extractTags(html: string): string[] {
    const out: string[] = [];
    for (const m of html.matchAll(TAG_RE)) {
        const tag = m[1];
        if (typeof tag === "string") out.push(tag.toLowerCase());
    }
    return out;
}

/** Naive LRU using insertion order of a Map. */
class LRUMap<K, V> {
    private readonly max: number;
    private readonly store = new Map<K, V>();
    constructor(max: number) {
        this.max = max;
    }
    get(k: K): V | undefined {
        const v = this.store.get(k);
        if (v !== undefined) {
            this.store.delete(k);
            this.store.set(k, v);
        }
        return v;
    }
    set(k: K, v: V): void {
        if (this.store.has(k)) this.store.delete(k);
        this.store.set(k, v);
        while (this.store.size > this.max) {
            const oldest = this.store.keys().next().value;
            if (oldest === undefined) break;
            this.store.delete(oldest);
        }
    }
    get size(): number {
        return this.store.size;
    }
}

/**
 * Pure markdown -> sanitized HTML pipeline. Synchronous on purpose:
 * marked@5 returns a string, DOMPurify is sync. The caller may await
 * even though there's nothing to wait on.
 */
export class MarkdownSanitizationPipeline {
    private readonly config: SanitizationConfig;
    private readonly cache: LRUMap<string, SanitizationResult>;
    private readonly marked: Marked;

    constructor(overrides: Partial<SanitizationConfig> = {}) {
        this.config = { ...DEFAULT_SANITIZATION_CONFIG, ...overrides };
        this.cache = new LRUMap(this.config.cacheMaxEntries);
        this.marked = buildMarked(this.config);
        configurePurify(getPurify(), this.config);
    }

    sanitizeMarkdown(markdown: string): SanitizationResult {
        if (typeof markdown !== "string") {
            return {
                sanitized: "",
                warnings: ["non-string-input"],
                blocked: ["entire-content"],
                safe: false,
            };
        }
        if (markdown.length > this.config.maxContentLength) {
            return {
                sanitized: "",
                warnings: ["content-exceeds-max-length"],
                blocked: ["entire-content"],
                safe: false,
            };
        }

        let cacheKey = "";
        if (this.config.enableCaching) {
            cacheKey = createHash("sha256").update(markdown).digest("hex");
            const cached = this.cache.get(cacheKey);
            if (cached !== undefined) return cached;
        }

        // marked.parse returns string in synchronous mode (default).
        let rendered: string;
        try {
            rendered = this.marked.parse(markdown, { async: false }) as string;
        } catch {
            return {
                sanitized: "",
                warnings: ["marked-parse-error"],
                blocked: ["entire-content"],
                safe: false,
            };
        }

        const purify = getPurify();
        // Re-apply config because tests may construct multiple pipelines
        // with different overrides on the same shared instance.
        configurePurify(purify, this.config);
        const sanitized = purify.sanitize(rendered);

        // Post-sanitization defensive scan.
        for (const re of POST_SANITIZATION_BAD_PATTERNS) {
            if (re.test(sanitized)) {
                const refusal: SanitizationResult = {
                    sanitized: "",
                    warnings: ["post-sanitization-unsafe-pattern"],
                    blocked: ["script-content"],
                    safe: false,
                };
                if (this.config.enableCaching) this.cache.set(cacheKey, refusal);
                return refusal;
            }
        }

        // Diff tag sets to surface what got dropped.
        const beforeTags = new Set(extractTags(rendered));
        const afterTags = new Set(extractTags(sanitized));
        const blocked: string[] = [];
        for (const t of beforeTags) if (!afterTags.has(t)) blocked.push(t);

        const result: SanitizationResult = {
            sanitized,
            warnings: [],
            blocked,
            safe: blocked.length === 0,
        };
        if (this.config.enableCaching) this.cache.set(cacheKey, result);
        return result;
    }

    /** Test introspection — current cache occupancy. */
    get cacheSize(): number {
        return this.cache.size;
    }
}

/** Module-level convenience for callers that don't need their own instance. */
let defaultPipeline: MarkdownSanitizationPipeline | null = null;
function getDefault(): MarkdownSanitizationPipeline {
    if (defaultPipeline === null) defaultPipeline = new MarkdownSanitizationPipeline();
    return defaultPipeline;
}

/**
 * Pure helper. Wraps the default pipeline. For per-call overrides build
 * your own MarkdownSanitizationPipeline.
 */
export function sanitizeMarkdown(markdown: string): SanitizationResult {
    return getDefault().sanitizeMarkdown(markdown);
}

/** Build a refusal message for templates to display. */
export function getRefusalMessage(result: SanitizationResult): string {
    if (result.warnings.length > 0) {
        return `Content cannot be displayed due to security concerns: ${result.warnings.join(", ")}`;
    }
    if (result.blocked.length > 0) {
        return `Content contains blocked elements: ${result.blocked.join(", ")}`;
    }
    return "Content failed security validation and cannot be displayed.";
}
