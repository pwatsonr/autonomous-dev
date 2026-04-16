import * as path from 'path';
import type {
  DeliveryAdapter,
  DeliveryResult,
  NotificationPayload,
} from '../types';

/**
 * Writes raw JSON to a configured directory.
 *
 * Single delivery: writes `{outputDir}/{notification_id}.json`.
 * Batch delivery: writes `{outputDir}/batch-{timestamp}.json` containing an array.
 *
 * All writes are atomic using a temp-file + rename pattern.
 */
export class FileDropDeliveryAdapter implements DeliveryAdapter {
  readonly method = "file_drop" as const;

  constructor(private outputDir: string) {}

  deliver(payload: NotificationPayload): DeliveryResult {
    const filePath = path.join(this.outputDir, `${payload.notification_id}.json`);
    const content = JSON.stringify(payload, null, 2);

    try {
      atomicWriteSync(filePath, content);
      return {
        success: true,
        method: this.method,
        formattedOutput: payload,
      };
    } catch (err: unknown) {
      return {
        success: false,
        method: this.method,
        formattedOutput: {},
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  deliverBatch(payloads: NotificationPayload[]): DeliveryResult {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(this.outputDir, `batch-${timestamp}.json`);
    const content = JSON.stringify(payloads, null, 2);

    try {
      atomicWriteSync(filePath, content);
      return {
        success: true,
        method: this.method,
        formattedOutput: payloads,
      };
    } catch (err: unknown) {
      return {
        success: false,
        method: this.method,
        formattedOutput: {},
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * Synchronous atomic write: write to temp file, then rename.
 * Uses Node's built-in synchronous fs for the DeliveryAdapter synchronous interface.
 */
function atomicWriteSync(targetPath: string, content: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fsSync = require('fs') as typeof import('fs');
  const tmpPath = `${targetPath}.${Date.now()}.tmp`;

  try {
    fsSync.writeFileSync(tmpPath, content, 'utf-8');
    fsSync.renameSync(tmpPath, targetPath);
  } catch (err: unknown) {
    // Best-effort cleanup of temp file
    try {
      fsSync.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}
