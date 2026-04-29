# SPEC-014-2-03: XSS Defense (marked + DOMPurify + Escape Helpers + Auto-Escape Templates)

## Metadata
- **Parent Plan**: PLAN-014-2
- **Tasks Covered**: TASK-008 (Markdown Sanitization Pipeline), TASK-009 (Code Diff Security Renderer)
- **Estimated effort**: 10 hours

## Description
Build a multi-layer XSS defense for any user-influenced content rendered by the portal. Markdown flows through `marked v5.1.x` configured with security-locked renderers, then through `DOMPurify v3.x` (running in JSDOM) with a strict tag/attribute allowlist. Code diffs and snippets bypass markdown entirely — they are HTML-entity encoded and styled with CSS classes only (zero JavaScript execution paths). Handlebars templates use auto-escape by default; the only way to emit raw HTML is via the explicit `{{{safeHtml content}}}` helper which routes through the sanitization pipeline. ESLint rule forbids `innerHTML` and equivalents anywhere in the codebase. Sanitization failures fall back to a refusal message — no content is rendered if the pipeline returns unsafe results.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `package.json` | Modify | Add deps: `marked@~5.1.2`, `dompurify@~3.0.5`, `jsdom@~22.1.0`, `@types/dompurify`, `@types/jsdom` |
| `src/portal/security/sanitization-pipeline.ts` | Create | `MarkdownSanitizationPipeline` class; pure function `sanitizeMarkdown(md) -> SanitizationResult` |
| `src/portal/security/sanitization-config.ts` | Create | Allowlists (tags, attributes, URL schemes), TTL/size limits, default config |
| `src/portal/security/secure-diff-renderer.ts` | Create | `renderSecureDiff(unifiedDiff, opts) -> string` returning HTML built from entity-encoded content + CSS classes |
| `src/portal/security/escape-helpers.ts` | Create | `escapeHtml`, `escapeAttr`, `escapeJsString`, `escapeUrl` pure helpers |
| `src/portal/helpers/markdown-helpers.ts` | Create | Handlebars helpers: `{{{md content}}}`, `{{{safeHtml content}}}`, `{{escape content}}`, `{{diff content}}` |
| `src/portal/helpers/diff-helpers.ts` | Create | Handlebars helper integration for diff rendering, syntax-class assignment |
| `src/portal/public/css/secure-syntax-highlighting.css` | Create | CSS-only syntax highlighting classes (`.tok-keyword`, `.tok-string`, etc.) for major languages |
| `.eslintrc.security.json` | Create | ESLint config extending base with `no-restricted-properties` rules |
| `eslint-rules/no-innerhtml.js` | Create | Custom ESLint rule banning `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` |

## Implementation Details

### Sanitization Config (`sanitization-config.ts`)

```typescript
export interface SanitizationConfig {
  allowedTags: string[];
  allowedAttributes: Record<string, string[]>;
  allowedUrlSchemes: string[];
  maxContentLength: number;        // bytes
  maxDataUrlSize: number;          // bytes for inline images
  enableCaching: boolean;
  cacheMaxEntries: number;
}

export const DEFAULT_SANITIZATION_CONFIG: SanitizationConfig = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr', 'strong', 'em', 'del', 's', 'sup', 'sub',
    'ul', 'ol', 'li',
    'blockquote',
    'code', 'pre', 'kbd',
    'a', 'img',
    'table', 'thead', 'tbody', 'tr', 'td', 'th',
    'span', 'div'  // styling only via class allowlist below
  ],
  allowedAttributes: {
    a:    ['href', 'title', 'rel', 'target'],
    img:  ['src', 'alt', 'title', 'width', 'height', 'loading'],
    code: ['class'],   // language-* class only
    pre:  ['class'],
    span: ['class'],   // tok-* class only
    div:  ['class'],
    th:   ['scope', 'colspan', 'rowspan'],
    td:   ['colspan', 'rowspan'],
    '*':  ['id', 'class']  // global; class values further filtered post-purify
  },
  allowedUrlSchemes: ['http', 'https', 'mailto'],  // explicitly excludes javascript, data, vbscript, file
  maxContentLength: 100_000,       // 100 KB
  maxDataUrlSize: 10_000,          // 10 KB
  enableCaching: true,
  cacheMaxEntries: 1_000
};
```

Forbidden tags (blocked even if user-allowlisted): `script`, `style`, `object`, `embed`, `form`, `input`, `button`, `textarea`, `select`, `iframe`, `frame`, `frameset`, `applet`, `meta`, `link`, `base`.

Forbidden attribute patterns: `^on` (any event handler), `style`, `srcdoc`, `formaction`, `xlink:href`, `data-*` (no data attributes — too easy to weaponize for app code).

### `MarkdownSanitizationPipeline`

`sanitizeMarkdown(markdown: string) -> Promise<SanitizationResult>`:

```typescript
export interface SanitizationResult {
  sanitized: string;
  warnings: string[];
  blocked: string[];
  safe: boolean;
}
```

Pipeline stages:

1. **Length guard**: If `markdown.length > maxContentLength` → return `{sanitized: '', warnings: ['content-exceeds-max-length'], blocked: ['entire-content'], safe: false}`.

2. **Cache lookup**: If `enableCaching` and SHA-256 hash of input is in cache → return cached result.

3. **Marked parse** with custom renderer:
   - `link(href, title, text)`: Reject `javascript:`, `data:`, `vbscript:`, `file:` URLs → emit `<span class="blocked-link" title="Blocked unsafe URL">${escapedText}</span>`. External links (http/https not matching same origin) get `target="_blank" rel="noopener noreferrer"`. All attributes escaped via `escapeAttr`.
   - `image(src, title, text)`: Same scheme allowlist. `data:` URLs allowed only if `< maxDataUrlSize`. Always emit `loading="lazy"`. Reject if size exceeded.
   - `code(code, language)`: ALWAYS entity-escape `code`. Validate `language` matches `^[a-zA-Z0-9-]{1,30}$`; if not, omit the class. Emit `<pre class="code-block language-${lang}"><code>${escapedCode}</code></pre>`.
   - `codespan(code)`: Entity-escape, emit `<code class="inline-code">${escaped}</code>`.
   - `html(html)`: REJECT all raw HTML in markdown — replace with entity-escaped placeholder. (User cannot inject `<script>` even if marked is permissive.)

   Marked options: `{headerIds: false, mangle: false, sanitize: false, breaks: true, gfm: true, pedantic: false, silent: false}`. `sanitize: false` is intentional — DOMPurify handles it next.

4. **DOMPurify** in JSDOM:
   ```typescript
   const window = new JSDOM('').window;
   const purify = DOMPurify(window as any);
   purify.setConfig({
     ALLOWED_TAGS: config.allowedTags,
     ALLOWED_ATTR: flattenAttrs(config.allowedAttributes),
     ALLOWED_URI_REGEXP: new RegExp(`^(?:${config.allowedUrlSchemes.join('|')}):`, 'i'),
     ALLOW_DATA_ATTR: false,
     ALLOW_UNKNOWN_PROTOCOLS: false,
     SANITIZE_DOM: true,
     FORBID_TAGS: ['script', 'style', 'object', 'embed', 'form', 'input',
                   'button', 'textarea', 'select', 'iframe', 'frame',
                   'frameset', 'applet', 'meta', 'link', 'base'],
     FORBID_ATTR: ['style', 'srcdoc', 'formaction', 'xlink:href'],
     KEEP_CONTENT: true,
     FORCE_BODY: false,
     WHOLE_DOCUMENT: false,
     RETURN_DOM_FRAGMENT: false
   });
   ```

   `beforeSanitizeAttributes` hook: iterate and remove any attribute whose name (lowercased) starts with `on` or matches `/^data-/`. Log each removal.

   `uponSanitizeAttribute` hook for `class`: split by whitespace, keep only classes matching `^(language-[a-z0-9-]{1,30}|tok-[a-z]{1,30}|inline-code|code-block|blocked-link|blocked-image|md-[a-z]{1,30})$`. Reassemble. (Defense against CSS-class-driven attacks.)

5. **Post-sanitization scan**: If output contains any of `<script`, `javascript:`, `vbscript:`, `data:text/html`, `data:application/javascript` → return `{sanitized: '', warnings: ['post-sanitization-unsafe-pattern'], blocked: ['script-content'], safe: false}`.

6. **Result**: Compare `extractElements(html)` (input after marked) vs `extractElements(sanitized)`. Anything missing goes into `blocked[]`. `safe = blocked.length === 0 && warnings.length === 0`.

7. **Cache write**: If `enableCaching` and `cache.size < cacheMaxEntries`, store. LRU-style eviction when full.

### Code Diff Renderer (`secure-diff-renderer.ts`)

`renderSecureDiff(unifiedDiff: string, opts?: {language?: string, maxLines?: number}) -> string`:

1. Validate `language` against allowlist `^[a-zA-Z0-9-]{1,30}$`. Default to no language class if invalid/missing.
2. Cap input at `opts.maxLines ?? 5_000` lines. Truncate with marker `<div class="diff-truncated">… diff truncated at 5000 lines …</div>`.
3. Split input by `\n`. For each line, classify:
   - Starts with `+++` or `---` → header line, class `tok-diff-meta`
   - Starts with `@@` → hunk line, class `tok-diff-hunk`
   - Starts with `+` (not `+++`) → addition, class `tok-diff-add`
   - Starts with `-` (not `---`) → deletion, class `tok-diff-del`
   - Else → context, class `tok-diff-ctx`
4. **Entity-encode** each line via `escapeHtml`. NEVER pass raw line text into the HTML.
5. Emit:
   ```html
   <pre class="diff-block language-${lang}"><code>
   <span class="diff-line tok-diff-meta" data-line-num="1">--- a/file.ts</span>
   <span class="diff-line tok-diff-add" data-line-num="2">+ const x = 1;</span>
   ...
   </code></pre>
   ```
   Note: `data-line-num` is set via `setAttribute` from server-rendered template; final HTML contains the attribute as a static string. Build the string with template literals using ONLY entity-escaped values.
6. Provide CSS classes only — no inline `style=`.
7. **No regex syntax highlighting in v1**. Tokenization is line-level only. Future enhancement can add language-aware tokens via Shiki or similar (out of scope).

### Escape Helpers (`escape-helpers.ts`)

```typescript
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
}

export function escapeAttr(s: string): string {
  // Same as escapeHtml plus backtick (IE quirk) and equals (attribute boundary)
  return escapeHtml(s).replace(/`/g, '&#096;').replace(/=/g, '&#061;');
}

export function escapeJsString(s: string): string {
  // Hex-encode anything outside ASCII alphanumerics for use inside JS string literals
  return s.replace(/[^a-zA-Z0-9,._]/g, c =>
    '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

export function escapeUrl(url: string): string | null {
  // Returns null if url scheme not in allowlist; otherwise URL-encoded
  const trimmed = url.trim();
  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):/i);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (!['http', 'https', 'mailto'].includes(scheme)) return null;
  }
  // Relative URLs allowed; encode the path components
  return encodeURI(trimmed);
}
```

### Handlebars Helpers (`markdown-helpers.ts`)

- `{{escape content}}` — calls `escapeHtml`. Default behavior already escapes; this is for explicit clarity in templates.
- `{{{md content}}}` — async-rendered (using `compile-time` async helper or pre-resolved data). Calls `sanitizeMarkdown`. If `result.safe === false`, emits `<div class="content-refused">${getRefusalMessage(result)}</div>`. Else emits `result.sanitized`.
- `{{{safeHtml content}}}` — accepts content already known to be safe (e.g., server-generated HTML). Routes through DOMPurify defensively. NEVER accepts user input directly without going through `{{{md}}}` first.
- `{{{diff content language=lang}}}` — calls `renderSecureDiff`.
- `{{escapeAttr value}}` — for attribute interpolation in cases where `{{value}}` is not enough.

Handlebars MUST be registered with `noEscape: false` (default — no change). Triple-mustache `{{{...}}}` is the only way to emit raw HTML and it MUST go through one of the helpers above. Document this contract in `helpers/README.md`.

### ESLint Rule (`eslint-rules/no-innerhtml.js`)

Block these AssignmentExpressions and MemberExpressions:
- `*.innerHTML = ...`
- `*.outerHTML = ...`
- `*.insertAdjacentHTML(...)`
- `document.write(...)`
- `document.writeln(...)`
- `eval(...)`
- `new Function(...)`

Provides autofix suggestions pointing to safe alternatives (`textContent`, `setAttribute`, `appendChild`).

### Refusal Pattern

```typescript
export function getRefusalMessage(result: SanitizationResult): string {
  if (result.warnings.length > 0) {
    return `Content cannot be displayed due to security concerns: ${result.warnings.join(', ')}`;
  }
  if (result.blocked.length > 0) {
    return `Content contains blocked elements: ${result.blocked.join(', ')}`;
  }
  return 'Content failed security validation and cannot be displayed.';
}
```

## Acceptance Criteria

- [ ] `marked@~5.1.2` and `dompurify@~3.0.5` pinned in `package.json` (caret range only — no `^`)
- [ ] `jsdom@~22.1.0` configured for server-side DOMPurify
- [ ] `sanitizeMarkdown` rejects content over `maxContentLength` (100KB) with `entire-content` blocked entry
- [ ] All `<script>` tag variations blocked: case variants, nested, broken (`<<SCRIPT>`), with whitespace tricks (`<script\x20`)
- [ ] All `on*=` event handlers stripped, including obfuscated forms
- [ ] `javascript:`, `vbscript:`, `file:`, `data:text/html`, `data:application/javascript` URLs rejected in `href` and `src`
- [ ] `data:image/*` URLs allowed only when under `maxDataUrlSize` (10KB)
- [ ] Code blocks always entity-encoded; language class validated against `^[a-zA-Z0-9-]{1,30}$`
- [ ] Class attribute filtered post-purify to allowlist patterns only (`language-*`, `tok-*`, etc.)
- [ ] Post-sanitization scan blocks any output containing `<script`, `javascript:`, `vbscript:`, `data:text/html`
- [ ] `renderSecureDiff` entity-encodes every line; classes assigned by line prefix; never executes user content
- [ ] Diff truncation at 5,000 lines with visible marker
- [ ] `escapeHtml`, `escapeAttr`, `escapeJsString`, `escapeUrl` cover all five HTML metacharacters plus backtick
- [ ] Custom ESLint rule blocks `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`
- [ ] ESLint security rule runs in CI; build fails on violation
- [ ] Handlebars `{{escape}}` helper available; `{{{md}}}` and `{{{safeHtml}}}` are the only routes for raw HTML
- [ ] Sanitization failure path emits refusal message; never falls through to raw rendering
- [ ] Cache LRU-evicts beyond `cacheMaxEntries` (1,000)
- [ ] Performance: 10KB markdown input sanitizes in < 100ms (NFR from PLAN-014-2)
- [ ] Performance: deeply nested HTML (1,000-level `<div>` nesting) does not stack-overflow
- [ ] No `innerHTML` usage anywhere in `src/portal/**` — verified by ESLint

## Dependencies

- **Inbound**: All template rendering paths must use the new helpers — coordinate with PLAN-013-2 (portal templates).
- **Outbound**: SPEC-014-2-04 (CSP) requires that no inline scripts exist except those carrying the per-request nonce — sanitization pipeline guarantees no inline scripts in user content.
- **Outbound**: SPEC-014-2-05 (security tests) imports `sanitizeMarkdown` and `renderSecureDiff` for payload tests.
- **Libraries**: `marked@~5.1.2`, `dompurify@~3.0.5`, `jsdom@~22.1.0`. Pin exact minor versions; subscribe to GHSA advisories for both.
- **Existing modules**: Handlebars instance from PLAN-013-2 portal scaffolding.

## Notes

- **Why marked + DOMPurify (belt and suspenders)?** marked may have parser bugs that allow bypass. DOMPurify is the defense layer with active security maintenance. Both are needed; neither is sufficient alone.
- **Why JSDOM server-side?** DOMPurify needs a DOM. JSDOM provides one without a real browser. Memory: ~3MB per instance — initialize once at startup, reuse.
- **Why post-sanitization scan?** Defense in depth. If a future DOMPurify CVE allows `<script>` smuggling, the scan catches it. Cost is one regex per render.
- **Why no syntax highlighting in v1?** Most syntax highlighters use regex tokenizers vulnerable to ReDoS. CSS-class-only highlighting is XSS-proof. Future: Shiki (server-side, AST-based).
- **`data:` URL strategy**: Allow inline images for UX, block inline HTML/JS. Size cap prevents hidden payloads (10KB).
- **Caching gotcha**: Cache key is content hash, NOT raw content (avoids large-string Map keys). Use `crypto.createHash('sha256')`.
- **DOMPurify version pinning**: Subscribe to https://github.com/cure53/DOMPurify/security/advisories. Treat any advisory as P0 patch.
- **Markdown `html` blocks**: Reject ALL raw HTML inside markdown (custom renderer override). Users who need richer formatting must use markdown syntax.
- **Future**: Markdown-It is a candidate alternative to marked with stronger security defaults; revisit in PLAN-014-3 if marked CVE rate increases.
