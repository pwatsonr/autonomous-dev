/**
 * T007 — gh_issues unit tests.
 */
import { ghIssueClient } from '../gh_issues';
import type { ExecFn } from '../../checks_client';

function makeExec(responses: Array<{ stdout: string; ok: boolean }>): ExecFn {
  let callIdx = 0;
  return async (_cmd, _args) => {
    const r = responses[callIdx] ?? { stdout: '[]', ok: true };
    callIdx += 1;
    return r;
  };
}

function captureExec(): { exec: ExecFn; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout: '[]', ok: true };
  };
  return { exec, calls };
}

function issueJson(n: number) {
  return {
    number: n,
    html_url: `https://github.com/o/r/issues/${n}`,
    title: `Issue ${n}`,
    body: '',
    labels: [],
    user: { login: 'alice' },
    updated_at: '2026-07-01T00:00:00Z',
  };
}

function makeIssuesResponse(count: number, hasNext = false): { stdout: string; ok: boolean } {
  const issues = Array.from({ length: count }, (_, i) => issueJson(i + 1));
  const body = JSON.stringify(issues);
  let headers = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n';
  if (hasNext) {
    headers += 'Link: <https://api.github.com/repos/o/r/issues?page=2>; rel="next"\r\n';
  }
  headers += '\r\n';
  return { stdout: headers + body, ok: true };
}

describe('ghIssueClient.listOpen', () => {
  it('T007-01: 50 issues, no Link header → 50 issues, truncated=false', async () => {
    const exec = makeExec([makeIssuesResponse(50)]);
    const client = ghIssueClient(exec);
    const result = await client.listOpen('o/r', ['autodev:pipeline-failed'], 100);
    expect(result.issues).toHaveLength(50);
    expect(result.truncated).toBe(false);
  });

  it('T007-02: 100 items + next → page 2 returns 50 → 150 total, truncated=false', async () => {
    const exec = makeExec([makeIssuesResponse(100, true), makeIssuesResponse(50)]);
    const client = ghIssueClient(exec);
    const result = await client.listOpen('o/r', ['autodev:pipeline-failed'], 100);
    expect(result.issues).toHaveLength(150);
    expect(result.truncated).toBe(false);
  });

  it('T007-03: 100 + next, page2 has 100 + next → 200 total, truncated=true', async () => {
    const exec = makeExec([makeIssuesResponse(100, true), makeIssuesResponse(100, true)]);
    const client = ghIssueClient(exec);
    const result = await client.listOpen('o/r', ['autodev:pipeline-failed'], 100);
    expect(result.issues).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });

  it('T007-04: non-zero exit → rejects with stderr in message', async () => {
    const exec = makeExec([{ stdout: 'gh: not found', ok: false }]);
    const client = ghIssueClient(exec);
    await expect(client.listOpen('o/r', [], 100)).rejects.toThrow(/gh api failed/);
  });

  it('T007-05: body with fingerprint marker → fingerprint extracted', async () => {
    const issues = [
      {
        ...issueJson(1),
        body: '<!-- autodev-failure: abcdef01 -->',
      },
    ];
    const headers = 'HTTP/1.1 200 OK\r\n\r\n';
    const exec = makeExec([{ stdout: headers + JSON.stringify(issues), ok: true }]);
    const client = ghIssueClient(exec);
    const result = await client.listOpen('o/r', [], 100);
    expect(result.issues[0].fingerprint).toBe('abcdef01');
  });

  it('T007-06: body with reviewer marker → reviewerBlockFp extracted', async () => {
    const issues = [{ ...issueJson(1), body: '<!-- autodev-reviewer: r-42 -->' }];
    const headers = 'HTTP/1.1 200 OK\r\n\r\n';
    const exec = makeExec([{ stdout: headers + JSON.stringify(issues), ok: true }]);
    const client = ghIssueClient(exec);
    const result = await client.listOpen('o/r', [], 100);
    expect(result.issues[0].reviewerBlockFp).toBe('r-42');
  });
});

describe('ghIssueClient.getEvents', () => {
  it('T007-07: two labeled events for same label → latest actor wins', async () => {
    const events = [
      { event: 'labeled', label: { name: 'autodev/auto-fix' }, actor: { login: 'bot' }, created_at: '2026-07-01T10:00:00Z' },
      { event: 'labeled', label: { name: 'autodev/auto-fix' }, actor: { login: 'alice' }, created_at: '2026-07-01T11:00:00Z' },
    ];
    const exec = makeExec([{ stdout: JSON.stringify(events), ok: true }]);
    const client = ghIssueClient(exec);
    const result = await client.getEvents('o/r', 1);
    expect(result.labeledBy['autodev/auto-fix']).toBe('alice');
  });
});

describe('ghIssueClient.comment', () => {
  it('T007-08: body with shell metacharacters passes as literal argv', async () => {
    const { exec, calls } = captureExec();
    const client = ghIssueClient(exec);
    const dangerousBody = '`; rm -rf /`';
    await client.comment('o/r', 1, dangerousBody);
    expect(calls).toHaveLength(1);
    // The body should be passed as-is in the args array, not interpreted
    expect(calls[0].args).toContain(dangerousBody);
    // Should NOT have constructed a shell string
    expect(calls[0].cmd).toBe('gh');
  });
});
