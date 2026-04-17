import {
  isValidName,
  slugify,
  integrationBranchName,
  trackBranchName,
  worktreePath,
} from '../../src/parallel/naming';
import {
  loadConfig,
  validateConfig,
} from '../../src/parallel/config';

describe('isValidName', () => {
  it('accepts lowercase alphanumeric with hyphens', () => {
    expect(isValidName('track-a')).toBe(true);
  });

  it('accepts minimum length (2 chars)', () => {
    expect(isValidName('ab')).toBe(true);
  });

  it('accepts "a1"', () => {
    expect(isValidName('a1')).toBe(true);
  });

  it('accepts "my-long-track-name-42"', () => {
    expect(isValidName('my-long-track-name-42')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidName('')).toBe(false);
  });

  it('rejects leading hyphen', () => {
    expect(isValidName('-bad')).toBe(false);
  });

  it('rejects trailing hyphen', () => {
    expect(isValidName('bad-')).toBe(false);
  });

  it('rejects uppercase', () => {
    expect(isValidName('UPPER')).toBe(false);
  });

  it('rejects spaces', () => {
    expect(isValidName('has space')).toBe(false);
  });

  it('rejects names exceeding 64 chars', () => {
    expect(isValidName('a'.repeat(65))).toBe(false);
  });

  it('rejects single character', () => {
    expect(isValidName('a')).toBe(false);
  });

  it('rejects reserved names (CON)', () => {
    expect(isValidName('con')).toBe(false);
  });

  it('rejects reserved names (PRN)', () => {
    expect(isValidName('prn')).toBe(false);
  });

  it('rejects reserved names (AUX)', () => {
    expect(isValidName('aux')).toBe(false);
  });

  it('rejects reserved names (NUL)', () => {
    expect(isValidName('nul')).toBe(false);
  });

  it('rejects reserved names (COM1)', () => {
    expect(isValidName('com1')).toBe(false);
  });

  it('rejects reserved names (LPT1)', () => {
    expect(isValidName('lpt1')).toBe(false);
  });

  it('accepts exactly 64 chars', () => {
    // 64 chars: starts and ends with alnum
    const name = 'a' + 'b'.repeat(62) + 'c';
    expect(name.length).toBe(64);
    expect(isValidName(name)).toBe(true);
  });
});

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Add User Auth')).toBe('add-user-auth');
  });

  it('converts "Add User Authentication Flow"', () => {
    expect(slugify('Add User Authentication Flow')).toBe('add-user-authentication-flow');
  });

  it('collapses multiple hyphens', () => {
    expect(slugify('a--b')).toBe('a-b');
  });

  it('truncates to 64 chars', () => {
    const result = slugify('a'.repeat(100));
    expect(result.length).toBeLessThanOrEqual(64);
    expect(isValidName(result)).toBe(true);
  });

  it('trims leading/trailing special chars', () => {
    expect(slugify('  foo  ')).toBe('foo');
  });

  it('handles numeric prefix', () => {
    expect(slugify('123-test')).toBe('123-test');
  });

  it('replaces slashes with hyphens', () => {
    expect(slugify('a/b/c')).toBe('a-b-c');
  });

  it('handles unicode/special chars', () => {
    const result = slugify('emojis!');
    expect(isValidName(result)).toBe(true);
  });

  it('property: output always valid', () => {
    for (const input of ['Hello World', '  foo  ', '123-test', 'a/b/c', 'emojis!']) {
      expect(isValidName(slugify(input))).toBe(true);
    }
  });

  it('throws for empty-ish input', () => {
    expect(() => slugify('')).toThrow();
    expect(() => slugify('---')).toThrow();
  });
});

describe('branch name construction', () => {
  it('builds integration branch', () => {
    expect(integrationBranchName('req-001')).toBe('auto/req-001/integration');
  });

  it('builds track branch', () => {
    expect(trackBranchName('req-001', 'track-a')).toBe('auto/req-001/track-a');
  });

  it('rejects invalid requestId', () => {
    expect(() => trackBranchName('INVALID', 'track-a')).toThrow();
  });

  it('rejects invalid trackName', () => {
    expect(() => trackBranchName('req-001', '')).toThrow();
  });

  it('rejects invalid requestId on integration branch', () => {
    expect(() => integrationBranchName('INVALID')).toThrow();
  });
});

describe('worktreePath', () => {
  it('joins root, requestId, and trackName', () => {
    expect(worktreePath('/repo/.worktrees', 'req-001', 'track-a'))
      .toBe('/repo/.worktrees/req-001/track-a');
  });

  it('works with relative root', () => {
    expect(worktreePath('.worktrees', 'req-001', 'track-a'))
      .toBe('.worktrees/req-001/track-a');
  });
});

describe('config', () => {
  it('returns valid defaults', () => {
    const cfg = loadConfig();
    expect(cfg.max_worktrees).toBe(5);
    expect(cfg.max_tracks).toBe(5);
    expect(cfg.disk_warning_threshold_gb).toBe(5);
    expect(cfg.disk_hard_limit_gb).toBe(2);
    expect(cfg.worktree_cleanup_delay_seconds).toBe(300);
    expect(cfg.worktree_root).toBe('.worktrees');
    expect(cfg.state_dir).toBe('.autonomous-dev/state');
    expect(cfg.base_branch).toBe('main');
    expect(cfg.stall_timeout_minutes).toBe(15);
    expect(cfg.max_revision_cycles).toBe(2);
    expect(cfg.conflict_ai_confidence_threshold).toBe(0.85);
    expect(cfg.merge_conflict_escalation_threshold).toBe(5);
    expect(cfg.disk_hard_limit_gb).toBeLessThan(cfg.disk_warning_threshold_gb);
  });

  it('accepts valid overrides', () => {
    const cfg = loadConfig({ max_worktrees: 10, max_tracks: 8 });
    expect(cfg.max_worktrees).toBe(10);
    expect(cfg.max_tracks).toBe(8);
    // other fields remain at defaults
    expect(cfg.disk_warning_threshold_gb).toBe(5);
  });

  it('rejects negative max_worktrees', () => {
    expect(() => validateConfig({ ...loadConfig(), max_worktrees: -1 })).toThrow();
  });

  it('rejects zero max_worktrees', () => {
    expect(() => validateConfig({ ...loadConfig(), max_worktrees: 0 })).toThrow();
  });

  it('rejects non-integer max_worktrees', () => {
    expect(() => validateConfig({ ...loadConfig(), max_worktrees: 1.5 })).toThrow();
  });

  it('rejects hard limit >= warning threshold', () => {
    expect(() =>
      validateConfig({ ...loadConfig(), disk_hard_limit_gb: 10, disk_warning_threshold_gb: 5 }),
    ).toThrow();
  });

  it('rejects hard limit == warning threshold', () => {
    expect(() =>
      validateConfig({ ...loadConfig(), disk_hard_limit_gb: 5, disk_warning_threshold_gb: 5 }),
    ).toThrow();
  });

  it('rejects negative disk_warning_threshold_gb', () => {
    expect(() =>
      validateConfig({ ...loadConfig(), disk_warning_threshold_gb: -1 }),
    ).toThrow();
  });

  it('rejects zero disk_hard_limit_gb', () => {
    expect(() =>
      validateConfig({ ...loadConfig(), disk_hard_limit_gb: 0 }),
    ).toThrow();
  });

  it('rejects empty worktree_root', () => {
    expect(() =>
      validateConfig({ ...loadConfig(), worktree_root: '' }),
    ).toThrow();
  });

  it('rejects empty base_branch', () => {
    expect(() =>
      validateConfig({ ...loadConfig(), base_branch: '' }),
    ).toThrow();
  });

  it('rejects negative stall_timeout_minutes', () => {
    expect(() =>
      validateConfig({ ...loadConfig(), stall_timeout_minutes: 0 }),
    ).toThrow();
  });

  it('rejects negative max_revision_cycles', () => {
    expect(() =>
      validateConfig({ ...loadConfig(), max_revision_cycles: -1 }),
    ).toThrow();
  });

  it('accepts max_revision_cycles of 0', () => {
    const cfg = loadConfig({ max_revision_cycles: 0 });
    expect(cfg.max_revision_cycles).toBe(0);
  });

  it('rejects conflict_ai_confidence_threshold of 0', () => {
    expect(() =>
      validateConfig({ ...loadConfig(), conflict_ai_confidence_threshold: 0 }),
    ).toThrow();
  });

  it('rejects conflict_ai_confidence_threshold > 1', () => {
    expect(() =>
      validateConfig({ ...loadConfig(), conflict_ai_confidence_threshold: 1.1 }),
    ).toThrow();
  });

  it('accepts conflict_ai_confidence_threshold of 1', () => {
    const cfg = loadConfig({ conflict_ai_confidence_threshold: 1 });
    expect(cfg.conflict_ai_confidence_threshold).toBe(1);
  });

  it('rejects non-existent absolute worktree_root', () => {
    expect(() =>
      validateConfig({ ...loadConfig(), worktree_root: '/nonexistent/path/that/does/not/exist' }),
    ).toThrow();
  });

  it('rejects zero merge_conflict_escalation_threshold', () => {
    expect(() =>
      validateConfig({ ...loadConfig(), merge_conflict_escalation_threshold: 0 }),
    ).toThrow();
  });
});
