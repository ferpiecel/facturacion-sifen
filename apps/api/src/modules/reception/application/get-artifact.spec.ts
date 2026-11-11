import { describe, expect, it } from 'vitest';
import { createGetArtifact, createGetArtifactUrl } from './get-artifact.js';
import type {
  ReceivedDocumentDetail,
  ReceivedDocumentQuery,
} from './ports/received-document-query.port.js';
import { StorageObjectNotFoundError, type StorageProvider } from './ports/storage-provider.port.js';

const detail = (artifact: ReceivedDocumentDetail['artifact']) =>
  ({ artifact }) as unknown as ReceivedDocumentDetail;
const withDetail = (found: ReceivedDocumentDetail | null): ReceivedDocumentQuery => ({
  list: () => Promise.resolve([]),
  find: () => Promise.resolve(found),
});
const ARTIFACT = {
  id: 'a',
  storageKey: 'k/1.xml',
  contentType: null,
  sha256: '0'.repeat(64),
  sizeBytes: 3,
  originalName: 'x.xml',
  pageCount: null,
};
const storage = (overrides: Partial<StorageProvider>): StorageProvider =>
  ({
    download: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    presignedUrl: (key: string) => Promise.resolve(`https://s/${key}`),
    ...overrides,
  }) as unknown as StorageProvider;

describe('createGetArtifact', () => {
  it('returns the bytes with an octet-stream fallback type', async () => {
    const get = createGetArtifact({ query: withDetail(detail(ARTIFACT)), storage: storage({}) });
    expect(await get('t', 'd')).toEqual({
      kind: 'found',
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'application/octet-stream',
      originalName: 'x.xml',
    });
  });

  it('is not-found without a document, without an artifact, or when the object is gone', async () => {
    const gone = storage({ download: () => Promise.reject(new StorageObjectNotFoundError('k')) });
    expect(await createGetArtifact({ query: withDetail(null), storage: gone })('t', 'd')).toEqual({
      kind: 'not-found',
    });
    expect(
      await createGetArtifact({ query: withDetail(detail(null)), storage: gone })('t', 'd'),
    ).toEqual({ kind: 'not-found' });
    expect(
      await createGetArtifact({ query: withDetail(detail(ARTIFACT)), storage: gone })('t', 'd'),
    ).toEqual({ kind: 'not-found' });
  });

  it('lets other storage failures through', async () => {
    const broken = storage({ download: () => Promise.reject(new Error('boom')) });
    await expect(
      createGetArtifact({ query: withDetail(detail(ARTIFACT)), storage: broken })('t', 'd'),
    ).rejects.toThrow('boom');
  });
});

describe('createGetArtifactUrl', () => {
  it('presigns the storage key for the default lifetime', async () => {
    const get = createGetArtifactUrl({ query: withDetail(detail(ARTIFACT)), storage: storage({}) });
    expect(await get('t', 'd')).toEqual({
      kind: 'found',
      url: 'https://s/k/1.xml',
      expiresInSeconds: 900,
    });
  });

  it('is not-found without an artifact', async () => {
    const get = createGetArtifactUrl({ query: withDetail(detail(null)), storage: storage({}) });
    expect(await get('t', 'd')).toEqual({ kind: 'not-found' });
  });
});
