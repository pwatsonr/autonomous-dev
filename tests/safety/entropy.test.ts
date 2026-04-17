/**
 * Tests for Shannon entropy calculator and high-entropy secret detector.
 *
 * Covers SPEC-007-2-1 test cases TC-2-1-40 through TC-2-1-44.
 */

import { shannonEntropy, detectHighEntropySecrets } from '../../src/safety/entropy';

// ---------------------------------------------------------------------------
// Shannon entropy calculation
// ---------------------------------------------------------------------------

describe('shannonEntropy', () => {
  test('TC-2-1-40: all same characters returns 0.0', () => {
    expect(shannonEntropy('aaaaaaaaaa')).toBeCloseTo(0.0, 5);
  });

  test('TC-2-1-41: two equal characters returns 1.0', () => {
    expect(shannonEntropy('ababababab')).toBeCloseTo(1.0, 5);
  });

  test('TC-2-1-42: high entropy string exceeds 4.5', () => {
    const entropy = shannonEntropy('aB3$xY9!kL2@mN5^pQ8&rT1wZ');
    expect(entropy).toBeGreaterThan(4.5);
  });

  test('TC-2-1-43: base64 string has entropy around 3.5-4.0', () => {
    const entropy = shannonEntropy('dXNlcjpwYXNzd29yZA==');
    expect(entropy).toBeGreaterThanOrEqual(3.0);
    expect(entropy).toBeLessThan(4.5);
  });

  test('TC-2-1-44: random hex 32 chars has entropy around 3.5-4.0', () => {
    const entropy = shannonEntropy('a3f8c2d1e9b04f72a3f8c2d1e9b04f72');
    expect(entropy).toBeGreaterThanOrEqual(3.0);
    expect(entropy).toBeLessThan(4.5);
  });

  test('empty string returns 0', () => {
    expect(shannonEntropy('')).toBe(0);
  });

  test('single character returns 0', () => {
    expect(shannonEntropy('a')).toBeCloseTo(0.0, 5);
  });

  test('256 unique bytes produces maximum entropy near 8', () => {
    // 256 unique chars -> entropy = log2(256) = 8.0
    let s = '';
    for (let i = 0; i < 256; i++) {
      s += String.fromCharCode(i);
    }
    expect(shannonEntropy(s)).toBeCloseTo(8.0, 2);
  });
});

// ---------------------------------------------------------------------------
// High-entropy secret detection
// ---------------------------------------------------------------------------

describe('detectHighEntropySecrets', () => {
  test('TC-2-1-31: flags high entropy in password= context', () => {
    const input = 'password=aB3$xY9!kL2@mN5^pQ8&rT1';
    const redactions = detectHighEntropySecrets(input);
    expect(redactions.length).toBe(1);
    expect(redactions[0].type).toBe('secret');
    expect(redactions[0].patternName).toBe('high_entropy');
  });

  test('TC-2-1-32: does not flag low entropy password value', () => {
    const input = 'password=aaaaaaaaaaaaaaaaaaaaaa';
    const redactions = detectHighEntropySecrets(input);
    expect(redactions.length).toBe(0);
  });

  test('TC-2-1-33: does not flag high entropy without key= context', () => {
    const input = 'random_data aB3$xY9!kL2@mN5^pQ8&rT1';
    const redactions = detectHighEntropySecrets(input);
    expect(redactions.length).toBe(0);
  });

  test('flags high entropy in secret= context', () => {
    const input = 'secret=zX4%wQ7#jR2!nM6*tP9&yV1bK';
    const redactions = detectHighEntropySecrets(input);
    expect(redactions.length).toBe(1);
  });

  test('flags high entropy in token= context', () => {
    const input = 'token=aB3$xY9!kL2@mN5^pQ8&rT1wZ';
    const redactions = detectHighEntropySecrets(input);
    expect(redactions.length).toBe(1);
  });

  test('flags high entropy in key= context', () => {
    const input = 'key=zX4%wQ7#jR2!nM6*tP9&yV1bK';
    const redactions = detectHighEntropySecrets(input);
    expect(redactions.length).toBe(1);
  });

  test('does not flag values shorter than 20 characters', () => {
    // "short" is 5 chars, well below 20
    const input = 'password=short';
    const redactions = detectHighEntropySecrets(input);
    expect(redactions.length).toBe(0);
  });

  test('does not flag values exactly 20 characters (must exceed 20)', () => {
    // 20 chars of high entropy — should NOT be flagged (condition is > 20, not >= 20)
    const input = 'password=aB3$xY9!kL2@mN5^pQ8&';
    const value = input.split('=')[1];
    // Ensure the value is exactly 20 chars or adjust the check
    // The regex captures \S{20,} so it will match if >= 20 chars
    // but the length check is > 20 (MIN_VALUE_LENGTH)
    const redactions = detectHighEntropySecrets(input);
    // This depends on the actual length of the value
    if (value.length <= 20) {
      expect(redactions.length).toBe(0);
    }
  });

  test('handles multiple secrets in one text', () => {
    const input = [
      'password=aB3$xY9!kL2@mN5^pQ8&rT1',
      'token=zX4%wQ7#jR2!nM6*tP9&yV1bKaZ',
    ].join('\n');
    const redactions = detectHighEntropySecrets(input);
    expect(redactions.length).toBe(2);
  });

  test('handles case insensitive context keywords', () => {
    const input = 'PASSWORD=aB3$xY9!kL2@mN5^pQ8&rT1';
    const redactions = detectHighEntropySecrets(input);
    expect(redactions.length).toBe(1);
  });

  test('handles colon separator', () => {
    const input = 'password: aB3$xY9!kL2@mN5^pQ8&rT1';
    const redactions = detectHighEntropySecrets(input);
    expect(redactions.length).toBe(1);
  });

  test('returns empty array for empty input', () => {
    expect(detectHighEntropySecrets('')).toEqual([]);
  });
});
