import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeQrHash, qrBaseUrl, verifyQrUrl, type QrExpectations } from './qr.js';

const CSC = 'ABCD0000000000000000000000000000';
const CDC = '01800000019001001000000122026093010002983980';
const DIGEST = 'GPj7NvPLG6LjL0Putib/tbLcQFuORds/juNfVug24qk=';
const PARAMS =
  `nVersion=150&Id=${CDC}&dFeEmiDE=323032362d30392d33305431393a31303a3535&dRucRec=80000002` +
  '&dTotGralOpe=10000&dTotIVA=909&cItems=1' +
  '&DigestValue=47506a374e76504c47364c6a4c3050757469622f74624c635146754f5264732f6a754e665675673234716b3d' +
  '&IdCSC=0001';
const HASH = 'a2b95df9fa7b6a66b207ca8e6083f69c4cc0808cbbb0f32972a415022dbe43bc';
const URL_TEST = `https://ekuatia.set.gov.py/consultas-test/qr?${PARAMS}&cHashQR=${HASH}`;

const EXPECTED: QrExpectations = {
  environment: 'test',
  cdc: CDC,
  issuedAt: '2026-09-30T19:10:55',
  receiver: { kind: 'ruc', value: '80000002' },
  totalOperation: 10000,
  totalVat: 909,
  itemCount: 1,
  digestValue: DIGEST,
  idCsc: '0001',
};

describe('qrBaseUrl', () => {
  it('points test to consultas-test and production to consultas (NT 010)', () => {
    expect(qrBaseUrl('test')).toBe('https://ekuatia.set.gov.py/consultas-test/qr?');
    expect(qrBaseUrl('production')).toBe('https://ekuatia.set.gov.py/consultas/qr?');
  });
});

describe('computeQrHash', () => {
  it('is the SHA-256 hex of the parameters concatenated with the CSC', () => {
    expect(computeQrHash(PARAMS, CSC)).toBe(HASH);
    expect(computeQrHash('a=1', 'x')).toBe(createHash('sha256').update('a=1x').digest('hex'));
  });
});

describe('verifyQrUrl', () => {
  it('accepts a correct URL', () => {
    expect(verifyQrUrl(URL_TEST, EXPECTED, CSC)).toEqual([]);
  });

  it('accepts an XML-escaped URL (&amp;)', () => {
    expect(verifyQrUrl(URL_TEST.replaceAll('&', '&amp;'), EXPECTED, CSC)).toEqual([]);
  });

  it('rejects a wrong CSC (cHashQR mismatch)', () => {
    expect(verifyQrUrl(URL_TEST, EXPECTED, 'WRONG')).toContain('cHashQR');
  });

  it('rejects the test URL when production is expected', () => {
    expect(verifyQrUrl(URL_TEST, { ...EXPECTED, environment: 'production' }, CSC)).toContain(
      'baseUrl',
    );
  });

  it.each([
    ['Id', { cdc: '1'.repeat(44) }],
    ['dFeEmiDE', { issuedAt: '2026-09-30T19:10:56' }],
    ['dRucRec', { receiver: { kind: 'ruc', value: '80000003' } }],
    ['dRucRec', { receiver: { kind: 'document', value: '80000002' } }],
    ['dTotGralOpe', { totalOperation: 10001 }],
    ['dTotIVA', { totalVat: 0 }],
    ['cItems', { itemCount: 2 }],
    ['DigestValue', { digestValue: 'AAAA' }],
    ['IdCSC', { idCsc: '0002' }],
  ] as const)('reports %s when it disagrees with the document', (param, override) => {
    expect(verifyQrUrl(URL_TEST, { ...EXPECTED, ...override } as QrExpectations, CSC)).toContain(
      param,
    );
  });

  it('rejects non-hexadecimal encodings and a missing cHashQR', () => {
    const plainDate = URL_TEST.replace(/dFeEmiDE=[0-9a-f]+/, 'dFeEmiDE=2026-09-30T19:10:55');
    expect(verifyQrUrl(plainDate, EXPECTED, CSC)).toContain('dFeEmiDE');
    expect(verifyQrUrl(URL_TEST.replace(/&cHashQR=.*/, ''), EXPECTED, CSC)).toContain('cHashQR');
  });

  it('expects dNumIDRec for a receiver identified by document number', () => {
    const params = PARAMS.replace('dRucRec=80000002', 'dNumIDRec=4567');
    const url = `${qrBaseUrl('test')}${params}&cHashQR=${computeQrHash(params, CSC)}`;
    const expected: QrExpectations = { ...EXPECTED, receiver: { kind: 'document', value: '4567' } };
    expect(verifyQrUrl(url, expected, CSC)).toEqual([]);
  });

  it('never echoes the CSC in its findings', () => {
    expect(JSON.stringify(verifyQrUrl(URL_TEST, EXPECTED, 'WRONG-SECRET'))).not.toContain(
      'WRONG-SECRET',
    );
  });
});
