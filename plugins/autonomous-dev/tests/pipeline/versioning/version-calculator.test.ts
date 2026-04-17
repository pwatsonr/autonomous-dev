import {
  parseVersion,
  formatVersion,
  calculateNextVersion,
} from '../../../src/pipeline/versioning/version-calculator';

describe('calculateNextVersion', () => {
  it('INITIAL reason always returns 1.0', () => {
    expect(calculateNextVersion(null, 'INITIAL')).toBe('1.0');
  });

  it('INITIAL reason returns 1.0 even if currentVersion is provided', () => {
    expect(calculateNextVersion('5.3', 'INITIAL')).toBe('1.0');
  });

  it('REVIEW_REVISION: 1.0 -> 1.1', () => {
    expect(calculateNextVersion('1.0', 'REVIEW_REVISION')).toBe('1.1');
  });

  it('REVIEW_REVISION: 1.1 -> 1.2', () => {
    expect(calculateNextVersion('1.1', 'REVIEW_REVISION')).toBe('1.2');
  });

  it('REVIEW_REVISION: 1.9 -> 1.10 (not 2.0)', () => {
    expect(calculateNextVersion('1.9', 'REVIEW_REVISION')).toBe('1.10');
  });

  it('REVIEW_REVISION: 9.9 -> 9.10', () => {
    expect(calculateNextVersion('9.9', 'REVIEW_REVISION')).toBe('9.10');
  });

  it('BACKWARD_CASCADE: 1.3 -> 2.0', () => {
    expect(calculateNextVersion('1.3', 'BACKWARD_CASCADE')).toBe('2.0');
  });

  it('BACKWARD_CASCADE: 2.5 -> 3.0', () => {
    expect(calculateNextVersion('2.5', 'BACKWARD_CASCADE')).toBe('3.0');
  });

  it('ROLLBACK: 1.2 -> 1.3', () => {
    expect(calculateNextVersion('1.2', 'ROLLBACK')).toBe('1.3');
  });

  it('ROLLBACK: 2.0 -> 2.1', () => {
    expect(calculateNextVersion('2.0', 'ROLLBACK')).toBe('2.1');
  });

  it('throws for null currentVersion with REVIEW_REVISION', () => {
    expect(() => calculateNextVersion(null, 'REVIEW_REVISION')).toThrow(
      'currentVersion is required for non-INITIAL versions',
    );
  });

  it('throws for unknown reason', () => {
    expect(() => calculateNextVersion('1.0', 'UNKNOWN' as any)).toThrow(
      'Unknown version reason: UNKNOWN',
    );
  });
});

describe('parseVersion', () => {
  it('parses "1.0" correctly', () => {
    expect(parseVersion('1.0')).toEqual({ major: 1, minor: 0 });
  });

  it('parses "9.10" correctly', () => {
    expect(parseVersion('9.10')).toEqual({ major: 9, minor: 10 });
  });

  it('throws for invalid format "1"', () => {
    expect(() => parseVersion('1')).toThrow('Invalid version string: 1');
  });

  it('throws for invalid format "abc"', () => {
    expect(() => parseVersion('abc')).toThrow('Invalid version string: abc');
  });

  it('throws for invalid format "1.2.3"', () => {
    expect(() => parseVersion('1.2.3')).toThrow('Invalid version string: 1.2.3');
  });
});

describe('formatVersion', () => {
  it('produces "1.0" from (1, 0)', () => {
    expect(formatVersion(1, 0)).toBe('1.0');
  });

  it('produces "9.10" from (9, 10)', () => {
    expect(formatVersion(9, 10)).toBe('9.10');
  });
});
