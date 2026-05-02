/**
 * Unit tests for `expandWildcards` (SPEC-024-3-04).
 *
 * The expander is a pure function — no mocking required.
 */

import { expandWildcards } from '../../intake/sessions/wildcard-expander';
import type { AllowlistEntry } from '../../intake/firewall/types';

describe('expandWildcards', () => {
  test('replaces leading *. with the region label', () => {
    // Production code matches a leading `*.` (per the schema's single-label
    // constraint); the spec example `ecs.*.amazonaws.com` was a mid-string
    // wildcard that the schema does not currently permit, so the canonical
    // form is `*.amazonaws.com`.
    const entries: AllowlistEntry[] = [
      { fqdn: '*.amazonaws.com', port: 443, protocol: 'tcp' },
    ];
    const out = expandWildcards(entries, 'us-east-1');
    expect(out).toEqual([
      { fqdn: 'us-east-1.amazonaws.com', port: 443, protocol: 'tcp' },
    ]);
  });

  test('non-wildcard entries pass through unchanged', () => {
    const entries: AllowlistEntry[] = [
      { fqdn: 'sts.amazonaws.com', port: 443, protocol: 'tcp' },
      { fqdn: 'metadata.googleapis.com', port: 443, protocol: 'tcp' },
    ];
    const out = expandWildcards(entries, 'us-east-1');
    expect(out).toEqual(entries);
    // returns fresh objects, not the same references
    expect(out[0]).not.toBe(entries[0]);
  });

  test('empty array returns empty array', () => {
    expect(expandWildcards([], 'us-east-1')).toEqual([]);
  });

  test('throws when region is empty and any entry contains a leading wildcard', () => {
    const entries: AllowlistEntry[] = [
      { fqdn: '*.amazonaws.com', port: 443, protocol: 'tcp' },
    ];
    expect(() => expandWildcards(entries, '')).toThrow(/region required/);
    expect(() => expandWildcards(entries, undefined)).toThrow(/region required/);
    expect(() => expandWildcards(entries, null)).toThrow(/region required/);
  });

  test('does not throw for empty region when there are no wildcards', () => {
    const entries: AllowlistEntry[] = [
      { fqdn: 'sts.amazonaws.com', port: 443, protocol: 'tcp' },
    ];
    expect(() => expandWildcards(entries, '')).not.toThrow();
  });
});
