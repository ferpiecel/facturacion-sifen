import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCdc, parseCdc } from '../../src/modules/emission/domain/cdc.js';
import { computeRucCheckDigit } from '../../src/modules/fiscal-config/domain/ruc.js';
import { anonymizeCapture, runCli, scanSensitive } from './anonymize-fixtures.js';

// Synthetic "real-looking" values made up for this test only.
const RUC_BASE = '80123456';
const RUC_DV = computeRucCheckDigit(RUC_BASE);
const RUC_REC = '4567890';
const CDC = buildCdc({
  documentType: '01',
  rucBase: RUC_BASE,
  rucDv: RUC_DV,
  establishment: '002',
  point: '003',
  documentNumber: '0004567',
  taxpayerType: 2,
  issueDate: '2026-05-04',
  emissionType: 1,
  securityCode: '123456789',
});
const CDC_2 = buildCdc({
  documentType: '01',
  rucBase: RUC_BASE,
  rucDv: RUC_DV,
  establishment: '002',
  point: '003',
  documentNumber: '0004568',
  taxpayerType: 2,
  issueDate: '2026-05-04',
  emissionType: 1,
  securityCode: '987654321',
});
const SENSITIVE = [
  RUC_BASE,
  RUC_REC,
  CDC,
  'Panaderia Los Pinos S.A.',
  'Juan Perez Gonzalez',
  'Av. Mariscal Lopez 1234',
  'dueno@panaderia-real.com.py',
  '0981123456',
  'SECRETSIGNATUREBYTES',
  'SESSIONCOOKIEVALUE',
];

const XML =
  `<rDE><DE Id="${CDC}"><dDVId>1</dDVId><gEmis><dRucEm>${RUC_BASE}</dRucEm><dDVEmi>${String(RUC_DV)}</dDVEmi>` +
  `<dNomEmi>Panaderia Los Pinos S.A.</dNomEmi><dNomFanEmi>Panaderia Los Pinos S.A.</dNomFanEmi>` +
  `<dDirEmi>Av. Mariscal Lopez 1234</dDirEmi><dTelEmi>0981123456</dTelEmi>` +
  `<dEmailE>dueno@panaderia-real.com.py</dEmailE></gEmis>` +
  `<gDatRec><dRucRec>${RUC_REC}</dRucRec><dDVRec>9</dDVRec><dNomRec>Juan Perez Gonzalez</dNomRec></gDatRec></DE>` +
  `<gCamFuFD><dCarQR>https://ekuatia.set.gov.py/consultas/qr?nVersion=150&amp;Id=${CDC}&amp;dRucRec=${RUC_REC}` +
  `&amp;DigestValue=abcdef&amp;IdCSC=1&amp;cHashQR=deadbeef</dCarQR></gCamFuFD>` +
  `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignatureValue>SECRETSIGNATUREBYTES</SignatureValue></Signature></rDE>`;

const REQUESTS = JSON.stringify([
  {
    url: 'https://ekuatia.set.gov.py/docs/documento-electronico',
    method: 'POST',
    status_code: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': 'sid=SESSIONCOOKIEVALUE; path=/' },
    set_cookie: ['sid=<redacted>; path=/'],
    body: JSON.stringify({
      DE: {
        '@Id': CDC,
        dRucEm: Number(RUC_BASE),
        dDVEmi: RUC_DV,
        dNomEmi: 'Panaderia Los Pinos S.A.',
        dEmailE: 'dueno@panaderia-real.com.py',
      },
    }),
    request: {
      method: 'POST',
      url: 'https://ekuatia.set.gov.py/docs/documento-electronico',
      headers: { 'content-type': 'application/json', cookie: 'sid=SESSIONCOOKIEVALUE' },
      cookie_names: ['sid'],
      body: JSON.stringify({ cdc: CDC, captcha: '<captcha-token>' }),
    },
  },
  {
    url: `https://ekuatia.set.gov.py/docs/documento-electronico-xml/${CDC}`,
    method: 'GET',
    status_code: 200,
    headers: { 'content-type': 'application/xml' },
    body: XML,
    request: {
      method: 'GET',
      url: `https://ekuatia.set.gov.py/docs/documento-electronico-xml/${CDC}`,
      headers: {},
      cookie_names: [],
      body: null,
    },
  },
]);
const META = JSON.stringify({ cdc: CDC, label: 'success', version: 'v2026-Q3' });
const RAW = { 'documento.xml': XML, 'requests.json': REQUESTS, 'meta.json': META };

interface CapturedRecord {
  headers: Record<string, string>;
  request: { headers: Record<string, string>; cookie_names: string[] };
  status_code: number;
  body: string;
}

describe('anonymizeCapture', () => {
  it('leaves no sensitive value behind in any file', () => {
    const { files } = anonymizeCapture(RAW);
    for (const [name, content] of Object.entries(files)) {
      for (const value of SENSITIVE)
        expect(content.includes(value), `${name} leaks a value`).toBe(false);
      expect(scanSensitive(content), name).toEqual([]);
    }
  });

  it('maps a CDC to a valid synthetic CDC, consistently within a run', () => {
    const { files } = anonymizeCapture(RAW);
    const fake = /Id="(\d{44})"/.exec(files['documento.xml'] ?? '')?.[1] ?? '';
    expect(fake).toHaveLength(44);
    expect(() => parseCdc(fake)).not.toThrow();
    expect(fake).not.toBe(CDC);
    expect(files['requests.json']?.split(fake).length).toBeGreaterThan(2);
    expect(JSON.parse(files['meta.json'] ?? '{}')).toMatchObject({ cdc: fake });
  });

  it('keeps RUC, its check digit and the CDC embedded RUC coherent', () => {
    const { files } = anonymizeCapture(RAW);
    const xml = files['documento.xml'] ?? '';
    const ruc = /<dRucEm>(\d+)<\/dRucEm><dDVEmi>(\d)<\/dDVEmi>/.exec(xml);
    expect(ruc).not.toBeNull();
    expect(computeRucCheckDigit(ruc?.[1] ?? '')).toBe(Number(ruc?.[2]));
    const cdc = /Id="(\d{44})"/.exec(xml)?.[1] ?? '';
    expect(parseCdc(cdc).rucBase).toBe((ruc?.[1] ?? '').padStart(8, '0'));
  });

  it('maps distinct CDCs to distinct synthetic CDCs', () => {
    const { files } = anonymizeCapture({
      'meta.json': JSON.stringify({ a: CDC, b: CDC_2, c: CDC }),
    });
    const { a, b, c } = JSON.parse(files['meta.json'] ?? '{}') as Record<string, string>;
    expect(a).toBe(c);
    expect(a).not.toBe(b);
  });

  it('drops cookies and session headers but keeps structure', () => {
    const { files } = anonymizeCapture(RAW);
    const records = JSON.parse(files['requests.json'] ?? '[]') as CapturedRecord[];
    expect(records).toHaveLength(2);
    expect(records[0]?.headers).toEqual({ 'content-type': 'application/json' });
    expect(records[0]?.request.headers).toEqual({ 'content-type': 'application/json' });
    expect(records[0]).not.toHaveProperty('set_cookie');
    expect(records[0]?.request.cookie_names).toEqual(['sid']);
    expect(records[0]?.status_code).toBe(200);
    expect((JSON.parse(records[0]?.body ?? '{}') as { DE: object }).DE).toHaveProperty('dRucEm');
  });

  it('is idempotent', () => {
    const once = anonymizeCapture(RAW);
    expect(anonymizeCapture(once.files).files).toEqual(once.files);
  });

  it('reports what it replaced without the original values', () => {
    const { report } = anonymizeCapture(RAW);
    expect(report.replacements.cdc).toBeGreaterThan(0);
    expect(report.replacements.ruc).toBeGreaterThan(0);
    expect(report.replacements.email).toBeGreaterThan(0);
    expect(report.replacements.signature).toBeGreaterThan(0);
    const text = JSON.stringify(report);
    for (const value of SENSITIVE) expect(text.includes(value)).toBe(false);
  });
});

describe('runCli', () => {
  const tmp = (): string => mkdtempSync(join(tmpdir(), 'anon-'));

  it.each([
    ['nothing', []],
    ['only --out', ['--out', 'X']],
    ['only --in', ['--in', 'X']],
    ['a value starting with --', ['--in', '--out', '--out', 'Y']],
  ])('refuses %s and creates nothing', (_name, argv) => {
    const dir = tmp();
    const out = join(dir, 'out');
    const args = argv.map((a) => (a === 'X' || a === 'Y' ? out : a));
    expect(runCli(args)).not.toBe(0);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses a missing or empty input directory without creating the output', () => {
    const dir = tmp();
    const out = join(dir, 'out');
    expect(runCli(['--in', join(dir, 'missing'), '--out', out])).not.toBe(0);
    mkdirSync(join(dir, 'empty'));
    expect(runCli(['--in', join(dir, 'empty'), '--out', out])).not.toBe(0);
    expect(existsSync(out)).toBe(false);
  });

  it('reads a raw capture directory and writes the anonymized copy plus the report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anon-'));
    const input = join(dir, 'in');
    const output = join(dir, 'out');
    mkdirSync(input);
    for (const [name, content] of Object.entries(RAW)) writeFileSync(join(input, name), content);
    expect(runCli(['--in', input, '--out', output])).toBe(0);
    expect(readdirSync(output).sort()).toEqual([
      'anonymization-report.json',
      'documento.xml',
      'meta.json',
      'requests.json',
    ]);
    expect(readFileSync(join(output, 'documento.xml'), 'utf8')).not.toContain(RUC_BASE);
  });
});

describe('numeric text fields', () => {
  it('rewrites numeric phone fields in JSON bodies and keeps the type', () => {
    const body = JSON.stringify({
      DE: { dTelEmi: 216189000, dTelRec: '0211234567', dCelRec: 981123456 },
    });
    const raw = JSON.stringify([{ url: 'u', method: 'POST', status_code: 200, body }]);
    const { files } = anonymizeCapture({ 'requests.json': raw });
    const record = (JSON.parse(files['requests.json'] ?? '[]') as { body: string }[])[0];
    const de = (JSON.parse(record.body) as { DE: Record<string, unknown> }).DE;
    expect(typeof de.dTelEmi).toBe('number');
    expect(typeof de.dCelRec).toBe('number');
    expect(typeof de.dTelRec).toBe('string');
    expect(Object.values(de).map(Number)).toEqual([0, 0, 0]);
    expect(scanSensitive(files['requests.json'] ?? '')).toEqual([]);
  });

  it('anonymizes the committed servicio_digital capture so no phone survives', () => {
    const dir = join(
      import.meta.dirname,
      '../../test/fixtures/reception/ekuatia/v2026-Q3/servicio_digital',
    );
    const input = Object.fromEntries(
      (['documento.xml', 'requests.json', 'meta.json'] as const).map((n) => [
        n,
        readFileSync(join(dir, n), 'utf8'),
      ]),
    );
    // The committed bytes still have the finding (verbatim fixture, never edited)...
    expect(scanSensitive(input['requests.json'])).toContain('phone');
    // ...but the anonymized copy does not.
    const { files } = anonymizeCapture(input);
    expect(scanSensitive(files['requests.json'] ?? '')).not.toContain('phone');
  });
});

describe('scanSensitive', () => {
  it('flags categories, never values', () => {
    const found = scanSensitive(XML);
    expect(found).toEqual(expect.arrayContaining(['cdc', 'ruc', 'email', 'phone', 'signature']));
    expect(JSON.stringify(found)).not.toContain(RUC_BASE);
  });
});

describe('committed eKuatia fixtures', () => {
  const root = join(import.meta.dirname, '../../test/fixtures/reception/ekuatia');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(xml|json|html)$/.test(entry)) files.push(path);
    }
  };
  walk(root);

  it('finds the committed capture files', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  // Findings already present in the committed bytes (fixtures are verbatim and must not be edited
  // here). They are pinned by category so a new leak, or a fix, fails this test. Reported to the
  // tech lead; the values are deliberately not written down anywhere.
  const KNOWN_FINDINGS: Record<string, string[]> = {
    'v2026-Q3/servicio_digital/requests.json': ['phone'], // numeric dTelEmi in the JSON body (anonymizeCapture now fixes it in a copy)
    'v2026-Q3/success_pago_credito/documento.xml': ['ruc'], // dCodCliente in RUC-like format
    'v2026-Q3/success_pago_credito/requests.json': ['ruc'], // same dCodCliente, inside the JSON body
  };

  it.each(files.map((f) => [f.slice(root.length + 1), f]))(
    '%s has only the known findings',
    (name, path) => {
      // Only categories are asserted so a failure never prints the offending value.
      expect(scanSensitive(readFileSync(path, 'utf8'))).toEqual(KNOWN_FINDINGS[name] ?? []);
    },
  );
});
