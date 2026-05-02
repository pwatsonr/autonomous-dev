/**
 * Custom AJV formats for the autonomous-dev hook validation vocabulary
 * (SPEC-019-2-02, Task 3).
 *
 * Three string-validating formats hook authors can use as schema primitives:
 *   - `semver`        — any valid Semantic Versioning string per semver.org.
 *   - `iso-duration`  — ISO 8601 duration grammar (`PT1H30M`, `P1Y2M10D`, ...).
 *   - `path-glob`     — any pattern picomatch.parse() accepts without throwing.
 *
 * `registerCustomFormats(ajv)` is idempotent: a second call on the same
 * instance is a no-op and never duplicates a registration.
 *
 * @module intake/hooks/formats
 */

import type Ajv from 'ajv';
import semver from 'semver';
// picomatch is CJS; default-import shape via require interop.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import picomatch = require('picomatch');

/**
 * ISO 8601 duration grammar.
 *
 * Pattern is intentionally strict: rejects `'PT'` (no time components) and
 * the empty `'P'` because both are technically malformed even though some
 * permissive parsers accept them. See SPEC-019-2-02 §Notes.
 */
// eslint-disable-next-line max-len
const ISO_DURATION = /^P(?!$)(\d+(?:\.\d+)?Y)?(\d+(?:\.\d+)?M)?(\d+(?:\.\d+)?W)?(\d+(?:\.\d+)?D)?(T(?=\d)(\d+(?:\.\d+)?H)?(\d+(?:\.\d+)?M)?(\d+(?:\.\d+)?S)?)?$/;

/**
 * Register the three autonomous-dev custom formats on the supplied AJV
 * instance. Idempotent — safe to call multiple times.
 */
export function registerCustomFormats(ajv: Ajv): void {
  if (!ajv.formats.semver) {
    ajv.addFormat('semver', {
      type: 'string',
      validate: (s: string) => semver.valid(s) !== null,
    });
  }

  if (!ajv.formats['iso-duration']) {
    ajv.addFormat('iso-duration', {
      type: 'string',
      validate: (s: string) => ISO_DURATION.test(s),
    });
  }

  if (!ajv.formats['path-glob']) {
    ajv.addFormat('path-glob', {
      type: 'string',
      validate: (s: string) => {
        try {
          // picomatch.parse accepts an array of patterns. It throws on
          // syntactic problems (unclosed brackets/braces); a successful
          // parse means the runtime matcher will accept this pattern too.
          picomatch.parse([s]);
          return true;
        } catch {
          return false;
        }
      },
    });
  }
}
