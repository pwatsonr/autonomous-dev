// SPEC-014-2-02 §Confirmation Phrase Allowlist — single source of truth.
//
// Adding a new destructive action REQUIRES adding an entry here. The
// confirmation service rejects requests for actions not in this map with
// the documented `unknown-action` error.
//
// Phrases are deliberately ALL CAPS short imperatives — typing them
// requires intent and breaks both click-through accidents and CSRF
// scripted submission. See SPEC-014-2-02 §Notes for the design rationale
// (the phrase is forced friction, not a secret).

export const CONFIRMATION_PHRASES: Readonly<Record<string, string>> =
    Object.freeze({
        "kill-switch": "EMERGENCY STOP",
        "circuit-breaker-reset": "RESET BREAKER",
        "allowlist-remove": "REMOVE ACCESS",
        "trust-level-reduce": "REDUCE TRUST",
        "delete-pipeline": "DELETE FOREVER",
        "reset-config": "RESET CONFIG",
    });

/**
 * Resolve the confirmation phrase for an action. Returns null when the
 * action is not in the allowlist — callers must reject with
 * `unknown-action`.
 */
export function getConfirmationPhrase(action: string): string | null {
    return CONFIRMATION_PHRASES[action] ?? null;
}

/** True when an action is registered in the allowlist. */
export function isConfirmableAction(action: string): boolean {
    return Object.prototype.hasOwnProperty.call(CONFIRMATION_PHRASES, action);
}
