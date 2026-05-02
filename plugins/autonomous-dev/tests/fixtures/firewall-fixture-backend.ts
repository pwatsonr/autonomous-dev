/**
 * Tiny child process used by `test-egress-blocked.test.ts` (SPEC-024-3-04).
 *
 * Reads host names on stdin, attempts a TCP connection to <host>:443, and
 * writes either `OK <host>` (connect) or `ERR <host> <code>` (failure) to
 * stdout. Emits `ready\n` on stderr after receiving a single `go\n` byte —
 * this is the "go-byte gate" from SPEC-024-3-02 that sequences firewall
 * application before the child opens any sockets.
 *
 * The fixture intentionally has no dependencies beyond Node's standard
 * library so it is safe to spawn under restricted UIDs / cgroups.
 */

import * as net from 'node:net';

let started = false;

process.stdin.on('data', (chunk: Buffer) => {
  const text = chunk.toString('utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (!started) {
      if (line === 'go') {
        started = true;
        process.stderr.write('ready\n');
      } else {
        process.stderr.write(`ignored:${line}\n`);
      }
      continue;
    }
    void attempt(line);
  }
});

function attempt(host: string): Promise<void> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port: 443, timeout: 5000 });
    let settled = false;
    const finish = (msg: string): void => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      process.stdout.write(msg + '\n');
      resolve();
    };
    sock.once('connect', () => finish(`OK ${host}`));
    sock.once('error', (err: NodeJS.ErrnoException) =>
      finish(`ERR ${host} ${err.code ?? 'EUNKNOWN'}`),
    );
    sock.once('timeout', () => finish(`ERR ${host} ETIMEDOUT`));
  });
}

// Keep the process alive while waiting for stdin.
process.stdin.resume();
