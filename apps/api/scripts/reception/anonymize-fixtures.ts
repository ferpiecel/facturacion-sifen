/**
 * Anonymizes a RAW eKuatia capture (output of `capture-ekuatia.ts`) so it can become a committed
 * fixture. HUMAN-RUN, offline: it reads and writes local files only.
 *
 *   pnpm --filter @sifen/api anonymize:ekuatia -- --in .captures/vYYYY-Qn/success --out /tmp/anon
 *
 * What is automatic: CDC (44 digits, synthetic with a valid check digit), RUC (+ check digit),
 * emails, phones, QR hashes, the XML signature block, and the text fields of the SIFEN document
 * (names, addresses). What is NOT: free text outside those fields. Review the result by hand
 * before committing, and see the README for the manual checklist.
 *
 * Idempotence: the output `meta.json` carries `anonymized: true`; such a capture is returned as is
 * (CDC/RUC mappings are per run, so re-mapping would only churn the synthetic values).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCdc, parseCdc } from '../../src/modules/emission/domain/cdc.js';
import { computeRucCheckDigit } from '../../src/modules/fiscal-config/domain/ruc.js';

export type CaptureFiles = Partial<Record<'documento.xml' | 'requests.json' | 'meta.json', string>>;
export type Category = 'cdc' | 'ruc' | 'email' | 'phone' | 'signature' | 'identity';

/** Values of dNumIDRec that carry no personal data ("consumidor final" and our synthetic id). */
const ID_NUMBER_KEEP = new Set(['CF', '1000000']);

export interface AnonymizeReport {
  anonymized: true;
  replacements: Record<
    'cdc' | 'ruc' | 'email' | 'phone' | 'text_field' | 'qr_param' | 'signature' | 'header_removed',
    number
  >;
  files: string[];
}

const SYNTHETIC_RUC = /^80000\d{3}$/;
const SYNTHETIC_EMAIL_DOMAIN = '@ejemplo.com';
const SESSION_HEADERS = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  'x-csrf-token',
]);
const TEXT_FIELDS: Record<string, string> = {
  dNomEmi: 'EMPRESA ANONIMIZADA S.A.',
  dNomFanEmi: 'EMPRESA ANONIMIZADA S.A.',
  dDirEmi: 'DIRECCION ANONIMIZADA',
  dTelEmi: '000000',
  dNomRec: 'CONSUMIDOR FINAL ANONIMIZADO',
  dNomFanRec: 'CONSUMIDOR FINAL ANONIMIZADO',
  dDirRec: 'DIRECCION ANONIMIZADA',
  dTelRec: '000000',
  dCelRec: '000000',
};
const SIGNATURE_KEYS = ['SignatureValue', 'X509Certificate'];
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE_SOURCE = String.raw`(?<![\d.])(?:\+?595|0)9\d{2}[ -]?\d{3}[ -]?\d{3}(?!\d)`;
const CDC_ANY = /(?<!\d)\d{44}(?!\d)/g;

class Anonymizer {
  readonly counts: AnonymizeReport['replacements'] = {
    cdc: 0,
    ruc: 0,
    email: 0,
    phone: 0,
    text_field: 0,
    qr_param: 0,
    signature: 0,
    header_removed: 0,
  };
  private readonly rucs = new Map<string, string>();
  private readonly cdcs = new Map<string, string>();
  private readonly emails = new Map<string, string>();

  fakeRuc(original: string): string {
    const key = original.replace(/^0+/, '');
    let fake = this.rucs.get(key);
    if (fake === undefined) {
      fake = String(80_000_000 + this.rucs.size);
      this.rucs.set(key, fake);
    }
    return fake;
  }

  fakeCdc(original: string): string {
    let fake = this.cdcs.get(original);
    if (fake === undefined) {
      const n = this.cdcs.size + 1;
      let base = {
        documentType: '01',
        rucBase: '0',
        taxpayerType: 2 as 1 | 2,
        issueDate: '2026-01-01',
        emissionType: 1 as 1 | 2,
      };
      try {
        base = { ...base, ...parseCdc(original) };
      } catch {
        // Not a structurally valid CDC (e.g. a placeholder): synthetic defaults apply.
      }
      const rucBase = this.fakeRuc(base.rucBase);
      fake = buildCdc({
        documentType: base.documentType,
        rucBase,
        rucDv: computeRucCheckDigit(rucBase),
        establishment: '001',
        point: '001',
        documentNumber: String(n).padStart(7, '0'),
        taxpayerType: base.taxpayerType,
        issueDate: base.issueDate,
        emissionType: base.emissionType,
        securityCode: String(100_000_000 + n),
      });
      this.cdcs.set(original, fake);
    }
    return fake;
  }

  private fakeEmail(original: string): string {
    if (original.endsWith(SYNTHETIC_EMAIL_DOMAIN)) return original;
    let fake = this.emails.get(original);
    if (fake === undefined) {
      fake = `contacto${String(this.emails.size + 1)}${SYNTHETIC_EMAIL_DOMAIN}`;
      this.emails.set(original, fake);
    }
    this.counts.email += 1;
    return fake;
  }

  text(input: string): string {
    let out = input.replace(/<((?:[\w.-]+:)?Signature)[ >][\s\S]*?<\/\1>/g, () => {
      this.counts.signature += 1;
      return '<!-- signature removed -->';
    });
    out = out.replace(
      /(\\?"(?:SignatureValue|X509Certificate)\\?":\s*\\?")[^"\\]+/g,
      (_m, head: string) => {
        this.counts.signature += 1;
        return `${head}REMOVED`;
      },
    );
    // RUC + check digit pairs first, so the digit stays coherent with the synthetic RUC.
    out = out.replace(
      /<(dRucEm|dRucRec)>(\d{1,9})<\/\1>(\s*)<(dDVEmi|dDVRec)>\d<\/\4>/g,
      (_m, tag: string, ruc: string, gap: string, dvTag: string) => {
        const fake = this.fakeRuc(ruc);
        this.counts.ruc += 1;
        return `<${tag}>${fake}</${tag}>${gap}<${dvTag}>${String(computeRucCheckDigit(fake))}</${dvTag}>`;
      },
    );
    out = out.replace(
      /<(dRucEm|dRucRec)>(\d{1,9})<\/\1>(?!\s*<dDV)/g,
      (_m, tag: string, ruc: string) => {
        this.counts.ruc += 1;
        return `<${tag}>${this.fakeRuc(ruc)}</${tag}>`;
      },
    );
    out = out.replace(/(dRucRec=)(\d{1,9})(?!\d)/g, (_m, head: string, ruc: string) => {
      this.counts.ruc += 1;
      return `${head}${this.fakeRuc(ruc)}`;
    });
    out = out.replace(/(?<!\d)(\d{6,8})-(\d)(?!\d)/g, (_m, base: string) => {
      const fake = this.fakeRuc(base);
      this.counts.ruc += 1;
      return `${fake}-${String(computeRucCheckDigit(fake))}`;
    });
    for (const [tag, value] of Object.entries(TEXT_FIELDS)) {
      out = out.replace(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'), (m, current: string) => {
        if (current === value) return m;
        this.counts.text_field += 1;
        return `<${tag}>${value}</${tag}>`;
      });
    }
    out = out.replace(/(<dNumIDRec>|dNumIDRec=)([^<&\s"]+)/g, (m, head: string, id: string) => {
      if (ID_NUMBER_KEEP.has(id)) return m;
      this.counts.text_field += 1;
      return `${head}1000000`;
    });
    out = out.replace(/(DigestValue|cHashQR)=([0-9a-fA-F]+)/g, (m, key: string, hex: string) => {
      if (/^0+$/.test(hex)) return m;
      this.counts.qr_param += 1;
      return `${key}=${'0'.repeat(hex.length)}`;
    });
    out = out.replace(CDC_ANY, (cdc) => {
      this.counts.cdc += 1;
      return this.fakeCdc(cdc);
    });
    out = out.replace(EMAIL, (email) => this.fakeEmail(email));
    return out.replace(new RegExp(PHONE_SOURCE, 'g'), () => {
      this.counts.phone += 1;
      return '0000000000';
    });
  }

  json(value: unknown): unknown {
    if (typeof value === 'string') return this.text(value);
    if (Array.isArray(value)) return value.map((v) => this.json(v));
    if (value === null || typeof value !== 'object') return value;
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(source)) {
      if (key === 'dRucEm' || key === 'dRucRec') {
        const fake = this.fakeRuc(String(v));
        this.counts.ruc += 1;
        out[key] = typeof v === 'number' ? Number(fake) : fake;
      } else if (key === 'dDVEmi' || key === 'dDVRec') {
        const rucKey = key === 'dDVEmi' ? 'dRucEm' : 'dRucRec';
        out[key] =
          rucKey in source ? computeRucCheckDigit(this.fakeRuc(String(source[rucKey]))) : v;
      } else if (key === 'dNumIDRec' && (typeof v === 'string' || typeof v === 'number')) {
        if (ID_NUMBER_KEEP.has(String(v))) out[key] = v;
        else {
          this.counts.text_field += 1;
          out[key] = typeof v === 'number' ? 1_000_000 : '1000000';
        }
      } else if (key in TEXT_FIELDS && (typeof v === 'string' || typeof v === 'number')) {
        const replacement = TEXT_FIELDS[key] ?? '';
        // Numeric values (e.g. a phone sent as a JSON number) keep their type.
        const synthetic =
          typeof v === 'number' && /^\d+$/.test(replacement) ? Number(replacement) : replacement;
        if (v !== synthetic) this.counts.text_field += 1;
        out[key] = synthetic;
      } else if (SIGNATURE_KEYS.includes(key) && typeof v === 'string') {
        this.counts.signature += 1;
        out[key] = 'REMOVED';
      } else out[key] = this.json(v);
    }
    return out;
  }

  /** A response/request body: JSON bodies are walked by key, anything else is treated as text. */
  body(raw: string): string {
    try {
      return JSON.stringify(this.json(JSON.parse(raw)));
    } catch {
      return this.text(raw);
    }
  }

  record(record: Record<string, unknown>): Record<string, unknown> {
    const scrub = (headers: unknown): unknown => {
      if (headers === null || typeof headers !== 'object') return headers;
      const kept: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
        if (SESSION_HEADERS.has(name.toLowerCase())) this.counts.header_removed += 1;
        else kept[name] = this.json(value);
      }
      return kept;
    };
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key === 'set_cookie') this.counts.header_removed += 1;
      else if (key === 'headers') out[key] = scrub(value);
      else if (key === 'body') out[key] = typeof value === 'string' ? this.body(value) : value;
      else if (key === 'request' && value !== null && typeof value === 'object') {
        const request = value as Record<string, unknown>;
        out[key] = {
          ...(this.json({ ...request, headers: undefined, body: undefined }) as object),
          headers: scrub(request.headers),
          body: typeof request.body === 'string' ? this.body(request.body) : request.body,
        };
        if (request.headers === undefined) delete (out[key] as Record<string, unknown>).headers;
      } else out[key] = this.json(value);
    }
    return out;
  }
}

export function anonymizeCapture(input: CaptureFiles): {
  files: CaptureFiles;
  report: AnonymizeReport;
} {
  const anonymizer = new Anonymizer();
  const files: CaptureFiles = {};
  const alreadyDone =
    (JSON.parse(input['meta.json'] ?? '{}') as { anonymized?: boolean }).anonymized === true;
  if (alreadyDone)
    return {
      files: { ...input },
      report: { anonymized: true, replacements: anonymizer.counts, files: Object.keys(input) },
    };
  if (input['documento.xml'] !== undefined)
    files['documento.xml'] = anonymizer.text(input['documento.xml']);
  if (input['requests.json'] !== undefined) {
    const records = JSON.parse(input['requests.json']) as Record<string, unknown>[];
    files['requests.json'] = JSON.stringify(
      records.map((r) => anonymizer.record(r)),
      null,
      2,
    );
  }
  const meta = anonymizer.json(JSON.parse(input['meta.json'] ?? '{}')) as Record<string, unknown>;
  files['meta.json'] = JSON.stringify({ ...meta, anonymized: true }, null, 2);
  return {
    files,
    report: { anonymized: true, replacements: anonymizer.counts, files: Object.keys(files) },
  };
}

/** Returns the CATEGORIES of sensitive-looking data found, never the values. */
export function scanSensitive(text: string): Category[] {
  const found = new Set<Category>();
  for (const cdc of text.match(CDC_ANY) ?? []) {
    if (/^0{20}/.test(cdc)) continue;
    try {
      const parts = parseCdc(cdc);
      if (
        SYNTHETIC_RUC.test(parts.rucBase) &&
        parts.establishment === '001' &&
        parts.point === '001'
      )
        continue;
    } catch {
      // Not a valid CDC: flagged below.
    }
    found.add('cdc');
  }
  for (const [, , ruc] of text.matchAll(/(dRuc(?:Em|Rec))\W{1,4}(\d+)/g)) {
    if (!SYNTHETIC_RUC.test(ruc)) found.add('ruc');
  }
  for (const [, ruc] of text.matchAll(/dRucRec=(\d+)/g)) {
    if (!SYNTHETIC_RUC.test(ruc)) found.add('ruc');
  }
  for (const [, base] of text.matchAll(/(?<!\d)(\d{6,8})-\d(?!\d)/g)) {
    if (!SYNTHETIC_RUC.test(base)) found.add('ruc');
  }
  for (const [, , id] of text.matchAll(/(dNumIDRec)(?:>|=|\\?":\s*\\?"?)([A-Za-z0-9-]+)/g)) {
    if (!ID_NUMBER_KEEP.has(id)) found.add('identity');
  }
  if ((text.match(EMAIL) ?? []).some((email) => !email.endsWith(SYNTHETIC_EMAIL_DOMAIN)))
    found.add('email');
  if (
    new RegExp(PHONE_SOURCE).test(text) ||
    [...text.matchAll(/(dTel\w*|dCel\w*)\W{1,4}(\d+)/g)].some(([, , n]) => !/^0+$/.test(n))
  ) {
    found.add('phone');
  }
  if (
    /<(?:[\w.-]+:)?(?:SignatureValue|X509Certificate)>[^<]+/.test(text) ||
    /(?:SignatureValue|X509Certificate)\\?":\s*\\?"(?!REMOVED)[^"\\]+/.test(text)
  ) {
    found.add('signature');
  }
  return [...found];
}

export function runCli(argv: readonly string[]): number {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    const value = index < 0 ? undefined : argv[index + 1];
    return value === undefined || value.startsWith('--') ? undefined : value;
  };
  const inDir = get('--in');
  const outDir = get('--out');
  if (inDir === undefined || outDir === undefined) {
    console.error(
      'Usage: anonymize-fixtures --in <raw capture dir> --out <output dir> (both required)',
    );
    return 2;
  }
  const input: CaptureFiles = {};
  for (const name of ['documento.xml', 'requests.json', 'meta.json'] as const) {
    if (existsSync(join(inDir, name))) input[name] = readFileSync(join(inDir, name), 'utf8');
  }
  if (Object.keys(input).length === 0) {
    console.error(
      'The input directory does not exist or has no capture files (documento.xml, requests.json, meta.json).',
    );
    return 2;
  }
  let result: ReturnType<typeof anonymizeCapture>;
  try {
    for (const name of ['meta.json', 'requests.json'] as const) {
      if (input[name] !== undefined) JSON.parse(input[name]);
    }
    result = anonymizeCapture(input);
  } catch {
    console.error('Malformed capture: meta.json or requests.json is not valid JSON.');
    return 2;
  }
  const { files, report } = result;
  const leftovers = new Map<string, number>();
  for (const content of Object.values(files)) {
    for (const category of scanSensitive(content)) {
      leftovers.set(category, (leftovers.get(category) ?? 0) + 1);
    }
  }
  if (leftovers.size > 0) {
    const summary = [...leftovers].map(
      ([category, files]) => `${category}: ${String(files)} file(s)`,
    );
    console.error(
      `Sensitive data would remain after anonymization (${summary.join(', ')}). Nothing was written.`,
    );
    return 3;
  }
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(outDir, name), content);
  writeFileSync(join(outDir, 'anonymization-report.json'), JSON.stringify(report, null, 2));
  console.log(`Wrote ${Object.keys(files).join(', ')} and anonymization-report.json to ${outDir}`);
  console.log(`Replacements: ${JSON.stringify(report.replacements)}`);
  console.log(
    'Review the output by hand before committing (names in free text are not detectable).',
  );
  return 0;
}

if (process.argv.length > 1 && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
