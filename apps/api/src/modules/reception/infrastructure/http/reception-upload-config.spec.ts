import { describe, expect, it } from 'vitest';
import { loadReceptionUploadConfig } from './reception-upload-config.js';

describe('loadReceptionUploadConfig', () => {
  it('defaults to 2 MiB', () => {
    expect(loadReceptionUploadConfig({})).toEqual({ maxBytes: 2 * 1024 * 1024 });
    expect(loadReceptionUploadConfig({ RECEPTION_MAX_UPLOAD_BYTES: ' ' }).maxBytes).toBe(
      2 * 1024 * 1024,
    );
  });

  it('reads a valid override', () => {
    expect(loadReceptionUploadConfig({ RECEPTION_MAX_UPLOAD_BYTES: '5000' }).maxBytes).toBe(5000);
  });

  it.each(['0', '-1', '1.5', 'abc', '15728641'])('rejects %s', (value) => {
    expect(() => loadReceptionUploadConfig({ RECEPTION_MAX_UPLOAD_BYTES: value })).toThrow(
      /RECEPTION_MAX_UPLOAD_BYTES/,
    );
  });
});
