import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { FileDropDeliveryAdapter } from '../../../src/notifications/adapters/file-drop-adapter';
import type { NotificationPayload } from '../../../src/notifications/types';

function makePayload(overrides: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    notification_id: '550e8400-e29b-41d4-a716-446655440000',
    event_type: 'escalation',
    urgency: 'immediate',
    timestamp: '2026-04-08T10:30:00Z',
    request_id: 'req-abc',
    repository: 'repo-name',
    title: 'Pipeline code_review gate requires human approval',
    body: 'Code review has failed after 3 retries...',
    ...overrides,
  };
}

describe('FileDropDeliveryAdapter', () => {
  let tmpDir: string;
  let adapter: FileDropDeliveryAdapter;

  beforeEach(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-drop-test-'));
    adapter = new FileDropDeliveryAdapter(tmpDir);
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('has method "file_drop"', () => {
    expect(adapter.method).toBe('file_drop');
  });

  // Test Case 13: Single: file written
  it('writes file at {outputDir}/{notification_id}.json', () => {
    const payload = makePayload({ notification_id: 'test-uuid-1234' });
    const result = adapter.deliver(payload);

    expect(result.success).toBe(true);

    const filePath = path.join(tmpDir, 'test-uuid-1234.json');
    expect(fs.existsSync(filePath)).toBe(true);
  });

  // Test Case 14: Single: valid JSON content
  it('file contents parse as the original payload', () => {
    const payload = makePayload({ notification_id: 'test-uuid-5678' });
    adapter.deliver(payload);

    const filePath = path.join(tmpDir, 'test-uuid-5678.json');
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);

    expect(parsed.notification_id).toBe('test-uuid-5678');
    expect(parsed.event_type).toBe('escalation');
    expect(parsed.urgency).toBe('immediate');
    expect(parsed.title).toBe('Pipeline code_review gate requires human approval');
    expect(parsed.body).toBe('Code review has failed after 3 retries...');
    expect(parsed.repository).toBe('repo-name');
    expect(parsed.request_id).toBe('req-abc');
  });

  // Test Case 15: Batch: array of payloads
  it('batch file contains JSON array with all payloads', () => {
    const payloads: NotificationPayload[] = [
      makePayload({ notification_id: 'n1', title: 'First' }),
      makePayload({ notification_id: 'n2', title: 'Second' }),
      makePayload({ notification_id: 'n3', title: 'Third' }),
    ];

    const result = adapter.deliverBatch(payloads);
    expect(result.success).toBe(true);

    // Find the batch file
    const files = fs.readdirSync(tmpDir);
    const batchFile = files.find(f => f.startsWith('batch-'));
    expect(batchFile).toBeDefined();

    const content = fs.readFileSync(path.join(tmpDir, batchFile!), 'utf-8');
    const parsed = JSON.parse(content);

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].notification_id).toBe('n1');
    expect(parsed[1].notification_id).toBe('n2');
    expect(parsed[2].notification_id).toBe('n3');
  });

  // Test Case 16: Atomic write -- verify temp+rename pattern (mock fs)
  it('uses atomic temp+rename pattern for writes', () => {
    const writeFileSyncSpy = jest.spyOn(fs, 'writeFileSync');
    const renameSyncSpy = jest.spyOn(fs, 'renameSync');

    const payload = makePayload({ notification_id: 'atomic-test' });
    adapter.deliver(payload);

    // writeFileSync should be called with a .tmp file
    expect(writeFileSyncSpy).toHaveBeenCalled();
    const writeCall = writeFileSyncSpy.mock.calls[writeFileSyncSpy.mock.calls.length - 1];
    const writtenPath = writeCall[0] as string;
    expect(writtenPath).toContain('.tmp');

    // renameSync should be called to rename .tmp to final path
    expect(renameSyncSpy).toHaveBeenCalled();
    const renameCall = renameSyncSpy.mock.calls[renameSyncSpy.mock.calls.length - 1];
    const sourcePath = renameCall[0] as string;
    const targetPath = renameCall[1] as string;
    expect(sourcePath).toContain('.tmp');
    expect(targetPath).toBe(path.join(tmpDir, 'atomic-test.json'));

    writeFileSyncSpy.mockRestore();
    renameSyncSpy.mockRestore();
  });

  it('batch file name starts with batch-', () => {
    const payloads: NotificationPayload[] = [
      makePayload({ notification_id: 'n1' }),
    ];

    adapter.deliverBatch(payloads);

    const files = fs.readdirSync(tmpDir);
    const batchFile = files.find(f => f.startsWith('batch-'));
    expect(batchFile).toBeDefined();
    expect(batchFile).toMatch(/^batch-.*\.json$/);
  });

  it('returns error result on write failure', () => {
    const badAdapter = new FileDropDeliveryAdapter('/nonexistent/directory/path');
    const result = badAdapter.deliver(makePayload());

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('formattedOutput is the payload object on success', () => {
    const payload = makePayload();
    const result = adapter.deliver(payload);

    expect(result.success).toBe(true);
    expect(result.formattedOutput).toEqual(payload);
  });

  it('batch formattedOutput is the payloads array on success', () => {
    const payloads: NotificationPayload[] = [
      makePayload({ notification_id: 'n1' }),
      makePayload({ notification_id: 'n2' }),
    ];

    const result = adapter.deliverBatch(payloads);
    expect(result.success).toBe(true);
    expect(result.formattedOutput).toEqual(payloads);
  });

  it('returns DeliveryResult with success, method, and formattedOutput', () => {
    const result = adapter.deliver(makePayload());
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('method');
    expect(result).toHaveProperty('formattedOutput');
  });
});
