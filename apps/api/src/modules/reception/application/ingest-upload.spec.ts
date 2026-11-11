import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createReceivedDocument } from '../domain/received-document.js';
import { IngestUpload, type IngestUploadResult } from './ingest-upload.js';
import type { IngestSifenXmlResult } from './ingest-sifen-xml.js';
import {
  FakeJobQueue,
  InMemoryReceptionRepository,
  InMemoryStorage,
} from './testing/in-memory-reception.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const pdf = (tag = 'a') => new TextEncoder().encode(`%PDF-1.7 ${tag}`);
const png = (tag = 'a') =>
  Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from(tag)]);
const jpeg = (tag = 'a') => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from(tag)]);
const xml = () => new TextEncoder().encode('<?xml version="1.0"?><rDE/>');

function harness() {
  const repository = new InMemoryReceptionRepository();
  const storage = new InMemoryStorage();
  const queue = new FakeJobQueue();
  let seq = 0;
  const xmlResult = { created: true } as unknown as IngestSifenXmlResult;
  const ingestXml = { execute: vi.fn(() => Promise.resolve(xmlResult)) };
  const useCase = new IngestUpload({
    repository,
    storage,
    queue,
    ingestXml,
    newId: () => `doc-${String((seq += 1))}`,
  });
  return { repository, storage, queue, ingestXml, useCase, xmlResult };
}

function accepted(result: IngestUploadResult) {
  if (result.kind !== 'accepted') throw new Error(`expected accepted, got ${result.kind}`);
  return result;
}

describe('IngestUpload', () => {
  it('stores a PDF, creates a received document and enqueues one extraction job', async () => {
    const { useCase, repository, storage, queue } = harness();
    const bytes = pdf();
    const result = accepted(
      await useCase.execute({ tenantId: TENANT, bytes, originalName: 'factura.pdf' }),
    );

    const key = `tenants/${TENANT}/received/pdf/${sha(bytes)}.pdf`;
    expect(storage.objects.get(key)).toEqual(bytes);
    expect(result.document).toMatchObject({ source: 'pdf', status: 'received', version: 1 });
    expect(repository.document(result.document.id).status).toBe('received');
    const stored = [...repository.artifacts.values()][0];
    expect(stored).toMatchObject({
      storageKey: key,
      contentType: 'application/pdf',
      sha256: sha(bytes),
      sizeBytes: bytes.byteLength,
      originalName: 'factura.pdf',
      pageCount: null,
    });
    expect(queue.jobs).toEqual([{ tenantId: TENANT, documentId: result.document.id }]);
  });

  it.each([
    ['PNG', png(), 'image/png', 'png'],
    ['JPEG', jpeg(), 'image/jpeg', 'jpg'],
  ])('treats a %s as a photo source', async (_name, bytes, contentType, ext) => {
    const { useCase, repository, queue } = harness();
    const result = accepted(await useCase.execute({ tenantId: TENANT, bytes }));
    expect(result.document.source).toBe('photo');
    expect([...repository.artifacts.values()][0]).toMatchObject({
      storageKey: `tenants/${TENANT}/received/photo/${sha(bytes)}.${ext}`,
      contentType,
      originalName: null,
    });
    expect(queue.jobs).toHaveLength(1);
  });

  it('trusts the bytes, not the declared content type', async () => {
    const { useCase } = harness();
    const result = accepted(
      await useCase.execute({ tenantId: TENANT, bytes: pdf(), declaredContentType: 'image/png' }),
    );
    expect(result.document.source).toBe('pdf');
  });

  it('routes XML to the SIFEN XML use case without queueing anything', async () => {
    const { useCase, ingestXml, queue, repository, xmlResult } = harness();
    const bytes = xml();
    const result = await useCase.execute({ tenantId: TENANT, bytes, originalName: 'a.xml' });
    expect(result).toEqual({ kind: 'xml', result: xmlResult });
    expect(ingestXml.execute).toHaveBeenCalledWith({
      tenantId: TENANT,
      xml: bytes,
      originalName: 'a.xml',
    });
    expect(queue.jobs).toEqual([]);
    expect(repository.rows.size).toBe(0);
  });

  it.each([
    ['empty', new Uint8Array()],
    ['plain text', new TextEncoder().encode('hello')],
    ['GIF', Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])],
  ])('rejects %s as an unsupported source and stores nothing', async (_name, bytes) => {
    const { useCase, storage, repository, queue } = harness();
    await expect(useCase.execute({ tenantId: TENANT, bytes })).resolves.toEqual({
      kind: 'unsupported_source',
    });
    expect(storage.objects.size).toBe(0);
    expect(repository.rows.size).toBe(0);
    expect(queue.jobs).toEqual([]);
  });

  it('dedupes by sha256: the same bytes return the existing document and enqueue nothing', async () => {
    const { useCase, repository, queue, storage } = harness();
    const first = accepted(await useCase.execute({ tenantId: TENANT, bytes: pdf() }));
    // The worker moved on: it is no longer waiting for a job.
    await repository.save(TENANT, { ...first.document, status: 'extracting' }, 1);
    const again = await useCase.execute({ tenantId: TENANT, bytes: pdf() });
    expect(again).toMatchObject({ kind: 'duplicate', requeued: false });
    expect(again.kind === 'duplicate' && again.document.id).toBe(first.document.id);
    expect(repository.rows.size).toBe(1);
    expect(queue.jobs).toHaveLength(1);
    expect(storage.objects.size).toBe(1);
  });

  it('keeps different bytes as different documents', async () => {
    const { useCase, repository } = harness();
    await useCase.execute({ tenantId: TENANT, bytes: pdf('a') });
    await useCase.execute({ tenantId: TENANT, bytes: pdf('b') });
    expect(repository.rows.size).toBe(2);
  });

  it('leaves the document in received when the queue is down and reports it', async () => {
    const { useCase, repository, queue } = harness();
    queue.failWith = new Error('x');
    const result = await useCase.execute({ tenantId: TENANT, bytes: pdf() });
    expect(result).toMatchObject({ kind: 'queue_unavailable', created: true });
    const document = result.kind === 'queue_unavailable' ? result.document : null;
    expect(document?.status).toBe('received');
    expect(repository.rows.size).toBe(1);
    expect(queue.jobs).toEqual([]);
  });

  it('recovers: uploading the same bytes again re-enqueues a document still in received', async () => {
    const { useCase, queue, repository } = harness();
    queue.failWith = new Error('x');
    const failed = await useCase.execute({ tenantId: TENANT, bytes: pdf() });
    queue.failWith = null;
    const retry = await useCase.execute({ tenantId: TENANT, bytes: pdf() });
    expect(retry).toMatchObject({ kind: 'duplicate', requeued: true });
    expect(repository.rows.size).toBe(1);
    expect(queue.jobs).toEqual([
      {
        tenantId: TENANT,
        documentId: failed.kind === 'queue_unavailable' ? failed.document.id : '',
      },
    ]);
  });

  it('reports a duplicate that cannot be re-enqueued as queue_unavailable, created=false', async () => {
    const { useCase, queue } = harness();
    queue.failWith = new Error('x');
    await useCase.execute({ tenantId: TENANT, bytes: pdf() });
    await expect(useCase.execute({ tenantId: TENANT, bytes: pdf() })).resolves.toMatchObject({
      kind: 'queue_unavailable',
      created: false,
    });
  });

  it('treats a lost insert race as a duplicate of the winner', async () => {
    const { useCase, repository, queue } = harness();
    const winner = createReceivedDocument({
      id: 'winner',
      tenantId: TENANT,
      source: 'pdf',
      isOwnReceiver: true,
    });
    vi.spyOn(repository, 'create').mockResolvedValue({ created: false, document: winner });
    const result = await useCase.execute({ tenantId: TENANT, bytes: pdf() });
    expect(result).toMatchObject({ kind: 'duplicate', requeued: true });
    expect(queue.jobs).toEqual([{ tenantId: TENANT, documentId: 'winner' }]);
  });
});
