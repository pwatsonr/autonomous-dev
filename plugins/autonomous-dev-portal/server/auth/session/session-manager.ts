// SPEC-014-1-04 §Task 4.5 — Session lifecycle manager.
//
// Public API:
//   create(profile)        — mint a new 256-bit session_id and persist it
//   validate(session_id)   — return the session iff still inside both the
//                            idle (24h) and absolute (30d) timeouts
//   regenerate(old_id)     — issue a new session_id, copy the profile,
//                            delete the old record. Called immediately
//                            after a successful OAuth callback to defeat
//                            session-fixation (OWASP A1).
//   destroy(session_id)    — drop the record (logout)
//
// The store implementation is injected (see SessionStore). The default
// production wiring uses FileSessionStore (file-session-store.ts);
// in-memory tests use the lightweight MemorySessionStore exported here.

import { randomBytes } from "node:crypto";

import { SecurityError } from "../types";
import { base64UrlEncode } from "../oauth/pkce-utils";

/** 24-hour idle timeout (re-issued on every successful validate). */
export const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
/** 30-day absolute timeout from session creation. */
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;

/** Provider literal stored on the session record. */
export type SessionProvider = "github" | "google";

/** Profile fields supplied by the OAuth callback, before session minting. */
export interface SessionProfile {
    user_id: string;
    email: string;
    display_name: string;
    provider: SessionProvider;
}

export interface Session extends SessionProfile {
    session_id: string;
    created_at: number;
    last_activity: number;
}

/**
 * Storage backend contract. Implementations MUST treat the session_id as
 * an opaque, validated identifier — they MUST NOT interpret it as a path.
 * The FileSessionStore re-validates the format before constructing any
 * filesystem path.
 */
export interface SessionStore {
    get(session_id: string): Promise<Session | null>;
    put(session: Session): Promise<void>;
    delete(session_id: string): Promise<void>;
}

export interface SessionManagerOptions {
    /** Test seam — deterministic clock. */
    now?: () => number;
    /** Override the idle timeout. Tests use a short value. */
    idleMs?: number;
    /** Override the absolute timeout. Tests use a short value. */
    absoluteMs?: number;
}

/**
 * Mint a 256-bit session_id encoded as 43 chars of URL-safe base64. Same
 * encoding/length as the PKCE state value, which is intentional: a single
 * `^[A-Za-z0-9_-]{43}$` regex covers both layers.
 */
export function generateSessionId(): string {
    return base64UrlEncode(randomBytes(32));
}

export class SessionManager {
    private readonly store: SessionStore;
    private readonly now: () => number;
    private readonly idleMs: number;
    private readonly absoluteMs: number;

    constructor(store: SessionStore, opts: SessionManagerOptions = {}) {
        this.store = store;
        this.now = opts.now ?? (() => Date.now());
        this.idleMs = opts.idleMs ?? SESSION_IDLE_MS;
        this.absoluteMs = opts.absoluteMs ?? SESSION_ABSOLUTE_MS;
    }

    async create(profile: SessionProfile): Promise<Session> {
        const session_id = generateSessionId();
        const now = this.now();
        const session: Session = {
            session_id,
            user_id: profile.user_id,
            email: profile.email,
            display_name: profile.display_name,
            provider: profile.provider,
            created_at: now,
            last_activity: now,
        };
        await this.store.put(session);
        return session;
    }

    /**
     * Look up the session. Returns null and deletes the record when either
     * timeout has elapsed; otherwise touches `last_activity` and writes
     * the session back so the idle window slides.
     */
    async validate(session_id: string): Promise<Session | null> {
        const s = await this.store.get(session_id);
        if (s === null) return null;
        const now = this.now();
        if (now - s.created_at > this.absoluteMs) {
            await this.store.delete(session_id);
            return null;
        }
        if (now - s.last_activity > this.idleMs) {
            await this.store.delete(session_id);
            return null;
        }
        s.last_activity = now;
        await this.store.put(s);
        return s;
    }

    /**
     * SPEC-014-1-04 §Task 4.5 — defeats session fixation. Called once,
     * immediately after the OAuth callback succeeds. The OLD record is
     * deleted (not orphaned) so a parallel-session race cannot reuse it.
     */
    async regenerate(old_id: string): Promise<Session> {
        const old = await this.store.get(old_id);
        if (old === null) {
            throw new SecurityError(
                "SESSION_NOT_FOUND",
                "Cannot regenerate: session not found",
            );
        }
        const new_id = generateSessionId();
        const now = this.now();
        const updated: Session = {
            ...old,
            session_id: new_id,
            created_at: now,
            last_activity: now,
        };
        await this.store.put(updated);
        await this.store.delete(old_id);
        return updated;
    }

    async destroy(session_id: string): Promise<void> {
        await this.store.delete(session_id);
    }
}

/**
 * Lightweight in-memory store. Suitable for tests and for the no-OAuth
 * unit-test path; production OAuth deployments use FileSessionStore so
 * sessions survive a daemon restart.
 */
export class MemorySessionStore implements SessionStore {
    private readonly map = new Map<string, Session>();

    async get(session_id: string): Promise<Session | null> {
        const s = this.map.get(session_id);
        return s === undefined ? null : { ...s };
    }

    async put(session: Session): Promise<void> {
        this.map.set(session.session_id, { ...session });
    }

    async delete(session_id: string): Promise<void> {
        this.map.delete(session_id);
    }

    /** Test helper. */
    size(): number {
        return this.map.size;
    }
}
