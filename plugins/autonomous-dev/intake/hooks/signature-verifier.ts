/**
 * SignatureVerifier — Ed25519 / RSA-PSS detached signature check
 * (SPEC-019-3-03, Task 6).
 *
 * Reads the manifest bytes and the detached signature, then walks every
 * `*.pub` PEM in `trustedKeysDir` and returns true on the first match.
 * Failure is silent (returns false) so the verifier is safe to call from
 * the trust pipeline without try/catch noise: the audit emitter records
 * the rejection at the call site.
 *
 * Implementation notes (per spec):
 *   - Ed25519 keys: `crypto.verify(null, data, key, signature)` — passing a
 *     digest string (e.g. `'sha256'`) throws ERR_CRYPTO_INVALID_DIGEST.
 *   - RSA-PSS / RSA: `crypto.verify('sha256', ...)` covers both algorithms.
 *   - Permission gate: refuses to enumerate keys if the dir has any
 *     world/group write bit set (mode & 0o022). This is the read-side
 *     fail-quiet counterpart to the daemon's startup fail-loud check.
 *
 * No third-party crypto libraries — Node built-ins only.
 *
 * @module intake/hooks/signature-verifier
 */

import { createPublicKey, verify } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export class SignatureVerifier {
  /**
   * @param trustedKeysDir absolute path to the trusted-keys directory
   *   (`~/.claude/trusted-keys/` by default).
   */
  constructor(private readonly trustedKeysDir: string) {}

  /**
   * Verify the detached signature for a manifest.
   *
   * @returns true iff the signature was produced by a key whose `.pub`
   *   file is in `trustedKeysDir`. Returns false on any error
   *   (missing manifest, missing sig, unsafe perms, no trusted keys,
   *   wrong key, corrupted bytes).
   */
  async verify(manifestPath: string, signaturePath: string): Promise<boolean> {
    let manifestBytes: Buffer;
    let sigBytes: Buffer;
    try {
      [manifestBytes, sigBytes] = await Promise.all([
        fs.readFile(manifestPath),
        fs.readFile(signaturePath),
      ]);
    } catch {
      return false;
    }

    const keyFiles = await this.listTrustedKeys();
    if (keyFiles.length === 0) return false;

    for (const keyPath of keyFiles) {
      try {
        const pem = await fs.readFile(keyPath);
        const publicKey = createPublicKey({ key: pem, format: 'pem' });
        const algo =
          publicKey.asymmetricKeyType === 'ed25519' ? null : 'sha256';
        if (verify(algo, manifestBytes, publicKey, sigBytes)) return true;
      } catch {
        // Bad key file or wrong algo for this signature — try next.
        continue;
      }
    }
    return false;
  }

  /**
   * List `*.pub` files in the trusted-keys dir. Returns `[]` if the dir
   * does not exist or its permissions are unsafe.
   */
  private async listTrustedKeys(): Promise<string[]> {
    try {
      await this.assertSafePerms();
      const entries = await fs.readdir(this.trustedKeysDir);
      return entries
        .filter((e) => e.endsWith('.pub'))
        .map((e) => join(this.trustedKeysDir, e));
    } catch {
      return [];
    }
  }

  /**
   * Throws if the directory is world- or group-writable. The startup
   * check in SPEC-019-3-04 prevents the daemon from starting in this
   * state; this defensive re-check guards against runtime mutation.
   */
  private async assertSafePerms(): Promise<void> {
    const stat = await fs.stat(this.trustedKeysDir);
    if ((stat.mode & 0o022) !== 0) {
      throw new Error(
        `trusted-keys directory has unsafe permissions: ${this.trustedKeysDir}`,
      );
    }
  }
}
