import { describe, expect, it } from 'vitest';
import {
  exportStatus,
  validExportSignature,
} from '../../src/accounts/export.js';

describe('account export', () => {
  it('only offers a signed seven-day download while unexpired', () => {
    const row = {
      id: crypto.randomUUID(),
      status: 'completed',
      requested_at: new Date(),
      expires_at: new Date(Date.now() + 7 * 86400_000),
    };
    const job = exportStatus(row, 'test-secret');
    expect(job?.status).toBe('ready');
    const url = new URL(job!.downloadUrl!, 'http://localhost');
    expect(
      validExportSignature(
        url.searchParams.get('id')!,
        url.searchParams.get('expires')!,
        url.searchParams.get('sig')!,
        'test-secret',
      ),
    ).toBe(true);
    expect(
      validExportSignature(
        url.searchParams.get('id')!,
        url.searchParams.get('expires')!,
        url.searchParams.get('sig')!,
        'other-secret',
      ),
    ).toBe(false);
    expect(
      exportStatus({ ...row, expires_at: new Date(0) }, 'test-secret')?.status,
    ).toBe('expired');
  });
});
