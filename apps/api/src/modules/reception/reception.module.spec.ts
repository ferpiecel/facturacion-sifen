import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { describe, expect, it, vi } from 'vitest';
import { DATABASE } from '../database/database.module.js';
import { IngestSifenXml } from './application/ingest-sifen-xml.js';
import { InMemoryStorageProvider } from './infrastructure/adapters/in-memory-storage-provider.js';
import { ReceptionModule } from './reception.module.js';
import { IngestUpload } from './application/ingest-upload.js';
import { ReceptionQueueUnavailableError } from './application/ports/reception-job-queue.port.js';
import {
  INGEST_SIFEN_XML,
  INGEST_UPLOAD,
  RECEPTION_JOB_QUEUE,
  RECEPTION_STORAGE,
} from './reception.tokens.js';

const stubDatabase = (db: unknown) => {
  @Global()
  @Module({ providers: [{ provide: DATABASE, useValue: db }], exports: [DATABASE] })
  class StubDatabaseModule {}
  return StubDatabaseModule;
};

const compile = (db: unknown, storage: unknown) =>
  Test.createTestingModule({
    imports: [ClsModule.forRoot({ global: true }), stubDatabase(db), ReceptionModule],
  })
    .overrideProvider(RECEPTION_STORAGE)
    .useValue(storage)
    .compile();

describe('ReceptionModule', () => {
  it('has no ingest use case without storage or a database', async () => {
    const withoutStorage = await compile(null, null);
    const withoutDatabase = await compile(null, new InMemoryStorageProvider());

    expect(withoutStorage.get(INGEST_SIFEN_XML)).toBeNull();
    expect(withoutDatabase.get(INGEST_SIFEN_XML)).toBeNull();
    await Promise.all([withoutStorage.close(), withoutDatabase.close()]);
  });

  it('assembles the ingest use case when both dependencies exist', async () => {
    // The factories only capture the database; nothing queries it while assembling.
    const moduleRef = await compile({}, new InMemoryStorageProvider());

    expect(moduleRef.get(INGEST_SIFEN_XML)).toBeInstanceOf(IngestSifenXml);
    await moduleRef.close();
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
    await moduleRef.close();
    vi.unstubAllEnvs();
  });
});
