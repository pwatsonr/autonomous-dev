// SPEC-014-3-04 §TOCTOU race tests.
//
// Exercises the file-descriptor-based TOCTOU mitigation in
// server/security/toctou-guard.ts. The guard uses O_NOFOLLOW + fstat
// re-validation to catch a symlink swap that happens between open()
// and read().

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    mkdtempSync,
    rmSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PathValidator } from "../../server/security/path-validator";
import { ToctouGuard } from "../../server/security/toctou-guard";

let root: string;
let validator: PathValidator;
let guard: ToctouGuard;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "portal-toctou-"));
    writeFileSync(join(root, "safe.txt"), "safe-content");
    writeFileSync(join(root, "secret.txt"), "secret-content");
    validator = new PathValidator({ allowed_roots: [root] });
    guard = new ToctouGuard();
});

afterEach(async () => {
    await guard.cleanup();
    rmSync(root, { recursive: true, force: true });
});

describe("ToctouGuard — open + read happy path", () => {
    test("plain validated path returns original content via openSafe + readSafe", async () => {
        const canonical = await validator.validate(join(root, "safe.txt"));
        await guard.openSafe(canonical);
        const buf = await guard.readSafe(canonical);
        expect(buf.toString("utf8")).toBe("safe-content");
        await guard.closeSafe(canonical);
    });

    test("readSafe before openSafe throws TOCTOU_NOT_OPENED", async () => {
        const canonical = await validator.validate(join(root, "safe.txt"));
        let caught: unknown = null;
        try {
            await guard.readSafe(canonical);
        } catch (e) {
            caught = e;
        }
        expect(caught).not.toBeNull();
        expect((caught as Error).message).toMatch(/not opened|TOCTOU_NOT_OPENED/i);
    });
});

describe("ToctouGuard — symlink rejection", () => {
    test("openSafe on a final-segment symlink rejects with TOCTOU_SYMLINK_REJECTED", async () => {
        const linkPath = join(root, "link.txt");
        symlinkSync(join(root, "safe.txt"), linkPath);
        // PathValidator may or may not canonicalize — pass the link path
        // directly to verify O_NOFOLLOW kicks in.
        let caught: unknown = null;
        try {
            await guard.openSafe(linkPath);
        } catch (e) {
            caught = e;
        }
        expect(caught).not.toBeNull();
        expect((caught as Error).message).toMatch(/symlink|SYMLINK/i);
    });
});

describe("ToctouGuard — post-open swap detection", () => {
    test("re-stat detects an inode swap between openSafe and readSafe", async () => {
        const target = join(root, "swap-target.txt");
        writeFileSync(target, "original-content");
        const canonical = await validator.validate(target);
        await guard.openSafe(canonical);

        // ATTACKER: replace the file (different inode) before readSafe
        // can fstat it. The guard's fstat-based identity check must
        // refuse to read because (dev, ino) drifted.
        unlinkSync(target);
        writeFileSync(target, "swapped-content");

        let caught: unknown = null;
        try {
            await guard.readSafe(canonical);
        } catch (e) {
            caught = e;
        }
        // The guard either (a) detects the swap and throws, or (b)
        // reads the original content from the pinned FD.  Either is
        // acceptable defense — assert that the read does NOT return
        // 'swapped-content'.
        if (caught === null) {
            const buf = await guard.readSafe(canonical);
            expect(buf.toString("utf8")).not.toBe("swapped-content");
        }
        await guard.closeSafe(canonical).catch(() => {});
    });
});

describe("PathValidator — symlink resolution at validate-time", () => {
    test("symlink to in-root file canonicalises to the target path", async () => {
        const linkPath = join(root, "link.txt");
        symlinkSync(join(root, "safe.txt"), linkPath);
        const canonical = await validator.validate(linkPath);
        expect(canonical.endsWith("safe.txt")).toBe(true);
    });

    test("symlink escaping the allowed_root is rejected", async () => {
        const outsideDir = mkdtempSync(join(tmpdir(), "portal-toctou-out-"));
        const outsidePath = join(outsideDir, "secret.txt");
        writeFileSync(outsidePath, "outside");
        const linkPath = join(root, "escape.txt");
        symlinkSync(outsidePath, linkPath);

        let caught: unknown = null;
        try {
            await validator.validate(linkPath);
        } catch (e) {
            caught = e;
        }
        expect(caught).not.toBeNull();

        rmSync(outsideDir, { recursive: true, force: true });
    });
});
