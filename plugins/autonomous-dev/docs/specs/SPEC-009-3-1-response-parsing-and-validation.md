# SPEC-009-3-1: Response Parsing and Validation

## Metadata
- **Parent Plan**: PLAN-009-3
- **Tasks Covered**: Task 1 (Define response type system), Task 2 (Implement Response Parser), Task 3 (Implement Response Validator)
- **Estimated effort**: 9 hours

## Description

Define the type system for human responses to escalations, implement the parser that converts raw human input into typed response objects, and implement the validator that ensures parsed responses are actionable. The parser handles three input formats (structured option selection, delegation pattern, free-text guidance) and never throws exceptions. The validator enforces state constraints: the escalation must exist, be pending, the selected option must be valid, and the request must not be cancelled.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/escalation/response-types.ts` | Create | Response and action type definitions |
| `src/escalation/response-parser.ts` | Create | Raw input to typed response parser |
| `src/escalation/response-validator.ts` | Create | Response actionability validation |

## Implementation Details

### response-types.ts

```typescript
export type ResponseType = "option" | "freetext" | "delegate";

export interface EscalationResponse {
  escalation_id: string;
  responder: string;              // Who responded (user ID or name)
  timestamp: string;              // ISO 8601
  response_type: ResponseType;
  option_id?: string;             // Present when response_type === "option"
  freetext?: string;              // Present when response_type === "freetext"
  delegate_target?: string;       // Present when response_type === "delegate"
}

export type ResolvedAction =
  | { action: "approve" }
  | { action: "retry_with_changes"; guidance: string }
  | { action: "cancel" }
  | { action: "override_proceed"; justification: string }
  | { action: "delegate"; target: string };

export interface ResponseValidationError {
  code: "ESCALATION_NOT_FOUND"
      | "ESCALATION_ALREADY_RESOLVED"
      | "INVALID_OPTION_ID"
      | "UNKNOWN_DELEGATE_TARGET"
      | "REQUEST_CANCELLED";
  message: string;
  availableOptions?: EscalationOption[];   // Included for INVALID_OPTION_ID
  knownTargets?: string[];                 // Included for UNKNOWN_DELEGATE_TARGET
}

export interface ReEscalationContext {
  originalEscalationId: string;
  previousEscalationIds: string[];         // Full chain
  reEscalationCount: number;
  lastGuidanceApplied: string;
  lastFailureReason: string;
}

export type ParseResult =
  | { success: true; response: EscalationResponse }
  | { success: false; error: ResponseValidationError };

export type ValidationResult =
  | { valid: true; response: EscalationResponse }
  | { valid: false; error: ResponseValidationError };
```

### response-parser.ts

```typescript
export class ResponseParser {
  parse(rawInput: string, escalationId: string, responder: string): ParseResult;
}
```

Parsing rules (evaluated in order):

1. **Option pattern**: Input matches `/^opt-\d+$/i` (e.g., `"opt-2"`, `"OPT-1"`).
   - Result: `{ response_type: "option", option_id: rawInput.toLowerCase() }`
2. **Delegate pattern**: Input matches `/^delegate:(.+)$/i` (e.g., `"delegate:security-lead"`).
   - Result: `{ response_type: "delegate", delegate_target: capturedGroup.trim() }`
3. **Free-text**: Everything else.
   - Result: `{ response_type: "freetext", freetext: rawInput.trim() }`

The parser NEVER throws. Empty input is treated as freetext with `freetext: ""`. The validator will handle the empty-freetext case.

### response-validator.ts

```typescript
export class ResponseValidator {
  constructor(
    private escalationStore: EscalationStore,   // Lookup pending escalations
    private routingConfig: EscalationConfig,     // Known routing targets
    private killSwitch: KillSwitchQuery,         // Check if request is cancelled
  ) {}

  validate(response: EscalationResponse): ValidationResult;
}

// Minimal interface for querying escalation state
export interface EscalationStore {
  getEscalation(escalationId: string): StoredEscalation | null;
}

export interface StoredEscalation {
  escalationId: string;
  requestId: string;
  status: "pending" | "resolved" | "cancelled";
  options: EscalationOption[];
}

// Minimal interface for kill switch queries
export interface KillSwitchQuery {
  isRequestCancelled(requestId: string): boolean;
}
```

Validation checks (in order -- first failure returns error):

1. **Escalation exists**: `escalationStore.getEscalation(response.escalation_id)` must return non-null. Error: `ESCALATION_NOT_FOUND`.
2. **Escalation is pending**: `escalation.status === "pending"`. Error: `ESCALATION_ALREADY_RESOLVED` (for both resolved and cancelled).
3. **Request not cancelled**: `killSwitch.isRequestCancelled(escalation.requestId)` must be false. Error: `REQUEST_CANCELLED`.
4. **If option response**: `response.option_id` must exist in `escalation.options`. Error: `INVALID_OPTION_ID` with `availableOptions` listing the valid options.
5. **If delegate response**: `response.delegate_target` must be a known routing target in config. Error: `UNKNOWN_DELEGATE_TARGET` with `knownTargets` listing valid targets.
6. **If freetext response**: `response.freetext` must be non-empty after trim. Error: `INVALID_OPTION_ID` with message "Empty free-text response not allowed".

## Acceptance Criteria

1. All response types (`EscalationResponse`, `ResolvedAction`, `ResponseValidationError`, `ReEscalationContext`) exported.
2. `ResolvedAction` is a discriminated union with exactly 5 members.
3. Parser recognizes `opt-N` patterns as option responses (case-insensitive).
4. Parser recognizes `delegate:target` patterns as delegate responses.
5. Parser treats all other input as freetext.
6. Parser never throws on any input (including empty string, null-like values).
7. Validator returns `ESCALATION_NOT_FOUND` for unknown escalation IDs.
8. Validator returns `ESCALATION_ALREADY_RESOLVED` for resolved or cancelled escalations.
9. Validator returns `REQUEST_CANCELLED` when the kill switch has cancelled the request.
10. Validator returns `INVALID_OPTION_ID` with available options when option ID not found.
11. Validator returns `UNKNOWN_DELEGATE_TARGET` with known targets when delegate target unknown.
12. Validator rejects empty freetext responses.

## Test Cases

### Parser

1. **Option: "opt-1"** -- Returns `{ response_type: "option", option_id: "opt-1" }`.
2. **Option: "OPT-3" (case insensitive)** -- Returns `{ option_id: "opt-3" }`.
3. **Option: "opt-42"** -- Multi-digit option ID parsed correctly.
4. **Delegate: "delegate:security-lead"** -- Returns `{ response_type: "delegate", delegate_target: "security-lead" }`.
5. **Delegate: "DELEGATE: tech-lead "** -- Case insensitive, target trimmed.
6. **Freetext: "Please retry with a smaller batch size"** -- Returns `{ response_type: "freetext", freetext: "Please retry with a smaller batch size" }`.
7. **Freetext: empty string** -- Returns `{ response_type: "freetext", freetext: "" }`.
8. **Freetext: "opt-abc" (not a valid option pattern)** -- Returns freetext (no digit after `opt-`).
9. **Freetext: "delegate" (no colon)** -- Returns freetext.
10. **Parser never throws** -- Feed null, undefined (cast), random binary; no exception.

### Validator

11. **Unknown escalation** -- `getEscalation` returns null; error `ESCALATION_NOT_FOUND`.
12. **Already resolved escalation** -- `status: "resolved"`; error `ESCALATION_ALREADY_RESOLVED`.
13. **Cancelled escalation** -- `status: "cancelled"`; error `ESCALATION_ALREADY_RESOLVED`.
14. **Request cancelled by kill switch** -- `isRequestCancelled` returns true; error `REQUEST_CANCELLED`.
15. **Invalid option ID** -- Option `"opt-99"` not in escalation's options; error `INVALID_OPTION_ID` includes `availableOptions`.
16. **Valid option ID** -- Option `"opt-1"` exists in escalation's options; validation passes.
17. **Unknown delegate target** -- Target `"unknown-person"` not in config; error `UNKNOWN_DELEGATE_TARGET` includes `knownTargets`.
18. **Valid delegate target** -- Target in config; validation passes.
19. **Empty freetext rejected** -- Freetext with `""` after trim; validation error.
20. **Valid freetext passes** -- Non-empty freetext; validation passes.
