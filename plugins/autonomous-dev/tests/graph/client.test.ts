import { httpGraphClient } from '../../src/graph/client';
import { readNeo4jCreds, boltToHttp } from '../../src/graph/secrets';
import type { SecretsReader } from '../../src/graph/secrets';
import type { GraphTransport, Neo4jCreds } from '../../src/graph/types';

/**
 * Unit tests for the Neo4j HTTP client + credential reader (ONBOARD P1.6 / AC6).
 * Injected transport + reader — never touches the real DB or the real secret.
 */

const CREDS: Neo4jCreds = { httpUrl: 'http://h:7474', user: 'neo4j', password: 'pw' };

function reader(content: string | undefined): SecretsReader {
  return { read: () => content };
}

function okTransport(
  captured: { req?: Parameters<GraphTransport>[0] },
  body = '{"results":[{"columns":["ok"],"data":[{"row":[1]}]}]}',
): GraphTransport {
  return async (req) => {
    captured.req = req;
    return { status: 200, text: body };
  };
}

function test_bolt_to_http(): void {
  assert(
    boltToHttp('bolt://neo4j.pwatson.space:7687') === 'http://neo4j.pwatson.space:7474',
    'bolt→http',
  );
  assert(boltToHttp('neo4j+s://host') === 'http://host:7474', 'neo4j+s→http');
  assert(boltToHttp('bolt+ssc://h:7687') === 'http://h:7474', 'bolt+ssc→http');
  assert(boltToHttp('bolt://h/db') === 'http://h:7474', 'bolt with path');
  assert(boltToHttp('bolt://[::1]:7687') === 'http://[::1]:7474', 'IPv6 literal preserved');
  assert(boltToHttp('') === '', 'empty uri → empty (invalid)');
  console.log('PASS: test_bolt_to_http');
}

function test_read_creds(): void {
  const ok = readNeo4jCreds(
    reader('{"uri":"bolt://h:7687","user":"neo4j","password":"p"}'),
    '/home/test',
  );
  assert(
    !!ok && ok.httpUrl === 'http://h:7474' && ok.user === 'neo4j' && ok.password === 'p',
    'valid creds parsed',
  );
  assert(readNeo4jCreds(reader(undefined), '/home/test') === undefined, 'missing file → undefined');
  assert(readNeo4jCreds(reader('not json'), '/home/test') === undefined, 'malformed → undefined');
  assert(
    readNeo4jCreds(reader('{"uri":"bolt://h"}'), '/home/test') === undefined,
    'missing user/password → undefined',
  );
  // an EMPTY httpUrl override must not win — falls back to the bolt-derived URL (H3)
  const override = readNeo4jCreds(
    reader('{"uri":"bolt://h:7687","user":"u","password":"p","httpUrl":""}'),
    '/home/test',
  );
  assert(
    !!override && override.httpUrl === 'http://h:7474',
    'empty httpUrl override falls back to bolt-derived',
  );
  console.log('PASS: test_read_creds');
}

async function test_run_success(): Promise<void> {
  const captured: { req?: Parameters<GraphTransport>[0] } = {};
  const client = httpGraphClient(CREDS, okTransport(captured));
  const res = await client.run([{ statement: 'RETURN 1' }]);
  assert(res.ok, 'run succeeds');
  assert(captured.req!.url === 'http://h:7474/db/neo4j/tx/commit', 'posts to tx/commit');
  assert(captured.req!.headers.Authorization.startsWith('Basic '), 'basic auth header');
  assert(captured.req!.body!.includes('RETURN 1'), 'body carries the statement');
  assert(await client.verifyConnectivity(), 'verifyConnectivity true');
  console.log('PASS: test_run_success');
}

async function test_run_failures(): Promise<void> {
  // neo4j errors array → ok:false
  const errClient = httpGraphClient(CREDS, async () => ({
    status: 200,
    text: '{"results":[],"errors":[{"message":"Neo.ClientError.Statement.SyntaxError"}]}',
  }));
  const e = await errClient.run([{ statement: 'BAD' }]);
  assert(!e.ok && (e.error ?? '').includes('SyntaxError'), 'neo4j error surfaced');

  // HTTP 401 → ok:false
  const authClient = httpGraphClient(CREDS, async () => ({ status: 401, text: 'Unauthorized' }));
  assert(!(await authClient.run([{ statement: 'X' }])).ok, '401 → not ok');

  // transport throws → ok:false (no throw escapes)
  const downClient = httpGraphClient(CREDS, async () => {
    throw new Error('ECONNREFUSED');
  });
  const d = await downClient.run([{ statement: 'X' }]);
  assert(!d.ok && (d.error ?? '').includes('transport error'), 'transport error caught (graceful)');
  assert((await downClient.verifyConnectivity()) === false, 'verifyConnectivity false when down');
  console.log('PASS: test_run_failures');
}

async function test_run_malformed_responses(): Promise<void> {
  // B1: a `null` body must NOT throw — graceful ok:false
  const nullClient = httpGraphClient(CREDS, async () => ({ status: 200, text: 'null' }));
  const n = await nullClient.run([{ statement: 'X' }]);
  assert(
    !n.ok && (n.error ?? '').includes('unexpected response shape'),
    'null body → ok:false (no throw)',
  );
  // M3: array / primitive body → ok:false (not silent success)
  assert(
    !(
      await httpGraphClient(CREDS, async () => ({ status: 200, text: '[]' })).run([
        { statement: 'X' },
      ])
    ).ok,
    'array body → ok:false',
  );
  assert(
    !(
      await httpGraphClient(CREDS, async () => ({ status: 200, text: 'true' })).run([
        { statement: 'X' },
      ])
    ).ok,
    'primitive body → ok:false',
  );
  assert(
    !(
      await httpGraphClient(CREDS, async () => ({ status: 200, text: '' })).run([
        { statement: 'X' },
      ])
    ).ok,
    'empty body → ok:false',
  );
  // H4: non-2xx with a JSON error body surfaces the message
  const e500 = httpGraphClient(CREDS, async () => ({
    status: 500,
    text: '{"errors":[{"message":"Service unavailable"}]}',
  }));
  const r5 = await e500.run([{ statement: 'X' }]);
  assert(
    !r5.ok && (r5.error ?? '').includes('Service unavailable'),
    '500 JSON error message surfaced',
  );
  // M4: verifyConnectivity is false on a 200 garbage body (a stray proxy 200 isn't Neo4j)
  assert(
    (await httpGraphClient(CREDS, async () => ({
      status: 200,
      text: 'true',
    })).verifyConnectivity()) === false,
    'verify false on garbage 200',
  );
  console.log('PASS: test_run_malformed_responses');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

describe('graph/client + secrets', () => {
  it('test_bolt_to_http', test_bolt_to_http);
  it('test_read_creds', test_read_creds);
  it('test_run_success', test_run_success);
  it('test_run_failures', test_run_failures);
  it('test_run_malformed_responses', test_run_malformed_responses);
});
