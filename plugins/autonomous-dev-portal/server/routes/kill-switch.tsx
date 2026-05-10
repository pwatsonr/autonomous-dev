// SPEC-035-3-02 / -03 / -04 — KillSwitch state-machine route handlers.
//
// Three endpoints:
//
//   GET  /ops/kill-switch-modal?step=arm   → armed fragment (server-minted armed_at)
//   GET  /ops/kill-switch-modal            → idle fragment (defensive default)
//   GET  /ops/kill-switch?step=arm         → armed fragment (idle button hx-get)
//   POST /ops/kill-switch                  → confirm + engage (typed-CONFIRM gate)
//   POST /ops/kill-switch/reset            → disengage (idempotent)
//
// SAFETY-CRITICAL contract (per TDD-035 §6.5.7 v1.1):
//
//   1. CSRF is enforced UPSTREAM by `csrfMiddleware` from
//      server/security/csrf-protection.ts. POST routes registered AFTER
//      that middleware never see a request without a validated token. The
//      handler MUST NOT bypass, weaken, or wrap the existing middleware.
//
//   2. Engage POST runs an ordered validation chain — each step gates the
//      next; daemon halt is invoked ONLY if all four prior validations
//      pass:
//        (a) typed CONFIRM exact case-sensitive match
//        (b) armed_at present and parseable
//        (c) armed_at within 30s window
//        (d) armed_at not >5s in the future (clock-skew defense)
//
//   3. On daemon-halt failure (CLI throw, timeout, non-zero exit) the
//      handler:
//        - logs structured ERROR `kill_switch_engage_failed`
//        - returns 500 + ks-error fragment + Retry button
//        - does NOT render the engaged state
//        - the kill switch state stays "armed" so the operator can retry
//
//   4. Reset is idempotent; CSRF-required; same failure-handling discipline
//      as engage (structured `kill_switch_reset_failed` log, ks-error
//      fragment, retry button posts to /reset).
//
//   5. Every response carries `Cache-Control: no-store` so time-sensitive
//      armed_at fragments never get cached by browsers or intermediaries.

import { Hono } from "hono";

import { KillSwitch } from "../components/kill-switch";
import { operationsHandlers } from "../lib/daemon-halt";

/**
 * Minimal logger surface — matches the shape used by csrf-protection.ts so
 * the route can accept either the structured-logger sink or a test-time
 * capture. `noopLogger()` is the default; production wiring should inject
 * the project's structured logger.
 */
export interface KillSwitchLogger {
    error(event: string, fields?: Record<string, unknown>): void;
}

function noopLogger(): KillSwitchLogger {
    return { error: (): void => undefined };
}

/** Production default: emit a JSON line to stdout for ERROR events. */
export function defaultKillSwitchLogger(): KillSwitchLogger {
    return {
        error(event: string, fields?: Record<string, unknown>): void {
            process.stdout.write(
                JSON.stringify({
                    ts: new Date().toISOString(),
                    level: "error",
                    event,
                    ...(fields ?? {}),
                }) + "\n",
            );
        },
    };
}

/** SPEC-035-3-03 §FR-9: ks-error fragment for daemon-engage failure. */
function killSwitchEngageErrorFragment(): JSX.Element {
    return (
        <div class="ks-panel armed ks-error">
            <div class="ks-status">
                <h4>
                    Kill switch <span class="chip err">ERROR</span>
                </h4>
                <div class="meta">
                    Daemon halt command failed. Kill switch was NOT engaged.
                    Check daemon logs and retry.
                </div>
            </div>
            <div class="ks-action">
                <button
                    class="btn destructive"
                    type="button"
                    hx-get="/ops/kill-switch-modal?step=arm"
                    hx-target="closest .ks-panel"
                    hx-swap="outerHTML"
                >
                    Retry
                </button>
            </div>
        </div>
    );
}

/** SPEC-035-3-04 §FR-6 / FR-7: ks-error fragment for daemon-reset failure. */
function killSwitchResetErrorFragment(csrfToken: string): JSX.Element {
    return (
        <div class="ks-panel ks-error">
            <div class="ks-status">
                <h4>
                    Kill switch <span class="chip err">RESET FAILED</span>
                </h4>
                <div class="meta">
                    Kill switch reset failed. Check daemon logs.
                </div>
            </div>
            <div class="ks-action">
                <form method="POST" action="/ops/kill-switch/reset">
                    <input type="hidden" name="_csrf" value={csrfToken} />
                    <button class="btn destructive" type="submit">
                        Retry reset
                    </button>
                </form>
            </div>
        </div>
    );
}

/** SPEC-035-3-03 §FR-5: armed_at-missing error fragment. */
function armedAtMissingFragment(): JSX.Element {
    return (
        <div class="ks-panel ks-error">
            <div class="ks-status">
                <h4>
                    Kill switch <span class="chip err">ERROR</span>
                </h4>
                <div class="meta">
                    Arming timestamp missing. Please try again.
                </div>
            </div>
            <div class="ks-action">
                <button
                    class="btn destructive"
                    type="button"
                    hx-get="/ops/kill-switch-modal?step=arm"
                    hx-target="closest .ks-panel"
                    hx-swap="outerHTML"
                >
                    Retry
                </button>
            </div>
        </div>
    );
}

/** SPEC-035-3-02 §FR-10: failure-path 500 fragment with no armed_at. */
function armRouteFailureFragment(): JSX.Element {
    return (
        <div class="ks-panel ks-error">
            <div class="ks-status">
                <h4>
                    Kill switch <span class="chip err">ERROR</span>
                </h4>
                <div class="meta">
                    Failed to arm kill switch. Please refresh and try again.
                </div>
            </div>
        </div>
    );
}

export interface KillSwitchRoutesDeps {
    /** Optional structured-logger sink. Defaults to a noop logger. */
    logger?: KillSwitchLogger;
}

/** Maximum age (ms) of a server-minted armed_at; SPEC-035-3-03 §FR-6. */
const ARMED_WINDOW_MS = 30_000;
/** Allowed forward clock skew (ms); SPEC-035-3-03 §FR-7. */
const ARMED_FUTURE_SKEW_MS = 5_000;

/**
 * Build the kill-switch sub-router. Returns a Hono instance the caller
 * mounts on the parent app via `app.route("/", buildKillSwitchRoutes(...))`.
 * Mount point is "/" (not "/ops") so the existing /ops route is preserved
 * untouched.
 */
export function buildKillSwitchRoutes(
    deps: KillSwitchRoutesDeps = {},
): Hono {
    const log = deps.logger ?? noopLogger();
    const router = new Hono();

    // -----------------------------------------------------------------
    // GET /ops/kill-switch-modal — SPEC-035-3-02
    // GET /ops/kill-switch       — same handler, supports the idle-button
    //                              hx-get path per SPEC-035-3-01 AC-1.
    // -----------------------------------------------------------------
    const armHandler = async (c: import("hono").Context): Promise<Response> => {
        try {
            const step = c.req.query("step");
            const csrfToken = (c.get("csrfToken") as string | undefined) ?? "";
            c.header("Cache-Control", "no-store");

            if (step !== "arm") {
                // FR-2: defensive default — never fail open into armed.
                return c.html(
                    <KillSwitch
                        engaged={false}
                        onConfirm="/ops/kill-switch"
                        csrfToken={csrfToken}
                    />,
                );
            }

            // FR-3: armed_at is server-minted; the request CANNOT supply
            // its own. Any ?armed_at= query param is silently ignored.
            const armedAt = new Date().toISOString();
            return c.html(
                <KillSwitch
                    engaged={false}
                    armed={true}
                    armedAt={armedAt}
                    csrfToken={csrfToken}
                    onConfirm="/ops/kill-switch"
                />,
            );
        } catch (err) {
            // FR-10: any internal exception → 500 + error fragment with
            // NO armed_at. Operator must restart the flow.
            log.error("kill_switch_arm_failed", {
                error: err instanceof Error ? err.message : String(err),
            });
            c.header("Cache-Control", "no-store");
            return c.html(armRouteFailureFragment(), 500);
        }
    };
    router.get("/ops/kill-switch-modal", armHandler);
    router.get("/ops/kill-switch", armHandler);

    // -----------------------------------------------------------------
    // POST /ops/kill-switch — SPEC-035-3-03 (confirm + engage)
    //
    // Validation order is contractual; do not reorder:
    //   1. typed CONFIRM exact match  → 422 + armed fragment (retry path)
    //   2. armed_at present            → 422 + "missing timestamp" fragment
    //   3. armed_at parseable + window → 422 + idle fragment (re-arm)
    //   4. clock-skew safety           → 422 + idle fragment
    //   5. daemon halt                 → 500 + ks-error  OR  200 + engaged
    // -----------------------------------------------------------------
    router.post("/ops/kill-switch", async (c) => {
        c.header("Cache-Control", "no-store");
        const csrfToken = (c.get("csrfToken") as string | undefined) ?? "";

        // Body parse: best-effort. Treat parse failures as missing fields.
        let body: Record<string, unknown> = {};
        try {
            body = (await c.req.parseBody()) as Record<string, unknown>;
        } catch {
            // fall through; downstream typeof checks fail closed.
        }

        const confirmation = body["confirmation"];
        const armedAt = body["armed_at"];

        // (1) Typed CONFIRM — strict equality, case-sensitive.
        // FR-4: re-render the armed fragment so the operator can retry
        // within the original 30s window. Echo armed_at back unchanged.
        if (typeof confirmation !== "string" || confirmation !== "CONFIRM") {
            return c.html(
                <KillSwitch
                    engaged={false}
                    armed={true}
                    armedAt={typeof armedAt === "string" ? armedAt : ""}
                    csrfToken={csrfToken}
                    onConfirm="/ops/kill-switch"
                />,
                422,
            );
        }

        // (2) armed_at present — FR-5.
        if (typeof armedAt !== "string" || armedAt.length === 0) {
            return c.html(armedAtMissingFragment(), 422);
        }

        // (3) armed_at parseable + within 30s window — FR-6.
        // (4) clock-skew safety — FR-7. Both checks emit the idle
        // fragment so the operator must re-arm from scratch.
        const armedTime = new Date(armedAt).getTime();
        const skew = Date.now() - armedTime;
        if (
            Number.isNaN(armedTime) ||
            skew > ARMED_WINDOW_MS ||
            skew < -ARMED_FUTURE_SKEW_MS
        ) {
            return c.html(
                <KillSwitch
                    engaged={false}
                    onConfirm="/ops/kill-switch"
                    csrfToken={csrfToken}
                />,
                422,
            );
        }

        // (5) Daemon halt — FR-8 / FR-9. Reason string is HARD-CODED;
        // never sourced from the request body. On throw: log structured
        // ERROR + 500 + ks-error fragment; state stays armed.
        try {
            await operationsHandlers.engageKillSwitch({
                reason: "portal-operator-manual",
            });
        } catch (err) {
            log.error("kill_switch_engage_failed", {
                error: err instanceof Error ? err.message : String(err),
                armed_at: armedAt,
            });
            return c.html(killSwitchEngageErrorFragment(), 500);
        }

        // FR-10: success path — engaged fragment with fresh CSRF token
        // for the subsequent reset POST.
        return c.html(
            <KillSwitch
                engaged={true}
                onConfirm="/ops/kill-switch"
                csrfToken={csrfToken}
            />,
        );
    });

    // -----------------------------------------------------------------
    // POST /ops/kill-switch/reset — SPEC-035-3-04 (disengage)
    //
    // Idempotent. CSRF-required (upstream middleware). No typed CONFIRM —
    // reset is the safer direction; the gate is reserved for engage.
    // On daemon throw: log + 500 + ks-error fragment with retry POST.
    // -----------------------------------------------------------------
    router.post("/ops/kill-switch/reset", async (c) => {
        c.header("Cache-Control", "no-store");
        const csrfToken = (c.get("csrfToken") as string | undefined) ?? "";

        try {
            await operationsHandlers.resetKillSwitch();
        } catch (err) {
            log.error("kill_switch_reset_failed", {
                error: err instanceof Error ? err.message : String(err),
            });
            return c.html(killSwitchResetErrorFragment(csrfToken), 500);
        }

        // FR-5: success → idle fragment + fresh CSRF token. No info-level
        // log line — success volume is reserved for the daemon-side audit.
        return c.html(
            <KillSwitch
                engaged={false}
                onConfirm="/ops/kill-switch"
                csrfToken={csrfToken}
            />,
        );
    });

    return router;
}
