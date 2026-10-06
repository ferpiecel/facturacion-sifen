import { describe, expect, it } from 'vitest';
import { buildCdc } from '../../emission/domain/cdc.js';
import { MAX_LOTE_DOCUMENTS, MAX_LOTE_MESSAGE_BYTES } from '../domain/lote-builder.js';
import {
  LoteAssembler,
  type LoteAssemblyStore,
  type ReadyDocument,
  type ResendCheck,
  type ResendVerdict,
} from './assemble-lotes.js';

const cdcOf = (n: number, documentType = '01', rucBase = '44444401', rucDv = 7): string =>
  buildCdc({
    documentType,
    rucBase,
    rucDv,
    establishment: '001',
    point: '001',
    documentNumber: String(n),
    taxpayerType: 2,
    issueDate: '2026-09-22',
    emissionType: 1,
    securityCode: '123456789',
  });

const doc = (n: number, documentType = '01', rucBase = '44444401', rucDv = 7): ReadyDocument => ({
  documentId: `doc-${String(n)}-${documentType}-${rucBase}`,
  cdc: cdcOf(n, documentType, rucBase, rucDv),
  xml: `<rDE>${String(n)}</rDE>`,
});

class InMemoryAssemblyStore implements LoteAssemblyStore {
  readonly created: { documentType: number; documentIds: readonly string[] }[] = [];
  /** Document ids that stop being ready between read and create. */
  readonly stale = new Set<string>();

  constructor(
    private readonly ready: readonly ReadyDocument[],
    private readonly inProcess: ReadonlySet<string> = new Set(),
  ) {}

  readyDocuments(): Promise<readonly ReadyDocument[]> {
    return Promise.resolve(this.ready);
  }

  cdcsInProcess(cdcs: readonly string[]): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set(cdcs.filter((cdc) => this.inProcess.has(cdc))));
  }

  createLote(input: {
    documentType: number;
    documentIds: readonly string[];
  }): Promise<string | null> {
    if (input.documentIds.some((id) => this.stale.has(id))) return Promise.resolve(null);
    this.created.push(input);
    return Promise.resolve(`lote-${String(this.created.length)}`);
  }
}

const small = (xmls: readonly string[]): number => xmls.length * 100;

function setup(
  ready: readonly ReadyDocument[],
  inProcess?: ReadonlySet<string>,
  measureMessage = small,
) {
  const store = new InMemoryAssemblyStore(ready, inProcess);
  return { store, assembler: new LoteAssembler({ store, measureMessage }) };
}

describe('LoteAssembler', () => {
  it('creates nothing when no document is ready', async () => {
    const { assembler, store } = setup([]);
    expect(await assembler.assemble()).toEqual({ lotes: [], skipped: [], conflicted: [] });
    expect(store.created).toHaveLength(0);
  });

  it('puts ready documents of one RUC and type in one lote', async () => {
    const docs = [doc(1), doc(2), doc(3)];
    const { assembler, store } = setup(docs);
    const result = await assembler.assemble();
    expect(result.lotes).toEqual([
      { loteId: 'lote-1', documentType: '01', cdcs: docs.map((d) => d.cdc) },
    ]);
    expect(store.created).toEqual([
      { documentType: 1, documentIds: docs.map((d) => d.documentId) },
    ]);
  });

  it('never mixes document types or RUCs in a lote', async () => {
    const docs = [doc(1), doc(2, '04'), doc(3, '01', '80069563', 1), doc(4)];
    const { assembler, store } = setup(docs);
    const result = await assembler.assemble();
    expect(result.lotes.map((l) => l.cdcs)).toEqual([
      [docs[0].cdc, docs[3].cdc],
      [docs[1].cdc],
      [docs[2].cdc],
    ]);
    expect(store.created.map((c) => c.documentType)).toEqual([1, 4, 1]);
  });

  it('starts a new lote after 50 documents', async () => {
    const docs = Array.from({ length: MAX_LOTE_DOCUMENTS + 3 }, (_, i) => doc(i + 1));
    const { assembler } = setup(docs);
    const result = await assembler.assemble();
    expect(result.lotes.map((l) => l.cdcs.length)).toEqual([MAX_LOTE_DOCUMENTS, 3]);
  });

  it('starts a new lote when the message would exceed the size limit', async () => {
    const docs = [doc(1), doc(2), doc(3)];
    const measure = (xmls: readonly string[]) => xmls.length * (MAX_LOTE_MESSAGE_BYTES / 2 - 1);
    const { assembler } = setup(docs, undefined, measure);
    const result = await assembler.assemble();
    expect(result.lotes.map((l) => l.cdcs.length)).toEqual([2, 1]);
  });

  it('skips a document that does not fit even alone', async () => {
    const docs = [doc(1), doc(2)];
    const measure = (xmls: readonly string[]) =>
      xmls.some((x) => x.includes('>1<')) ? MAX_LOTE_MESSAGE_BYTES + 1 : 100;
    const { assembler } = setup(docs, undefined, measure);
    const result = await assembler.assemble();
    expect(result.lotes.map((l) => l.cdcs)).toEqual([[docs[1].cdc]]);
    expect(result.skipped).toEqual([{ cdc: docs[0].cdc, reason: 'size-exceeded' }]);
  });

  it('skips documents whose CDC is already in a lote in process', async () => {
    const docs = [doc(1), doc(2)];
    const { assembler } = setup(docs, new Set([docs[0].cdc]));
    const result = await assembler.assemble();
    expect(result.lotes.map((l) => l.cdcs)).toEqual([[docs[1].cdc]]);
    expect(result.skipped).toEqual([{ cdc: docs[0].cdc, reason: 'cdc-in-process' }]);
  });

  it('skips a repeated CDC once', async () => {
    const docs = [doc(1), { ...doc(1), documentId: 'other' }];
    const { assembler } = setup(docs);
    const result = await assembler.assemble();
    expect(result.lotes.map((l) => l.cdcs)).toEqual([[docs[0].cdc]]);
    expect(result.skipped).toEqual([{ cdc: docs[0].cdc, reason: 'duplicate-cdc' }]);
  });

  it('reports a conflict and keeps assembling the other lotes', async () => {
    const docs = [doc(1), doc(2, '04')];
    const { assembler, store } = setup(docs);
    store.stale.add(docs[0].documentId);
    const result = await assembler.assemble();
    expect(result.conflicted).toEqual([{ cdc: docs[0].cdc }]);
    expect(result.lotes.map((l) => l.cdcs)).toEqual([[docs[1].cdc]]);
  });

  it('skips a document with an invalid CDC and keeps assembling the rest', async () => {
    const bad: ReadyDocument = { documentId: 'bad', cdc: '123', xml: '<rDE/>' };
    const docs = [doc(1), bad, doc(2)];
    const { assembler } = setup(docs);
    const result = await assembler.assemble();
    expect(result.lotes.map((l) => l.cdcs)).toEqual([[docs[0].cdc, docs[2].cdc]]);
    expect(result.skipped).toEqual([{ cdc: '123', reason: 'invalid-cdc' }]);
  });

  it('reports the documents of a lote whose creation failed and keeps going', async () => {
    const docs = [doc(1), doc(2, '04')];
    const { assembler, store } = setup(docs);
    const create = store.createLote.bind(store);
    let calls = 0;
    store.createLote = (input) => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('db down')) : create(input);
    };
    const result = await assembler.assemble();
    expect(result.conflicted).toEqual([{ cdc: docs[0].cdc, error: 'Error: db down' }]);
    expect(result.lotes.map((l) => l.cdcs)).toEqual([[docs[1].cdc]]);
  });

  it('logs a failed create and caps what it keeps of the error', async () => {
    const docs = [doc(1)];
    const store = new InMemoryAssemblyStore(docs);
    store.createLote = () => Promise.reject(new Error(`boom\n${'x'.repeat(1000)}`));
    const warnings: string[] = [];
    const assembler = new LoteAssembler({
      store,
      measureMessage: small,
      logger: { warn: (message) => warnings.push(message) },
    });
    const result = await assembler.assemble();
    const error = result.conflicted[0].error ?? '';
    expect(error.startsWith('Error: boom')).toBe(true);
    expect(error).not.toContain('\n');
    expect(error.length).toBeLessThanOrEqual(200);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('createLote');
  });

  it('asks the store about every ready CDC once, in one call', async () => {
    const docs = [doc(1), doc(2)];
    const asked: (readonly string[])[] = [];
    const store = new InMemoryAssemblyStore(docs);
    const original = store.cdcsInProcess.bind(store);
    store.cdcsInProcess = (cdcs) => {
      asked.push(cdcs);
      return original(cdcs);
    };
    await new LoteAssembler({ store, measureMessage: small }).assemble();
    expect(asked).toEqual([docs.map((d) => d.cdc)]);
  });

  describe('resent documents (HU-E6-04)', () => {
    const resent = (n: number): ReadyDocument => ({ ...doc(n), resent: true });
    const setupResend = (
      ready: readonly ReadyDocument[],
      verdict: (document: ReadyDocument) => ResendVerdict | Promise<ResendVerdict>,
      maxResendChecks?: number,
    ) => {
      const store = new InMemoryAssemblyStore(ready);
      const checked: string[] = [];
      const resendCheck: ResendCheck = {
        verify: async (document) => {
          checked.push(document.documentId);
          return verdict(document);
        },
      };
      return {
        store,
        checked,
        assembler: new LoteAssembler({
          store,
          measureMessage: small,
          resendCheck,
          maxResendChecks,
        }),
      };
    };

    it('verifies only the resent documents, and sends those SIFEN still does not hold', async () => {
      const normal = doc(1);
      const again = resent(2);
      const { assembler, store, checked } = setupResend([normal, again], () => 'send');
      const result = await assembler.assemble();
      expect(checked).toEqual([again.documentId]);
      expect(store.created[0].documentIds).toEqual([normal.documentId, again.documentId]);
      expect(result.skipped).toEqual([]);
    });

    it('keeps a document SIFEN approved in the meantime out of every lote (0422 race)', async () => {
      const normal = doc(1);
      const raced = resent(2);
      const { assembler, store } = setupResend([normal, raced], () => 'approved');
      const result = await assembler.assemble();
      expect(store.created.flatMap((c) => c.documentIds)).toEqual([normal.documentId]);
      expect(result.skipped).toEqual([{ cdc: raced.cdc, reason: 'resend-already-approved' }]);
    });

    it('keeps a document it could not verify out of the lote, for the next run', async () => {
      const unsure = resent(2);
      const { assembler, store } = setupResend([doc(1), unsure], () => 'wait');
      const result = await assembler.assemble();
      expect(store.created.flatMap((c) => c.documentIds)).not.toContain(unsure.documentId);
      expect(result.skipped).toEqual([{ cdc: unsure.cdc, reason: 'resend-unverified' }]);
    });

    it('treats a throwing check as unverified and still assembles the rest', async () => {
      const unsure = resent(2);
      const { assembler, store } = setupResend([doc(1), unsure], () => {
        throw new Error('db down');
      });
      const result = await assembler.assemble();
      expect(store.created).toHaveLength(1);
      expect(result.skipped).toEqual([{ cdc: unsure.cdc, reason: 'resend-unverified' }]);
    });

    it('verifies at most maxResendChecks per run (default 20) and leaves the rest unverified', async () => {
      const many = Array.from({ length: 4 }, (_, i) => resent(i + 1));
      const { assembler, checked, store } = setupResend(many, () => 'send', 2);
      const result = await assembler.assemble();
      expect(checked).toHaveLength(2);
      expect(store.created.flatMap((c) => c.documentIds)).toHaveLength(2);
      expect(result.skipped.map((s) => s.reason)).toEqual([
        'resend-unverified',
        'resend-unverified',
      ]);
    });

    it('never sends a resent document when no check is configured', async () => {
      const store = new InMemoryAssemblyStore([doc(1), resent(2)]);
      const assembler = new LoteAssembler({ store, measureMessage: small });
      const result = await assembler.assemble();
      expect(store.created.flatMap((c) => c.documentIds)).toHaveLength(1);
      expect(result.skipped).toHaveLength(1);
    });
  });
});
