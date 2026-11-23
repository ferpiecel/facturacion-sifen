import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import type { TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATABASE } from '../database/database.module.js';
import { IngestSifenXml } from './application/ingest-sifen-xml.js';
import { InMemoryStorageProvider } from './infrastructure/adapters/in-memory-storage-provider.js';
import { ReceptionModule } from './reception.module.js';
import { IngestFromCdc } from './application/ingest-from-cdc.js';
import { IngestUpload } from './application/ingest-upload.js';
import { ReceptionQueueUnavailableError } from './application/ports/reception-job-queue.port.js';
import {
  INGEST_FROM_CDC,
  INGEST_SIFEN_XML,
  CORRECT_RECEIVED_DOCUMENT,
  INGEST_UPLOAD,
  RECEPTION_JOB_QUEUE,
  RECEPTION_STORAGE,
  REPROCESS_RECEIVED_DOCUMENT,
} from './reception.tokens.js';

const stubDatabase = (db: unknown) => {
  @Global()
  @Module({ providers: [{ provide: DATABASE, useValue: db }], exports: [DATABASE] })
  class StubDatabaseModule {}
  return StubDatabaseModule;
};

const compiled: TestingModule[] = [];

const compile = async (db: unknown, storage: unknown) => {
  const moduleRef = await Test.createTestingModule({
    imports: [ClsModule.forRoot({ global: true }), stubDatabase(db), ReceptionModule],
  })
    .overrideProvider(RECEPTION_STORAGE)
    .useValue(storage)
    .compile();
  compiled.push(moduleRef);
  return moduleRef;
};

describe('ReceptionModule', () => {
  // Cleanup runs even when an assertion fails, so a stubbed env or an open module never leaks.
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(compiled.splice(0).map((moduleRef) => moduleRef.close()));
  });

  it('has no ingest use case without storage or a database', async () => {
    const withoutStorage = await compile(null, null);
    const withoutDatabase = await compile(null, new InMemoryStorageProvider());

    expect(withoutStorage.get(INGEST_SIFEN_XML)).toBeNull();
    expect(withoutDatabase.get(INGEST_SIFEN_XML)).toBeNull();
  });

  it('assembles the ingest use case when both dependencies exist', async () => {
    // The factories only capture the database; nothing queries it while assembling.
    const moduleRef = await compile({}, new InMemoryStorageProvider());

    expect(moduleRef.get(INGEST_SIFEN_XML)).toBeInstanceOf(IngestSifenXml);
  });

  it('assembles the upload entry point and has no queue without REDIS_URL', async () => {
    vi.stubEnv('REDIS_URL', '');
    const moduleRef = await compile({}, new InMemoryStorageProvider());
    expect(moduleRef.get(INGEST_UPLOAD)).toBeInstanceOf(IngestUpload);
    await expect(
      moduleRef
        .get<{ enqueueExtraction(job: object): Promise<void> }>(RECEPTION_JOB_QUEUE)
        .enqueueExtraction({}),
    ).rejects.toBeInstanceOf(ReceptionQueueUnavailableError);
  });

  it.each([
    ['RECEPTION_EXTRACTION_TIMEOUT_MS', 'abc'],
    ['RECEPTION_EXTRACTION_CONCURRENCY', '99'],
    ['RECEPTION_EXTRACTION_MODEL', 'not a model'],
    ['RECEPTION_EXTRACTION_FALLBACK_MODEL', 'not a model'],
  ])('does not fail the API boot on the worker-only variable %s', async (name, value) => {
    vi.stubEnv(name, value);
    const moduleRef = await compile({}, new InMemoryStorageProvider());
    expect(moduleRef.get(CORRECT_RECEIVED_DOCUMENT)).not.toBeNull();
  });

  it('fails the API boot on an invalid auto-confirm threshold', async () => {
    vi.stubEnv('RECEPTION_AUTO_CONFIRM_THRESHOLD', '2');
    await expect(compile({}, new InMemoryStorageProvider())).rejects.toThrow(
      'RECEPTION_AUTO_CONFIRM_THRESHOLD',
    );
  });

  it('assembles reprocess and fails the API boot on an invalid stale threshold', async () => {
    const moduleRef = await compile({}, new InMemoryStorageProvider());
    expect(moduleRef.get(REPROCESS_RECEIVED_DOCUMENT)).not.toBeNull();
    vi.stubEnv('RECEPTION_EXTRACTION_STALE_AFTER_MS', '5');
    await expect(compile({}, new InMemoryStorageProvider())).rejects.toThrow(
      'RECEPTION_EXTRACTION_STALE_AFTER_MS',
    );
  });

  it('fails the API boot on an invalid daily extraction cap', async () => {
    vi.stubEnv('RECEPTION_EXTRACTION_DAILY_CAP', '0');
    await expect(compile({}, new InMemoryStorageProvider())).rejects.toThrow(
      'RECEPTION_EXTRACTION_DAILY_CAP',
    );
  });

  it('assembles the lookup by CDC only with a database, and leaves it off by default', async () => {
    const withDatabase = await compile({}, new InMemoryStorageProvider());
    expect(withDatabase.get(INGEST_FROM_CDC)).toBeInstanceOf(IngestFromCdc);
    const withoutDatabase = await compile(null, new InMemoryStorageProvider());
    expect(withoutDatabase.get(INGEST_FROM_CDC)).toBeNull();
  });

  it.each([
    ['RECEPTION_EKUATIA_ENABLED', 'maybe'],
    ['RECEPTION_EKUATIA_DAILY_SOLVE_CAP', '0'],
    ['RECEPTION_EKUATIA_GLOBAL_DAILY_SOLVE_CAP', 'x'],
    ['RECEPTION_EKUATIA_BREAKER_FAILURES', '0'],
    ['RECEPTION_EKUATIA_BREAKER_COOLDOWN_MS', '1'],
  ])('fails the API boot on an invalid %s', async (name, value) => {
    vi.stubEnv(name, value);
    await expect(compile({}, new InMemoryStorageProvider())).rejects.toThrow(name);
  });
});
