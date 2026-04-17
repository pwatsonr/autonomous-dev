# SPEC-008-2-02: Argument Parser, Identity Resolution & Input Validation

## Metadata
- **Parent Plan**: PLAN-008-2
- **Tasks Covered**: Task 3, Task 4, Task 9
- **Estimated effort**: 7 hours

## Description

Implement the Claude App argument parser that handles quoted strings, named flags, and boolean flags; the user identity resolver that maps OS users to internal identities with auto-provisioning; and the adapter-level input validation layer that rejects malformed inputs before they reach the router.

## Files to Create/Modify

| File | Action |
|------|--------|
| `intake/adapters/claude_arg_parser.ts` | Create |
| `intake/adapters/claude_identity.ts` | Create |
| `intake/adapters/claude_adapter.ts` | Modify (add validation) |

## Implementation Details

### Task 3: Argument Parser

**Tokenizer:**

The tokenizer splits the raw command string into tokens, respecting double-quoted strings:

```typescript
function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      if (inQuotes) {
        tokens.push(current);
        current = '';
        inQuotes = false;
      } else {
        if (current.length > 0) {
          tokens.push(current);
          current = '';
        }
        inQuotes = true;
      }
    } else if (ch === ' ' && !inQuotes) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  
  if (inQuotes) {
    throw new ValidationError('Unclosed quote in command arguments');
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  
  return tokens;
}
```

**Parser:**

```typescript
function parseCommandArgs(raw: string): { args: string[], flags: Record<string, string | boolean> } {
  if (!raw || raw.trim().length === 0) {
    return { args: [], flags: {} };
  }
  
  const tokens = tokenize(raw.trim());
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};
  
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].startsWith('--')) {
      const flagName = tokens[i].slice(2);
      if (flagName.length === 0) {
        throw new ValidationError('Empty flag name: --');
      }
      const nextToken = tokens[i + 1];
      if (nextToken && !nextToken.startsWith('--')) {
        flags[flagName] = nextToken;
        i += 2;
      } else {
        flags[flagName] = true;
        i += 1;
      }
    } else {
      args.push(tokens[i]);
      i += 1;
    }
  }
  
  return { args, flags };
}
```

**Edge cases handled:**
- Empty input -> `{ args: [], flags: {} }`
- `"quoted string"` -> single arg `quoted string`
- `--flag value` -> `{ flag: 'value' }`
- `--flag` (no value, next is another flag or end) -> `{ flag: true }`
- `--flag --other` -> `{ flag: true, other: true }`
- Unclosed quote -> throws `ValidationError`
- Special characters inside quotes preserved verbatim
- Multiple spaces between tokens ignored

### Task 4: User Identity Resolution

```typescript
class ClaudeIdentityResolver {
  constructor(private db: Repository) {}

  async resolve(): Promise<string> {
    const osUsername = os.userInfo().username;
    
    // Lookup by claude_user column
    const existing = await this.db.getUserByPlatformId('claude_app', osUsername);
    if (existing) {
      return existing.internal_id;
    }
    
    // Auto-provision
    const userCount = await this.db.getUserCount();
    const role = userCount === 0 ? 'admin' : 'viewer';
    
    const newUser: UserIdentity = {
      internal_id: osUsername,
      role,
      claude_user: osUsername,
      discord_id: null,
      slack_id: null,
      repo_permissions: {},
      rate_limit_override: null,
    };
    
    await this.db.upsertUser(newUser);
    return newUser.internal_id;
  }
}
```

**Auto-provisioning rules:**
- First user ever (no users in `user_identities` table) -> provisioned as `admin`.
- All subsequent unmapped users -> provisioned as `viewer`.
- Identity is the OS username, stored in `user_identities.claude_user`.
- Once provisioned, subsequent calls return the existing identity.

### Task 9: Input Validation at Adapter Level

Validation runs BEFORE passing the command to the router:

```typescript
const VALIDATORS: Record<string, (args: string[], flags: Record<string, string | boolean>) => void> = {
  submit: (args, flags) => {
    if (args[0] && args[0].length > 10_000) {
      throw new ValidationError(`Description exceeds maximum length of 10,000 characters (received ${args[0].length}).`);
    }
    if (flags.priority && !['high', 'normal', 'low'].includes(flags.priority as string)) {
      throw new ValidationError(`Invalid priority: ${flags.priority}. Must be high, normal, or low.`);
    }
    if (flags.repo && !/^[\w.-]+\/[\w.-]+$/.test(flags.repo as string)) {
      throw new ValidationError(`Invalid repo format: ${flags.repo}. Expected owner/name format.`);
    }
    if (flags.deadline) {
      const d = new Date(flags.deadline as string);
      if (isNaN(d.getTime())) {
        throw new ValidationError(`Invalid deadline format: ${flags.deadline}. Expected ISO-8601 date.`);
      }
      if (d.getTime() <= Date.now()) {
        throw new ValidationError(`Deadline must be in the future.`);
      }
    }
  },
  status: (args) => validateRequestId(args[0]),
  cancel: (args) => validateRequestId(args[0]),
  pause:  (args) => validateRequestId(args[0]),
  resume: (args) => validateRequestId(args[0]),
  priority: (args) => {
    validateRequestId(args[0]);
    if (!['high', 'normal', 'low'].includes(args[1])) {
      throw new ValidationError(`Invalid priority: ${args[1]}. Must be high, normal, or low.`);
    }
  },
  logs: (args) => validateRequestId(args[0]),
  feedback: (args) => {
    validateRequestId(args[0]);
    if (!args[1] || args[1].length === 0) {
      throw new ValidationError('Feedback message is required.');
    }
  },
  list: () => {},  // No validation needed
  kill: () => {},  // No validation needed
};

function validateRequestId(id: string | undefined): void {
  if (!id) {
    throw new ValidationError('Request ID is required.');
  }
  if (!/^REQ-\d{6}$/.test(id)) {
    throw new ValidationError(`Invalid request ID format: ${id}. Expected REQ-NNNNNN (e.g., REQ-000042).`);
  }
}
```

## Acceptance Criteria

1. `parseCommandArgs` correctly splits `"Build a user auth system" --priority high` into `args: ["Build a user auth system"]`, `flags: { priority: "high" }`.
2. Boolean flags (e.g., `--force`) are parsed as `true`.
3. Empty input returns `{ args: [], flags: {} }`.
4. Unclosed quotes throw `ValidationError`.
5. First user is auto-provisioned as `admin`.
6. Second user is auto-provisioned as `viewer`.
7. Existing user returns their stored `internal_id`.
8. Request ID validation rejects `REQ-42`, `REQ-0000001`, `TASK-000042`, and empty string.
9. Request ID validation accepts `REQ-000042`.
10. Priority validation rejects `urgent`, `HIGH` (case-sensitive).
11. Repo validation rejects `not-a-repo`, `owner`, `owner/repo/extra`.
12. Repo validation accepts `myorg/my-repo`, `owner/repo.name`.
13. Deadline validation rejects `not-a-date` and past dates.
14. Description length validation rejects 10,001-character input.

## Test Cases

1. **ArgParser: simple args**: `"hello world"` -> `{ args: ["hello", "world"], flags: {} }`.
2. **ArgParser: quoted string**: `'"hello world"'` -> `{ args: ["hello world"], flags: {} }`.
3. **ArgParser: mixed args and flags**: `'"Build auth" --priority high --force'` -> `{ args: ["Build auth"], flags: { priority: "high", force: true } }`.
4. **ArgParser: consecutive boolean flags**: `"--force --all"` -> `{ flags: { force: true, all: true } }`.
5. **ArgParser: empty input**: `""` -> `{ args: [], flags: {} }`.
6. **ArgParser: unclosed quote**: `'"hello world'` -> throws `ValidationError`.
7. **ArgParser: special characters in quotes**: `'"hello & world <test>"'` -> `{ args: ["hello & world <test>"] }`.
8. **ArgParser: flag at end**: `"REQ-000001 --all"` -> `{ args: ["REQ-000001"], flags: { all: true } }`.
9. **ArgParser: empty flag name**: `"--"` -> throws `ValidationError`.
10. **Identity: first user**: Empty DB, resolve -> admin role, stored in DB.
11. **Identity: second user**: One user exists, resolve as different OS user -> viewer role.
12. **Identity: existing user**: User already in DB, resolve -> returns same internal_id without creating new row.
13. **Validation: valid request ID**: `REQ-000042` -> no error.
14. **Validation: invalid request IDs**: `REQ-42`, `REQ-0000001`, `TASK-000042`, `""`, `undefined` -> each throws `ValidationError`.
15. **Validation: valid priority**: `high`, `normal`, `low` -> no error.
16. **Validation: invalid priority**: `urgent`, `HIGH`, `""` -> throws `ValidationError`.
17. **Validation: valid repo**: `myorg/my-repo` -> no error.
18. **Validation: invalid repo**: `not-a-repo`, `owner/repo/extra` -> throws `ValidationError`.
19. **Validation: future deadline**: ISO-8601 date tomorrow -> no error.
20. **Validation: past deadline**: ISO-8601 date yesterday -> throws `ValidationError`.
21. **Validation: invalid deadline**: `"not-a-date"` -> throws `ValidationError`.
22. **Validation: description too long**: 10,001 chars -> throws `ValidationError`.
23. **Validation: description at limit**: 10,000 chars -> no error.
