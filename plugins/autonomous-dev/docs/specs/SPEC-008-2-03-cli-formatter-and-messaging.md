# SPEC-008-2-03: CLI Formatter, sendMessage & promptUser

## Metadata
- **Parent Plan**: PLAN-008-2
- **Tasks Covered**: Task 5, Task 6, Task 7
- **Estimated effort**: 8 hours

## Description

Implement the CLI notification formatter that renders status information using ANSI escape codes with box-drawing characters, color-coded phases, and progress bars. Also implement `ClaudeAdapter.sendMessage` for terminal output and `ClaudeAdapter.promptUser` for interactive terminal prompts with timeout.

## Files to Create/Modify

| File | Action |
|------|--------|
| `intake/notifications/formatters/cli_formatter.ts` | Create |
| `intake/adapters/claude_adapter.ts` | Modify (add sendMessage, promptUser) |

## Implementation Details

### Task 5: CLI Notification Formatter

**ANSI color codes used:**

```typescript
const ANSI = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  green:   '\x1b[32m',
  blue:    '\x1b[34m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  gray:    '\x1b[90m',
};
```

**Phase color mapping:**

| Phase | Color | ANSI Code |
|-------|-------|-----------|
| `queued` | gray | `\x1b[90m` |
| `prd_generation`, `tdd_generation` | blue | `\x1b[34m` |
| `prd_review`, `tdd_review`, `code_review` | yellow (orange approximation) | `\x1b[33m` |
| `planning`, `spec` | magenta | `\x1b[35m` |
| `execution`, `done`, `merged` | green | `\x1b[32m` |
| `paused` | yellow | `\x1b[33m` |
| `cancelled`, `failed` | red | `\x1b[31m` |

**Box-drawing status card format:**

```
\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510
\u2502  REQ-000042  Build user auth with OAuth2    \u2502
\u251c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524
\u2502  Phase:    TDD Generation (3/8)             \u2502
\u2502  Progress: \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591 50%             \u2502
\u2502  Priority: high                             \u2502
\u2502  Age:      2h 14m                           \u2502
\u2502  Blocker:  None                             \u2502
\u2502  Artifacts:                                 \u2502
\u2502    PRD PR: https://github.com/.../pull/87   \u2502
\u2502    TDD PR: (in progress)                    \u2502
\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518
```

**Box-drawing characters:** `\u250c` (top-left), `\u2510` (top-right), `\u2514` (bottom-left), `\u2518` (bottom-right), `\u2500` (horizontal), `\u2502` (vertical), `\u251c` (left-T), `\u2524` (right-T).

**Progress bar rendering:**

```typescript
function renderProgressBar(current: number, total: number, width: number = 16): string {
  const fraction = total > 0 ? current / total : 0;
  const filled = Math.round(fraction * width);
  const empty = width - filled;
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
  const pct = Math.round(fraction * 100);
  return `${bar} ${pct}%`;
}
```

**Duration formatting:**

```typescript
function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${remainMinutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
```

**`CLIFormatter` implements `NotificationFormatter` interface:**

```typescript
interface NotificationFormatter {
  formatStatusCard(request: RequestEntity): FormattedMessage;
  formatPhaseTransition(request: RequestEntity, event: PhaseTransitionEvent): FormattedMessage;
  formatDigest(digest: DigestData): FormattedMessage;
  formatError(error: ErrorResponse): FormattedMessage;
}
```

Each method returns a `FormattedMessage` with:
- `channelType: 'claude_app'`
- `payload`: ANSI-encoded string
- `fallbackText`: plain text without any ANSI escape codes

### Task 6: ClaudeAdapter.sendMessage

```typescript
async sendMessage(target: MessageTarget, payload: FormattedMessage): Promise<DeliveryReceipt> {
  try {
    const output = process.stdout.isTTY
      ? payload.payload as string
      : payload.fallbackText;
    process.stdout.write(output + '\n');
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message, retryable: false };
  }
}
```

- If `process.stdout.isTTY` is true, writes ANSI-formatted payload.
- If false (piped, CI, redirected), writes `fallbackText`.
- Always appends a newline.
- Returns `DeliveryReceipt` with `success: true` on success.

### Task 7: ClaudeAdapter.promptUser

```typescript
async promptUser(
  target: MessageTarget,
  prompt: StructuredPrompt
): Promise<UserResponse | TimeoutExpired> {
  // Render prompt content
  process.stdout.write(`\n${prompt.content}\n`);
  
  // Render options as numbered list
  if (prompt.options && prompt.options.length > 0) {
    prompt.options.forEach((opt, i) => {
      process.stdout.write(`  ${i + 1}. ${opt.label}\n`);
    });
    process.stdout.write('\nEnter selection (number or text): ');
  } else {
    process.stdout.write('\nYour response: ');
  }

  // Wait for stdin with timeout
  const response = await readLineWithTimeout(prompt.timeoutSeconds * 1000);
  
  if (response === null) {
    return {
      kind: 'timeout',
      requestId: prompt.requestId,
      promptedAt: new Date(),
      expiredAt: new Date(),
    };
  }

  // Resolve option selection
  let selectedOption: string | undefined;
  if (prompt.options) {
    const num = parseInt(response, 10);
    if (!isNaN(num) && num >= 1 && num <= prompt.options.length) {
      selectedOption = prompt.options[num - 1].value;
    }
  }

  return {
    responderId: target.userId ?? 'unknown',
    content: response,
    selectedOption,
    timestamp: new Date(),
  };
}
```

**`readLineWithTimeout` implementation:**
- Creates a `readline.Interface` on `process.stdin`.
- Uses `Promise.race` between the readline promise and a `setTimeout` promise.
- If stdin is not a TTY (non-interactive mode), immediately returns `null` (timeout) with a logged warning.
- Cleans up the readline interface in all cases.

## Acceptance Criteria

1. `formatStatusCard` produces output containing box-drawing characters (`\u250c`, `\u2500`, `\u2502`, `\u2518`).
2. Phase colors applied: `execution` phase renders with green ANSI code.
3. Progress bar renders filled blocks (`\u2588`) and empty blocks (`\u2591`) proportional to progress.
4. `fallbackText` contains NO ANSI escape codes (no `\x1b[` sequences).
5. `formatDuration` renders "2h 14m" for 8,040,000ms, "0m" for 0ms, "1d 3h" for 97,200,000ms.
6. `sendMessage` writes ANSI output when `isTTY` is true, fallback text when false.
7. `sendMessage` returns `{ success: true }` on successful write.
8. `promptUser` displays numbered options when `prompt.options` is provided.
9. `promptUser` returns `UserResponse` with `selectedOption` when user enters a valid number.
10. `promptUser` returns `TimeoutExpired` when the timeout elapses.
11. `promptUser` returns `TimeoutExpired` immediately in non-interactive mode.

## Test Cases

1. **Formatter: box characters present**: `formatStatusCard` output contains `\u250c` and `\u2518`.
2. **Formatter: phase color green**: Request in `execution` phase; output contains `\x1b[32m`.
3. **Formatter: phase color red**: Request in `failed` phase; output contains `\x1b[31m`.
4. **Formatter: progress bar 0%**: `renderProgressBar(0, 10)` starts with 16 empty blocks.
5. **Formatter: progress bar 50%**: `renderProgressBar(5, 10)` has 8 filled and 8 empty blocks.
6. **Formatter: progress bar 100%**: `renderProgressBar(10, 10)` has 16 filled blocks.
7. **Formatter: fallback no ANSI**: `formatStatusCard(...).fallbackText` does not match `/\x1b\[/`.
8. **Formatter: duration formatting**: `formatDuration(0)` = "0m", `formatDuration(90_000)` = "1m", `formatDuration(8_040_000)` = "2h 14m", `formatDuration(97_200_000)` = "1d 3h".
9. **sendMessage: TTY mode**: Mock `isTTY = true`; verify `payload` (not fallbackText) written to stdout.
10. **sendMessage: non-TTY mode**: Mock `isTTY = false`; verify `fallbackText` written to stdout.
11. **promptUser: option selection**: Mock stdin to send "2"; verify `selectedOption` is the value of option 2.
12. **promptUser: free text response**: Mock stdin to send "some text"; verify `content = "some text"`.
13. **promptUser: timeout**: Mock stdin to never respond; verify `TimeoutExpired` returned after timeout.
14. **promptUser: non-interactive**: Mock `stdin.isTTY = false`; verify immediate `TimeoutExpired`.
15. **Formatter: digest**: `formatDigest` with 3 active, 1 blocked, 2 completed; verify output contains counts.
16. **Formatter: error**: `formatError` with `AUTHZ_DENIED`; verify output contains error code and message.
