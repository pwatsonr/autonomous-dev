/**
 * Stack trace normalization (SPEC-007-3-3, Task 6).
 *
 * Removes deployment-specific artifacts from stack traces so that the
 * same logical error produces the same fingerprint across deployments.
 *
 * Normalization rules:
 *   - Line numbers:    `Foo.java:42`      -> `Foo.java:*`
 *   - Memory addresses: `0x7fff5fbff8a0`  -> `0x*`
 *   - Thread IDs:       `[thread-42]`     -> `[thread-*]`
 *   - Thread names:     `Thread-42`       -> `Thread-*`
 *   - Timestamps:       `2026-04-08T14:30:22Z` -> `<timestamp>`
 *   - Pod IDs:          `pod-abc123def`   -> `pod-*`
 *
 * Only the top 3 stack frames are included in the output.
 */

// ---------------------------------------------------------------------------
// Frame parsing
// ---------------------------------------------------------------------------

/**
 * Parses a raw stack trace string into individual frame lines.
 *
 * Recognises common frame formats:
 *   - Java/JavaScript: `at ...`
 *   - Python:          `File "..."`
 *   - Ruby/Go:         `  in ...`
 *   - Generic:         any line whose trimmed form starts with a word
 *                      followed by a dot (e.g., `com.example.Foo.bar`)
 */
export function parseStackFrames(stackTrace: string): string[] {
  const lines = stackTrace.split('\n');
  return lines.filter((line) => {
    const trimmed = line.trim();
    return (
      trimmed.startsWith('at ') ||
      /^File "/.test(trimmed) ||
      /^\s*in /.test(line) ||
      /^\s+\w+\./.test(line)
    );
  });
}

// ---------------------------------------------------------------------------
// Single-frame normalization
// ---------------------------------------------------------------------------

/**
 * Applies all normalization rules to a single stack frame string.
 */
export function normalizeFrame(frame: string): string {
  let normalized = frame;

  // Remove line numbers: Foo.java:42 -> Foo.java:*
  normalized = normalized.replace(/:(\d+)/g, ':*');

  // Remove memory addresses: 0x7fff5fbff8a0 -> 0x*
  normalized = normalized.replace(/0x[0-9a-fA-F]+/g, '0x*');

  // Remove thread IDs: [thread-42] -> [thread-*]
  normalized = normalized.replace(/\[thread-\d+\]/g, '[thread-*]');

  // Alternative thread naming: Thread-42 -> Thread-*
  normalized = normalized.replace(/Thread-\d+/g, 'Thread-*');

  // Remove timestamps embedded in traces
  normalized = normalized.replace(
    /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g,
    '<timestamp>',
  );

  // Remove pod IDs: pod-abc123def -> pod-*
  normalized = normalized.replace(/pod-[a-z0-9]+/g, 'pod-*');

  return normalized.trim();
}

// ---------------------------------------------------------------------------
// Full trace normalization
// ---------------------------------------------------------------------------

/**
 * Normalizes a raw stack trace string.
 *
 * 1. Parses the trace into individual frames.
 * 2. Takes the top 3 frames.
 * 3. Applies normalization rules to each frame.
 * 4. Returns the result joined by newlines.
 */
export function normalizeStackTrace(stackTrace: string): string {
  const frames = parseStackFrames(stackTrace);
  const top3 = frames.slice(0, 3);
  return top3.map(normalizeFrame).join('\n');
}

/**
 * Extracts a stack trace from an array of log sample lines.
 *
 * Concatenates all lines and delegates to {@link parseStackFrames} for
 * frame identification.
 */
export function extractStackTrace(logSamples: string[]): string {
  return logSamples.join('\n');
}
